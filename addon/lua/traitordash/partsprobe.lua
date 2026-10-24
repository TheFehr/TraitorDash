-- TraitorDash probe for the parts of a map that move (RFC 20, stage 0): what a real server shows before anything is built.
--
--   traitordash_parts_probe scan            list the movable entities of the map, once, and say how they look
--   traitordash_parts_probe start [secs]    watch for that long (default 120, at most 1800), then print the result
--   traitordash_parts_probe round           watch the next round, from its start to its end
--   traitordash_parts_probe auto on [n]     watch every round that starts with at least n people (default 1), from now on,
--                                           also after a restart or a map change, until "auto off"; for a night with a full server
--   traitordash_parts_probe stop            end a watch and print the result
--   traitordash_parts_probe status          what is going on
--
-- Console or superadmin only. Nothing is hooked and no timer runs unless a watch is started. The result goes to the
-- console and is appended to data/traitordash_parts_probe.txt, so it can be copied into the RFC.
--
-- It answers the questions RFC 20 rests on (section 9):
--   * is the model of a brush entity "*N", and is N unique? (the join between the mesh and the game)
--   * which inputs reach the movable parts, and who caused them? (AcceptInput)
--   * does a part ever move without an input just before it? (what AcceptInput misses; PlayerUse is counted next to it)
--   * what does the hook cost on a busy map, and what does sampling the parts cost?
--   * how many doors that are props, breakable walls and buttons does the map have? (what is left out)
--
-- Every way a watch can end writes its result: the round ending, a restarted round, a map change or shutdown, the time
-- running out. The hook cost is measured with SysTime around each call, which adds a little of its own, so it reads a
-- bit high. The server's frame time is looked at five times a second, so it shows a trend, not every frame.
--
-- It only watches. The hooks end without returning a value on every path: in Garry's Mod, returning true from
-- AcceptInput (or false from PlayerUse) stops the game from doing what it was about to do.

if not SERVER then return end

TraitorDash = TraitorDash or {}

-- The classes of RFC 18 that are drawn as parts that can move.
local CLASSES = {
    func_door = true, func_door_rotating = true, func_movelinear = true, func_rotating = true,
    func_tracktrain = true, func_physbox = true, func_physbox_multiplayer = true,
}
-- Only counted, for what RFC 20 leaves out.
local OTHERS = { "prop_door_rotating", "func_breakable", "func_breakable_surf", "func_button", "func_wall_toggle" }

local HOOK_INPUT, HOOK_USE, TIMER_SAMPLE, TIMER_STOP = "TraitorDash_PartsProbe", "TraitorDash_PartsProbe", "TraitorDash_PartsProbe", "TraitorDash_PartsProbeStop"
local MAX_PARTS = 512
local DEFAULT_SECONDS, MAX_SECONDS = 120, 1800
local SAMPLE = 0.2             -- seconds between two looks at the parts
local ANNOUNCED = 5            -- a movement counts as announced when an input reached the part in the 5 s before
local MAX_FILE = 512 * 1024    -- stop adding to the data file beyond this
local AUTO_FILE = "traitordash_parts_probe_auto.txt"
local MAX_LINES = 40           -- lines of detail kept for each list
local STILL = 0.5              -- a part moved when its position changed by more than this many units...
local TURNED = 0.25            -- ...or its angles by more than this many degrees

local run = nil                -- the watch in progress
local armed = false            -- "round": waiting for the next round to begin
local auto = nil               -- "auto on": { min = people needed } while every round is watched

local function Out(msg) print("[TraitorDash:parts] " .. msg) end

local function ModelNumber(ent)
    local m = ent:GetModel()
    local n = isstring(m) and string.match(m, "^%*(%d+)$")
    return n and tonumber(n) or nil
end

local function Describe(part)
    return string.format("%s name=%s model=%s", part.class, part.name ~= "" and part.name or "(none)", part.model and ("*" .. part.model) or tostring(part.rawModel))
end

local function Sorted(map)
    local keys = {}
    for k in pairs(map) do keys[#keys + 1] = k end
    table.sort(keys)
    return keys
end

-- The movable entities of the map, and how their models look. Pure reading.
local function Scan()
    local parts, byIndex = {}, {}
    local info = { byClass = {}, noModel = {}, duplicates = {}, unnamed = 0, parented = 0, others = {}, over = false, entityCount = 0 }
    local seen = {}
    for _, name in ipairs(OTHERS) do info.others[name] = 0 end
    for _, ent in ipairs(ents.GetAll()) do
        info.entityCount = info.entityCount + 1
        if IsValid(ent) then
            local class = ent:GetClass()
            if CLASSES[class] then
                if #parts >= MAX_PARTS then info.over = true
                else
                    local model = ModelNumber(ent)
                    local part = { ent = ent, class = class, name = ent:GetName() or "", model = model, rawModel = ent:GetModel(), index = ent:EntIndex() }
                    parts[#parts + 1] = part
                    byIndex[part.index] = part
                    info.byClass[class] = (info.byClass[class] or 0) + 1
                    if part.name == "" then info.unnamed = info.unnamed + 1 end
                    if IsValid(ent:GetParent()) then info.parented = info.parented + 1 end
                    if model then
                        if seen[model] then info.duplicates[#info.duplicates + 1] = { model = model, a = seen[model], b = part } else seen[model] = part end
                    else info.noModel[#info.noModel + 1] = part end
                end
            elseif info.others[class] ~= nil then info.others[class] = info.others[class] + 1 end
        end
    end
    info.parts, info.byIndex = parts, byIndex
    return info
end

local function ScanLines(info)
    local lines = {}
    local classes = {}
    for _, c in ipairs(Sorted(info.byClass)) do classes[#classes + 1] = c .. " " .. info.byClass[c] end
    lines[#lines + 1] = string.format("movable entities: %d (%s)%s", #info.parts, #classes > 0 and table.concat(classes, ", ") or "none", info.over and (" - more than " .. MAX_PARTS .. ", the rest are not looked at") or "")
    lines[#lines + 1] = string.format("model is \"*N\": %d of %d; without it: %d; the same N on two entities: %d; without a name: %d; with a parent (left out of the mesh): %d",
        #info.parts - #info.noModel, #info.parts, #info.noModel, #info.duplicates, info.unnamed, info.parented)
    for i, p in ipairs(info.noModel) do if i > MAX_LINES then break end lines[#lines + 1] = "  no *N: " .. Describe(p) end
    for i, d in ipairs(info.duplicates) do if i > MAX_LINES then break end lines[#lines + 1] = string.format("  *%d twice: %s and %s", d.model, Describe(d.a), Describe(d.b)) end
    local others = {}
    for _, name in ipairs(OTHERS) do others[#others + 1] = name .. " " .. info.others[name] end
    lines[#lines + 1] = "left out by RFC 20, counted: " .. table.concat(others, ", ")
    return lines
end

local function Counts()
    local all, humans = 0, 0
    for _, ply in ipairs(player.GetAll()) do
        all = all + 1
        if not (ply.IsBot and ply:IsBot()) then humans = humans + 1 end
    end
    return all, humans
end

local function IsPlayer(ent) return IsValid(ent) and ent.IsPlayer ~= nil and ent:IsPlayer() end

local function Report(lines, label)
    local header = string.format("--- parts probe, %s, map %s, %s ---", label, game.GetMap(), os and os.date and os.date("%Y-%m-%d %H:%M:%S") or "")
    Out(header)
    local all = { header }
    for _, l in ipairs(lines) do Out(l) all[#all + 1] = l end
    local ok, err = pcall(function()
        local old = file.Read("traitordash_parts_probe.txt", "DATA") or ""
        if #old > MAX_FILE then error("the file is over " .. MAX_FILE .. " bytes; move it away and the next result is written") end
        file.Write("traitordash_parts_probe.txt", old .. table.concat(all, "\n") .. "\n\n")
    end)
    if not ok then Out("could not write data/traitordash_parts_probe.txt: " .. tostring(err)) end
end

-- What a watch records, as the hooks and the timer see it. Every body runs inside pcall: an error stops the watch's
-- bookkeeping, never the game.
local function OnInput(ent, name, activator, caller)
    local r = run
    if not r then return end
    local t0 = SysTime()
    r.inputsAll = r.inputsAll + 1
    local part = IsValid(ent) and r.byIndex[ent:EntIndex()] or nil
    if part then
        local input = string.lower(tostring(name))
        local now = t0 - r.started
        r.inputsSeen = r.inputsSeen + 1
        local key = part.class .. " " .. input
        r.inputs[key] = (r.inputs[key] or 0) + 1
        part.lastInput = now
        part.inputs = part.inputs + 1
        local by = "nobody"
        if IsPlayer(activator) then by = "activator" r.byActivator = r.byActivator + 1
        elseif IsPlayer(caller) then by = "caller" r.byCaller = r.byCaller + 1
        else r.byNobody = r.byNobody + 1 end
        if #r.inputLines < MAX_LINES then
            r.inputLines[#r.inputLines + 1] = string.format("  %6.1fs %-9s %s (by %s)", now, input, Describe(part), by)
        end
    end
    local dt = SysTime() - t0
    r.hookTime = r.hookTime + dt
    if dt > r.hookWorst then r.hookWorst = dt end
end

local function OnUse(ply, ent)
    local r = run
    if not r then return end
    local part = IsValid(ent) and r.byIndex[ent:EntIndex()] or nil
    if part then
        r.uses = r.uses + 1
        part.lastInput = SysTime() - r.started
        part.uses = part.uses + 1
    end
end

local function Differs(a, b)
    return math.abs(a.x - b.x) + math.abs(a.y - b.y) + math.abs(a.z - b.z) > STILL
end
local function Turned(a, b)
    local function d(x, y) local v = math.abs(x - y) % 360 return math.min(v, 360 - v) end
    return d(a.p, b.p) + d(a.y, b.y) + d(a.r, b.r) > TURNED
end

local function Sample()
    local r = run
    if not r then return end
    local t0 = SysTime()
    local now = t0 - r.started
    for _, part in ipairs(r.parts) do
        if not part.gone then
            if not IsValid(part.ent) then
                part.gone = true
                r.removed = r.removed + 1
                r.goneLines[#r.goneLines + 1] = string.format("  %6.1fs removed: %s", now, Describe(part))
            else
                local pos, ang = part.ent:GetPos(), part.ent:GetAngles()
                local p = { x = pos.x, y = pos.y, z = pos.z }
                local a = { p = ang.p, y = ang.y, r = ang.r }
                if part.pos then
                    local moved = Differs(p, part.pos) or Turned(a, part.ang)
                    if moved and not part.moving then
                        -- a movement begins: was it announced by an input a moment ago?
                        part.moving = true
                        part.moves = part.moves + 1
                        r.movements = r.movements + 1
                        local announced = part.lastInput ~= nil and now - part.lastInput <= ANNOUNCED
                        if announced then r.announced = r.announced + 1
                        else
                            r.unannounced = r.unannounced + 1
                            if #r.unannouncedLines < MAX_LINES then
                                r.unannouncedLines[#r.unannouncedLines + 1] = string.format("  %6.1fs %s%s", now, Describe(part), part.lastInput and string.format(" (last input %.1fs earlier)", now - part.lastInput) or " (no input yet)")
                            end
                        end
                    elseif not moved and part.moving then part.moving = false end
                end
                part.pos, part.ang = p, a
            end
        end
    end
    -- once a second: how many people, and how the server's frames are doing
    if r.samples % 5 == 0 then
        local all, humans = Counts()
        if all > r.playersMax then r.playersMax = all end
        if humans > r.humansMax then r.humansMax = humans end
    end
    local ft = FrameTime and FrameTime() or 0
    r.frameSum = r.frameSum + ft
    if ft > r.frameWorst then r.frameWorst = ft end
    local dt = SysTime() - t0
    r.samples = r.samples + 1
    r.sampleTime = r.sampleTime + dt
    if dt > r.sampleWorst then r.sampleWorst = dt end
end

local function Finish(why)
    local r = run
    run = nil
    armed = false
    hook.Remove("AcceptInput", HOOK_INPUT)
    hook.Remove("PlayerUse", HOOK_USE)
    timer.Remove(TIMER_SAMPLE)
    timer.Remove(TIMER_STOP)
    if not r then return nil end

    local secs = SysTime() - r.started
    local lines = {}
    local all, humans = Counts()
    lines[#lines + 1] = string.format("watched %.0f s (%s); at the start %d people (%d of them bots), at most %d (%d humans), at the end %d (%d humans); %d entities in the map",
        secs, why or r.label, r.playersStart, r.playersStart - r.humansStart, math.max(r.playersMax, all), math.max(r.humansMax, humans), all, humans, r.info.entityCount)
    lines[#lines + 1] = string.format("SUMMARY humans<=%d | inputs %.1f/s | hook %.1f us avg %.1f us worst | looking at parts %.1f us avg %.1f us worst | unannounced movements %d | frames %.2f ms avg %.2f ms worst (tick %.2f ms)",
        math.max(r.humansMax, humans), secs > 0 and r.inputsAll / secs or 0, r.inputsAll > 0 and r.hookTime / r.inputsAll * 1e6 or 0, r.hookWorst * 1e6,
        r.samples > 0 and r.sampleTime / r.samples * 1e6 or 0, r.sampleWorst * 1e6, r.unannounced,
        r.samples > 0 and r.frameSum / r.samples * 1000 or 0, r.frameWorst * 1000, (engine and engine.TickInterval and engine.TickInterval() or 0) * 1000)
    for _, l in ipairs(ScanLines(r.info)) do lines[#lines + 1] = l end
    lines[#lines + 1] = string.format("inputs on any entity: %d (%.1f a second); on movable parts: %d; the hook cost %.1f us on average, %.1f us at worst (%.2f ms in all)",
        r.inputsAll, secs > 0 and r.inputsAll / secs or 0, r.inputsSeen, r.inputsAll > 0 and r.hookTime / r.inputsAll * 1e6 or 0, r.hookWorst * 1e6, r.hookTime * 1000)
    if r.inputsSeen > 0 then
        local kinds = {}
        for _, k in ipairs(Sorted(r.inputs)) do kinds[#kinds + 1] = k .. " " .. r.inputs[k] end
        lines[#lines + 1] = "inputs on movable parts: " .. table.concat(kinds, ", ")
        lines[#lines + 1] = string.format("who caused them: activator was a player %d, only the caller was a player %d, nobody %d", r.byActivator, r.byCaller, r.byNobody)
        for _, l in ipairs(r.inputLines) do lines[#lines + 1] = l end
    end
    lines[#lines + 1] = string.format("PlayerUse on movable parts: %d (compare with the \"use\" inputs above)", r.uses)
    local moved = 0
    for _, p in ipairs(r.parts) do if p.moves > 0 then moved = moved + 1 end end
    lines[#lines + 1] = string.format("parts that moved: %d of %d; movements %d: announced by an input in the %d s before %d, with no input %d",
        moved, #r.parts, r.movements, ANNOUNCED, r.announced, r.unannounced)
    for _, l in ipairs(r.unannouncedLines) do lines[#lines + 1] = l end
    lines[#lines + 1] = string.format("parts removed from the game while watching: %d", r.removed)
    for i, l in ipairs(r.goneLines) do if i <= MAX_LINES then lines[#lines + 1] = l end end
    lines[#lines + 1] = string.format("looking at all parts every %.1f s: %d looks, %.1f us on average, %.1f us at worst", SAMPLE, r.samples, r.samples > 0 and r.sampleTime / r.samples * 1e6 or 0, r.sampleWorst * 1e6)
    if r.errors > 0 then lines[#lines + 1] = string.format("errors while watching: %d (the first: %s)", r.errors, tostring(r.firstError)) end
    Report(lines, r.label)
    return lines
end

local function Begin(label, seconds)
    local info = Scan()
    run = {
        label = label, started = SysTime(), info = info, parts = info.parts, byIndex = info.byIndex,
        inputs = {}, inputLines = {}, unannouncedLines = {}, goneLines = {},
        inputsAll = 0, inputsSeen = 0, byActivator = 0, byCaller = 0, byNobody = 0, hookTime = 0, hookWorst = 0,
        uses = 0, movements = 0, announced = 0, unannounced = 0, removed = 0, samples = 0, sampleTime = 0, sampleWorst = 0,
        errors = 0, firstError = nil, frameSum = 0, frameWorst = 0,
    }
    run.playersStart, run.humansStart = Counts()
    run.playersMax, run.humansMax = run.playersStart, run.humansStart
    for _, p in ipairs(info.parts) do p.inputs, p.uses, p.moves, p.moving = 0, 0, 0, false end
    local function guard(fn)
        return function(...)
            local ok, err = pcall(fn, ...)
            if not ok and run then
                run.errors = run.errors + 1
                if run.errors == 1 then run.firstError = err Out("error while watching: " .. tostring(err)) end
            end
            -- no return value: see the head of this file
        end
    end
    hook.Add("AcceptInput", HOOK_INPUT, guard(OnInput))
    hook.Add("PlayerUse", HOOK_USE, guard(OnUse))
    timer.Create(TIMER_SAMPLE, SAMPLE, 0, guard(Sample))
    timer.Create(TIMER_STOP, seconds, 1, function() local ok, err = pcall(Finish, "time is up") if not ok then Out("error: " .. tostring(err)) end end)
    Out(string.format("watching %d movable parts for %d s (%s)", #info.parts, seconds, label))
end

-- A round is watched from its start to its end (and for at most MAX_SECONDS). "round" watches the next one; "auto"
-- watches each one that starts with enough people.
local function Safe(fn, ...)
    local ok, err = pcall(fn, ...)
    if not ok then Out("error: " .. tostring(err)) end
    return ok
end

hook.Add("TTTBeginRound", "TraitorDash_PartsProbeBegin", function()
    if run then return end
    local _, humans = Counts()
    if armed or (auto and humans >= auto.min) then
        armed = false
        if not Safe(Begin, "round", MAX_SECONDS) then
            run = nil
            hook.Remove("AcceptInput", HOOK_INPUT) hook.Remove("PlayerUse", HOOK_USE)
            timer.Remove(TIMER_SAMPLE) timer.Remove(TIMER_STOP)
        end
    end
end)
hook.Add("TTTEndRound", "TraitorDash_PartsProbeEnd", function()
    if run and run.label == "round" then Safe(Finish, "the round ended") end
end)
-- a restarted round and a map change or shutdown end the watch the same way, with what was seen so far
hook.Add("TTTPrepareRound", "TraitorDash_PartsProbePrepare", function()
    if run and run.label == "round" then Safe(Finish, "the round was restarted") end
end)
hook.Add("ShutDown", "TraitorDash_PartsProbeShutDown", function()
    if run then Safe(Finish, "the server shut down or changed map") end
end)

-- "auto on" is kept in a file, so it holds after a restart and a map change.
local function SaveAuto()
    if auto then file.Write(AUTO_FILE, tostring(auto.min)) else file.Delete(AUTO_FILE) end
end
local function LoadAuto()
    local saved = file.Read(AUTO_FILE, "DATA")
    local n = saved and tonumber(saved)
    if n then
        auto = { min = math.max(math.floor(n), 1) }
        Out(string.format("auto: every round that starts with %d or more people is watched (traitordash_parts_probe auto off to end it)", auto.min))
    end
end

local USAGE = "usage: traitordash_parts_probe scan | start [seconds] | round | auto on [people] | auto off | stop | status"

concommand.Add("traitordash_parts_probe", function(ply, _, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local sub = string.lower(args and args[1] or "")
    if sub == "scan" then
        local ok, res = pcall(function() return ScanLines(Scan()) end)
        if ok then Report(res, "scan") else Out("error: " .. tostring(res)) end
    elseif sub == "start" then
        if run then Out("already watching (" .. run.label .. "); stop it first") return end
        armed = false
        local secs = math.floor(math.min(math.max(tonumber(args[2]) or DEFAULT_SECONDS, 5), MAX_SECONDS))
        local ok, err = pcall(Begin, "manual", secs)
        if not ok then Out("could not start: " .. tostring(err)) end
    elseif sub == "round" then
        if run then Out("already watching (" .. run.label .. "); stop it first") return end
        armed = true
        Out("armed: the next round will be watched")
    elseif sub == "auto" then
        local word = string.lower(args[2] or "")
        if word == "on" then
            auto = { min = math.max(math.floor(tonumber(args[3]) or 1), 1) }
            SaveAuto()
            Out(string.format("auto: every round that starts with %d or more people is watched, from now on", auto.min))
        elseif word == "off" then
            auto = nil
            SaveAuto()
            Out("auto is off" .. (run and run.label == "round" and "; the round in progress is still watched" or ""))
        else
            Out(auto and string.format("auto is on for %d or more people", auto.min) or "auto is off")
        end
    elseif sub == "stop" then
        if not run then Out(armed and "nothing is being watched yet; the next round is armed" or "nothing is being watched") return end
        local ok, err = pcall(Finish, "stopped")
        if not ok then Out("error: " .. tostring(err)) end
    elseif sub == "status" then
        local a = auto and string.format("; auto is on for %d or more people", auto.min) or ""
        if run then Out(string.format("watching (%s) for %.0f s: %d inputs seen, %d movements%s", run.label, SysTime() - run.started, run.inputsAll, run.movements, a))
        elseif armed then Out("armed for the next round" .. a)
        else Out("idle" .. a) end
    else
        Out(USAGE)
    end
end)

LoadAuto()
