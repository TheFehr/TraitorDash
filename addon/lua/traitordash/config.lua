-- TraitorDash: where the bridge finds the backend URL and its API token (RFC 8).
--
-- 1. data/traitordash/config.json   { "url": "https://...", "token": "..." }
-- 2. otherwise the ConVars traitordash_url / traitordash_token (server.cfg)
--
-- Each setting is decided on its own, and the file wins. The file is read once (at first use and
-- on `traitordash_reload`), never per poll, so asking for the configuration costs no disk I/O.
-- Every sender goes through TraitorDash.GetConfig(); nothing else reads the ConVars. If this
-- file fails to load, GetConfig does not exist and every sender stays idle (fail closed).

TraitorDash = TraitorDash or {}

local CONFIG_PATH = "traitordash/config.json"

local loaded = false
local fromFile = {}   -- the valid settings found in the file: { url = "...", token = "..." }

local function NonEmptyString(v)
    if type(v) == "string" and v ~= "" then return v end
    return nil
end

local function ConVarString(name)
    local cv = GetConVar(name)
    local v = cv and cv:GetString()
    return type(v) == "string" and v or ""
end

-- Reads the file into `fromFile`. A missing or empty file is normal; anything that is present
-- but not a JSON object is reported, and the ConVars are used instead.
local function LoadFile()
    loaded = true
    fromFile = {}

    local ok, raw = pcall(file.Read, CONFIG_PATH, "DATA")
    if not ok or type(raw) ~= "string" or raw == "" then return end

    local okParse, parsed = pcall(util.JSONToTable, raw)
    if not okParse or type(parsed) ~= "table" then
        print("[TraitorDash] data/" .. CONFIG_PATH .. " is not valid JSON; using server.cfg values.")
        return
    end

    fromFile.url = NonEmptyString(parsed.url)
    fromFile.token = NonEmptyString(parsed.token)
end

-- Where `key` ("url" / "token") comes from, and its raw value.
local function Resolve(key, convarName)
    if fromFile[key] then return fromFile[key], "file" end
    local v = ConVarString(convarName)
    if v ~= "" then return v, "convar" end
    return "", "none"
end

--- The configuration, as a table:
---   url         the backend base URL, cleaned and trusted (https or a private address), or nil
---   rawUrl      the URL as configured ("" if none), for messages about a refused one
---   token       the API token ("" if none)
---   urlSource, tokenSource   "file" | "convar" | "none"
---   source      "file" if either value came from the file, else "convar" if either did, else "none"
function TraitorDash.GetConfig()
    if not loaded then LoadFile() end

    local rawUrl, urlSource = Resolve("url", "traitordash_url")
    local token, tokenSource = Resolve("token", "traitordash_token")

    local url = nil
    if rawUrl ~= "" and TraitorDash.TrustedBaseUrl then url = TraitorDash.TrustedBaseUrl(rawUrl) end

    local source = "none"
    if urlSource == "file" or tokenSource == "file" then source = "file"
    elseif urlSource == "convar" or tokenSource == "convar" then source = "convar" end

    return {
        url = url, rawUrl = rawUrl, token = token,
        urlSource = urlSource, tokenSource = tokenSource, source = source,
    }
end

--- Re-reads the file and lets the warn-once messages speak again.
function TraitorDash.ReloadConfig()
    TraitorDash.WarnedTransport = nil
    LoadFile()
    return TraitorDash.GetConfig()
end

local SOURCE_LABEL = { file = "file", convar = "server.cfg", none = "not set" }
TraitorDash.ConfigSourceLabel = function(source) return SOURCE_LABEL[source] or tostring(source) end

--- Said once at startup: what is missing, and what the file overrides. Never prints a token.
function TraitorDash.ReportConfig()
    local c = TraitorDash.GetConfig()

    if c.token == "" then
        print("[TraitorDash] Not configured: no token. Create a server in the dashboard and put its token in data/" .. CONFIG_PATH .. " (or set traitordash_token in server.cfg).")
    end
    if c.rawUrl == "" then
        print("[TraitorDash] Not configured: no dashboard URL. Set \"url\" in data/" .. CONFIG_PATH .. " (or traitordash_url in server.cfg).")
    end

    -- A ConVar that somebody set in server.cfg and that the file now overrides.
    for _, s in ipairs({ { "url", "traitordash_url" }, { "token", "traitordash_token" } }) do
        local key, name = s[1], s[2]
        local cv = GetConVar(name)
        local value = ConVarString(name)
        local default = (cv and cv.GetDefault and cv:GetDefault()) or ""
        if fromFile[key] and value ~= "" and value ~= default and value ~= fromFile[key] then
            print("[TraitorDash] " .. CONFIG_PATH:gsub("^traitordash/", "") .. " overrides " .. name .. " from server.cfg.")
        end
    end
end

concommand.Add("traitordash_reload", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    local c = TraitorDash.ReloadConfig()
    print("[TraitorDash] Configuration reloaded (url: " .. TraitorDash.ConfigSourceLabel(c.urlSource) .. ", token: " .. TraitorDash.ConfigSourceLabel(c.tokenSource) .. ").")
end)
