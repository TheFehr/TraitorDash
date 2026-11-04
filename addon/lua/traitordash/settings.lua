-- TraitorDash: the bridge's own settings that the dashboard may change (RFC 23).
--
-- The list below is all the dashboard can touch, with each setting's kind and range; keep it identical to
-- backend/src/services/bridgeSettings.ts (a test compares the two). Not on it, on purpose: traitordash_url, traitordash_token and
-- traitordash_public_url (how the bridge finds and trusts the dashboard, and where players are sent), and everything that is not a
-- setting of the bridge. The bridge decides what it accepts: a `setting` command for a name not on this list, or a value outside its
-- range, is refused here whatever the backend says.
--
-- What the dashboard sets is kept in data/traitordash/config.json under "settings" (the other keys are left as they are) and applied
-- when the bridge starts, after server.cfg, so a restart does not undo it. The bridge reports what it runs with, so the dashboard can
-- show it. This file never reads or writes anything else.

TraitorDash = TraitorDash or {}

local CONFIG_PATH = "traitordash/config.json"

TraitorDash.SettingList = {
    { name = "traitordash_stats",                kind = "bool",   default = "1" },
    { name = "traitordash_stats_debug",          kind = "bool",   default = "1" },
    { name = "traitordash_stats_bots",           kind = "bool",   default = "0" },
    { name = "traitordash_track",                kind = "bool",   default = "0" },
    { name = "traitordash_track_interval_min",   kind = "number", default = "0.2", min = 0.1,  max = 2 },
    { name = "traitordash_track_interval_max",   kind = "number", default = "1",   min = 0.2,  max = 5 },
    { name = "traitordash_track_budget_ms",      kind = "number", default = "0.5", min = 0.05, max = 5 },
}

local BY_NAME = {}
for _, s in ipairs(TraitorDash.SettingList) do BY_NAME[s.name] = s end

--- The value as the bridge will write it, or nil and the reason. `value` is a string.
function TraitorDash.CheckSettingValue(name, value)
    local s = BY_NAME[name]
    if not s then return nil, "not a setting the dashboard may change" end
    if type(value) ~= "string" or #value == 0 or #value > 8 then return nil, "not a value" end
    if s.kind == "bool" then
        if value == "0" or value == "1" then return value end
        return nil, "must be 0 or 1"
    end
    if not (value:match("^%d+%.?%d*$") or value:match("^%.%d+$")) then return nil, "not a number" end
    local n = tonumber(value)
    if not n or n < s.min or n > s.max then return nil, "out of range (" .. s.min .. " to " .. s.max .. ")" end
    return string.format("%.4g", n)
end

--- Reads exactly what the backend formats: `name value`. Returns name, value; or nil and the reason (and the name when it had one).
function TraitorDash.ParseSettingCommand(payload)
    if type(payload) ~= "string" or #payload > 80 then return nil, "malformed" end
    local name, value = payload:match("^(traitordash_[%w_]+) ([%d%.]+)$")
    if not name then return nil, "malformed" end
    local v, why = TraitorDash.CheckSettingValue(name, value)
    if not v then return nil, why, name end
    return name, v
end

-- ---- the file

local function ReadFile()
    local raw = file.Read(CONFIG_PATH, "DATA")
    if raw == nil or raw == "" then return {} end
    local ok, t = pcall(util.JSONToTable, raw)
    if not ok or type(t) ~= "table" then return nil, "data/" .. CONFIG_PATH .. " is not valid JSON" end
    return t
end

local function SaveToFile(name, value)
    local t, why = ReadFile()
    if not t then return false, why end -- a file that cannot be read is not overwritten
    if type(t.settings) ~= "table" then t.settings = {} end
    t.settings[name] = value
    if t.version == nil then t.version = 1 end
    local json = util.TableToJSON(t)
    if not json then return false, "the file could not be encoded" end
    file.CreateDir("traitordash")
    file.Write(CONFIG_PATH, json)
    if file.Read(CONFIG_PATH, "DATA") ~= json then return false, "data/" .. CONFIG_PATH .. " could not be written" end
    return true
end

--- What the file holds: name -> value, only for names on the list and values that pass the check.
local function SavedSettings()
    local out = {}
    local t = ReadFile()
    if type(t) ~= "table" or type(t.settings) ~= "table" then return out end
    for name, value in pairs(t.settings) do
        local v = TraitorDash.CheckSettingValue(name, tostring(value))
        if v then out[name] = v end
    end
    return out
end

local function Same(a, b)
    if a == nil or b == nil then return false end
    local x, y = tonumber(a), tonumber(b)
    if x and y then return math.abs(x - y) < 1e-9 end
    return tostring(a) == tostring(b)
end

-- ---- applying

--- Applies a checked setting. `fromFile`: it came from the file (at start), so it is not written back.
function TraitorDash.ApplySetting(name, value, fromFile)
    local v, why = TraitorDash.CheckSettingValue(name, value)
    if not v then return false, why end
    if not GetConVar(name) then return false, "that ConVar does not exist on this server" end
    RunConsoleCommand(name, v)
    if not fromFile then
        local ok, err = SaveToFile(name, v)
        if not ok then print("[TraitorDash] The setting " .. name .. " is applied but not kept for the next start: " .. tostring(err)) end
    end
    return true
end

--- A `setting` command from the dashboard (the payload is `name value`).
function TraitorDash.HandleSettingCommand(payload)
    local name, value, who = TraitorDash.ParseSettingCommand(payload)
    if not name then
        print("[TraitorDash] WARNING: Refused a setting command (" .. tostring(value) .. "): " .. tostring(payload):sub(1, 80))
        return false
    end
    local ok, why = TraitorDash.ApplySetting(name, value)
    if not ok then
        print("[TraitorDash] WARNING: Refused a setting command (" .. tostring(why) .. "): " .. tostring(payload):sub(1, 80))
        return false
    end
    print("[TraitorDash] SETTING: " .. name .. " " .. value)
    return true
end

--- At start: what the dashboard set is applied over what server.cfg says.
function TraitorDash.ApplySavedSettings()
    local changed, kept = {}, SavedSettings()
    for _, s in ipairs(TraitorDash.SettingList) do
        local saved = kept[s.name]
        local cv = GetConVar(s.name)
        if saved and cv and not Same(cv:GetString(), saved) then
            RunConsoleCommand(s.name, saved)
            changed[#changed + 1] = s.name .. "=" .. saved
        end
    end
    if #changed > 0 then print("[TraitorDash] Settings from the dashboard applied: " .. table.concat(changed, ", ")) end
    return #changed
end

-- ---- reporting

local noEndpointOn = nil -- the map on which the backend said it does not know /api/v1/settings

--- Tells the dashboard what the bridge runs with: the value of each setting on the list, and where the file holds another one.
function TraitorDash.ReportSettings()
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    local map = game and game.GetMap and game.GetMap() or ""
    if noEndpointOn == map then return end
    local values, saved, kept = {}, {}, SavedSettings()
    for _, s in ipairs(TraitorDash.SettingList) do
        local cv = GetConVar(s.name)
        if cv then
            values[s.name] = cv:GetString()
            if kept[s.name] and not Same(kept[s.name], values[s.name]) then saved[s.name] = kept[s.name] end
        end
    end
    local body = { format = 1, settings = values }
    if next(saved) then body.saved = saved end
    HTTP({
        url = cfg.url .. "/api/v1/settings",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. cfg.token },
        body = util.TableToJSON(body),
        timeout = 15,
        success = function(code)
            if code == 404 then noEndpointOn = map
            elseif code ~= 200 then print("[TraitorDash] The settings report was rejected (HTTP " .. tostring(code) .. ")") end
        end,
        failed = function() end, -- the next report will do
    })
end

--- A burst of changes is one report, two seconds after the last.
function TraitorDash.QueueSettingsReport()
    timer.Create("TraitorDash_ReportSettings", 2, 1, TraitorDash.ReportSettings)
end

--- Called once from the bridge's Init, when every file is loaded and server.cfg has run.
function TraitorDash.StartSettings()
    TraitorDash.ApplySavedSettings()
    for _, s in ipairs(TraitorDash.SettingList) do
        if GetConVar(s.name) then cvars.AddChangeCallback(s.name, TraitorDash.QueueSettingsReport, "TraitorDash_Settings") end
    end
    -- the map's server.cfg may run after this: once more, a moment later
    timer.Simple(5, TraitorDash.ApplySavedSettings)
    timer.Simple(8, TraitorDash.ReportSettings)
    timer.Create("TraitorDash_ReportSettingsEvery", 600, 0, TraitorDash.ReportSettings)
end

concommand.Add("traitordash_settings", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local kept = SavedSettings()
    print("--- TraitorDash settings (the dashboard can change these) ---")
    for _, s in ipairs(TraitorDash.SettingList) do
        local cv = GetConVar(s.name)
        local value = cv and cv:GetString() or "(not loaded)"
        local note = ""
        if cv and Same(value, s.default) then note = " (default)" end
        if kept[s.name] then note = note .. (Same(kept[s.name], value) and " (set by the dashboard)" or (" (the dashboard set " .. kept[s.name] .. "; this changed since)")) end
        print(string.format("%-34s %s%s", s.name, value, note))
    end
end)
