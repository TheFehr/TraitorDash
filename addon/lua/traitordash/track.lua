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
-- Health (RFC 26, stage B): each sample also holds the player's health `hp` (delta coded like the position; read from `ply:Health()`, no hook), and
-- each player the most health they had, `mh`. Damage to a player of the round is an event `hurt` (PostEntityTakeDamage; see Track.Hurt below).
--
-- Weapons, C4, DNA and traitor buttons (RFC 26, stage C, package C1): events `wpick` and `wdrop` (WeaponEquip, PlayerDroppedWeapon), `c4` (TTT2's event log through
-- TTT2AddedEvent), `dna` (TTTFoundDNA) and `tbtn` (TTTTraitorButtonActivated); see the section after Track.Spawned below. None of them uses a hook that runs before the action.
--
-- Polled state and karma (RFC 26, stage C, package C2): events `hold` (the weapon in hand, polled at the sample), `credits` (a change of credits, polled; the reason
-- from the hooks that run after the change), `karma` (a detour of KARMA.DoKarmaChange, TTT2 only) and `spec` (whom a dead player watches, or which prop they possess, polled, opt-in); see PollState
-- and the karma detour below.
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
local cv_prep = CreateConVar("traitordash_track_prep", "1", {FCVAR_ARCHIVE}, "Also record the preparation before the round starts; the replay shows it before the round's time 0 (1/0; needs traitordash_track).")
local cv_parts = CreateConVar("traitordash_track_parts", "0", {FCVAR_ARCHIVE}, "Also record doors, lifts and other parts that move, and who set them off (1/0; needs traitordash_track).")
local cv_props = CreateConVar("traitordash_track_props", "0", {FCVAR_ARCHIVE}, "Also record props, prop doors and weapons on the floor that move (1/0; needs traitordash_track).")
local cv_chat = CreateConVar("traitordash_track_chat", "0", {FCVAR_ARCHIVE}, "Also record what players write in chat, for the replay (1/0; needs traitordash_track). Everyone who may open a replay can read it.")
local cv_spec = CreateConVar("traitordash_track_spec", "0", {FCVAR_ARCHIVE}, "Also record whom a dead player is watching, for the replay (1/0; needs traitordash_track). Everyone who may open a replay can read it.")
-- Declared only so the dashboard can show and set it (RFC 23); the bridge does nothing with it. The dashboard reads the value the bridge reports and, when it is 1, keeps who spoke on its own voice page and when (RFC 26, 4c.5), never what.
CreateConVar("traitordash_track_voice", "0", {FCVAR_ARCHIVE}, "Let the dashboard record who speaks in its own voice chat, and when, for the replay (1/0; needs traitordash_track). The bridge does not use it; in-game voice is not recorded. Everyone who may open a replay can read it.")
local cv_debug = CreateConVar("traitordash_stats_debug", "1", {FCVAR_ARCHIVE}, "Log what the stats tracker does (1/0).")

local TIMER = "TraitorDash_Track"
local MAX_TICKS_FLOOR, MAX_TICKS_CEILING = 1000, 100000 -- what traitordash_track_max_ticks is kept between (the backend refuses more than the ceiling)
local MAX_SEGMENTS = 64          -- per player
local MAX_DEATHS = 512
-- What happened to players besides moving (RFC 14, 4.3 and RFC 26): each kind has a cap of its own, so a chatty round does not use up the room of the others.
local EVENT_CAP = { revive = 1024, role = 1024, say = 1024, buy = 512, found = 256, pickup = 256, drop = 256, hurt = 2048, heal = 512,
    wpick = 512, wdrop = 512, c4 = 128, dna = 128, tbtn = 256, -- these five: RFC 26, stage C, package C1
    hold = 1024, credits = 512, karma = 512, spec = 512, -- these four: package C2
    shots = 1536 } -- package C3
-- Shots (RFC 26, 4c, C3): a shot is one call of FireBullets by a player's weapon (never a pellet). One `shots` event holds the shots of one player and one
-- weapon within MERGE_MS of the first of them. The hook runs for every bullet of the server, so it has a safety valve: a round that makes it run more
-- than CALLS times, or in which the timed calls (one in SAMPLE, from MIN_SAMPLES of them) add up to more than COST seconds, stops recording shots.
local SHOT = { MERGE_MS = 1000, N_MAX = 10000, CALLS = 200000, SAMPLE = 64, MIN_SAMPLES = 32, COST = 1.0 }
local HP_MAX = 1000             -- the most health a sample or an event holds (TTT2 roles can have more than 100); more is cut, less than 0 is 0 (RFC 26, 4a)
local HURT_MERGE_MS = 50        -- damage to the same victim, from the same attacker with the same cause, within this is one event (pellets, a blast)
local HURT_W_LEN = 40
local HEAL_MERGE_MS = 1000          -- health gained by the same player from the same source (and healer) within this of the last of it is one event (a health station gives 1 hp every 0.2 s)
local HEAL_GRACE_MS = 1000          -- after a player spawned or was revived, and after the round began, a rise of health is the game setting it up, not a heal (RFC 26, 4b)
local SAY_LEN = 200             -- characters of a chat line that are kept
local TBTN_LEN = 40             -- characters of a traitor button's description that are kept (RFC 26, 4c)
local WEAPON_GRACE_MS = 1000    -- after a player spawned, got a new role, and after the round began, weapons given are loadout, not pickups (RFC 26, 4c)
local TBTN_MERGE_MS = 1000      -- the same player on the same traitor button within this is one event
local C4_RANGE = 256            -- units: the game's own range for defusing a charge, used to tell which charge was defused
local HOLD_MERGE_MS = 300           -- a change of the weapon in hand within this of the player's last `hold` replaces it (quick switching is one change)
local SPEC_MODEL_LEN = 40          -- characters of a possessed prop's model name that are kept (RFC 26, 4c.x)
local SPEC_MERGE_MS = 500           -- the same for the target of a dead player (cycling with the mouse)
local CREDIT_GRACE_MS = 1000        -- after the round began and after a spawn, a change of credits is the game setting them up, not a gain or a spend
local CREDIT_TAG_MS = 1500          -- a hook's note about why a player's credits changed is used for a change seen within this of it (or since the last poll, when that is longer)
local CREDIT_MERGE_MS = 1000        -- changes of one player's credits in the same direction for the same reason within this of the last are one event
local CREDITS_MAX = 255             -- the game sends credits as UInt(8)
local KARMA_MAX = 1000              -- the most a `karma` event's change or karma-after holds (the server's maximum may be higher: cut)
local KARMA_MERGE_MS = 1000         -- karma changes of the same player for the same reason within this of the last are one event (a shotgun at a teammate)
local POS_MAX = 4096            -- the backend's limit for a position in units / 8; a place beyond it is left out
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
local PREP_MAX = 300             -- seconds a preparation may be recorded without the round starting; then it is dropped
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

-- ---- The heal detour (RFC 26, 4b)
-- The game has no hook for a rise of health. TTT2's health station fires TTTPlayerUsedHealthStation, but BEFORE it sets the health (and a hook may
-- cancel it), while the TTT base fires it after; and a medic's knife or a role's regeneration sets the health with no hook at all. So while a round
-- is recorded, `SetHealth` of the Player metatable is replaced by a wrapper that calls the original with every argument and returns what it
-- returns, and only looks at what changed (Track.HealBefore and Track.Healed, under pcall). It is put back when the recording ends. The state
-- lives in TraitorDash so that a reload of this file finds the wrapper it left and neither wraps twice nor leaves a second one recording.
local HEAL_KEY = "TrackSetHealth"

local function MakeSetHealth(st)
    local orig = st.orig
    -- runs after the original: records under pcall and hands on what the original returned
    local function finish(T, ply, before, caller, ...)
        pcall(T.Healed, ply, before, caller)
        return ...
    end
    return function(self, ...)
        if not st.on then return orig(self, ...) end
        local T = TraitorDash.Track
        local ok, before = pcall(T.HealBefore, self, (...))
        if not ok or not before then return orig(self, ...) end
        -- Who is calling (levels count from this function, so this is not in a helper and not under pcall): the file, and the object the method is
        -- called on (`self` of a weapon's PrimaryAttack or of the health station's GiveHealth). Both are only read; getinfo and getlocal with a level
        -- that exists cannot raise an error, and a level that does not exist gives nil.
        local src, ent
        local dbg = debug
        if type(dbg) == "table" and dbg.getinfo then
            local info = dbg.getinfo(2, "S")
            if info then
                src = info.short_src
                if dbg.getlocal then
                    local name, value = dbg.getlocal(2, 1)
                    if name == "self" then ent = value end
                end
            end
        end
        return finish(T, self, before, { src = src, ent = ent }, orig(self, ...))
    end
end

local function RemoveHeal()
    local st = TraitorDash[HEAL_KEY]
    if not st then return end
    st.on = false
    if st.meta.SetHealth == st.wrapper then
        st.meta.SetHealth = st.had -- nil when the Player metatable only inherited it: the inheritance is back
        TraitorDash[HEAL_KEY] = nil
    end
    -- else somebody else wrapped SetHealth after us: our wrapper stays in their chain, switched off, and passes everything through
end

local function InstallHeal()
    if not FindMetaTable then return end
    local ok, meta = pcall(FindMetaTable, "Player")
    if not ok or type(meta) ~= "table" then return end
    local st = TraitorDash[HEAL_KEY]
    if st and st.meta == meta and meta.SetHealth == st.wrapper then st.on = true return end -- already in place (a reload of this file)
    if st then st.on = false end
    local cur = meta.SetHealth
    if type(cur) ~= "function" then return end
    st = { meta = meta, orig = cur, had = rawget(meta, "SetHealth"), on = true }
    st.wrapper = MakeSetHealth(st)
    meta.SetHealth = st.wrapper
    TraitorDash[HEAL_KEY] = st
end

-- ---- The karma detour (RFC 26, 4c, package C2)
-- TTT2 changes karma in one place, KARMA.DoKarmaChange(ply, amount, reason) (sv_karma.lua), after the hook TTTKarmaGivePenalty, which runs BEFORE and may cancel it
-- and is therefore not used. Like SetHealth above, the function is replaced by a wrapper while a round is recorded: the original runs first with every argument and
-- its results are handed on; what was done is looked at afterwards, under pcall (Track.Karma). It is put back when the recording ends; the state lives in
-- TraitorDash so that a reload of this file neither wraps twice nor leaves a second one recording. The TTT base has no such function: nothing is recorded there.
local KARMA_KEY = "TrackKarma"

local function MakeKarma(st)
    local orig = st.orig
    local function finish(T, ply, amount, reason, ...)
        pcall(T.Karma, ply, amount, reason)
        return ...
    end
    return function(ply, amount, reason, ...)
        if not st.on then return orig(ply, amount, reason, ...) end
        return finish(TraitorDash.Track, ply, amount, reason, orig(ply, amount, reason, ...))
    end
end

local function RemoveKarma()
    local st = TraitorDash[KARMA_KEY]
    if not st then return end
    st.on = false
    if st.tbl.DoKarmaChange == st.wrapper then
        st.tbl.DoKarmaChange = st.had -- nil when the table only inherited it
        TraitorDash[KARMA_KEY] = nil
    end
    -- else somebody else wrapped it after us: our wrapper stays in their chain, switched off, and passes everything through
end

local function InstallKarma()
    local tbl = KARMA
    if type(tbl) ~= "table" then return end
    local st = TraitorDash[KARMA_KEY]
    if st and st.tbl == tbl and tbl.DoKarmaChange == st.wrapper then st.on = true return end -- already in place (a reload of this file)
    if st then st.on = false end
    local cur = tbl.DoKarmaChange
    if type(cur) ~= "function" then return end
    st = { tbl = tbl, orig = cur, had = rawget(tbl, "DoKarmaChange"), on = true }
    st.wrapper = MakeKarma(st)
    tbl.DoKarmaChange = st.wrapper
    TraitorDash[KARMA_KEY] = st
end

local HOOK_ID = "TraitorDash_TrackParts"

-- The timer and, with it, the two hooks of the parts (RFC 20, 4.4): both go when a recording ends for any reason.
local function RemoveTimer()
    RemoveHeal()
    RemoveKarma()
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

-- A player's health as a whole number from 0 to HP_MAX, or nil when the game cannot say.
local function ReadHealth(ply)
    local ok, v = pcall(ply.Health, ply)
    if not ok or type(v) ~= "number" or v ~= v then return nil end
    return math.min(math.max(Floor(v), 0), HP_MAX)
end

-- A player's most health (the scale of the bar), once for each player of a round: 1 to HP_MAX, or false.
local function ReadMaxHealth(ply)
    local ok, v = pcall(ply.GetMaxHealth, ply)
    if not ok or type(v) ~= "number" or v ~= v or v < 1 then return false end
    return math.min(Floor(v), HP_MAX)
end

-- The view pitch (RFC 39, 3.1): quarter degrees from -360 to 360, positive looking down as in `Angle.p`, read with the yaw from `EyeAngles()`; nil when it cannot be read.
local PITCH_MAX = 360
local function ReadPitch(ply)
    local ok, a = pcall(ply.EyeAngles, ply)
    if not ok or a == nil then return nil end
    local ok2, v = pcall(function() return a.p end)
    if not ok2 or type(v) ~= "number" or v ~= v then return nil end
    v = Floor(v * 4) -- Floor rounds
    return math.min(math.max(v, -PITCH_MAX), PITCH_MAX)
end

-- The eye height above the feet, standing and crouching (RFC 39, 3.2): once for each player of a round, whole units from 1 to 128, or nil for one that cannot be read
-- (the replay then uses 64 and 28). TTT2 roles and addons can change both.
local function ReadEye(ply, ducked)
    local fn = ducked and ply.GetViewOffsetDucked or ply.GetViewOffset
    if not fn then return nil end
    local ok, v = pcall(fn, ply)
    if not ok or v == nil then return nil end
    local ok2, z = pcall(function() return v.z end)
    if not ok2 or type(z) ~= "number" or z ~= z or z < 1 then return nil end
    return math.min(Floor(z), 128)
end

local function Push(r, p, idx, x, y, z, a, st, hp, ap)
    local c = p.cur
    if not c then
        if #p.segs >= MAX_SEGMENTS then return end
        c = { from = idx - 1, x = {}, y = {}, z = {}, a = {}, s = {}, hp = {}, ap = {}, lx = 0, ly = 0, lz = 0, la = 0, lh = 0, lp = 0 }
        p.cur = c
        p.segs[#p.segs + 1] = c
    end
    local n = #c.x + 1
    c.x[n], c.y[n], c.z[n], c.a[n] = x - c.lx, y - c.ly, z - c.lz, a - c.la
    c.s[n] = st or 0
    if hp then -- health, delta coded like the position (RFC 26, 4a); a sample whose health could not be read leaves the whole segment without it
        c.hp[n] = hp - c.lh
        c.lh = hp
    else
        c.hpBad = true
    end
    if ap then -- the view pitch (RFC 39, 3.1), delta coded; a sample without it leaves the whole segment without it
        c.ap[n] = ap - c.lp
        c.lp = ap
    else
        c.apBad = true
    end
    c.lx, c.ly, c.lz, c.la = x, y, z, a
    r.samples = r.samples + 1
end

-- One sample of every tracked player at one tick. `also` is the SteamID of a player to sample even
-- though they are no longer alive (the death hook: the death position is exact).
-- Milliseconds since the round began, as the backend wants them (0 to six hours).
local function RoundMs(r, now)
    return math.min(math.max(Floor((now - r.t0) * 1000), 0), 6 * 3600 * 1000)
end

-- Adds an event (RFC 14, 4.3, RFC 26); beyond the cap of its kind the track is marked truncated instead. Returns the event, or nil at the cap.
local function AddEvent(r, now, e)
    local n = (r.kinds[e.k] or 0) + 1
    if n > (EVENT_CAP[e.k] or 0) then r.truncated = true return nil end
    r.kinds[e.k] = n
    e.t = RoundMs(r, now)
    r.events[#r.events + 1] = e
    return e
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

local function AddPlayer(r, sid, ply)
    if r.players[sid] then r.players[sid].ply = ply r.shotMap = {} return end
    if #r.order >= 128 then return end
    r.order[#r.order + 1] = sid
    r.players[sid] = { ply = ply, segs = {} }
    r.shotMap = {} -- the shots hook's lookup by entity index is made again
end

-- During the preparation the round has no players yet (they are chosen when it begins), so everybody who takes part now is recorded, and a
-- player who comes in later is added: the same ids as the round report (TraitorDash.PlayerId).
local function AddPrepPlayers(r)
    local id = TraitorDash.PlayerId
    if not id then return end
    for _, ply in ipairs(player.GetAll()) do
        if IsValid(ply) and ply:IsTerror() then
            local sid = id(ply)
            if sid then AddPlayer(r, sid, ply) end
        end
    end
end

local PollState -- defined with the events of package C2 below: the weapon, credits and spectator target polled at each sample

local function SampleAll(r, now, also)
    if r.prep then AddPrepPlayers(r) end
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
                p.spawnAt = RoundMs(r, now)
                AddEvent(r, now, { p = sid, k = "revive" })
            end
            local x, y, z, a = Pos(ply, sid == also and r.deathAt or nil)
            local hp = ReadHealth(ply)
            if p.mh == nil then p.mh = ReadMaxHealth(ply) end
            if hp and hp > 0 then p.hpPrev = hp end
            if p.eh == nil then p.eh = ReadEye(ply, false) or false; p.ed = ReadEye(ply, true) or false end
            Push(r, p, idx, x, y, z, a, State(ply), hp, ReadPitch(ply))
        else
            p.cur = nil -- not alive now: the segment ends here (a revived player starts a new one)
            if p.awaiting then p.sawDead = true end
        end
    end
    SampleBodies(r, now)
    if not r.pollOff and PollState then
        local ok, err = pcall(PollState, r, now)
        if not ok then
            r.pollOff = true
            print("[TraitorDash:track] polling the weapons, credits and targets failed, they are left out: " .. tostring(err))
        end
    end
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
    if r.prep and CurTime() - r.t0 > PREP_MAX then
        rec = nil
        RemoveTimer()
        Dbg("the round did not start within " .. PREP_MAX .. " s of the preparation; recording dropped")
        return
    end

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

local function NewRecording(roundId)
    local mn = Settings()
    return {
        id = roundId, t0 = CurTime(), lastMs = 0, t = {}, order = {}, players = {}, deaths = {}, events = {}, wm = {}, wmCount = 0,
        samples = 0, ticks = 0, skipped = 0, interval = mn, minUsed = math.huge, maxUsed = 0,
        ring = {}, costSum = 0, worst = 0, truncated = false, degraded = false, stopped = false,
        keys = 0, inputs = {}, bodies = {}, kinds = {}, chat = cv_chat:GetBool(), spec = cv_spec:GetBool(), begin = 0,
        shotCalls = 0, shotCost = 0, shotSamples = 0, shotMap = {}, shotsOff = false,
    }
end

-- The preparation starts (TTTPrepareRound): recording begins now, so the replay can show the players before the round (RFC 12, 3.7). The round's
-- start is noted when it begins (Track.Begin); the replay counts its time from there and shows the preparation as negative time.
function Track.Prepare()
    rec = nil
    RemoveTimer()
    if not cv_track:GetBool() or not cv_prep:GetBool() then return end
    if noEndpointOn == game.GetMap() then return end
    if TraitorDash.StatsOn and not TraitorDash.StatsOn() then return end -- no round will be reported, so nothing would adopt this recording
    local r = NewRecording(nil)
    r.prep = true
    rec = r
    AddPrepPlayers(r)
    SampleAll(r, r.t0)
    timer.Create(TIMER, r.interval, 0, SafeTick)
    Dbg("recording the preparation")
end

-- The round begins. `players` is a list of { sid = SteamID64 (or the bot's test id), ply = the player }.
function Track.Begin(roundId, players)
    local prep = rec
    if prep and prep.prep and not prep.stopped and cv_track:GetBool() then
        -- the preparation was recorded: it becomes the start of this round's track, and the round starts now
        local r = prep
        r.id, r.prep, r.chat, r.spec = roundId, false, cv_chat:GetBool(), cv_spec:GetBool()
        r.begin = RoundMs(r, CurTime())
        r.members = {}
        for _, e in ipairs(players) do
            r.members[e.sid] = true
            AddPlayer(r, e.sid, e.ply)
        end
        if cv_parts:GetBool() then StartParts(r) end
        if cv_props:GetBool() then StartThings(r) end
        InstallHeal() -- from here on a rise of health is looked at (not in the preparation)
        InstallKarma()
        if RoundMs(r, CurTime()) > r.lastMs then
            SampleAll(r, CurTime()) -- where everybody stands at the start
        else -- a tick just took them: only the parts and props that were started now are looked at, in that tick
            local tick = #r.t - 1
            if r.partList then pcall(SampleParts, r, tick) end
            if r.candList then pcall(SampleThings, r, tick) end
            if PollState then pcall(PollState, r, CurTime()) end -- what everybody holds and has at the start
        end
        Dbg(string.format("recording round %s: %d players, the preparation before it %.1f s", roundId, #r.order, r.begin / 1000))
        return
    end
    rec = nil
    RemoveTimer()
    if not cv_track:GetBool() then return end
    if noEndpointOn == game.GetMap() then return end

    local mn = Settings()
    local r = NewRecording(roundId)
    for _, e in ipairs(players) do AddPlayer(r, e.sid, e.ply) end
    rec = r
    if cv_parts:GetBool() then StartParts(r) end
    if cv_props:GetBool() then StartThings(r) end
    InstallHeal()
    InstallKarma()
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
    p.spawnAt = RoundMs(r, CurTime())
    p.rag, p.lastBody = nil, nil -- a revival removes the body
    local e = { p = sid, k = "revive" }
    if info then e.by, e.how, e.why = info.by, info.how, info.why end
    AddEvent(r, CurTime(), e)
end

-- A tracked player's role or team settled on a new value (RFC 14, 4.1).
function Track.RoleChanged(sid, role, team)
    local r = rec
    if not r or r.stopped or not r.players[sid] then return end
    r.players[sid].roleAt = RoundMs(r, CurTime()) -- weapons that come with a new role are not pickups (RFC 26, 4c)
    AddEvent(r, CurTime(), { p = sid, k = "role", role = role, team = team })
end

-- ---- Chat, purchases and bodies found (RFC 26)

-- A chat line as it is kept: control characters are spaces, the ends are trimmed, text that is not valid UTF-8 keeps its ASCII only, and the
-- line is cut at SAY_LEN characters.
local function CleanText(text, limit)
    limit = limit or SAY_LEN
    local s = string.gsub(tostring(text or ""), "[%c\127]", " ")
    s = string.gsub(string.gsub(s, "^%s+", ""), "%s+$", "")
    if utf8 and utf8.len then
        local n = utf8.len(s)
        if not n then s = string.gsub(s, "[\128-\255]", "?"); n = #s end
        if n > limit then s = string.sub(s, 1, (utf8.offset(s, limit + 1) or (limit + 1)) - 1) end
    else
        s = string.sub(string.gsub(s, "[\128-\255]", "?"), 1, limit)
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
    Track.CreditTag(ply, "buy") -- what it cost shows at the next poll of the credits (package C2)
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

-- ---- Damage (RFC 26, 4a)

-- The damage types that are named when no weapon or entity did it (falling, drowning, fire, ...), in the order they are tried.
local DMG_NAMES = {
    { "DMG_FALL", "fall" }, { "DMG_DROWN", "drown" }, { "DMG_BURN", "fire" }, { "DMG_BLAST", "explosion" }, { "DMG_CRUSH", "crush" },
    { "DMG_POISON", "poison" }, { "DMG_RADIATION", "radiation" }, { "DMG_SHOCK", "shock" }, { "DMG_ACID", "acid" },
}

local function CauseOfType(info)
    if info.GetDamageType and bit and bit.band then
        local ok, ty = pcall(info.GetDamageType, info)
        if ok and type(ty) == "number" then
            for _, e in ipairs(DMG_NAMES) do
                local flag = _G[e[1]]
                if flag and bit.band(ty, flag) ~= 0 then return e[2] end
            end
        end
    end
    return "world"
end

-- What did the damage: the class of the weapon the attacker holds (the inflictor of a bullet is the player), or of the entity that did it (a prop,
-- an explosive), or the name of the damage type for falling, drowning, fire and the rest. A short word of letters, digits, _ . and -.
local function HurtCause(info, attacker)
    local class = Weapon(info:GetInflictor(), attacker)
    if class and class ~= "worldspawn" then
        class = string.sub(class, 1, HURT_W_LEN)
        if class ~= "" then return class end
    end
    return CauseOfType(info)
end

-- A tracked player took damage (PostEntityTakeDamage: after it was applied, `took` says whether any was). One event for all the damage to the
-- same victim from the same attacker with the same cause within HURT_MERGE_MS (the pellets of a shotgun, the hits of a blast).
function Track.Hurt(ent, info, took)
    local r = rec
    if not r or r.stopped or r.prep or not took or not info then return end
    if not IsValid(ent) or not ent.IsPlayer or not ent:IsPlayer() then return end
    local vsid = SidOf(r, ent)
    if not vsid then return end
    if r.members and not r.members[vsid] then return end
    local dmg = info:GetDamage()
    if type(dmg) ~= "number" or dmg ~= dmg or dmg < 0.5 then return end
    local h = ReadHealth(ent)
    if not h then return end
    local p = r.players[vsid]
    local d = math.min(math.max(Floor(dmg), 1), 10000)
    if h == 0 and p.hpPrev and d > p.hpPrev then d = math.max(p.hpPrev, 1) end -- the blow that killed: no more than what was left
    if h > 0 then p.hpPrev = h end

    local attacker = info:GetAttacker()
    local asid = nil
    if IsValid(attacker) and attacker ~= ent and attacker.IsPlayer and attacker:IsPlayer() then
        asid = SidOf(r, attacker)
        if asid and r.members and not r.members[asid] then asid = nil end
    end
    local w = HurtCause(info, attacker)
    local now = RoundMs(r, CurTime())
    local slot = asid or "-"
    local byA = p.hurtLast
    if not byA then byA = {} p.hurtLast = byA end
    local byW = byA[slot]
    if not byW then byW = {} byA[slot] = byW end
    local last = byW[w]
    if last and now - last.at <= HURT_MERGE_MS then
        last.ev.d = math.min(last.ev.d + d, 10000)
        last.ev.h = h
        last.at = now
        return
    end
    local ev = AddEvent(r, CurTime(), { p = vsid, k = "hurt", a = asid, w = w, d = d, h = h })
    if ev then byW[w] = { ev = ev, at = now } end
end

-- ---- Health gained (RFC 26, 4b)

-- A short word for where a file is from, from the path of the function that called SetHealth (debug.getinfo's short_src): the weapon's or the
-- entity's folder or file, a role's folder, an addon's folder, else the file's own name. Letters, digits, _ . and -, at most HURT_W_LEN, or nil.
local function SourceOfPath(path)
    if type(path) ~= "string" then return nil end
    local p = string.gsub(path, "\\", "/")
    if string.sub(p, 1, 1) == "[" then return nil end -- "[C]" or [string "..."]: not a file
    local name = string.match(p, "/weapons/([^/]+)") or string.match(p, "/entities/entities/([^/]+)")
    if not name then
        local e = string.match(p, "/entities/([^/]+)")
        if e and e ~= "roles" and e ~= "weapons" and e ~= "effects" then name = e end
    end
    if not name then
        local role = string.match(p, "/roles/([^/]+)")
        if role then name = "role_" .. role end
    end
    name = name or string.match(p, "^addons/([^/]+)/") or string.match(p, "([^/]+)$")
    if not name then return nil end
    name = string.gsub(name, "%.lua$", "")
    name = string.sub(string.gsub(name, "[^%w_.%-]", ""), 1, HURT_W_LEN)
    if name == "" or name == "shared" or name == "init" then return nil end
    return name
end
Track.SourceOfPath = SourceOfPath

-- What gave the health, and who (a player of the round) gave it. In order: the object the calling method belongs to when it is an entity that is
-- not a player (the health station's GiveHealth, a weapon's PrimaryAttack): its class, and for a weapon its owner as the healer; else the calling
-- file; else "other". A file or class with "regen" in its name is "regen".
local function HealSource(r, ply, caller)
    local w, healer = nil, nil
    local ent = caller and caller.ent
    if ent ~= nil and ent ~= ply and IsValid(ent) and ent.GetClass and not (ent.IsPlayer and ent:IsPlayer()) then
        local okc, class = pcall(ent.GetClass, ent)
        if okc and type(class) == "string" then
            w = string.sub(string.gsub(class, "[^%w_.%-]", ""), 1, HURT_W_LEN)
            if w == "" then w = nil end
        end
        if w and ent.IsWeapon and ent.GetOwner then
            local oko, owner = pcall(function() return ent:IsWeapon() and ent:GetOwner() or nil end)
            if oko and owner ~= nil and IsValid(owner) and owner.IsPlayer and owner:IsPlayer() then
                local sid = SidOf(r, owner)
                if sid and (not r.members or r.members[sid]) then healer = sid end
            end
        end
    end
    if not w and caller then w = SourceOfPath(caller.src) end
    if w and string.find(string.lower(w), "regen", 1, true) then w = "regen" end
    return w or "other", healer
end

-- The first half, before the game's own SetHealth runs: is this a rise of a living round player's health that is worth looking at? Returns the health
-- before, or nil. It must be cheap (every SetHealth of the game comes through it while a round is recorded) and never raises (the caller has pcall).
function Track.HealBefore(ply, new)
    local r = rec
    if not r or r.stopped or r.prep or type(new) ~= "number" then return nil end
    if not IsValid(ply) or not ply.IsPlayer or not ply:IsPlayer() then return nil end
    local before = ReadHealth(ply)
    if not before or before < 1 or new <= before then return nil end -- a decrease, no change, or a dead player (a revival sets the health of a dead one)
    if not ply:IsTerror() then return nil end
    if not SidOf(r, ply) then return nil end
    return before
end

-- The second half, after SetHealth ran: the health gained is what the game says now minus what it said before. Merged within HEAL_MERGE_MS.
function Track.Healed(ply, before, caller)
    local r = rec
    if not r or r.stopped or r.prep or type(before) ~= "number" then return end
    local sid = SidOf(r, ply)
    if not sid then return end
    if r.members and not r.members[sid] then return end
    local after = ReadHealth(ply)
    if not after or after <= before then return end
    local p = r.players[sid]
    local now = RoundMs(r, CurTime())
    p.hpPrev = after
    if now - r.begin < HEAL_GRACE_MS or (p.spawnAt and now - p.spawnAt < HEAL_GRACE_MS) then return end -- the round setting itself up, or a spawn or a revival
    local w, healer = HealSource(r, ply, caller)
    local d = after - before
    local slot = healer or "-"
    local byA = p.healLast
    if not byA then byA = {} p.healLast = byA end
    local byW = byA[slot]
    if not byW then byW = {} byA[slot] = byW end
    local last = byW[w]
    if last and now - last.at <= HEAL_MERGE_MS then
        last.ev.d = math.min(last.ev.d + d, 10000)
        last.ev.h = after
        last.at = now
        return
    end
    local ev = AddEvent(r, CurTime(), { p = sid, k = "heal", a = healer, w = w, d = d, h = after })
    if ev then byW[w] = { ev = ev, at = now } end
end

-- A player of the round spawned (PlayerSpawn: a respawn, a revival): what the game does to their health in the next moment is not a heal.
function Track.Spawned(ply)
    local r = rec
    if not r or r.stopped then return end
    local sid = SidOf(r, ply)
    if sid then r.players[sid].spawnAt = RoundMs(r, CurTime()) end
end

-- ---- Weapons, C4, DNA and traitor buttons (RFC 26, stage C, package C1)

-- A class or name as one safe word: letters, digits, _ . and -, at most HURT_W_LEN; nil when nothing is left.
local function Word(v)
    if type(v) ~= "string" then return nil end
    local w = string.sub(string.gsub(v, "[^%w_.%-]", ""), 1, HURT_W_LEN)
    return w ~= "" and w or nil
end

local function ClassOf(ent)
    if not IsValid(ent) or not ent.GetClass then return nil end
    local ok, class = pcall(ent.GetClass, ent)
    return ok and Word(class) or nil
end

-- Is `sid` a player of this round (and not only of the preparation)?
local function Member(r, sid)
    return sid ~= nil and r.players[sid] ~= nil and (r.members == nil or r.members[sid] == true)
end

-- The round player behind an entity that the game's hook named, or nil.
local function RoundPlayer(r, ply)
    if not IsValid(ply) or not ply.IsPlayer or not ply:IsPlayer() then return nil end
    local sid = SidOf(r, ply)
    if sid and Member(r, sid) then return sid end
    return nil
end

-- The place of an entity in units / 8 as the backend wants it, or nil when it cannot be read or is beyond the map.
local function PlaceOf(ent)
    if not IsValid(ent) or not ent.GetPos then return nil end
    local ok, pos = pcall(ent.GetPos, ent)
    if not ok or type(pos) ~= "table" then return nil end
    local x, y, z = pos.x, pos.y, pos.z
    if type(x) ~= "number" or type(y) ~= "number" or type(z) ~= "number" or x ~= x or y ~= y or z ~= z then return nil end
    x, y, z = Floor(x / 8), Floor(y / 8), Floor(z / 8)
    if math.abs(x) > POS_MAX or math.abs(y) > POS_MAX or math.abs(z) > POS_MAX then return nil end
    return x, y, z
end

-- A weapon the game gave to a player of the round, in a quiet moment: not in the preparation, not within WEAPON_GRACE_MS of the round's start, of a spawn, of a
-- revival or of a role change (loadouts and the weapons of a role), and only while the player is alive. Returns the player's id, or nil.
local function WeaponMoment(r, ply)
    if r.prep then return nil end
    local sid = RoundPlayer(r, ply)
    if not sid then return nil end
    if not ply.IsTerror or not ply:IsTerror() then return nil end
    local now = RoundMs(r, CurTime())
    local p = r.players[sid]
    if now - r.begin < WEAPON_GRACE_MS or (p.spawnAt and now - p.spawnAt < WEAPON_GRACE_MS) or (p.roleAt and now - p.roleAt < WEAPON_GRACE_MS) then return nil end
    return sid
end

-- GM:WeaponEquip(wep, ply) of TTT2: runs as a weapon is picked up (its owner is still NULL then, so the player is the second argument). A weapon with no
-- `Kind` is one the game removes at once. The TTT base calls it with the weapon only: there is no player then, and nothing is recorded.
function Track.WeaponPicked(wep, ply)
    local r = rec
    if not r or r.stopped then return end
    local sid = WeaponMoment(r, ply)
    if not sid or not IsValid(wep) or wep.Kind == nil then return end
    local class = ClassOf(wep)
    if class then AddEvent(r, CurTime(), { p = sid, k = "wpick", w = class }) end
end

-- GM:PlayerDroppedWeapon(ply, wep) of TTT2. A drop because the player died is not recorded (`IsDroppedBecauseDeath` is set while the hook runs, which the
-- first real round has to confirm; a player who is not alive counts as a death drop anyway).
function Track.WeaponDropped(ply, wep)
    local r = rec
    if not r or r.stopped then return end
    local sid = WeaponMoment(r, ply)
    if not sid or not IsValid(wep) or wep.IsDroppedBecauseDeath then return end
    local class = ClassOf(wep)
    if class then AddEvent(r, CurTime(), { p = sid, k = "wdrop", w = class }) end
end

-- The player of the round that TTT2's event log names by SteamID64 or, for a bot, by nick (as stats.lua does), or nil.
local function PlayerByIdentity(r, sid64, nick)
    for _, sid in ipairs(r.order) do
        local ply = r.players[sid].ply
        if Member(r, sid) and IsValid(ply) then
            if sid64 ~= nil and sid64 ~= "" then
                local ok, id = pcall(ply.SteamID64, ply)
                if sid == tostring(sid64) or (ok and id ~= nil and tostring(id) == tostring(sid64)) then return sid end
            end
            if nick ~= nil and ply.IsBot and ply:IsBot() and ply.Nick and ply:Nick() == nick then return sid end
        end
    end
    return nil
end

-- ent:Method() under pcall: the value, or nil when the method is not there or raises an error.
local function Call(ent, method)
    local ok, v = pcall(function() return ent[method](ent) end)
    if ok then return v end
    return nil
end

-- The charge that was just armed by `ply`: a valid ttt_c4, armed, thrown (or originated) by them, with the newest arm time. nil when the game cannot say.
local function ArmedCharge(ply)
    local best, bestAt
    for _, ent in ipairs(ents.FindByClass("ttt_c4")) do
        if IsValid(ent) and Call(ent, "GetArmed") then
            local who, orig = Call(ent, "GetThrower"), Call(ent, "GetOriginator")
            if who == ply or orig == ply then
                local at = Call(ent, "GetArmTime")
                at = type(at) == "number" and at or 0
                if not best or at > bestAt then best, bestAt = ent, at end
            end
        end
    end
    return best
end

local function Distance(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

-- The charge a defuse, a failed defuse or an explosion was about, among those that were seen being armed: the ones of that owner (when the owner is known)
-- that still exist. A defuse takes the nearest to the disarmer within the game's range of 256 units; an explosion the one whose explode time is 0 (the
-- game removes the charge right after the event). Several candidates and no way to tell: nil, and the place is left out.
local function KeptCharge(r, owner, near, exploded)
    local pick, count = nil, 0
    local bestD
    for _, c in ipairs(r.c4) do
        if IsValid(c.ent) and (owner == nil or c.owner == owner) then
            if exploded then
                local t = Call(c.ent, "GetExplodeTime")
                if t == nil or (type(t) == "number" and t <= 0) then -- an entity that cannot be asked counts only when it is the only one
                    count = count + 1
                    pick = c
                end
            elseif near then
                local ok, pos = pcall(c.ent.GetPos, c.ent)
                if ok and type(pos) == "table" then
                    local okd, d = pcall(Distance, pos, near)
                    if okd and d <= C4_RANGE and (not bestD or d < bestD) then bestD, pick, count = d, c, 1 end
                end
            else
                count = count + 1
                pick = c
            end
        end
    end
    if count ~= 1 then return nil end
    return pick
end

local function ForgetCharge(r, charge)
    for i, c in ipairs(r.c4) do
        if c == charge then table.remove(r.c4, i) return end
    end
end

local function PosOf(ply)
    if not IsValid(ply) or not ply.GetPos then return nil end
    local ok, pos = pcall(ply.GetPos, ply)
    if ok and type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" and type(pos.z) == "number" then return pos end
    return nil
end

-- TTT2's own event log, after the action: `TTT2AddedEvent(name, event)` runs once the event was made (lua/ttt2/libraries/events.lua). The names are the
-- lower-case strings the EVENT_ constants hold. Of the three C4 events the arming, the defusing (`successful` true, or a wrong wire: false) and the
-- explosion are recorded; the hooks TTTC4Arm and the like run BEFORE the action and may cancel it, so they are not used. The event holds no entity and no
-- place; the charge is found as KeptCharge says.
function Track.AddedEvent(name, event)
    local r = rec
    if not r or r.stopped or r.prep then return end
    if name ~= "c4plant" and name ~= "c4disarm" and name ~= "c4explode" then return end
    local data = type(event) == "table" and event.event
    if type(data) ~= "table" then return end
    r.c4 = r.c4 or {}
    if name == "c4plant" then
        local sid = PlayerByIdentity(r, data.sid64, data.nick)
        if not sid then return end
        local ev = { p = sid, k = "c4", st = "plant" }
        local ent = ArmedCharge(r.players[sid].ply)
        local kept = nil
        if ent then
            local x, y, z = PlaceOf(ent)
            if x then
                ev.x, ev.y, ev.z = x, y, z
                local idx = Call(ent, "EntIndex")
                for i = #r.c4, 1, -1 do
                    if r.c4[i].ent == ent or (idx ~= nil and r.c4[i].idx == idx) then table.remove(r.c4, i) end
                end
                kept = { ent = ent, idx = idx, owner = sid }
                local timerS = Call(ent, "GetDetonateTimer")
                if type(timerS) == "number" and timerS == timerS then
                    timerS = Floor(timerS)
                    if timerS >= 1 and timerS <= 3600 then ev.s = timerS end
                end
            end
        end
        if AddEvent(r, CurTime(), ev) and kept then r.c4[#r.c4 + 1] = kept end -- at the cap the charge is not followed
    elseif name == "c4disarm" then
        local who, owner = data.disarmer, data.owner
        if type(who) ~= "table" then return end
        local sid = PlayerByIdentity(r, who.sid64, who.nick)
        if not sid then return end
        local ofSid = type(owner) == "table" and PlayerByIdentity(r, owner.sid64, owner.nick) or nil
        local st = data.successful == true and "defuse" or data.successful == false and "fail" or nil
        if not st then return end
        local ev = { p = sid, k = "c4", st = st, of = ofSid }
        local charge = KeptCharge(r, ofSid, PosOf(r.players[sid].ply), false)
        if charge then
            ev.x, ev.y, ev.z = PlaceOf(charge.ent)
            if st == "defuse" then ForgetCharge(r, charge) end -- a wrong wire is followed by the explosion of the same charge
        end
        AddEvent(r, CurTime(), ev)
    else
        local sid = PlayerByIdentity(r, data.sid64, data.nick)
        if not sid then return end
        local ev = { p = sid, k = "c4", st = "boom" }
        local charge = KeptCharge(r, sid, nil, true)
        if charge then
            ev.x, ev.y, ev.z = PlaceOf(charge.ent)
            ForgetCharge(r, charge)
        end
        AddEvent(r, CurTime(), ev)
    end
end

-- TTTFoundDNA(owner, ply, ent), after a sample was stored (a duplicate or a failed scan fires nothing): `owner` holds the scanner, `ply` is whose DNA it is
-- (the killer, or the player who touched the object) and `ent` the body or object the sample came from.
function Track.FoundDNA(owner, ply, ent)
    local r = rec
    if not r or r.stopped or r.prep then return end
    local sid = RoundPlayer(r, owner)
    if not sid then return end
    AddEvent(r, CurTime(), { p = sid, k = "dna", of = RoundPlayer(r, ply), w = ClassOf(ent) })
end

-- TTTTraitorButtonActivated(ent, ply): after the button's outputs ran and it was locked. The same player on the same button within a second is one event.
function Track.ButtonUsed(ent, ply)
    local r = rec
    if not r or r.stopped or r.prep then return end
    local sid = RoundPlayer(r, ply)
    if not sid or not IsValid(ent) then return end
    local p, now = r.players[sid], RoundMs(r, CurTime())
    local idx = Call(ent, "EntIndex")
    if idx ~= nil then
        p.btnLast = p.btnLast or {}
        local at = p.btnLast[idx]
        if at and now - at < TBTN_MERGE_MS then return end
        p.btnLast[idx] = now
    end
    local ev = { p = sid, k = "tbtn" }
    local desc = Call(ent, "GetDescription")
    if type(desc) == "string" then
        desc = CleanText(desc, TBTN_LEN)
        if desc ~= "" and desc ~= "?" then ev.n = desc end -- "?" is what the game says when the map gave the button no text
    end
    ev.x, ev.y, ev.z = PlaceOf(ent)
    AddEvent(r, CurTime(), ev)
end

-- ---- Polled state, credits and karma (RFC 26, stage C, package C2)

-- The class of the weapon the player holds, or nil (nothing in hand, or the game cannot say).
local function HeldClass(ply)
    if not ply.GetActiveWeapon then return nil end
    local ok, wep = pcall(ply.GetActiveWeapon, ply)
    if not ok then return nil end
    return ClassOf(wep)
end

-- The player's credits as a whole number from 0 to CREDITS_MAX (the game sends them as UInt(8)), or nil when the game cannot say.
local function ReadCredits(ply)
    if not ply.GetCredits then return nil end
    local ok, v = pcall(ply.GetCredits, ply)
    if not ok or type(v) ~= "number" or v ~= v then return nil end
    return math.min(math.max(Floor(v), 0), CREDITS_MAX)
end

-- Why a player's credits changed: the hooks of TTT2 that run after the change leave a note (Track.CreditTag); the sign of the change picks among them
-- (a purchase or a gift costs, the rest pays), the newest one wins; no note, or none that fits: "other".
local CREDIT_SIGN = { kill = 1, team = 1, found = 1, got = 1, buy = -1, give = -1 }

local function CreditReason(tags, pollAt, d, ms)
    local sign = d > 0 and 1 or -1
    local from = math.min(ms - CREDIT_TAG_MS, pollAt or ms)
    if tags then
        for i = #tags, 1, -1 do
            local t = tags[i]
            if t.at >= from and CREDIT_SIGN[t.w] == sign then return t.w end
        end
    end
    return "other"
end

-- The world model of a weapon class (RFC 39, 3.4), once for each class that appears in a `hold` event: a lower-case path `models/....mdl` of at most 120
-- characters from letters, digits and `_ . / -`, and at most WM_MAX classes; anything else is not recorded (the replay then draws no weapon model).
local WM_MAX = 64
local function NoteModel(r, ply, w)
    if r.wm == nil or r.wm[w] ~= nil or r.wmCount >= WM_MAX then return end
    local ok, wep = pcall(ply.GetActiveWeapon, ply)
    if not ok or wep == nil then return end
    local m
    local ok2, v = pcall(function() return wep.WorldModel end)
    if ok2 and type(v) == "string" and v ~= "" then m = v end
    if not m and wep.GetModel then
        local ok3, v3 = pcall(wep.GetModel, wep)
        if ok3 and type(v3) == "string" then m = v3 end
    end
    if not m then return end
    m = string.lower((string.gsub(m, "\\", "/")))
    if #m > 120 or not string.match(m, "^models/[a-z0-9_./-]+%.mdl$") or string.find(m, "..", 1, true) then return end
    r.wm[w] = m
    r.wmCount = r.wmCount + 1
end

-- The weapon in hand, polled: the first look at a player writes it, then each change; changes within HOLD_MERGE_MS of the last one are one.
local function PollHold(r, p, ply, now, ms)
    local w = HeldClass(ply)
    if not w or w == p.holdW then return end
    p.holdW = w
    NoteModel(r, ply, w)
    local last = p.holdEv
    if last and p.holdAt and ms - p.holdAt <= HOLD_MERGE_MS then
        last.w = w
        p.holdAt = ms
        if r.events[#r.events] == last then last.t = ms end -- the newest event of all: it moves with the change, so the order of the list holds
        return
    end
    p.holdEv = AddEvent(r, now, { p = p.sid, k = "hold", w = w })
    p.holdAt = ms
end

-- Credits, polled: no event at the first look (the baseline), nor in the first second of the round or after a spawn (the game's own setting up); then one event
-- with the net change since the last look, the reason from the hooks' notes, merged with the last event of the same player, reason and direction within CREDIT_MERGE_MS.
local function PollCredits(r, p, ply, now, ms)
    local c = ReadCredits(ply)
    if c == nil then return end
    local last = p.credLast
    local pollAt = p.credPollAt
    p.credLast, p.credPollAt = c, ms
    if last == nil or c == last then return end
    local tags = p.credTags
    p.credTags = nil -- the notes were for this change, used or not
    if ms - r.begin < CREDIT_GRACE_MS or (p.spawnAt and ms - p.spawnAt < CREDIT_GRACE_MS) then return end
    local d = c - last
    local w = CreditReason(tags, pollAt, d, ms)
    local prev = p.credEv
    if prev and p.credAt and prev.w == w and (prev.d > 0) == (d > 0) and ms - p.credAt <= CREDIT_MERGE_MS then
        prev.d = math.min(math.max(prev.d + d, -CREDITS_MAX), CREDITS_MAX)
        prev.c = c
        p.credAt = ms
        return
    end
    local ev = AddEvent(r, now, { p = p.sid, k = "credits", d = d, c = c, w = w })
    p.credEv, p.credAt = ev, ms
end

-- Whom a dead player watches, polled (only with traitordash_track_spec 1, read when the round began): a round player is `of`; a prop the dead player possesses
-- (TTT's prop spectating) is `pr` (its class), `pm` (its model's file name) and, when the prop is a thing that moved, `ti` (its number in `things`, set in Finish);
-- roaming, a ragdoll, a weapon or nothing is "watching nobody". Nothing is written for a dead player who watches nobody at first; changes within SPEC_MERGE_MS
-- of the last are one. RFC 26, 4c.x: PROPSPEC.Start does `SpectateEntity(ent, true)`, so GetObserverTarget is the prop, and sets `spec_owner` on it to the player.
local function PropModel(ent)
    if not ent.GetModel then return nil end
    local ok, m = pcall(ent.GetModel, ent)
    if not ok or type(m) ~= "string" then return nil end
    local name = string.lower(string.match(m, "([^/\\]*)$") or "")
    name = string.gsub(name, "%.[^.]*$", "")
    name = string.sub(string.gsub(name, "[^a-z0-9_%-]", ""), 1, SPEC_MODEL_LEN)
    return name ~= "" and name or nil
end

-- Is `target` a prop that `ply` possesses? Only the game's own marker counts (the entity's `spec_owner` is the player, which is what TTT2's own client code asks;
-- or the player's `propspec` table names it), so a ragdoll, a weapon, a prop somebody only looks at and the player's own body are not.
local function PossessedProp(ply, target)
    if not target.IsPlayer or target:IsPlayer() then return false end
    if target.GetNWEntity then
        local ok, owner = pcall(target.GetNWEntity, target, "spec_owner")
        if ok and owner == ply then return true end
    end
    local ps = ply.propspec
    return type(ps) == "table" and ps.ent == target
end

local function PollSpec(r, p, ply, now, ms)
    if not ply.GetObserverTarget then return end
    local ok, target = pcall(ply.GetObserverTarget, ply)
    if not ok then return end
    local of, pr, pm, key, cand = false, nil, nil, false, nil
    if target ~= nil and IsValid(target) then
        local tsid = RoundPlayer(r, target)
        if tsid then
            if tsid ~= p.sid then of, key = tsid, tsid end
        elseif PossessedProp(ply, target) then
            pr = ClassOf(target)
            if pr then
                pm = PropModel(target)
                local okIdx, idx = pcall(target.EntIndex, target)
                key = "prop:" .. (okIdx and tostring(idx) or "?")
                cand = okIdx and r.candByEnt and r.candByEnt[idx] or nil
            end
        end
    end
    local was = p.specKey or false
    if key == was then
        local last = p.specEv
        if cand and last and last.pr and not last.cand then last.cand = cand end -- the prop became a candidate after the possession began
        return
    end
    p.specKey = key
    local last = p.specEv
    if last and p.specAt and ms - p.specAt <= SPEC_MERGE_MS then
        last.of, last.pr, last.pm, last.cand = of or nil, pr, pm, cand
        p.specAt = ms
        if r.events[#r.events] == last then last.t = ms end
        return
    end
    p.specEv = AddEvent(r, now, { p = p.sid, k = "spec", of = of or nil, pr = pr, pm = pm, cand = cand })
    p.specAt = ms
end

-- The poll at one sample (in SampleAll, under pcall): the weapon in hand and the credits of every living round player, the target of every dead one. A player
-- who is dead has what was polled forgotten, so the first look after a revival is a baseline again. Not in the preparation. A call the game does not have counts as nothing.
PollState = function(r, now)
    if r.prep then return end
    local ms = RoundMs(r, now)
    for _, sid in ipairs(r.order) do
        if Member(r, sid) then
            local p = r.players[sid]
            local ply = p.ply
            if IsValid(ply) then
                p.sid = sid
                if ply.IsTerror and ply:IsTerror() then
                    if r.spec then p.specKey, p.specEv, p.specAt = false, nil, nil end
                    PollHold(r, p, ply, now, ms)
                    PollCredits(r, p, ply, now, ms)
                else
                    p.holdW, p.holdEv, p.credLast, p.credEv, p.credTags, p.credPollAt = nil, nil, nil, nil, nil, nil
                    if r.spec then PollSpec(r, p, ply, now, ms) end
                end
            end
        end
    end
end

-- A hook of TTT2 that runs after credits changed leaves a note for the player: the reason (kill, team, found, give, got, buy). The notes are only read by the next poll.
function Track.CreditTag(ply, w)
    local r = rec
    if not r or r.stopped or r.prep then return end
    local sid = RoundPlayer(r, ply)
    if not sid then return end
    local p, now = r.players[sid], RoundMs(r, CurTime())
    local tags = p.credTags
    if not tags then tags = {} p.credTags = tags end
    local n = #tags
    if n > 0 and tags[n].w == w and tags[n].at == now then return end
    tags[n + 1] = { w = w, at = now }
    if #tags > 8 then table.remove(tags, 1) end
end

-- TTT2OnReceiveKillCredits: documented as (ply, victim, credits) but run as (victim, attacker, credits) (credits.lua:55), so both players are looked at, and
-- the one whose credits are above what the last poll saw is the one who got them.
function Track.KillCredits(a, b)
    local r = rec
    if not r or r.stopped or r.prep then return end
    for _, ply in ipairs({ a, b }) do
        local sid = RoundPlayer(r, ply)
        local p = sid and r.players[sid]
        if p and p.credLast ~= nil then
            local c = ReadCredits(ply)
            if c and c > p.credLast then Track.CreditTag(ply, "kill") end
        end
    end
end

-- TTT2OnTransferCredits(ply, target, credits): the giver pays, the receiver is paid.
function Track.CreditsTransferred(ply, target)
    Track.CreditTag(ply, "give")
    Track.CreditTag(target, "got")
end

-- The reason of a karma change as one word: karma_teamkill_tooltip is "teamkill"; a word that is not one of the game's own is "other".
local KARMA_REASONS = { teamkill = true, teamhurt = true, enemykill = true, enemyhurt = true, cleanround = true, roundheal = true, unknown = true }

local function KarmaReason(reason)
    if type(reason) ~= "string" then return "other" end
    local w = string.gsub(string.gsub(reason, "^karma_", ""), "_tooltip$", "")
    return KARMA_REASONS[w] and w or "other"
end

-- After KARMA.DoKarmaChange(ply, amount, reason) ran: the change is the amount the game rounds it to (as its own record of the round does), the karma after is the
-- live karma now. Not recorded: no change after rounding, a player who is not in the round, a karma the game cannot say. The same player, reason and direction
-- within KARMA_MERGE_MS of the last is one event, the changes added and the karma of the last.
function Track.Karma(ply, amount, reason)
    local r = rec
    if not r or r.stopped or r.prep then return end
    if type(amount) ~= "number" or amount ~= amount then return end
    local sid = RoundPlayer(r, ply)
    if not sid then return end
    local d = math.min(math.max(Floor(amount), -KARMA_MAX), KARMA_MAX)
    if d == 0 then return end
    if not ply.GetLiveKarma then return end
    local ok, live = pcall(ply.GetLiveKarma, ply)
    if not ok or type(live) ~= "number" or live ~= live then return end
    local c = math.min(math.max(Floor(live), 0), KARMA_MAX)
    local p, now = r.players[sid], RoundMs(r, CurTime())
    local w = KarmaReason(reason)
    local last = p.karmaLast and p.karmaLast[w]
    if last and (last.ev.d > 0) == (d > 0) and now - last.at <= KARMA_MERGE_MS then
        last.ev.d = math.min(math.max(last.ev.d + d, -KARMA_MAX), KARMA_MAX)
        last.ev.c = c
        last.at = now
        return
    end
    local ev = AddEvent(r, CurTime(), { p = sid, k = "karma", d = d, c = c, w = w })
    if ev then
        p.karmaLast = p.karmaLast or {}
        p.karmaLast[w] = { ev = ev, at = now }
    end
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

-- ---- Shots fired (RFC 26, 4c, package C3)
-- GM:EntityFireBullets(entity, data) runs for every call of FireBullets, by a player, an NPC or a prop, so it is the hottest hook of the bridge. With no round
-- recorded it is one upvalue check and a return. Under recording a player is found by entity index in a table that is made once per player (checked
-- against the entity, so a slot a new player took is looked at again), the weapon class is cached per player and only looked up again when the class
-- the game names changes, and the only allocation is the event of a new one-second bucket. The hook returns nothing: the wiki says to return true
-- to apply changes to the bullet table and false to suppress the bullet; it does not say what nothing does, and nothing is what every hook of the
-- bridge returns, so the bullet is never changed.
-- The shooter is a player of the round (not in the preparation); a bullet with Damage 0 is not a shot (the crowbar fires one for the blood decal when it hits a
-- player); the weapon is the bullet's Inflictor when that is a weapon, else the player's active weapon, and none of the two is no shot.
local function ShotShooter(r, ent)
    local idx = ent:EntIndex()
    local e = r.shotMap[idx]
    if e and e.ply == ent then return e.p, e.sid end
    local sid = RoundPlayer(r, ent)
    local p = sid and r.players[sid] or false
    r.shotMap[idx] = { ply = ent, p = p, sid = sid }
    return p, sid
end

function Track.Shot(r, ent, data)
    if not ent:IsPlayer() or type(data) ~= "table" or data.Damage == 0 then return end
    local p, sid = ShotShooter(r, ent)
    if not p then return end
    local wep = data.Inflictor
    if not IsValid(wep) or not wep.IsWeapon or not wep:IsWeapon() then wep = ent:GetActiveWeapon() end
    if not IsValid(wep) then return end
    local raw = wep:GetClass()
    if raw ~= p.shotRaw then p.shotRaw, p.shotClass = raw, Word(raw) end
    local class = p.shotClass
    if not class then return end
    local now = RoundMs(r, CurTime())
    local b = p.shotB
    if not b then b = {} p.shotB = b end
    local ev = b[class]
    if ev and now - ev.t < SHOT.MERGE_MS then
        if ev.n < SHOT.N_MAX then ev.n = ev.n + 1 end
        return
    end
    if (r.kinds.shots or 0) >= EVENT_CAP.shots then r.truncated = true return end
    b[class] = AddEvent(r, CurTime(), { p = sid, k = "shots", w = class, n = 1 })
end

local function ShotsOff(r, why)
    r.shotsOff = true
    print(string.format("[TraitorDash:track] shots: %s, so no more shots are recorded in this round (%d calls, about %.2f ms timed so far)", why, r.shotCalls, r.shotCost * 1000))
end

local function ShotHook(ent, data)
    local r = rec
    if not r or r.shotsOff or r.prep or r.stopped then return end
    local n = r.shotCalls + 1
    r.shotCalls = n
    if n > SHOT.CALLS then ShotsOff(r, "the hook ran more than " .. SHOT.CALLS .. " times") return end
    if n % SHOT.SAMPLE ~= 0 then pcall(Track.Shot, r, ent, data) return end
    local t0 = SysTime()
    pcall(Track.Shot, r, ent, data)
    r.shotCost = r.shotCost + (SysTime() - t0)
    r.shotSamples = r.shotSamples + 1
    if r.shotSamples >= SHOT.MIN_SAMPLES and r.shotCost * SHOT.SAMPLE > SHOT.COST then ShotsOff(r, "the hook took about " .. math.floor(r.shotCost * SHOT.SAMPLE * 1000) .. " ms") end
end

-- The hooks return nothing, so they can never block or change what they watch.
hook.Add("PlayerSay", "TraitorDash_TrackSay", function(ply, text, teamOnly) pcall(Track.Say, ply, text, teamOnly) end)
hook.Add("TTT2OrderedEquipment", "TraitorDash_TrackBuy", function(ply, item, isItem) pcall(Track.Buy, ply, item, isItem) end)
hook.Add("TTTOrderedEquipment", "TraitorDash_TrackBuyClassic", function(ply, item, isItem) pcall(Track.Buy, ply, item, isItem) end)
hook.Add("TTTOnCorpseCreated", "TraitorDash_TrackCorpse", function(rag, ply) pcall(Track.Corpse, rag, ply) end)
hook.Add("OnPlayerPhysicsPickup", "TraitorDash_TrackPickup", function(ply, ent) pcall(Track.Pickup, ply, ent) end)
hook.Add("OnPlayerPhysicsDrop", "TraitorDash_TrackDrop", function(ply, ent) pcall(Track.Drop, ply, ent) end)
hook.Add("PostEntityTakeDamage", "TraitorDash_TrackHurt", function(ent, info, took) pcall(Track.Hurt, ent, info, took) end)
hook.Add("PlayerSpawn", "TraitorDash_TrackSpawn", function(ply) pcall(Track.Spawned, ply) end)
hook.Add("TTTBodyFound", "TraitorDash_TrackFound", function(finder, dead) pcall(Track.Found, finder, dead) end)
-- RFC 26, stage C, package C1: all of them run after the thing happened (the "about to" hooks of TTT2 can be cancelled and are not used) and return nothing.
hook.Add("WeaponEquip", "TraitorDash_TrackWeaponPick", function(wep, ply) pcall(Track.WeaponPicked, wep, ply) end)
hook.Add("PlayerDroppedWeapon", "TraitorDash_TrackWeaponDrop", function(ply, wep) pcall(Track.WeaponDropped, ply, wep) end)
hook.Add("TTT2AddedEvent", "TraitorDash_TrackEvents", function(name, event) pcall(Track.AddedEvent, name, event) end)
hook.Add("TTTFoundDNA", "TraitorDash_TrackDNA", function(owner, ply, ent) pcall(Track.FoundDNA, owner, ply, ent) end)
hook.Add("TTTTraitorButtonActivated", "TraitorDash_TrackButton", function(ent, ply) pcall(Track.ButtonUsed, ent, ply) end)
-- Package C2: the credits' reasons, from hooks that run after the credits changed (TTT2; the TTT base has none of them). The change itself is polled.
hook.Add("TTT2OnGiveFoundCredits", "TraitorDash_TrackCreditFound", function(ply) pcall(Track.CreditTag, ply, "found") end)
hook.Add("TTT2OnReceiveTeamAwardCredits", "TraitorDash_TrackCreditTeam", function(ply) pcall(Track.CreditTag, ply, "team") end)
hook.Add("TTT2OnTransferCredits", "TraitorDash_TrackCreditTransfer", function(ply, target) pcall(Track.CreditsTransferred, ply, target) end)
hook.Add("TTT2OnReceiveKillCredits", "TraitorDash_TrackCreditKill", function(a, b) pcall(Track.KillCredits, a, b) end)
hook.Add("EntityFireBullets", "TraitorDash_TrackShots", ShotHook) -- returns nothing (see above)

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
    if r.shotCalls > 0 then
        print(string.format("[TraitorDash:track] shots: the hook ran %d times, %d events, about %.3f ms in all (from %d timed calls)%s",
            r.shotCalls, r.kinds.shots or 0, r.shotSamples > 0 and r.shotCost / r.shotSamples * r.shotCalls * 1000 or 0, r.shotSamples, r.shotsOff and ", SWITCHED OFF" or ""))
    end
    if r.thingList then print(string.format("[TraitorDash:track] props: %d moved, %d keyframes", #r.thingList, r.thingKeys)) end
    if r.partList then print(string.format("[TraitorDash:track] parts: %d, %d keyframes, %d inputs", #r.partList, r.keys, #r.inputs)) end

    -- Who took part in the round: the players recorded in the preparation who were not in it (spectators, those who left) are not sent.
    local function In(sid) return sid ~= nil and r.players[sid] ~= nil and (r.members == nil or r.members[sid] == true) end
    local players = {}
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        if In(sid) and #p.segs > 0 then
            local segs = {}
            for i, c in ipairs(p.segs) do segs[i] = { from = c.from, x = c.x, y = c.y, z = c.z, a = c.a, s = c.s, hp = (not c.hpBad and #c.hp == #c.x) and c.hp or nil, ap = (not c.apBad and #c.ap == #c.x) and c.ap or nil } end
            players[#players + 1] = { id = sid, mh = p.mh or nil, eh = p.eh or nil, ed = p.ed or nil, segments = segs }
        end
    end
    local function Only(list, key, strip)
        local out = {}
        for _, e in ipairs(list) do
            if In(e[key]) then
                for _, f in ipairs(strip or {}) do if e[f] ~= nil and not In(e[f]) then e[f] = nil end end
                out[#out + 1] = e
            end
        end
        return out
    end
    local deaths = Only(r.deaths, "victim")
    for _, d in ipairs(deaths) do
        if d.attacker ~= nil and not In(d.attacker) then d.attacker, d.ax, d.ay, d.az = nil, nil, nil, nil end
    end
    local events = Only(r.events, "p", { "by", "of", "a" })
    local things = ThingsOut(r)
    -- A possessed prop that moved is a thing: the `spec` event gets its number in `things` (`ti`); the held reference to the candidate is never sent.
    local inThings = {}
    for _, th in ipairs(things or {}) do inThings[th.e] = true end
    for _, e in ipairs(events) do
        local cand = e.cand
        e.cand = nil
        if e.k == "spec" and e.pr and cand and cand.thing and inThings[cand.thing.e] then e.ti = cand.thing.e end
    end
    local bodies = Only(r.bodies, "p")
    local inputs = {}
    for _, e in ipairs(r.inputs) do
        if e.by ~= nil and not In(e.by) then e.by = nil end
        inputs[#inputs + 1] = e
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
        t = r.t, players = players, deaths = deaths, begin = r.begin > 0 and r.begin or nil,
        events = #events > 0 and events or nil,
        wm = r.wmCount > 0 and r.wm or nil,
        bodies = #bodies > 0 and bodies or nil,
        parts = PartsOut(r), things = things, inputs = #inputs > 0 and inputs or nil,
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
    local ok, err = pcall(Track.Prepare)
    if not ok then print("[TraitorDash:track] could not start the preparation: " .. tostring(err)) end
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
