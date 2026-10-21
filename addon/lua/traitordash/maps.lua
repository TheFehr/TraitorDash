-- TraitorDash: which maps does this server have, and which of them does it actually play?
-- (prototype: `traitordash_maps` collects every signal GMod exposes and writes
-- data/traitordash/maps.json, so one run on a real server shows which signal is authoritative)
--
-- Signals, none of them authoritative on its own:
--   * maps on disk or mounted:   file.Find("maps/*.bsp", "GAME")
--   * the gamemode's map pattern: engine.GetGamemodes() -> maps (e.g. "^ttt_")
--   * the map cycle file:         the mapcyclefile ConVar (default cfg/mapcycle.txt)
--   * a map-vote addon (MapVote):  its loaded config, else data/mapvote/config.txt; the cooldown
--                                 list data/mapvote/recentmaps.txt; the mapvote_* ConVars
--   * the running and the next map, and how many mounted addons are maps

TraitorDash = TraitorDash or {}

local Trim = TraitorDash.Util.Trim

-- One map name per line; blank lines and // comments are skipped.
local function ParseCycle(text)
    local maps = {}
    for line in tostring(text or ""):gmatch("[^\n]+") do
        line = Trim(line)
        if line ~= "" and line:sub(1, 2) ~= "//" then maps[#maps + 1] = line end
    end
    return maps
end

local function GamemodePattern(active)
    for _, gm in ipairs(engine.GetGamemodes() or {}) do
        if gm.name == active and type(gm.maps) == "string" and gm.maps ~= "" then return gm.maps end
    end
    return nil
end

-- true / false, or nil when there is no pattern or it cannot be used as a Lua pattern.
local function Matches(name, pattern)
    if not pattern then return nil end
    local ok, found = pcall(string.find, name, pattern)
    if not ok then return nil end
    return found ~= nil
end

local function HasTag(tags, wanted)
    for tag in tostring(tags or ""):gmatch("[^,%s]+") do
        if tag == wanted then return true end
    end
    return false
end

-- The MapVote settings worth reporting, and the ConVars (without the "mapvote_" prefix) that override them.
local VOTE_KEYS = { "MapPrefixes", "MapLimit", "TimeLimit", "AllowCurrentMap", "EnableCooldown", "MapsBeforeRevote", "RTVPlayerCount" }
local VOTE_CONVARS = { "maplimit", "timelimit", "allowcurrentmap", "enablecooldown", "mapsbeforerevote", "rtvplayercount" }

local function ReadJson(path)
    local text = file.Read(path, "DATA")
    if type(text) ~= "string" or text == "" then return nil end
    local ok, parsed = pcall(util.JSONToTable, text)
    return ok and type(parsed) == "table" and parsed or nil
end

local function HasVoteKeys(t)
    for _, key in ipairs(VOTE_KEYS) do
        if t[key] ~= nil then return true end
    end
    return false
end

local function SortedKeys(t)
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    return keys
end

-- A ConVar value as a boolean: "0" and "" are off.
local function Flag(value) return value ~= "0" and value ~= "" end

local function StartsWithAny(name, prefixes)
    for _, prefix in ipairs(prefixes) do
        if name:sub(1, #prefix) == prefix then return true end
    end
    return false
end

-- A map's fingerprint identifies which version of the file the server runs (RFC 10, RFC 11): the
-- SHA-256 of the lowercase hex of the first 1036 bytes (the BSP header: identifier, version, 64
-- lump entries, map revision), a colon, and the file size in decimal. Only those bytes are read,
-- never the file (maps are 100-250 MB). Hex text because the raw bytes are not safe to hash as a
-- Lua string. nil (unknown) for anything that is not a complete map header.
local HEADER_BYTES = 1036

function TraitorDash.MapFingerprint(path, size)
    if type(size) ~= "number" or size < 0 or not util.SHA256 then return nil end
    local ok, result = pcall(function()
        local f = file.Open(path, "rb", "GAME")
        if not f then return nil end
        local data = f:Read(HEADER_BYTES)
        f:Close()
        if type(data) ~= "string" or #data ~= HEADER_BYTES or data:sub(1, 4) ~= "VBSP" then return nil end
        local hex = data:gsub(".", function(c) return string.format("%02x", c:byte()) end)
        return util.SHA256(hex .. ":" .. string.format("%d", size))
    end)
    return ok and result or nil
end

function TraitorDash.CollectMaps()
    local active = engine.ActiveGamemode()
    local pattern = GamemodePattern(active)

    local cycleName = "mapcycle.txt"
    local cv = GetConVar("mapcyclefile")
    if cv and cv:GetString() ~= "" then cycleName = cv:GetString() end
    local cyclePath = "cfg/" .. cycleName
    local cycle = ParseCycle(file.Read(cyclePath, "GAME"))
    local inCycle = {}
    for _, name in ipairs(cycle) do inCycle[name] = true end

    -- MapVote: the addon's own loaded config wins; otherwise its file in the data folder.
    local mapvote = { present = type(MapVote) == "table", prefixes = {}, config = {}, configSource = "none", convars = {},
        recent = {}, recentMissing = {}, globalKeys = {}, configKeys = {} }
    -- What the addon exposes, so a run on a real server shows where its settings live.
    if mapvote.present then
        mapvote.globalKeys = SortedKeys(MapVote)
        if type(MapVote.Config) == "table" then mapvote.configKeys = SortedKeys(MapVote.Config) end
    end
    -- Settings merge per key: the addon's loaded config wins, the data file fills in what it lacks.
    -- (On a real server MapVote.Config held only MapLimit/AllowCurrentMap; the prefixes were in the file.)
    local loaded = mapvote.present and type(MapVote.Config) == "table" and HasVoteKeys(MapVote.Config) and MapVote.Config or nil
    local filed = ReadJson("mapvote/config.txt")
    if filed and not HasVoteKeys(filed) then filed = nil end
    local sources = {}
    if filed then sources[#sources + 1] = filed end
    if loaded then sources[#sources + 1] = loaded end -- later wins
    mapvote.configSource = (loaded and filed) and "merged" or loaded and "global" or filed and "file" or "none"

    local prefixes
    for _, source in ipairs(sources) do
        for _, key in ipairs(VOTE_KEYS) do
            local v = source[key]
            if type(v) == "number" or type(v) == "boolean" or type(v) == "string" then mapvote.config[key] = v end
        end
        if type(source.MapPrefixes) == "table" then prefixes = source.MapPrefixes end
    end
    for _, prefix in ipairs(prefixes or {}) do
        if type(prefix) == "string" then mapvote.prefixes[#mapvote.prefixes + 1] = prefix end
    end
    for _, name in ipairs(VOTE_CONVARS) do
        local cv = GetConVar("mapvote_" .. name)
        if cv then mapvote.convars[name] = cv:GetString() end
    end

    local recent = {}
    for _, entry in ipairs(ReadJson("mapvote/recentmaps.txt") or {}) do
        if type(entry) == "string" then
            local name = entry:gsub("%.bsp$", "")
            recent[name] = true
            mapvote.recent[#mapvote.recent + 1] = name
        end
    end

    -- The ConVars are the live values; they beat the file. MapVote's defaults: cooldown on, current map out.
    local allowCurrent = mapvote.config.AllowCurrentMap == true
    if mapvote.convars.allowcurrentmap ~= nil then allowCurrent = Flag(mapvote.convars.allowcurrentmap) end
    local cooldown = mapvote.config.EnableCooldown ~= false
    if mapvote.convars.enablecooldown ~= nil then cooldown = Flag(mapvote.convars.enablecooldown) end
    local current = game.GetMap()

    -- What decides the pool: the vote's prefixes if there are any, else the gamemode's map pattern.
    mapvote.poolBasis = #mapvote.prefixes > 0 and "prefixes" or pattern and "gamemode" or nil

    local maps, onDisk = {}, {}
    for _, f in ipairs((file.Find("maps/*.bsp", "GAME"))) do
        local name = f:gsub("%.bsp$", "")
        onDisk[name] = true
        local size = file.Size("maps/" .. f, "GAME")
        local entry = {
            name = name, size = size, fingerprint = TraitorDash.MapFingerprint("maps/" .. f, size),
            matchesGamemode = Matches(name, pattern), inCycle = inCycle[name] or false,
            onCooldown = recent[name] or false, isCurrent = name == current,
        }
        if #mapvote.prefixes > 0 then
            entry.inVotePool = StartsWithAny(name, mapvote.prefixes)
        else
            entry.inVotePool = entry.matchesGamemode -- nil when there is no usable pattern either
        end
        if entry.inVotePool ~= nil then
            entry.votable = entry.inVotePool and (allowCurrent or not entry.isCurrent) and (not cooldown or not entry.onCooldown)
        end
        maps[#maps + 1] = entry
    end
    table.sort(maps, function(a, b) return a.name < b.name end)

    local missing = {}
    for _, name in ipairs(cycle) do
        if not onDisk[name] then missing[#missing + 1] = name end
    end
    for _, name in ipairs(mapvote.recent) do
        if not onDisk[name] then mapvote.recentMissing[#mapvote.recentMissing + 1] = name end
    end

    -- `ids` are the Workshop IDs of the mounted map addons (digits only). The backend uses them as
    -- the places to look when it fetches a map's file (RFC 11, 3.2).
    local addons = { mounted = 0, maps = 0, ids = {} }
    for _, addon in ipairs(engine.GetAddons() or {}) do
        if addon.mounted then
            addons.mounted = addons.mounted + 1
            if HasTag(addon.tags, "map") then
                addons.maps = addons.maps + 1
                local id = tostring(addon.wsid or "")
                if id:match("^%d+$") and #id <= 12 then addons.ids[#addons.ids + 1] = id end
            end
        end
    end

    return {
        current = current, next = game.GetMapNext(), gamemode = active, pattern = pattern,
        maps = maps, cycle = { file = cyclePath, maps = cycle, missing = missing },
        mapvote = mapvote, addons = addons,
    }
end

concommand.Add("traitordash_maps", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end

    local r = TraitorDash.CollectMaps()
    local matching, pool, votable = 0, 0, 0
    for _, m in ipairs(r.maps) do
        if m.matchesGamemode then matching = matching + 1 end
        if m.inVotePool then pool = pool + 1 end
        if m.votable then votable = votable + 1 end
    end

    file.CreateDir("traitordash")
    file.Write("traitordash/maps.json", util.TableToJSON(r))
    print(string.format("[TraitorDash] %d maps on disk, %d match the gamemode pattern (%s), %d in the map cycle (%d missing on disk). Map vote addon: %s (config: %s, pool by %s), %d in the vote pool (%d votable now). Wrote data/traitordash/maps.json.",
        #r.maps, matching, tostring(r.pattern), #r.cycle.maps, #r.cycle.missing,
        r.mapvote.present and "yes" or "no", r.mapvote.configSource, tostring(r.mapvote.poolBasis), pool, votable))
end)
