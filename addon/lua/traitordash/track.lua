-- TraitorDash position tracking (RFC 12).
--
-- While a round runs, one repeating timer samples where every living player is and which way they
-- look; when the round is over and the backend has accepted its stats, the whole track is sent once.
--
-- Hard rule, the same as stats.lua: this must NEVER hurt the game.
--   * it is off unless traitordash_track is 1, and then does nothing but a timer (not Think)
--   * a server with the ConVar off does not even create the timer
--   * the timer body runs inside pcall; an error stops the recording, not the round
--   * every tick is timed against a budget; a slow tick or a busy server makes the interval longer,
--     a very busy one skips the tick (a gap, never an invented sample), and a server that cannot
--     afford the slowest interval gets a "degraded" track
--   * the buffers are capped (players, ticks, bytes); a track that reaches a cap is sent truncated
--   * nothing is sent while the round runs; a failed upload is dropped: no queue, no retry
--
-- Besides the position and the view yaw, each sample says how the player moves, as a number of bits `s`: 1 crouching, 2 in the air,
-- 4 in water (the replay animates a player from it). A player the game cannot ask (a call that is not there) counts as 0.
--
-- Parts that move (RFC 20, 4.3): with traitordash_track_parts on, the doors, lifts and other brush entities that can move are recorded
-- as keyframes on the same tick list, and the inputs that reach them (also a player pressing use) as a list; see the Parts section below.
--
-- Encoding (as recorded and as sent): one shared list `t` of tick times in whole milliseconds since
-- the round began, stored as differences; per player and segment `x`, `y`, `z` in units / 8 and the
-- view yaw `a` as 0-255, each the first absolute value and then differences to the previous sample.

TraitorDash = TraitorDash or {}
local Track = {}
TraitorDash.Track = Track

local cv_track = CreateConVar("traitordash_track", "0", {FCVAR_ARCHIVE}, "Record player positions for round replays (1/0).")
local cv_min = CreateConVar("traitordash_track_interval_min", "0.2", {FCVAR_ARCHIVE}, "Fastest sampling interval in seconds (at least 0.05).")
local cv_max = CreateConVar("traitordash_track_interval_max", "1", {FCVAR_ARCHIVE}, "Slowest sampling interval in seconds.")
local cv_budget = CreateConVar("traitordash_track_budget_ms", "0.5", {FCVAR_ARCHIVE}, "What one sampling tick may cost on average, in milliseconds.")
local cv_maxticks = CreateConVar("traitordash_track_max_ticks", "40000", {FCVAR_ARCHIVE}, "The most sampling ticks a round records; a longer round is cut and flagged truncated (1000 to 100000).")
local cv_parts = CreateConVar("traitordash_track_parts", "0", {FCVAR_ARCHIVE}, "Also record doors, lifts and other parts that move, and who set them off (1/0; needs traitordash_track).")
local cv_props = CreateConVar("traitordash_track_props", "0", {FCVAR_ARCHIVE}, "Also record props, prop doors and weapons on the floor that move (1/0; needs traitordash_track).")
local cv_chat = CreateConVar("traitordash_track_chat", "0", {FCVAR_ARCHIVE}, "Also record what players write in chat, for the replay (1/0; needs traitordash_track). Everyone who may open a replay can read it.")
local cv_debug = CreateConVar("traitordash_stats_debug", "1", {FCVAR_ARCHIVE}, "Log what the stats tracker does (1/0).")

local TIMER = "TraitorDash_Track"
local MAX_TICKS_FLOOR, MAX_TICKS_CEILING = 1000, 100000 -- what traitordash_track_max_ticks is kept between (the backend refuses more than the ceiling)
local MAX_SEGMENTS = 64          -- per player
local MAX_DEATHS = 512
-- What happened to players besides moving (RFC 14, 4.3 and RFC 26): each kind has a cap of its own, so a chatty round does not use up the room of the others.
local EVENT_CAP = { revive = 1024, role = 1024, say = 1024, buy = 512, found = 256, pickup = 256, drop = 256 }
local SAY_LEN = 200             -- characters of a chat line that are kept
local MAX_BODIES = 4096         -- points of bodies' paths (RFC 24)
local BODY_MOVE = 16                -- units a body must move from its last point to be recorded again
local BODY_TURN = 80                -- quarter degrees (20 degrees) it must turn
local MAX_PARTS = 256           -- parts that move, per round (RFC 20, 4.3)
local MAX_KEYS_PART = 4000
local MAX_KEYS = 50000
local MAX_INPUTS = 1024
local MAX_THINGS = 256              -- props, prop doors and weapons that moved, per round (RFC 20, 4.8)
local MAX_KEYS_THING = 2000
local MAX_THING_KEYS = 30000
local MAX_CANDIDATES = 768          -- entities looked at to see whether they move
local THING_CLASSES = { prop_physics = true, prop_physics_multiplayer = true, prop_door_rotating = true }
local FULL_SCAN = 5                -- every part is looked at on every fifth tick; an active one on every tick
local LIST_REFRESH = 25            -- the list of parts is made again on every 25th tick (a map creates and removes some during a round)
local QUIET = 2                    -- ticks without a change after which a part is not active any more
local SAME_INPUT_MS = 1000         -- the same input by the same player on one part within this is one entry (use is sent again while the key is held)
local MAX_BYTES = 8 * 1024 * 1024
local SAFE_BYTES = 7 * 1024 * 1024 -- the size estimate at which recording stops, a margin below the cap
local BYTES_PER_SAMPLE = 18
local RING = 10                  -- ticks the average cost is taken over
local STEP_MAX = 60000           -- the longest step between two ticks the backend accepts, ms

local rec = nil                  -- the round being recorded, or nil
local noEndpointOn = nil         -- the map on which the backend answered 404 (it is too old)

local function Dbg(...)
    if cv_debug:GetBool() then print("[TraitorDash:track]", ...) end
end

local function Floor(v) return math.floor(v + 0.5) end

local function Settings()
    local mn = math.max(cv_min:GetFloat(), 0.05)
    local mx = math.max(cv_max:GetFloat(), mn)
    local budget = math.max(cv_budget:GetFloat(), 0.05) / 1000 -- seconds
    return mn, mx, budget
end

-- The most ticks a round records (RFC 12, 3.2): a round that never ends must not record for ever. 40,000 is 33 minutes at the fastest sampling, 0.05 s.
local function MaxTicks()
    return math.min(math.max(math.floor(cv_maxticks:GetInt()), MAX_TICKS_FLOOR), MAX_TICKS_CEILING)
end

local function EstimateBytes(r)
    return r.samples * BYTES_PER_SAMPLE + #r.t * 6 + #r.deaths * 120 + #r.events * 100 + #r.bodies * 40 + r.keys * 36 + (r.thingKeys or 0) * 36 + #(r.thingList or {}) * 120 + #r.inputs * 90
end

-- `at` is where the player really was, when it is known and `GetPos` would say something else: a dead player's position is the
-- one of a spectator, at the height of their eyes (see Track.Death).
local function Pos(ply, at)
    local p = at or ply:GetPos()
    local a = ply:EyeAngles()
    return Floor(p.x / 8), Floor(p.y / 8), Floor(p.z / 8), math.floor((a.y % 360) / 360 * 256) % 256
end

-- How the player moves, as bits (see the top of this file). Each question is asked on its own, so one that does not exist costs only its bit.
local function State(ply)
    local s = 0
    local ok, v = pcall(ply.Crouching, ply)
    if ok and v then s = s + 1 end
    ok, v = pcall(ply.IsOnGround, ply)
    if ok and v == false then s = s + 2 end
    ok, v = pcall(ply.WaterLevel, ply)
    if ok and type(v) == "number" and v >= 2 then s = s + 4 end
    return s
end

local HOOK_ID = "TraitorDash_TrackParts"

-- The timer and, with it, the two hooks of the parts (RFC 20, 4.4): both go when a recording ends for any reason.
local function RemoveTimer()
    if timer.Exists and timer.Exists(TIMER) then timer.Remove(TIMER) end
    if hook.Remove then
        hook.Remove("AcceptInput", HOOK_ID)
        hook.Remove("PlayerUse", HOOK_ID)
    end
end

-- Ends sampling for this round; what was recorded is kept.
local function StopSampling(r, why)
    if r.stopped then return end
    r.stopped = true
    RemoveTimer()
    Dbg("sampling stopped: " .. why)
end

-- A tick: its time (the difference to the last tick, in ms) is added to the shared list.
local function AddTick(r, now)
    local ms = Floor((now - r.t0) * 1000)
    local diff = math.min(math.max(ms - r.lastMs, 0), STEP_MAX)
    r.lastMs = r.lastMs + diff
    r.t[#r.t + 1] = diff
    return #r.t
end

local function Push(r, p, idx, x, y, z, a, st)
    local c = p.cur
    if not c then
        if #p.segs >= MAX_SEGMENTS then return end
        c = { from = idx - 1, x = {}, y = {}, z = {}, a = {}, s = {}, lx = 0, ly = 0, lz = 0, la = 0 }
        p.cur = c
        p.segs[#p.segs + 1] = c
    end
    local n = #c.x + 1
    c.x[n], c.y[n], c.z[n], c.a[n] = x - c.lx, y - c.ly, z - c.lz, a - c.la
    c.s[n] = st or 0
    c.lx, c.ly, c.lz, c.la = x, y, z, a
    r.samples = r.samples + 1
end

-- One sample of every tracked player at one tick. `also` is the SteamID of a player to sample even
-- though they are no longer alive (the death hook: the death position is exact).
-- Milliseconds since the round began, as the backend wants them (0 to six hours).
local function RoundMs(r, now)
    return math.min(math.max(Floor((now - r.t0) * 1000), 0), 6 * 3600 * 1000)
end

-- Adds an event (RFC 14, 4.3, RFC 26); beyond the cap of its kind the track is marked truncated instead.
local function AddEvent(r, now, e)
    local n = (r.kinds[e.k] or 0) + 1
    if n > (EVENT_CAP[e.k] or 0) then r.truncated = true return end
    r.kinds[e.k] = n
    e.t = RoundMs(r, now)
    r.events[#r.events + 1] = e
end

-- ---- Parts that move (RFC 20, 4.3 and 4.4)
-- Which entities are parts: the movable brush classes of RFC 18, with a model "*N" (the number of the model in the map file, which is what
-- the mesh's node of the part is called) and no parent (a part with a parent is left out of the mesh).
local PART_CLASSES = {
    func_door = true, func_door_rotating = true, func_movelinear = true, func_rotating = true,
    func_tracktrain = true, func_physbox = true, func_physbox_multiplayer = true,
}
-- The inputs that are recorded when they reach a part. The pose says what happened; the input says what was asked, and by whom.
local PART_INPUTS = {
    open = true, close = true, toggle = true, lock = true, unlock = true, use = true, setposition = true,
    startforward = true, startbackward = true, stop = true, reverse = true, start = true,
}

-- An angle in quarter degrees, from -720 up to 719.
local function Quarter(a)
    return (Floor(a * 4) + 720) % 1440 - 720
end

-- The part an entity is, as a record of its own, or nil when it is not one to record.
local function PartOf(ent)
    if not IsValid(ent) then return nil end
    local class = ent:GetClass()
    if not PART_CLASSES[class] then return nil end
    local model = ent:GetModel()
    local n = type(model) == "string" and string.match(model, "^%*(%d+)$")
    n = n and tonumber(n)
    if not n or n < 1 or n > 65535 then return nil end
    if ent.GetParent and IsValid(ent:GetParent()) then return nil end
    local name = tostring(ent.GetName and ent:GetName() or ""):gsub("[^%w_.%-]", ""):sub(1, 64)
    return {
        ent = ent, idx = ent:EntIndex(), m = n, c = class, n = name ~= "" and name or nil,
        nk = 0, lastKey = 0, quiet = 0, gone = false, stopped = false,
        k = {}, x = {}, y = {}, z = {}, p = {}, w = {}, r = {},
        wx = 0, wy = 0, wz = 0, wp = 0, ww = 0, wr = 0, -- the pose of the last keyframe written
    }
end

-- Writes a keyframe: its tick (0-based, as the segments count them) and its pose, each as the difference to the one before it.
local function WriteKey(r, part, tick, x, y, z, p, w, ro)
    if part.nk >= MAX_KEYS_PART or r.keys >= MAX_KEYS then
        part.stopped = true
        r.truncated = true
        return false
    end
    local n = part.nk + 1
    part.k[n], part.x[n], part.y[n], part.z[n] = tick - part.lastKey, x - part.wx, y - part.wy, z - part.wz
    part.p[n], part.w[n], part.r[n] = p - part.wp, w - part.ww, ro - part.wr
    part.nk, part.lastKey = n, tick
    part.wx, part.wy, part.wz, part.wp, part.ww, part.wr = x, y, z, p, w, ro
    r.keys = r.keys + 1
    return true
end

-- One look at a part. A keyframe is written when the pose is not the one of the last keyframe; and when the part stood still for more than a
-- tick before, first one more keyframe of the old pose just before, so that the replay (which draws a straight line between two keyframes)
-- does not slide from the rest pose to the new one over the whole time the part stood still.
local function Look(r, part, tick)
    local ent = part.ent
    if not IsValid(ent) then
        part.gone = true
        if r.partByEnt[part.idx] == part then r.partByEnt[part.idx] = nil end
        return
    end
    local pos, ang = ent:GetPos(), ent:GetAngles()
    local x, y, z = Floor(pos.x), Floor(pos.y), Floor(pos.z)
    local p, w, ro = Quarter(ang.p), Quarter(ang.y), Quarter(ang.r)
    if part.nk == 0 then
        WriteKey(r, part, tick, x, y, z, p, w, ro)
    elseif x ~= part.wx or y ~= part.wy or z ~= part.wz or p ~= part.wp or w ~= part.ww or ro ~= part.wr then
        if part.lastKey < tick - 1 then WriteKey(r, part, tick - 1, part.wx, part.wy, part.wz, part.wp, part.ww, part.wr) end
        WriteKey(r, part, tick, x, y, z, p, w, ro)
        part.quiet = QUIET
    elseif part.quiet > 0 then
        part.quiet = part.quiet - 1
    end
end

-- Finds the parts the list does not have yet (a map creates some during a round). Beyond the cap the track is marked truncated.
local function RefreshParts(r)
    for class in pairs(PART_CLASSES) do
        for _, ent in ipairs(ents.FindByClass(class)) do
            if IsValid(ent) and not r.partByEnt[ent:EntIndex()] then
                if #r.partList >= MAX_PARTS then
                    r.truncated = true
                else
                    local part = PartOf(ent)
                    if part then
                        part.id = #r.partList + 1
                        r.partList[part.id] = part
                        r.partByEnt[part.idx] = part
                    end
                end
            end
        end
    end
end

-- The parts at one tick: the active ones every time, all of them on every fifth tick (which finds what no input announced: a pushed crate,
-- a train). Inside the tick's own time, so the budget of the track covers it.
local function SampleParts(r, tick)
    r.partTick = r.partTick + 1
    local n = r.partTick
    if n == 1 or n % LIST_REFRESH == 0 then RefreshParts(r) end
    local full = n == 1 or n % FULL_SCAN == 0
    for _, part in ipairs(r.partList) do
        if not part.gone and not part.stopped and (full or part.quiet > 0 or part.nk == 0) then Look(r, part, tick) end
    end
end

-- The SteamID64 of a tracked player, or nil when `ply` is not one.
local function SidOf(r, ply)
    if not IsValid(ply) then return nil end
    for _, sid in ipairs(r.order) do
        if r.players[sid].ply == ply then return sid end
    end
    return nil
end

local function AddInput(r, part, name, ply, via)
    if #r.inputs >= MAX_INPUTS then r.truncated = true return end
    local now = RoundMs(r, CurTime())
    local by = SidOf(r, ply)
    if part.lastName == name and part.lastBy == by and part.lastAt and now - part.lastAt < SAME_INPUT_MS then return end
    part.lastName, part.lastBy, part.lastAt = name, by, now
    r.inputs[#r.inputs + 1] = { t = now, e = part.id, i = name, v = via, by = by }
end

-- GM:AcceptInput. It must end without a value on every path (returning true blocks the input in the game), and it does one table lookup
-- before anything else, so the many inputs of a busy map cost almost nothing.
local function OnInput(ent, input, activator, caller)
    local r = rec
    if not r or r.stopped or not IsValid(ent) then return end
    local cand = r.candByEnt and r.candByEnt[ent:EntIndex()]
    if cand then cand.quiet = QUIET + 1 end -- something was done to a prop or a prop door: it is looked at every tick for a while
    local part = r.partByEnt and r.partByEnt[ent:EntIndex()]
    if not part then return end
    part.quiet = QUIET + 1 -- an input makes the part active
    local name = string.lower(tostring(input))
    if not PART_INPUTS[name] then return end
    local who = IsValid(activator) and activator.IsPlayer and activator:IsPlayer() and activator or (IsValid(caller) and caller.IsPlayer and caller:IsPlayer() and caller or nil)
    AddInput(r, part, name, who, "input")
end

-- GM:PlayerUse: a door pushed open with the use key often arrives with no input to the door at all (RFC 20, findings), and this says who.
-- It is sent again for as long as the key is held; AddInput makes that one entry. It ends without a value as well (false would stop the use).
local function OnUse(ply, ent)
    local r = rec
    if not r or r.stopped or not IsValid(ent) then return end
    local cand = r.candByEnt and r.candByEnt[ent:EntIndex()]
    if cand then cand.quiet = QUIET + 1 end
    local part = r.partByEnt and r.partByEnt[ent:EntIndex()]
    if not part then return end
    part.quiet = QUIET + 1
    AddInput(r, part, "use", ply, "use")
end

local function StartParts(r)
    r.partList, r.partByEnt, r.partTick = {}, {}, 0
    hook.Add("AcceptInput", HOOK_ID, function(ent, input, activator, caller) pcall(OnInput, ent, input, activator, caller) end)
    hook.Add("PlayerUse", HOOK_ID, function(ply, ent) pcall(OnUse, ply, ent) end)
end

-- ---- Props, prop doors and weapons that move (RFC 20, 4.8; RFC 24, stage 4)
-- Every prop of the three classes and every weapon lying on the floor is a candidate. A candidate costs a look at its pose: every fifth tick
-- for all of them, every tick while something was done to it. A candidate that never moves is never written to the track. One that does gets
-- a keyframe of the pose it was first seen in (so the replay does not slide it from the start) and then a keyframe at each change.

-- The model's bounds as six whole units, or nil.
local function BoundsOf(ent)
    local ok, a, b = pcall(function() return ent:GetModelBounds() end)
    if not ok or not a or not b then
        ok, a, b = pcall(function() return ent:OBBMins(), ent:OBBMaxs() end)
    end
    if not ok or not a or not b then return nil end
    return { Floor(a.x), Floor(a.y), Floor(a.z), Floor(b.x), Floor(b.y), Floor(b.z) }
end

local function IsWeaponOnFloor(ent, class)
    if string.sub(class, 1, 7) ~= "weapon_" then return false end
    return not IsValid(ent:GetOwner())
end

local function Adopt(r, ent, tick)
    if not IsValid(ent) then return end
    local idx = ent:EntIndex()
    if r.candByEnt[idx] or r.candCount >= MAX_CANDIDATES then return end
    local class = ent:GetClass()
    if not THING_CLASSES[class] and not IsWeaponOnFloor(ent, class) then return end
    local model = ent:GetModel()
    if type(model) ~= "string" or not string.match(model, "^[%w_./%-]+$") or #model > 128 or string.find(model, "..", 1, true) then return end
    local bounds = BoundsOf(ent)
    if not bounds then return end
    local pos, ang = ent:GetPos(), ent:GetAngles()
    local mid = nil
    if ent.MapCreationID then
        local ok, v = pcall(ent.MapCreationID, ent)
        if ok and type(v) == "number" and v >= 0 then mid = v end
    end
    local cand = {
        ent = ent, idx = idx, c = class, mdl = model, b = bounds, id = mid, quiet = 0, tick = tick,
        weapon = string.sub(class, 1, 7) == "weapon_", physics = class ~= "prop_door_rotating" and string.sub(class, 1, 7) ~= "weapon_",
        rest = { Floor(pos.x), Floor(pos.y), Floor(pos.z), Quarter(ang.p), Quarter(ang.y), Quarter(ang.r) }, restTick = tick,
    }
    r.candByEnt[idx] = cand
    r.candList[#r.candList + 1] = cand
    r.candCount = r.candCount + 1
end

local function RefreshThings(r, tick)
    for class in pairs(THING_CLASSES) do
        for _, ent in ipairs(ents.FindByClass(class)) do Adopt(r, ent, tick) end
    end
    for _, ent in ipairs(ents.FindByClass("weapon_*")) do Adopt(r, ent, tick) end
end

local function WriteThingKey(r, th, tick, x, y, z, p, w, ro)
    if th.nk >= MAX_KEYS_THING or r.thingKeys >= MAX_THING_KEYS then
        th.stopped = true
        r.truncated = true
        return false
    end
    local n = th.nk + 1
    th.k[n], th.x[n], th.y[n], th.z[n] = tick - th.lastKey, x - th.wx, y - th.wy, z - th.wz
    th.p[n], th.w[n], th.r[n] = p - th.wp, w - th.ww, ro - th.wr
    th.nk, th.lastKey = n, tick
    th.wx, th.wy, th.wz, th.wp, th.ww, th.wr = x, y, z, p, w, ro
    r.thingKeys = r.thingKeys + 1
    return true
end

local function LookThing(r, cand, tick)
    local ent = cand.ent
    local th = cand.thing
    if not IsValid(ent) or (cand.weapon and IsValid(ent:GetOwner())) then
        -- removed, or picked up (a weapon in a hand moves with the player): the thing is gone from this tick
        if th then th.g = tick end
        cand.gone = true
        if r.candByEnt[cand.idx] == cand then r.candByEnt[cand.idx] = nil end
        r.candCount = r.candCount - 1
        return
    end
    if cand.physics and cand.quiet == 0 then
        local phys = ent:GetPhysicsObject()
        if IsValid(phys) and phys:IsAsleep() then return end -- a prop at rest has not moved
    end
    local pos, ang = ent:GetPos(), ent:GetAngles()
    local x, y, z = Floor(pos.x), Floor(pos.y), Floor(pos.z)
    local p, w, ro = Quarter(ang.p), Quarter(ang.y), Quarter(ang.r)
    if not th then
        local rest = cand.rest
        if x == rest[1] and y == rest[2] and z == rest[3] and p == rest[4] and w == rest[5] and ro == rest[6] then
            if cand.quiet > 0 then cand.quiet = cand.quiet - 1 end
            return
        end
        if #r.thingList >= MAX_THINGS or r.thingKeys >= MAX_THING_KEYS then
            r.truncated = true
            cand.stopped = true
            return
        end
        th = {
            e = #r.thingList + 1, c = cand.c, mdl = cand.mdl, b = cand.b, id = cand.id,
            nk = 0, lastKey = 0, k = {}, x = {}, y = {}, z = {}, p = {}, w = {}, r = {},
            wx = 0, wy = 0, wz = 0, wp = 0, ww = 0, wr = 0,
        }
        r.thingList[th.e] = th
        cand.thing = th
        WriteThingKey(r, th, cand.restTick, rest[1], rest[2], rest[3], rest[4], rest[5], rest[6])
        if tick - 1 > cand.restTick then WriteThingKey(r, th, tick - 1, rest[1], rest[2], rest[3], rest[4], rest[5], rest[6]) end -- held until just before it moved
        WriteThingKey(r, th, tick, x, y, z, p, w, ro)
        cand.quiet = QUIET
    elseif th.stopped then
        return
    elseif x ~= th.wx or y ~= th.wy or z ~= th.wz or p ~= th.wp or w ~= th.ww or ro ~= th.wr then
        if th.lastKey < tick - 1 then WriteThingKey(r, th, tick - 1, th.wx, th.wy, th.wz, th.wp, th.ww, th.wr) end
        WriteThingKey(r, th, tick, x, y, z, p, w, ro)
        cand.quiet = QUIET
    elseif cand.quiet > 0 then
        cand.quiet = cand.quiet - 1
    end
end

-- The things at one tick: those that were touched or are moving on every tick, all candidates on every fifth.
local function SampleThings(r, tick)
    r.thingTick = r.thingTick + 1
    local n = r.thingTick
    if n == 1 or n % LIST_REFRESH == 0 then RefreshThings(r, tick) end
    local full = n == 1 or n % FULL_SCAN == 0
    local list, keep = r.candList, {}
    for _, cand in ipairs(list) do
        if not cand.gone and not cand.stopped then
            if full or cand.quiet > 0 then LookThing(r, cand, tick) end
            if not cand.gone then keep[#keep + 1] = cand end
        end
    end
    r.candList = keep
end

local function StartThings(r)
    r.candList, r.candByEnt, r.candCount, r.thingList, r.thingKeys, r.thingTick = {}, {}, 0, {}, 0, 0
    hook.Add("AcceptInput", HOOK_ID, function(ent, input, activator, caller) pcall(OnInput, ent, input, activator, caller) end)
    hook.Add("PlayerUse", HOOK_ID, function(ply, ent) pcall(OnUse, ply, ent) end)
end

local function ThingsOut(r)
    local out = {}
    for _, th in ipairs(r.thingList or {}) do
        if th.nk > 0 then
            out[#out + 1] = { e = th.e, c = th.c, mdl = th.mdl, b = th.b, id = th.id, g = th.g, k = th.k, x = th.x, y = th.y, z = th.z, p = th.p, w = th.w, r = th.r }
        end
    end
    return #out > 0 and out or nil
end

-- What `Finish` sends of the parts: nil when there are none.
local function PartsOut(r)
    local out = {}
    for _, part in ipairs(r.partList or {}) do
        if part.nk > 0 then
            out[#out + 1] = { e = part.id, m = part.m, c = part.c, n = part.n, k = part.k, x = part.x, y = part.y, z = part.z, p = part.p, w = part.w, r = part.r }
        end
    end
    return #out > 0 and out or nil
end

-- The way round between two angles in quarter degrees (they are -720 to 719).
local function QuarterGap(a, b)
    local d = math.abs(a - b) % 1440
    return math.min(d, 1440 - d)
end

-- The bodies (RFC 24, 4.2): a body that has moved BODY_MOVE units or turned BODY_TURN from its last point gets a new one, and the first
-- sighting always does. A body that lies still costs one distance check. A ragdoll that is gone or a player who lives again drops it.
local function SampleBodies(r, now)
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        local rag = p.rag
        if rag then
            if not IsValid(rag) or (IsValid(p.ply) and p.ply:IsTerror()) then
                p.rag, p.lastBody = nil, nil
            elseif #r.bodies >= MAX_BODIES then
                r.truncated = true
            else
                local pos, ang = rag:GetPos(), rag:GetAngles()
                local x, y, z = Floor(pos.x / 8), Floor(pos.y / 8), Floor(pos.z / 8)
                local pt, w, ro = Quarter(ang.p), Quarter(ang.y), Quarter(ang.r)
                local l = p.lastBody
                local moved = not l or math.abs(x - l.x) * 8 >= BODY_MOVE or math.abs(y - l.y) * 8 >= BODY_MOVE or math.abs(z - l.z) * 8 >= BODY_MOVE
                    or QuarterGap(pt, l.pt) >= BODY_TURN or QuarterGap(w, l.w) >= BODY_TURN or QuarterGap(ro, l.ro) >= BODY_TURN
                if moved then
                    p.lastBody = { x = x, y = y, z = z, pt = pt, w = w, ro = ro }
                    r.bodies[#r.bodies + 1] = { p = sid, t = RoundMs(r, now), x = x, y = y, z = z, pt = pt, w = w, r = ro }
                end
            end
        end
    end
end

local function SampleAll(r, now, also)
    local idx = AddTick(r, now)
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        local ply = p.ply
        local alive = IsValid(ply) and ply:IsTerror()
        if IsValid(ply) and (alive or sid == also) then
            -- Dead at an earlier tick, alive now, and no respawn event came: a revival by a path that
            -- fires none. The time is this tick's; the source is unknown (RFC 14, 4.1).
            if alive and p.awaiting and p.sawDead then
                p.awaiting, p.sawDead = false, false
                AddEvent(r, now, { p = sid, k = "revive" })
            end
            local x, y, z, a = Pos(ply, sid == also and r.deathAt or nil)
            Push(r, p, idx, x, y, z, a, State(ply))
        else
            p.cur = nil -- not alive now: the segment ends here (a revived player starts a new one)
            if p.awaiting then p.sawDead = true end
        end
    end
    SampleBodies(r, now)
    if r.candList and not r.thingsOff then
        local ok, err = pcall(SampleThings, r, idx - 1)
        if not ok then
            r.thingsOff = true
            print("[TraitorDash:track] recording the props failed, they are left out: " .. tostring(err))
        end
    end
    if r.partList and not r.partsOff then
        -- (also called from Begin and Death, outside the timer's own pcall: a failure here ends the parts, never the round)
        local ok, err = pcall(SampleParts, r, idx - 1)
        if not ok then
            r.partsOff = true
            print("[TraitorDash:track] recording the parts failed, they are left out: " .. tostring(err))
        end
    end
end

local function CloseAll(r)
    for _, sid in ipairs(r.order) do r.players[sid].cur = nil end
end

local function SetInterval(r, v)
    if v == r.interval then return end
    r.interval = v
    if timer.Adjust then timer.Adjust(TIMER, v) end
end

local function Grow(r)
    local _, mx = Settings()
    SetInterval(r, math.min(mx, r.interval * 1.5))
end

local function Adapt(r, cost, busy)
    local mn, mx, budget = Settings()
    r.ring[#r.ring + 1] = cost
    if #r.ring > RING then table.remove(r.ring, 1) end
    r.costSum = r.costSum + cost
    r.worst = math.max(r.worst, cost)

    -- the settings may have changed since the last tick
    local want = math.min(math.max(r.interval, mn), mx)
    SetInterval(r, want)

    if busy then Grow(r) end
    if #r.ring < RING then return end
    local sum = 0
    for _, c in ipairs(r.ring) do sum = sum + c end
    local avg = sum / #r.ring

    local nearCap = EstimateBytes(r) > SAFE_BYTES * 0.6
    if avg > budget then
        if r.interval >= mx - 1e-9 then
            r.degraded = true
            StopSampling(r, string.format("a tick costs %.2f ms on average, over the %.2f ms budget even at the slowest interval", avg * 1000, budget * 1000))
            return
        end
        Grow(r)
        r.ring = {}
    elseif avg < budget / 3 and not busy and not nearCap then
        SetInterval(r, math.max(mn, r.interval * 0.75))
        r.ring = {}
    end
    if nearCap then SetInterval(r, mx) end -- the size is approaching its cap: slow down instead of cutting the round short
end

local function Tick()
    local r = rec
    if not r or r.stopped then return end
    if not cv_track:GetBool() then
        -- the kill switch: take effect at once and keep nothing
        rec = nil
        RemoveTimer()
        Dbg("traitordash_track is 0; recording dropped")
        return
    end
    local t0 = SysTime()

    if #r.t >= MaxTicks() then r.truncated = true StopSampling(r, "the tick cap was reached") return end
    if EstimateBytes(r) > SAFE_BYTES then r.truncated = true StopSampling(r, "the size cap was reached") return end

    -- A server that is already struggling gets no extra work: its own frame time against its tick.
    local ti, ft = engine.TickInterval(), FrameTime()
    local busy = false
    if ft > 3 * ti then
        r.skipped = r.skipped + 1
        CloseAll(r) -- a gap is a gap
        Grow(r)
        return
    elseif ft > 1.5 * ti then
        busy = true
    end

    SampleAll(r, CurTime())
    local cost = SysTime() - t0
    r.ticks = r.ticks + 1
    r.minUsed = math.min(r.minUsed, r.interval)
    r.maxUsed = math.max(r.maxUsed, r.interval)
    Adapt(r, cost, busy)
end

local function SafeTick()
    local ok, err = pcall(Tick)
    if not ok then
        print("[TraitorDash:track] sampling error: " .. tostring(err))
        if rec then rec.truncated = true StopSampling(rec, "an error") end
    end
end

-- The round begins. `players` is a list of { sid = SteamID64 (or the bot's test id), ply = the player }.
function Track.Begin(roundId, players)
    rec = nil
    RemoveTimer()
    if not cv_track:GetBool() then return end
    if noEndpointOn == game.GetMap() then return end

    local mn = Settings()
    local r = {
        id = roundId, t0 = CurTime(), lastMs = 0, t = {}, order = {}, players = {}, deaths = {}, events = {},
        samples = 0, ticks = 0, skipped = 0, interval = mn, minUsed = math.huge, maxUsed = 0,
        ring = {}, costSum = 0, worst = 0, truncated = false, degraded = false, stopped = false,
        keys = 0, inputs = {}, bodies = {}, kinds = {}, chat = cv_chat:GetBool(),
    }
    for _, e in ipairs(players) do
        if #r.order >= 128 then break end
        r.order[#r.order + 1] = e.sid
        r.players[e.sid] = { ply = e.ply, segs = {} }
    end
    rec = r
    if cv_parts:GetBool() then StartParts(r) end
    if cv_props:GetBool() then StartThings(r) end
    SampleAll(r, r.t0) -- where everybody stands at the start
    timer.Create(TIMER, r.interval, 0, SafeTick)
    Dbg(string.format("recording round %s: %d players, interval %.2f-%.2f s", roundId, #r.order, mn, select(2, Settings())))
end

local function Weapon(inflictor, attacker)
    local ent = inflictor
    if IsValid(ent) and ent.IsPlayer and ent:IsPlayer() and ent.GetActiveWeapon then ent = ent:GetActiveWeapon() end
    if not IsValid(ent) and IsValid(attacker) and attacker.GetActiveWeapon then ent = attacker:GetActiveWeapon() end
    if not IsValid(ent) or not ent.GetClass then return nil end
    local class = tostring(ent:GetClass()):gsub("[^%w_.%-]", ""):sub(1, 64)
    return class ~= "" and class or nil
end

-- A tracked player died: a final sample is taken so the death position is exact, and the death is
-- recorded with both positions. `vsid` / `asid` are the SteamIDs the stats use (asid is nil for the world).
--
-- `at` ({ x, y, z }) is where the victim died, taken before they became a spectator: by the time the hook this runs from fires
-- (TTT2PostPlayerDeath), `GetPos` is the spectator's, 64 units too high for a standing player (a real round: 278 of 322 deaths).
-- Without it (an older caller) `GetPos` is used as before.
function Track.Death(victim, inflictor, attacker, vsid, asid, at)
    local r = rec
    if not r or #r.deaths >= MAX_DEATHS then return end
    local p = r.players[vsid]
    if not p or not IsValid(victim) then return end

    local now = CurTime()
    if not r.stopped then
        r.deathAt = at
        SampleAll(r, now, vsid)
        r.deathAt = nil
        p.cur = nil
    end
    p.awaiting, p.sawDead = true, false -- a revival is expected from here on
    local d = { victim = vsid, t = math.min(math.max(Floor((now - r.t0) * 1000), 0), 6 * 3600 * 1000) }
    d.vx, d.vy, d.vz = Pos(victim, at)
    if asid and r.players[asid] and IsValid(attacker) then
        d.attacker = asid
        d.ax, d.ay, d.az = Pos(attacker)
    end
    d.weapon = Weapon(inflictor, attacker)
    r.deaths[#r.deaths + 1] = d
end

-- A tracked player came back to life (the respawn event of TTT2). `info` is { by = SteamID64 of the
-- reviver, how = weapon class or "role:<name>", why = reason key }, every field optional.
function Track.Revive(sid, info)
    local r = rec
    if not r or r.stopped then return end
    local p = r.players[sid]
    if not p then return end
    p.awaiting, p.sawDead = false, false
    p.rag, p.lastBody = nil, nil -- a revival removes the body
    local e = { p = sid, k = "revive" }
    if info then e.by, e.how, e.why = info.by, info.how, info.why end
    AddEvent(r, CurTime(), e)
end

-- A tracked player's role or team settled on a new value (RFC 14, 4.1).
function Track.RoleChanged(sid, role, team)
    local r = rec
    if not r or r.stopped or not r.players[sid] then return end
    AddEvent(r, CurTime(), { p = sid, k = "role", role = role, team = team })
end

-- ---- Chat, purchases and bodies found (RFC 26)

-- A chat line as it is kept: control characters are spaces, the ends are trimmed, text that is not valid UTF-8 keeps its ASCII only, and the
-- line is cut at SAY_LEN characters.
local function CleanText(text)
    local s = string.gsub(tostring(text or ""), "[%c\127]", " ")
    s = string.gsub(string.gsub(s, "^%s+", ""), "%s+$", "")
    if utf8 and utf8.len then
        local n = utf8.len(s)
        if not n then s = string.gsub(s, "[\128-\255]", "?"); n = #s end
        if n > SAY_LEN then s = string.sub(s, 1, (utf8.offset(s, SAY_LEN + 1) or (SAY_LEN + 1)) - 1) end
    else
        s = string.sub(string.gsub(s, "[\128-\255]", "?"), 1, SAY_LEN)
    end
    return s
end

-- A tracked player said something, when traitordash_track_chat was on as the round began (it is off by default). `ch` is "all" (everybody), "team" (a team's chat, the traitors' among them) or "dead" (what the dead say to each other).
function Track.Say(ply, text, teamOnly)
    local r = rec
    if not r or r.stopped or not r.chat then return end
    local sid = SidOf(r, ply)
    if not sid then return end
    local line = CleanText(text)
    if line == "" then return end
    local ch = "all"
    local alive = ply.IsTerror and ply:IsTerror()
    if not alive then ch = "dead" elseif teamOnly then ch = "team" end
    AddEvent(r, CurTime(), { p = sid, k = "say", text = line, ch = ch })
end

-- A tracked player bought a weapon or an item in the shop. TTT2 runs the hook under two names, so the same purchase within a second is one.
function Track.Buy(ply, item, isItem)
    local r = rec
    if not r or r.stopped then return end
    local sid = SidOf(r, ply)
    if not sid then return end
    local name = string.sub(string.gsub(tostring(item or ""), "[^%w_.%-]", ""), 1, 64)
    if name == "" then return end
    local p, now = r.players[sid], RoundMs(r, CurTime())
    if p.lastBuy == name and p.lastBuyAt and now - p.lastBuyAt < 1000 then return end
    p.lastBuy, p.lastBuyAt = name, now
    AddEvent(r, CurTime(), { p = sid, k = "buy", item = name, it = isItem and true or nil })
end

-- A tracked player found (searched) the body of a player. `of` is the dead player when they were in the round.
function Track.Found(finder, dead)
    local r = rec
    if not r or r.stopped then return end
    local sid = SidOf(r, finder)
    if not sid then return end
    AddEvent(r, CurTime(), { p = sid, k = "found", of = SidOf(r, dead) })
end

-- ---- Bodies (RFC 24)

-- TTT2 made a ragdoll for a tracked player's death: it is followed from the next tick on (SampleBodies).
function Track.Corpse(rag, ply)
    local r = rec
    if not r or r.stopped or not IsValid(rag) then return end
    local sid = SidOf(r, ply)
    if not sid then return end
    local p = r.players[sid]
    p.rag, p.lastBody = rag, nil
end

-- A tracked player took hold of a body (the magneto stick, or the use key) or let go of it. `ent` is any entity the hook is about: only a ragdoll
-- counts, and `of` is the player it was when the game still knows.
local function BodyHandled(kind, ply, ent)
    local r = rec
    if not r or r.stopped or not IsValid(ent) or ent:GetClass() ~= "prop_ragdoll" then return end
    local sid = SidOf(r, ply)
    if not sid then return end
    local owner = nil
    if CORPSE and CORPSE.GetPlayer then
        local ok, o = pcall(CORPSE.GetPlayer, ent)
        if ok then owner = o end
    end
    AddEvent(r, CurTime(), { p = sid, k = kind, of = SidOf(r, owner) })
end
function Track.Pickup(ply, ent) BodyHandled("pickup", ply, ent) end
function Track.Drop(ply, ent) BodyHandled("drop", ply, ent) end

-- The hooks return nothing, so they can never block or change what they watch.
hook.Add("PlayerSay", "TraitorDash_TrackSay", function(ply, text, teamOnly) pcall(Track.Say, ply, text, teamOnly) end)
hook.Add("TTT2OrderedEquipment", "TraitorDash_TrackBuy", function(ply, item, isItem) pcall(Track.Buy, ply, item, isItem) end)
hook.Add("TTTOrderedEquipment", "TraitorDash_TrackBuyClassic", function(ply, item, isItem) pcall(Track.Buy, ply, item, isItem) end)
hook.Add("TTTOnCorpseCreated", "TraitorDash_TrackCorpse", function(rag, ply) pcall(Track.Corpse, rag, ply) end)
hook.Add("OnPlayerPhysicsPickup", "TraitorDash_TrackPickup", function(ply, ent) pcall(Track.Pickup, ply, ent) end)
hook.Add("OnPlayerPhysicsDrop", "TraitorDash_TrackDrop", function(ply, ent) pcall(Track.Drop, ply, ent) end)
hook.Add("TTTBodyFound", "TraitorDash_TrackFound", function(finder, dead) pcall(Track.Found, finder, dead) end)

-- The round is over: stops the timer, prints the one line, and returns the track to upload (or nil
-- when there is nothing to send). `fingerprint` of the map is added when it is known.
function Track.Finish(roundId)
    local r = rec
    rec = nil
    RemoveTimer()
    if not r or r.id ~= roundId then return nil end

    local avg = r.ticks > 0 and r.costSum / r.ticks or 0
    print(string.format(
        "[TraitorDash:track] round %s: %d ticks (%d samples, %d skipped), interval %.2f-%.2f s, tick cost avg %.3f ms worst %.3f ms, about %d KB%s%s",
        r.id, #r.t, r.samples, r.skipped, r.minUsed == math.huge and 0 or r.minUsed, r.maxUsed, avg * 1000, r.worst * 1000,
        math.floor(EstimateBytes(r) / 1024), r.truncated and ", TRUNCATED" or "", r.degraded and ", DEGRADED" or ""))
    if r.thingList then print(string.format("[TraitorDash:track] props: %d moved, %d keyframes", #r.thingList, r.thingKeys)) end
    if r.partList then print(string.format("[TraitorDash:track] parts: %d, %d keyframes, %d inputs", #r.partList, r.keys, #r.inputs)) end

    local players = {}
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        if #p.segs > 0 then
            local segs = {}
            for i, c in ipairs(p.segs) do segs[i] = { from = c.from, x = c.x, y = c.y, z = c.z, a = c.a, s = c.s } end
            players[#players + 1] = { id = sid, segments = segs }
        end
    end
    if #players == 0 or #r.t == 0 then return nil end

    local fingerprint = nil
    if TraitorDash.MapFingerprint and file.Size then
        local ok, fp = pcall(function()
            local path = "maps/" .. game.GetMap() .. ".bsp"
            local size = file.Size(path, "GAME")
            return size and size > 0 and TraitorDash.MapFingerprint(path, size) or nil
        end)
        if ok then fingerprint = fp end
    end

    return {
        round_id = r.id, map = game.GetMap(), fingerprint = fingerprint,
        truncated = r.truncated, degraded = r.degraded,
        t = r.t, players = players, deaths = r.deaths,
        events = #r.events > 0 and r.events or nil,
        bodies = #r.bodies > 0 and r.bodies or nil,
        parts = PartsOut(r), things = ThingsOut(r), inputs = #r.inputs > 0 and r.inputs or nil,
    }
end

-- Sends a finished track. Called once the backend has accepted the round's stats; a failure is logged and dropped.
function Track.Upload(body)
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    -- Encoding a big track is the one hitch the tracker causes (at the end of the round); its time is printed.
    local t0 = SysTime()
    local json = util.TableToJSON(body)
    if json then print(string.format("[TraitorDash:track] track encoded: %d KB in %.1f ms", math.floor(#json / 1024), (SysTime() - t0) * 1000)) end
    if not json or #json > MAX_BYTES then
        print("[TraitorDash:track] track dropped: " .. (json and (#json .. " bytes is over the 8 MB limit") or "it could not be encoded"))
        return
    end
    local map = game.GetMap()
    HTTP({
        url = cfg.url .. "/api/v1/track",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. cfg.token },
        body = json,
        timeout = 60,
        success = function(code, resp)
            if code == 200 then
                Dbg("track " .. body.round_id .. " accepted: " .. tostring(resp))
            elseif code == 404 then
                noEndpointOn = map
                print("[TraitorDash:track] the backend has no track endpoint (too old?); not trying again on this map")
            else
                print("[TraitorDash:track] track rejected (HTTP " .. tostring(code) .. "): " .. tostring(resp):sub(1, 200))
            end
        end,
        failed = function(err)
            print("[TraitorDash:track] track lost (backend unreachable): " .. tostring(err))
        end,
    })
end

-- A new round is being prepared: whatever was being recorded is dropped.
hook.Add("TTTPrepareRound", "TraitorDash_TrackReset", function()
    rec = nil
    RemoveTimer()
end)

concommand.Add("traitordash_track_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local mn, mx, budget = Settings()
    print(string.format("[TraitorDash:track] enabled=%s interval %.2f-%.2f s budget %.2f ms", tostring(cv_track:GetBool()), mn, mx, budget * 1000))
    if rec then
        print(string.format("[TraitorDash:track] recording %s: %d ticks, interval %.2f s%s", rec.id, #rec.t, rec.interval, rec.stopped and " (stopped)" or ""))
    else
        print("[TraitorDash:track] not recording")
    end
end)
