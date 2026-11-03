-- TraitorDash role trace: finds out what puts a revived player back to the role they had, or any other unexpected role change.
--
--   traitordash_role_trace on       start tracing, from now on, also after a restart or a map change
--   traitordash_role_trace off      stop
--   traitordash_role_trace status   what is going on
--
-- Console or superadmin only. Off until switched on. While on, it follows the players who have died in the current
-- round and writes to data/traitordash_role_trace.txt (on the server, not the console, which a restart empties):
--   * their death, their spawn (a revive is a spawn after a death), the revive attempts at them
--   * every change of their role or team, with the Lua call stack that made it, and the role they are left with
--   * at the end of the round, the role each of them ends with
-- So when someone is revived by the Necromancer's defibrillator and stays what they were, the file shows whether the
-- change to zombie never came or something set the role back, and which code did it.
--
-- It only watches: the hooks return nothing. Players who have not died are not followed, so the file stays small; it
-- stops growing at 512 KB.

if not SERVER then return end

TraitorDash = TraitorDash or {}

local FILE, SWITCH = "traitordash_role_trace.txt", "traitordash_role_trace_on.txt"
local MAX_FILE = 512 * 1024
local STACK_LEVELS = 14        -- frames of the call stack kept for each role change
local ID = "TraitorDash_RoleTrace"
local EVENTS = { "TTTPrepareRound", "PlayerDeath", "PlayerSpawn", "TTT2UpdateSubrole", "TTT2UpdateTeam", "TTT2AttemptDefibPlayer", "TTTEndRound" }

local on = false
local dead = {}                -- players (by user id) who have died this round

local function Out(msg) print("[TraitorDash:roles] " .. msg) end

local function Name(ply)
    local ok, n = pcall(function() return ply:Nick() end)
    return ok and tostring(n) or "?"
end

local function Role(ply)
    local ok, r = pcall(function() return ply:GetRoleString() end)
    if ok and r ~= nil then return tostring(r) end
    local ok2, i = pcall(function() return ply:GetSubRole() end)
    return ok2 and ("#" .. tostring(i)) or "?"
end

local function Team(ply)
    local ok, t = pcall(function() return ply:GetTeam() end)
    return ok and tostring(t) or "?"
end

local function Id(ply)
    local ok, u = pcall(function() return ply:UserID() end)
    return ok and u or nil
end

local function Add(line)
    local size = file.Size and file.Size(FILE, "DATA") or 0
    if size and size > MAX_FILE then return end
    file.Append(FILE, string.format("%.2f %s\n", CurTime(), line))
end

-- The call stack of the code that is changing a role, without this file's own frames.
local function Stack()
    local out = {}
    local full = debug.traceback("", 3)
    for line in string.gmatch(full, "[^\n]+") do
        if string.find(line, "stack traceback", 1, true) == nil then
            out[#out + 1] = (string.gsub(line, "^%s+", ""))
            if #out >= STACK_LEVELS then break end
        end
    end
    return table.concat(out, "\n    ")
end

local function Safe(fn)
    return function(...)
        local ok, err = pcall(fn, ...)
        if not ok then Out("error: " .. tostring(err)) end
    end
end

local function Followed(ply)
    local id = ply and Id(ply)
    return id ~= nil and dead[id] == true
end

local handlers = {
    TTTPrepareRound = function()
        dead = {}
        Add("round " .. tostring(game.GetMap()))
    end,
    PlayerDeath = function(victim)
        local id = Id(victim)
        if not id then return end
        dead[id] = true
        Add(string.format("DEATH %s role=%s team=%s", Name(victim), Role(victim), Team(victim)))
    end,
    PlayerSpawn = function(ply)
        if not Followed(ply) then return end
        Add(string.format("SPAWN %s role=%s team=%s", Name(ply), Role(ply), Team(ply)))
    end,
    TTT2UpdateSubrole = function(ply, old, new)
        if not Followed(ply) then return end
        Add(string.format("SUBROLE %s %s -> %s (now %s)\n    %s", Name(ply), tostring(old), tostring(new), Role(ply), Stack()))
    end,
    TTT2UpdateTeam = function(ply, old, new)
        if not Followed(ply) then return end
        Add(string.format("TEAM %s %s -> %s\n    %s", Name(ply), tostring(old), tostring(new), Stack()))
    end,
    TTT2AttemptDefibPlayer = function(ply, target)
        if not (target and Followed(target)) then return end
        Add(string.format("DEFIB by %s at %s role=%s team=%s", Name(ply), Name(target), Role(target), Team(target)))
    end,
    TTTEndRound = function()
        for _, ply in ipairs(player.GetAll()) do
            if Followed(ply) then Add(string.format("END %s role=%s team=%s alive=%s", Name(ply), Role(ply), Team(ply), tostring(ply:Alive()))) end
        end
        dead = {}
    end,
}

local function Switch(state)
    if state == on then return end
    on = state
    for _, ev in ipairs(EVENTS) do
        if on then hook.Add(ev, ID, Safe(handlers[ev])) else hook.Remove(ev, ID) end
    end
    dead = {}
    if on then file.Write(SWITCH, "1") else file.Delete(SWITCH) end
end

concommand.Add("traitordash_role_trace", function(ply, _, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local sub = args[1]
    if sub == "on" then
        Switch(true)
        Out("tracing; the result is data/" .. FILE)
    elseif sub == "off" then
        Switch(false)
        Out("off")
    else
        Out(on and ("on; following " .. (function() local n = 0 for _ in pairs(dead) do n = n + 1 end return n end)() .. " dead this round; data/" .. FILE) or "off (traitordash_role_trace on)")
    end
end)

if file.Read(SWITCH, "DATA") then Switch(true) end
