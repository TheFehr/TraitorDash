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
-- Encoding (as recorded and as sent): one shared list `t` of tick times in whole milliseconds since
-- the round began, stored as differences; per player and segment `x`, `y`, `z` in units / 8 and the
-- view yaw `a` as 0-255, each the first absolute value and then differences to the previous sample.

TraitorDash = TraitorDash or {}
local Track = {}
TraitorDash.Track = Track

local cv_track = CreateConVar("traitordash_track", "0", {FCVAR_ARCHIVE}, "Record player positions for round replays (1/0).")
local cv_min = CreateConVar("traitordash_track_interval_min", "0.2", {FCVAR_ARCHIVE}, "Fastest sampling interval in seconds (at least 0.1).")
local cv_max = CreateConVar("traitordash_track_interval_max", "1", {FCVAR_ARCHIVE}, "Slowest sampling interval in seconds.")
local cv_budget = CreateConVar("traitordash_track_budget_ms", "0.5", {FCVAR_ARCHIVE}, "What one sampling tick may cost on average, in milliseconds.")
local cv_debug = CreateConVar("traitordash_stats_debug", "1", {FCVAR_ARCHIVE}, "Log what the stats tracker does (1/0).")

local TIMER = "TraitorDash_Track"
local MAX_TICKS = 20000          -- caps of RFC 12, 3.2 (the backend refuses more)
local MAX_SEGMENTS = 64          -- per player
local MAX_DEATHS = 512
local MAX_BYTES = 8 * 1024 * 1024
local SAFE_BYTES = 7 * 1024 * 1024 -- the size estimate at which recording stops, a margin below the cap
local BYTES_PER_SAMPLE = 16
local RING = 10                  -- ticks the average cost is taken over
local STEP_MAX = 60000           -- the longest step between two ticks the backend accepts, ms

local rec = nil                  -- the round being recorded, or nil
local noEndpointOn = nil         -- the map on which the backend answered 404 (it is too old)

local function Dbg(...)
    if cv_debug:GetBool() then print("[TraitorDash:track]", ...) end
end

local function Floor(v) return math.floor(v + 0.5) end

local function Settings()
    local mn = math.max(cv_min:GetFloat(), 0.1)
    local mx = math.max(cv_max:GetFloat(), mn)
    local budget = math.max(cv_budget:GetFloat(), 0.05) / 1000 -- seconds
    return mn, mx, budget
end

local function EstimateBytes(r)
    return r.samples * BYTES_PER_SAMPLE + #r.t * 6 + #r.deaths * 120
end

local function Pos(ply)
    local p = ply:GetPos()
    local a = ply:EyeAngles()
    return Floor(p.x / 8), Floor(p.y / 8), Floor(p.z / 8), math.floor((a.y % 360) / 360 * 256) % 256
end

local function RemoveTimer()
    if timer.Exists and timer.Exists(TIMER) then timer.Remove(TIMER) end
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

local function Push(r, p, idx, x, y, z, a)
    local c = p.cur
    if not c then
        if #p.segs >= MAX_SEGMENTS then return end
        c = { from = idx - 1, x = {}, y = {}, z = {}, a = {}, lx = 0, ly = 0, lz = 0, la = 0 }
        p.cur = c
        p.segs[#p.segs + 1] = c
    end
    local n = #c.x + 1
    c.x[n], c.y[n], c.z[n], c.a[n] = x - c.lx, y - c.ly, z - c.lz, a - c.la
    c.lx, c.ly, c.lz, c.la = x, y, z, a
    r.samples = r.samples + 1
end

-- One sample of every tracked player at one tick. `also` is the SteamID of a player to sample even
-- though they are no longer alive (the death hook: the death position is exact).
local function SampleAll(r, now, also)
    local idx = AddTick(r, now)
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        local ply = p.ply
        if IsValid(ply) and (ply:IsTerror() or sid == also) then
            Push(r, p, idx, Pos(ply))
        else
            p.cur = nil -- not alive now: the segment ends here (a revived player starts a new one)
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

    if #r.t >= MAX_TICKS then r.truncated = true StopSampling(r, "the tick cap was reached") return end
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
        id = roundId, t0 = CurTime(), lastMs = 0, t = {}, order = {}, players = {}, deaths = {},
        samples = 0, ticks = 0, skipped = 0, interval = mn, minUsed = math.huge, maxUsed = 0,
        ring = {}, costSum = 0, worst = 0, truncated = false, degraded = false, stopped = false,
    }
    for _, e in ipairs(players) do
        if #r.order >= 128 then break end
        r.order[#r.order + 1] = e.sid
        r.players[e.sid] = { ply = e.ply, segs = {} }
    end
    rec = r
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
function Track.Death(victim, inflictor, attacker, vsid, asid)
    local r = rec
    if not r or #r.deaths >= MAX_DEATHS then return end
    local p = r.players[vsid]
    if not p or not IsValid(victim) then return end

    local now = CurTime()
    if not r.stopped then
        SampleAll(r, now, vsid)
        p.cur = nil
    end
    local d = { victim = vsid, t = math.min(math.max(Floor((now - r.t0) * 1000), 0), 6 * 3600 * 1000) }
    d.vx, d.vy, d.vz = Pos(victim)
    if asid and r.players[asid] and IsValid(attacker) then
        d.attacker = asid
        d.ax, d.ay, d.az = Pos(attacker)
    end
    d.weapon = Weapon(inflictor, attacker)
    r.deaths[#r.deaths + 1] = d
end

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

    local players = {}
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        if #p.segs > 0 then
            local segs = {}
            for i, c in ipairs(p.segs) do segs[i] = { from = c.from, x = c.x, y = c.y, z = c.z, a = c.a } end
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
    }
end

-- Sends a finished track. Called once the backend has accepted the round's stats; a failure is logged and dropped.
function Track.Upload(body)
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    local json = util.TableToJSON(body)
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
