-- TraitorDash: the server's part of the role guide in TTT2's F1 menu (RFC 15, 4.5).
--
-- The dashboard has a public, read-only page for every role. The F1 tab (client files in
-- lua/terrortown/menus/gamemode/ and lua/autorun/client/) shows that page inside the game. This
-- file knows two things the client cannot: the address a PLAYER can reach (`public_url`, https
-- only) and the server's id on the dashboard (asked once, GET /api/v1/whoami). It sends both to
-- each player once, and answers `!role`, `!role <name>` and `!roles`.
--
-- A net message carries a role NAME at most, never an address: the client builds the address
-- itself from the base it was given once, and never opens one it was sent. With either value
-- missing the feature is off, nothing is sent, and one console line says why.

TraitorDash = TraitorDash or {}
local Guide = {}
TraitorDash.RoleGuide = Guide

if not (TraitorDash.Util) then include("traitordash/util.lua") end
local Util = TraitorDash.Util
local ASK_EVERY = 2 -- seconds between two requests of one player

Guide.base = nil      -- the public address, cleaned
Guide.serverId = nil  -- from whoami
Guide.state = "off"   -- "off" | "asking" | "on"
Guide.reason = "not started"
local told = {}       -- console messages already printed
local lastAsk = {}    -- steam id -> SysTime of the last accepted request

if SERVER then
    util.AddNetworkString("TraitorDash_RolesInit")
    util.AddNetworkString("TraitorDash_RolesOpen")
    util.AddNetworkString("TraitorDash_RolesKey")
end

local function SaidOnce(key, text)
    if told[key] then return end
    told[key] = true
    print("[TraitorDash] " .. text)
end

--- The address players can reach, or nil and why. https only: a plain http address could be
--- altered on the way, and a private address is useless to a player's machine.
function Guide.CleanPublicUrl(raw)
    if type(raw) ~= "string" or raw == "" then return nil, "no public_url is set" end
    local url = raw:gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
    local ok, why = Util.CheckBase(url)
    if not ok then
        return nil, why == "chars" and "public_url has characters that are not allowed"
            or why == "long" and "public_url is too long"
            or "public_url must be an https:// address"
    end
    return url
end

--- A role name as typed, matched against the roles the game has (case-insensitive); the game's own
--- spelling, or nil. Anything with other characters, or too long, is nil before any lookup.
function Guide.ResolveRoleName(input, known)
    if type(input) ~= "string" then return nil end
    local typed = input:gsub("^%s+", ""):gsub("%s+$", "")
    if not Util.ValidName(typed) then return nil end
    local lower = typed:lower()
    for _, name in ipairs(known or {}) do
        if type(name) == "string" and name:lower() == lower then return name end
    end
    return nil
end

--- What the game calls its roles, as a list of names.
function Guide.KnownRoles()
    local out = {}
    if roles and roles.GetList then
        for _, r in pairs(roles.GetList()) do
            if type(r) == "table" and type(r.name) == "string" and r.name ~= "none" then out[#out + 1] = r.name end
        end
    end
    return out
end

local function OwnRoleName(ply)
    local ok, data = pcall(function() return ply:GetSubRoleData() end)
    local name = ok and type(data) == "table" and data.name or nil
    if type(name) ~= "string" or name == "" or name == "none" then return nil end
    return name
end

--- Sends the base and the id to one player, or to everybody when `ply` is nil. Only when the feature is on.
function Guide.SendInit(ply)
    if Guide.state ~= "on" then return end
    net.Start("TraitorDash_RolesInit")
    net.WriteString(Guide.base)
    net.WriteString(Guide.serverId)
    if ply then net.Send(ply) else net.Broadcast() end
end

--- Tells a player's client to open the tab: on `name`, or on the list when name is "".
function Guide.SendOpen(ply, name)
    net.Start("TraitorDash_RolesOpen")
    net.WriteString(name or "")
    net.Send(ply)
end

--- A request from a player. `arg` is what followed the command ("" for none); `wantList` for !roles.
--- Returns "sent", "ratelimited", "off", "noname" or "unknown", so the caller and the tests can tell.
function Guide.Request(ply, arg, wantList)
    if Guide.state ~= "on" then
        ply:ChatPrint("The role guide is not available on this server.")
        return "off"
    end
    local id = ply:SteamID64() or tostring(ply)
    local now = SysTime()
    if lastAsk[id] and now - lastAsk[id] < ASK_EVERY then return "ratelimited" end
    lastAsk[id] = now

    if wantList then Guide.SendOpen(ply, ""); return "sent" end

    local typed = (arg or ""):gsub("^%s+", ""):gsub("%s+$", "")
    local name
    if typed == "" then
        name = OwnRoleName(ply)
        if not name then ply:ChatPrint("You have no role yet. Try !role <name> or !roles."); return "noname" end
    else
        name = Guide.ResolveRoleName(typed, Guide.KnownRoles())
        if not name then
            -- the text is not echoed: a bad name is at most 64 characters of plain text, but there is no need to repeat it
            ply:ChatPrint("No role by that name. Try !roles for the list.")
            return "unknown"
        end
    end
    Guide.SendOpen(ply, name)
    return "sent"
end

--- Chat: `!role`, `!role <name>`, `!roles`. Returns "" (hide the line) when it was ours, else nil.
function Guide.OnChat(ply, text)
    if type(text) ~= "string" then return nil end
    local command, rest = text:match("^%s*!(%a+)%s*(.*)$")
    command = command and command:lower()
    if command == "roles" and rest == "" then Guide.Request(ply, "", true); return "" end
    if command == "role" then Guide.Request(ply, rest, false); return "" end
    return nil
end

-- The game vouches for its players (RFC 16, 4). The dashboard makes a short-lived key for each
-- player we name, and only for the server's token; the client puts it into the link it opens, and
-- the dashboard turns it into a session of a plain user. The key is a value the dashboard made: it is
-- checked for its shape here and sent only to the player it was made for.
local KEY_SHAPE = "^%d+%.%d+%.[%w_%-]+$"
local MAX_KEY = 100
local KEY_EVERY = 600       -- seconds between two rounds of keys (a key lives 15 minutes)
local KEY_BATCH_WAIT = 3    -- seconds to collect players who join together
local pendingKeys = {}      -- steam id 64 -> true

--- Asks for a key for each of `players` (Player objects) and sends each its own. Returns how many were asked for.
function Guide.IssueKeys(players)
    if Guide.state ~= "on" then return 0 end
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return 0 end
    local ids, byId = {}, {}
    for _, ply in ipairs(players) do
        if IsValid(ply) and not (ply.IsBot and ply:IsBot()) then
            local id = ply:SteamID64()
            if type(id) == "string" and id:match("^%d+$") and #id == 17 and not byId[id] and #ids < Util.MAX_PLAYERS then
                ids[#ids + 1] = id
                byId[id] = ply
            end
        end
    end
    if #ids == 0 then return 0 end
    local payload = util.TableToJSON({ players = ids })
    if not payload or payload == "" then return 0 end
    HTTP({
        url = cfg.url .. "/api/v1/ingame-keys",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. cfg.token },
        body = payload,
        timeout = 15,
        success = function(code, body)
            local parsed = code == 200 and type(body) == "string" and util.JSONToTable(body) or nil
            local keys = type(parsed) == "table" and parsed.keys or nil
            if type(keys) ~= "table" then
                SaidOnce("keys" .. tostring(code), "Could not get keys for the players (HTTP " .. tostring(code) .. "); the in-game pages stay public only.")
                return
            end
            local sent = 0
            for id, key in pairs(keys) do
                local ply = byId[id]
                if IsValid(ply) and type(key) == "string" and #key <= MAX_KEY and key:match(KEY_SHAPE) then
                    net.Start("TraitorDash_RolesKey")
                    net.WriteString(key)
                    net.Send(ply)
                    sent = sent + 1
                end
            end
            SaidOnce("keysok", "Got " .. sent .. " key(s) for the players from the dashboard (more are sent quietly from now on).")
        end,
        failed = function(err) SaidOnce("keysfail", "Could not get keys for the players: " .. tostring(err)) end,
    })
    return #ids
end

--- Collects joining players and asks for their keys in one request.
local function QueueKey(ply)
    if not IsValid(ply) then return end
    local id = ply:SteamID64()
    if type(id) ~= "string" then return end
    local first = next(pendingKeys) == nil
    pendingKeys[id] = true
    if not first then return end
    timer.Simple(KEY_BATCH_WAIT, function()
        local list = {}
        for _, p in ipairs(player.GetAll()) do
            if pendingKeys[p:SteamID64() or ""] then list[#list + 1] = p end
        end
        pendingKeys = {}
        Guide.IssueKeys(list)
    end)
end

--- Works out the base and asks the dashboard for the server's id. Safe to call again.
function Guide.Start()
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then
        Guide.state, Guide.reason = "off", "the bridge is not configured"
        return
    end
    local raw = TraitorDash.GetPublicUrlRaw and TraitorDash.GetPublicUrlRaw() or ""
    local base, why = Guide.CleanPublicUrl(raw)
    if not base then
        Guide.state, Guide.reason = "off", why
        SaidOnce("base", "Role guide is off: " .. why .. ". Set \"public_url\" in data/traitordash/config.json (or traitordash_public_url) to the https address players can reach.")
        return
    end
    Guide.base, Guide.state = base, "asking"
    HTTP({
        url = cfg.url .. "/api/v1/whoami",
        method = "GET",
        headers = { ["Authorization"] = "Bearer " .. cfg.token },
        timeout = 15,
        success = function(code, body)
            local parsed = code == 200 and type(body) == "string" and util.JSONToTable(body) or nil
            local id = type(parsed) == "table" and parsed.server_id or nil
            if not Util.ValidServerId(id) then
                Guide.state = "off"
                Guide.reason = code == 404 and "the dashboard is too old (no /api/v1/whoami)" or ("whoami answered HTTP " .. tostring(code))
                SaidOnce("whoami", "Role guide is off: " .. Guide.reason .. ".")
                return
            end
            Guide.serverId, Guide.state, Guide.reason = id, "on", "on"
            print("[TraitorDash] Role guide is on (" .. base .. ").")
            Guide.SendInit(nil)
            Guide.IssueKeys(player.GetAll())
        end,
        failed = function(err)
            Guide.state, Guide.reason = "off", "whoami failed: " .. tostring(err)
            SaidOnce("whoami", "Role guide is off: " .. Guide.reason .. ".")
        end,
    })
end

hook.Add("PlayerSay", "TraitorDash_RoleGuide", function(ply, text) return Guide.OnChat(ply, text) end)
hook.Add("PlayerInitialSpawn", "TraitorDash_RoleGuide", function(ply)
    -- the client is not ready for a net message at the moment it spawns
    timer.Simple(5, function()
        if not IsValid(ply) then return end
        Guide.SendInit(ply)
        QueueKey(ply)
    end)
end)
timer.Create("TraitorDash_RoleGuideKeys", KEY_EVERY, 0, function() Guide.IssueKeys(player.GetAll()) end)

concommand.Add("traitordash_role", function(ply, _, args)
    if not IsValid(ply) then print("[TraitorDash] Role guide: " .. Guide.state .. " (" .. tostring(Guide.reason) .. ")"); return end
    Guide.Request(ply, args and args[1] or "", false)
end)

timer.Simple(8, Guide.Start)
