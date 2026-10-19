-- TraitorDash frame-time measurement (RFC 12, section 7: the acceptance test of the sampling rate).
--
--   traitordash_frametime round      measure the next round, from its start to its end
--   traitordash_frametime start      measure now, until "stop"
--   traitordash_frametime stop       end a measurement and print it
--   traitordash_frametime status     what is being measured
--   traitordash_frametime history    the results so far (the last 20), one line each
--
-- Console or superadmin only. Nothing runs unless a measurement is started: the Think hook that
-- records frames exists only while one is going, and one measurement holds at most 200 000 frames.
--
-- What it measures, and what it cannot. A dedicated server runs on a fixed tick, so a frame
-- normally takes exactly one tick; what shows is an OVERRUN: a frame that took longer than the tick
-- (a hitch, such as encoding a large track at the end of a round) or a server that cannot keep up.
-- It does NOT show how much headroom each tick has; for that read `Svms` in the server's own
-- `stats` command. Both are in the line, together with whether position tracking was on, so rounds
-- with traitordash_track 0 and 1 on the same map and with a similar number of players can be compared.

if not SERVER then return end

TraitorDash = TraitorDash or {}

local HOOK = "TraitorDash_FrameTime"
local MAX_FRAMES = 200000
local KEEP = 20

local run = nil        -- the measurement in progress
local armed = false    -- "round": waiting for the next round to begin
local history = {}

local function Out(msg) print("[TraitorDash:frametime] " .. msg) end

local function Percentile(sorted, p)
    if #sorted == 0 then return 0 end
    local i = math.min(#sorted, math.max(1, math.ceil(#sorted * p)))
    return sorted[i]
end

local function Summarise(values)
    local sorted, sum, worst = {}, 0, 0
    for i, v in ipairs(values) do sorted[i] = v sum = sum + v if v > worst then worst = v end end
    table.sort(sorted)
    return { mean = #values > 0 and sum / #values or 0, p99 = Percentile(sorted, 0.99), worst = worst }
end

local function Tracking()
    local cv = GetConVar and GetConVar("traitordash_track")
    return cv ~= nil and cv:GetBool()
end

local function Think()
    local r = run
    if not r then return end
    local ok, err = pcall(function()
        local now = SysTime()
        local ft = FrameTime()
        if #r.ft >= MAX_FRAMES then
            r.capped = true
            hook.Remove("Think", HOOK)
            return
        end
        r.ft[#r.ft + 1] = ft
        if r.last then r.period[#r.period + 1] = now - r.last end
        r.last = now
    end)
    if not ok then
        r.errors = r.errors + 1
        if r.errors == 1 then print("[TraitorDash:frametime] error while sampling: " .. tostring(err)) end
    end
end

local function Begin(label)
    run = { label = label, ft = {}, period = {}, last = nil, started = SysTime(), errors = 0, capped = false, tracking = Tracking(), map = game.GetMap() }
    hook.Add("Think", HOOK, Think)
    Out("measuring (" .. label .. "); tracking is " .. (run.tracking and "on" or "off"))
end

-- Ends the measurement, prints one line and keeps it in the history.
local function Finish()
    local r = run
    run = nil
    armed = false
    hook.Remove("Think", HOOK)
    if not r then return nil end

    local tick = engine.TickInterval()
    local f, p = Summarise(r.ft), Summarise(r.period)
    local over15, over2 = 0, 0
    for _, v in ipairs(r.ft) do
        if v > 2 * tick then over2 = over2 + 1 end
        if v > 1.5 * tick then over15 = over15 + 1 end
    end
    local result = {
        label = r.label, map = r.map, tracking = r.tracking, frames = #r.ft, seconds = SysTime() - r.started, tick = tick,
        mean = f.mean, p99 = f.p99, worst = f.worst, over15 = over15, over2 = over2,
        periodMean = p.mean, periodP99 = p.p99, periodWorst = p.worst,
        players = #player.GetAll(), capped = r.capped, errors = r.errors,
    }
    history[#history + 1] = result
    if #history > KEEP then table.remove(history, 1) end
    Out(string.format(
        "%s on %s, tracking %s, %d players: %d frames over %.1f s, tick %.1f ms; frame time mean %.2f p99 %.2f worst %.2f ms; "
        .. "frames over 1.5x the tick: %d, over 2x: %d; time between frames mean %.2f p99 %.2f worst %.2f ms%s%s",
        result.label, result.map, result.tracking and "ON" or "off", result.players, result.frames, result.seconds, tick * 1000,
        result.mean * 1000, result.p99 * 1000, result.worst * 1000, over15, over2,
        result.periodMean * 1000, result.periodP99 * 1000, result.periodWorst * 1000,
        result.capped and " (stopped at the frame limit)" or "", result.errors > 0 and (" (" .. result.errors .. " sampling errors)") or ""))
    return result
end

-- A round measures from its start to its end.
hook.Add("TTTBeginRound", "TraitorDash_FrameTimeBegin", function()
    if armed and not run then
        local ok, err = pcall(Begin, "round")
        if not ok then print("[TraitorDash:frametime] could not start: " .. tostring(err)) armed = false end
    end
end)
hook.Add("TTTEndRound", "TraitorDash_FrameTimeEnd", function()
    if run and run.label == "round" then
        local ok, err = pcall(Finish)
        if not ok then print("[TraitorDash:frametime] error: " .. tostring(err)) end
    end
end)
hook.Add("TTTPrepareRound", "TraitorDash_FrameTimePrepare", function()
    -- a measurement that was waiting for a round that never ended is dropped when the next one is prepared
    if run and run.label == "round" then run = nil hook.Remove("Think", HOOK) Out("the round was restarted; measurement dropped") end
end)

local USAGE = "usage: traitordash_frametime round | start | stop | status | history"

concommand.Add("traitordash_frametime", function(ply, _, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local sub = string.lower(args and args[1] or "")
    if sub == "round" then
        if run then Out("already measuring (" .. run.label .. "); stop it first") return end
        armed = true
        Out("armed: the next round will be measured (tracking is " .. (Tracking() and "on" or "off") .. ")")
    elseif sub == "start" then
        if run then Out("already measuring (" .. run.label .. ")") return end
        armed = false
        Begin("manual")
    elseif sub == "stop" then
        if not run then Out(armed and "nothing is being measured yet; the next round is armed" or "nothing is being measured") return end
        Finish()
    elseif sub == "status" then
        if run then Out(string.format("measuring (%s): %d frames so far, tracking %s", run.label, #run.ft, run.tracking and "on" or "off"))
        elseif armed then Out("armed for the next round")
        else Out("idle; " .. #history .. " results kept") end
    elseif sub == "history" then
        if #history == 0 then Out("no results yet") return end
        for i, h in ipairs(history) do
            Out(string.format("%2d. %-6s %s tracking %-3s players %2d  mean %.2f p99 %.2f worst %.2f ms  >1.5x %d  >2x %d  frames %d",
                i, h.label, h.map, h.tracking and "ON" or "off", h.players, h.mean * 1000, h.p99 * 1000, h.worst * 1000, h.over15, h.over2, h.frames))
        end
    else
        Out(USAGE)
    end
end)
