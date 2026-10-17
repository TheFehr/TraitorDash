-- TraitorDash GMod Side: TraitorLink Bridge
-- Scans for roles and pushes them to the backend for schema extraction

TraitorDash = TraitorDash or {}
TraitorDash.RoleCodeCache = TraitorDash.RoleCodeCache or {}
TraitorDash.RegisteredCallbacks = TraitorDash.RegisteredCallbacks or {}
TraitorDash.ConVarToRoles = TraitorDash.ConVarToRoles or {}
TraitorDash.RoleMeta = TraitorDash.RoleMeta or {}            -- role name -> { abbr = "surv" }
TraitorDash.WatchedConVars = TraitorDash.WatchedConVars or {} -- ConVars already reporting changes
TraitorDash.PendingValues = TraitorDash.PendingValues or {}   -- name -> role, waiting to be pushed

-- What the bridge will apply on the backend's say-so (see commands.lua). If it cannot be
-- loaded, every command is refused rather than run unchecked.
local okCommands, errCommands = pcall(include, "traitordash/commands.lua")
if not okCommands then print("[TraitorDash] commands.lua failed to load; all commands will be refused: " .. tostring(errCommands)) end

local cv_url = CreateConVar("traitordash_url", "http://localhost:3000", {FCVAR_ARCHIVE, FCVAR_PROTECTED}, "The base URL of the TraitorDash backend.")
-- No default token: an empty one keeps the bridge idle instead of calling the backend with a
-- well-known value. The token is set in server.cfg (the Ansible role writes it).
local cv_token = CreateConVar("traitordash_token", "", {FCVAR_ARCHIVE, FCVAR_PROTECTED}, "The API token for authenticating with the backend.")

-- Who is an admin right now. The result is only informational (the backend logs it), so
-- this must NEVER be able to break a poll or an ingest.
--
-- CAMI.PlayerHasAccess is ASYNCHRONOUS: it requires a callback and reports the answer
-- through it (ULib's implementation calls `callback(...)` unconditionally). The bridge used
-- to call it without one, which threw on every poll as soon as a player was connected, and
-- an aborted poll means no heartbeat and no config changes delivered. The answers are cached
-- per player; each call asks again so the cache follows permission changes within a poll.
TraitorDash.AdminAccessCache = TraitorDash.AdminAccessCache or {}
local PRIVILEGE = "ttt2_conf_edit"

local function AskCami(ply, steamId)
    if not CAMI or not CAMI.PlayerHasAccess then return end

    local ok, err = pcall(CAMI.PlayerHasAccess, ply, PRIVILEGE, function(allowed)
        TraitorDash.AdminAccessCache[steamId] = allowed and true or false
    end)

    if not ok and not TraitorDash.WarnedCami then
        TraitorDash.WarnedCami = true -- once, not every ten seconds
        print("[TraitorDash] CAMI admin lookup failed, falling back to IsSuperAdmin only: " .. tostring(err))
    end
end

function TraitorDash.GetActiveAdmins()
    local admins = {}

    local ok, err = pcall(function()
        for _, ply in ipairs(player.GetAll()) do
            if IsValid(ply) then
                local steamId = ply:SteamID64() or ply:SteamID()
                AskCami(ply, steamId)

                if ply:IsSuperAdmin() or TraitorDash.AdminAccessCache[steamId] then
                    table.insert(admins, steamId)
                end
            end
        end
    end)

    if not ok then
        print("[TraitorDash] Could not list admins (ignored): " .. tostring(err))
        return {}
    end

    return admins
end

hook.Add("PlayerDisconnected", "TraitorDash_AdminCache", function(ply)
    if IsValid(ply) then TraitorDash.AdminAccessCache[ply:SteamID64() or ply:SteamID()] = nil end
end)

-- ---------------------------------------------------------------------------
-- Live ConVar values
--
-- The dashboard form should show what is actually set on THIS server, not the role's
-- defaults. After a role is ingested, the backend answers with the role's schema (which
-- carries the ConVar names); the bridge reads each of those ConVars, plus the standard
-- per-role ones TTT2 creates for every role but a role file never declares, and pushes
-- value / default / min / max (or "does not exist") to /api/v1/values. Each ConVar is
-- also watched, so a change from the console, an admin mod or the dashboard itself is
-- pushed a moment later.
-- ---------------------------------------------------------------------------
local NAME_SUFFIXES = { "enabled", "random", "traitor_button", "pct", "max", "min_players", "karma_min" }
local ABBR_SUFFIXES = { "credits_starting", "credits_award_dead_enb", "credits_award_kill_enb", "shop_fallback" }

local function GetApi()
    local baseUrl = cv_url:GetString():gsub("[\"']", ""):gsub("/+$", "")
    local token = cv_token:GetString()
    if baseUrl == "" or token == "" then return nil end
    return baseUrl, token
end

function TraitorDash.ReadConVar(name, roleName)
    local cv = GetConVar(name)
    if not cv then return { name = name, role = roleName, present = false } end

    return {
        name = name,
        role = roleName,
        present = true,
        value = cv:GetString(),
        default = cv:GetDefault(),
        min = cv:GetMin(),
        max = cv:GetMax()
    }
end

function TraitorDash.PushValues(entries)
    if #entries == 0 then return end

    local baseUrl, token = GetApi()
    if not baseUrl then return end

    -- The backend accepts at most 400 entries per request.
    for first = 1, #entries, 400 do
        local chunk = {}
        for i = first, math.min(first + 399, #entries) do chunk[#chunk + 1] = entries[i] end

        HTTP({
            url = baseUrl .. "/api/v1/values",
            method = "POST",
            headers = {
                ["Content-Type"] = "application/json",
                ["Authorization"] = "Bearer " .. token
            },
            body = util.TableToJSON({ convars = chunk }),
            timeout = 15,
            success = function(code)
                if code ~= 200 then print("[TraitorDash] Live values rejected (HTTP " .. code .. ")") end
            end,
            failed = function(err)
                print("[TraitorDash] Live values failed: " .. tostring(err))
            end
        })
    end
end

local function FlushPendingValues()
    local entries = {}
    for name, roleName in pairs(TraitorDash.PendingValues) do
        entries[#entries + 1] = TraitorDash.ReadConVar(name, roleName)
    end
    TraitorDash.PendingValues = {}
    TraitorDash.PushValues(entries)
end

-- Debounced: a burst of changes becomes one request, one second after the last.
function TraitorDash.QueueValue(name, roleName)
    TraitorDash.PendingValues[name] = roleName
    timer.Create("TraitorDash_PushValues", 1, 1, FlushPendingValues)
end

function TraitorDash.WatchConVar(name, roleName)
    if TraitorDash.WatchedConVars[name] then return end
    TraitorDash.WatchedConVars[name] = true

    cvars.AddChangeCallback(name, function()
        TraitorDash.QueueValue(name, roleName)
    end, "TraitorDash_Live")
end

function TraitorDash.ReportRole(roleName, schema)
    local seen, order = {}, {}
    local function add(name)
        if isstring(name) and name ~= "" and not seen[name] then
            seen[name] = true
            order[#order + 1] = name
        end
    end

    for _, item in ipairs(schema or {}) do
        local args = item.args
        if istable(args) then
            add(args.convar)
            add(args.serverConvar)
        end
    end

    -- Standard per-role ConVars the role file does not declare.
    for _, suffix in ipairs(NAME_SUFFIXES) do add("ttt_" .. roleName .. "_" .. suffix) end

    local abbr = (TraitorDash.RoleMeta[roleName] or {}).abbr
    if isstring(abbr) and abbr ~= "" then
        for _, suffix in ipairs(ABBR_SUFFIXES) do add("ttt_" .. abbr .. "_" .. suffix) end
    end

    local entries = {}
    for _, name in ipairs(order) do
        local entry = TraitorDash.ReadConVar(name, roleName)
        entries[#entries + 1] = entry
        if entry.present then TraitorDash.WatchConVar(name, roleName) end
    end

    TraitorDash.PushValues(entries)
end

-- ---------------------------------------------------------------------------
-- Language files
--
-- A role's settings menu labels are translation keys (label_med_armor); the text is
-- defined in terrortown/lang/en.lua (TTT2 core) and terrortown/lang/en/<addon>.lua (one per
-- role addon). Those paths are relative to the LUA search path, which merges every mounted
-- addon, so one lookup sees them all. They are sent to the backend ONCE per sync, before
-- any role is ingested, and the backend uses them while extracting each role.
-- ---------------------------------------------------------------------------
local function ReadLangFiles()
    local files = {}

    local core = file.Read("terrortown/lang/en.lua", "LUA")
    if core and core ~= "" then files["core"] = core end

    for _, name in ipairs((file.Find("terrortown/lang/en/*.lua", "LUA"))) do
        local content = file.Read("terrortown/lang/en/" .. name, "LUA")
        if content and content ~= "" then files[name] = content end
    end

    return files
end

function TraitorDash.PushLang(callback)
    local baseUrl, token = GetApi()
    local files = ReadLangFiles()

    if not baseUrl or next(files) == nil then
        if callback then callback() end
        return
    end

    local count = 0
    for _ in pairs(files) do count = count + 1 end

    local payload = util.TableToJSON({ files = files })
    if not payload or payload == "" then
        print("[TraitorDash] Could not encode the language files (too large?)")
        if callback then callback() end
        return
    end

    print("[TraitorDash] Sending " .. count .. " language files (" .. math.floor(#payload / 1024) .. " KB)...")

    HTTP({
        url = baseUrl .. "/api/v1/lang",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " .. token
        },
        body = payload,
        timeout = 60,
        success = function(code, body)
            if code == 200 then
                print("[TraitorDash] Language files OK")
            else
                print("[TraitorDash] Language files rejected (HTTP " .. code .. "): " .. tostring(body))
            end
            if callback then callback() end
        end,
        failed = function(err)
            print("[TraitorDash] Language files failed: " .. tostring(err))
            if callback then callback() end
        end
    })
end

function TraitorDash.IngestRole(roleName, roleCode, hash, force, callback)
    local baseUrl = cv_url:GetString()
    local token = cv_token:GetString()
    
    -- Ensure URL is clean
    baseUrl = baseUrl:gsub("[\"']", ""):gsub("/+$", "")
    
    if baseUrl == "" or token == "" then 
        print("[TraitorDash] ERROR: URL or Token not set!")
        if callback then callback() end
        return 
    end

    -- Scan for GetConVar and Global state accessors
    local convar_state = {}
    local data_state = {}

    -- Extract ConVars
    for name in roleCode:gmatch("GetConVar%([\"']([^\"']+)[\"']%)") do
        if not convar_state[name] then
            local cv = GetConVar(name)
            if cv then
                convar_state[name] = cv:GetString()
            end

            -- Setup Dynamic Re-Ingestion for this ConVar
            TraitorDash.ConVarToRoles[name] = TraitorDash.ConVarToRoles[name] or {}
            TraitorDash.ConVarToRoles[name][roleName] = true

            if not TraitorDash.RegisteredCallbacks[name] then
                cvars.AddChangeCallback(name, function(cv_name, old, new)
                    if old == new then return end
                    local rolesToUpdate = TraitorDash.ConVarToRoles[cv_name]
                    if not rolesToUpdate then return end

                    for rName, _ in pairs(rolesToUpdate) do
                        local cached = TraitorDash.RoleCodeCache[rName]
                        if cached then
                            print("[TraitorDash] ConVar " .. cv_name .. " changed. Re-ingesting " .. rName .. "...")
                            -- Re-ingestion due to convar change should be forced to update values
                            local newHash = util.MD5(cached)
                            TraitorDash.IngestRole(rName, cached, newHash, true)
                        end
                    end
                end, "TraitorDash_ReIngest")
                TraitorDash.RegisteredCallbacks[name] = true
            end
        end
    end

    -- Extract Global/TTT2 Data (GetGlobal*, TTT2.DATA)
    for name in roleCode:gmatch("GetGlobal%w+%([\"']([^\"']+)[\"']%)") do
        if not data_state[name] then
            local val = _G["GetGlobalVar"] and GetGlobalVar(name) or nil
            if val == nil then
                for _, t in ipairs({"Bool", "Int", "String", "Float"}) do
                    local v = _G["GetGlobal"..t](name)
                    if v ~= nil then val = v break end
                end
            end
            data_state[name] = val
        end
    end
    
    local payload = util.TableToJSON({
        role_name = roleName,
        role_code = roleCode,
        md5_hash = hash,
        force = force or false,
        convar_state = convar_state,
        data_state = data_state,
        active_admins = TraitorDash.GetActiveAdmins()
    })
    
    if not payload or payload == "" or payload == "{}" then
        print("[TraitorDash] ERROR: Could not generate JSON for " .. roleName .. " (Too large? Size: " .. #roleCode .. ")")
        if callback then callback() end
        return
    end

    print("[TraitorDash] Ingesting " .. roleName .. " (" .. math.floor(#payload / 1024) .. " KB)...")
    
    HTTP({
        url = baseUrl .. "/api/ingest",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " .. token
        },
        body = payload,
        timeout = 30,
        success = function(code, body, headers)
            if code == 200 then
                print("[TraitorDash] OK: " .. roleName)

                local data = util.JSONToTable(body or "")
                if istable(data) and istable(data.schema) then
                    TraitorDash.ReportRole(roleName, data.schema)
                end
            else
                print("[TraitorDash] FAIL: " .. roleName .. " (HTTP " .. code .. ")")
                print("[TraitorDash] Response: " .. (body or "empty"))
            end
            if callback then callback() end
        end,
        failed = function(err)
            print("[TraitorDash] ERR: " .. roleName .. " (" .. err .. ")")
            if callback then callback() end
        end
    })
end

function TraitorDash.Sync(force)
    if not roles or not roles.GetList then
        print("[TraitorDash] Error: TTT2 roles library not found!")
        return
    end

    local roleList = roles.GetList()
    print("[TraitorDash] Syncing " .. #roleList .. " roles (Force: " .. tostring(force or false) .. ")...")
    
    -- Disable hibernation during sync to ensure callbacks fire even if server is empty
    local oldHibernate = GetConVar("sv_hibernate_think"):GetInt()
    RunConsoleCommand("sv_hibernate_think", "1")
    
    local queue = {}
    for _, v in ipairs(roleList) do
        -- Use ClassName for unique ID, fallback to name
        local name = v.ClassName or v.name or "unknown"
        
        -- Skip base roles and internal roles
        if v.IsAbstract or name == "none" or name == "unknown" or name == "base" then 
            continue 
        end
        
        local func = v.PreInitialize or v.Initialize or v.OnRoleSetup
        local info = func and debug.getinfo(func)
        local sourcePath = info and info.source or ""
        
        -- Clean up the source path from debug.getinfo
        if sourcePath:sub(1, 1) == "@" then sourcePath = sourcePath:sub(2) end
        
        -- Try a few variations to find the file
        local pathsToTry = {
            sourcePath,
            sourcePath:gsub("^lua/", ""),
            sourcePath:gsub("^gamemodes/[^/]+/entities/roles/", "terrortown/entities/roles/"),
            "terrortown/entities/roles/" .. name .. "/shared.lua",
            "terrortown/entities/roles/" .. name .. ".lua",
            "terrortown/entities/roles/sh_" .. name .. ".lua"
        }

        local content = nil
        local foundPath = nil

        for _, path in ipairs(pathsToTry) do
            if not path or path == "" then continue end
            content = file.Read(path, "LUA")
            if content and content ~= "" then
                foundPath = path
                break
            end
        end

        if content then
            local extraFiles = {}
            local baseDir = foundPath:match("(.*/)") or ""
            
            -- Recursive Localization & Extra File Discovery
            if foundPath:match("shared%.lua$") then
                local folder = foundPath:gsub("shared%.lua$", "")
                for _, f in ipairs({"cl_init.lua", "init.lua"}) do
                    local extra = file.Read(folder .. f, "LUA")
                    if extra then
                        content = content .. "\n\n--[[ --- TRAITORDASH: " .. f:upper() .. " --- ]]\n\n" .. extra
                        table.insert(extraFiles, f)
                    end
                end
            end

            local extraMsg = #extraFiles > 0 and (" (incl. " .. table.concat(extraFiles, ", ") .. ")") or ""
            print("[TraitorDash] Queueing " .. name .. " from " .. foundPath .. extraMsg)
            
            -- Cache the code for dynamic re-ingestion
            TraitorDash.RoleCodeCache[name] = content
            TraitorDash.RoleMeta[name] = { abbr = v.abbr }
            
            local hash = util.MD5(content)
            table.insert(queue, { name = name, code = content, hash = hash })
        else
            print("[TraitorDash] WARNING: Could not find file for role: " .. name .. " (Source: " .. sourcePath .. ")")
        end
    end

    local count = 0
    local total = #queue
    print("[TraitorDash] Queue prepared with " .. total .. " roles.")

    local function processNext()
        if #queue == 0 then
            print("[TraitorDash] Sync complete! " .. count .. " roles processed.")
            -- Restore hibernation setting
            RunConsoleCommand("sv_hibernate_think", tostring(oldHibernate))
            return
        end

        local item = table.remove(queue, 1)
        count = count + 1
        
        TraitorDash.IngestRole(item.name, item.code, item.hash, force, function()
            processNext()
        end)
    end

    -- Roles are ingested only after the backend has the language files, so their labels
    -- resolve. A failed push does not block the sync.
    TraitorDash.PushLang(function() processNext() end)
end

concommand.Add("traitordash_sync_force", function(ply, cmd, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print("[TraitorDash] Force syncing all roles...")
    TraitorDash.Sync(true)
end)

function TraitorDash.Poll()
    local ok, err = pcall(function()
        local baseUrl = cv_url:GetString()
        local token = cv_token:GetString()
        
        -- Clean URL
        baseUrl = baseUrl:gsub("[\"']", ""):gsub("/+$", "")
        
        if baseUrl == "" or token == "" then return end
        if not (TraitorDash.IsTrustedTransport and TraitorDash.IsTrustedTransport(baseUrl)) then
            if not TraitorDash.WarnedTransport then
                TraitorDash.WarnedTransport = true
                print("[TraitorDash] Not polling: traitordash_url must be https:// (or a private address), because the backend's commands change this server.")
            end
            return
        end

        -- Ids of commands applied so far. The backend keeps a command queued until it is
        -- acknowledged here, so a lost response never loses a change.
        TraitorDash.PendingAcks = TraitorDash.PendingAcks or {}
        local sentAcks = {}
        for i, id in ipairs(TraitorDash.PendingAcks) do sentAcks[i] = id end

        -- Fresh for every poll; the backend signs its answer together with it.
        local nonce = util.SHA256(tostring(SysTime()) .. ":" .. tostring(math.random()) .. ":" .. tostring(os.time())):sub(1, 32)

        local payload = util.TableToJSON({
            active_admins = TraitorDash.GetActiveAdmins(),
            acked = sentAcks,
            nonce = nonce,
            timestamp = os.time()
        })

        HTTP({
            url = baseUrl .. "/api/v1/poll",
            method = "POST",
            headers = {
                ["Authorization"] = "Bearer " .. token,
                ["Content-Type"] = "application/json",
                ["Cache-Control"] = "no-cache"
            },
            body = payload,
            success = function(code, body, headers)
                if code == 200 then
                    TraitorDash.LastSuccess = RealTime()
                    -- Nothing below runs unless the answer is signed with our token for THIS poll.
                    local got = TraitorDash.FindHeader(headers, "X-TraitorDash-Signature")
                    local expected = TraitorDash.ExpectedSignature and TraitorDash.ExpectedSignature(token, nonce, body or "", util.SHA256)
                    if not (TraitorDash.SignatureMatches and TraitorDash.SignatureMatches(expected, got)) then
                        -- At most one line every 5 minutes, with enough detail to tell the causes apart.
                        TraitorDash.SignatureWarnings = (TraitorDash.SignatureWarnings or 0) + 1
                        if TraitorDash.SignatureWarnings <= 3 or RealTime() - (TraitorDash.LastSignatureWarning or -1e9) > 300 then
                            TraitorDash.LastSignatureWarning = RealTime()
                            local names = {}
                            for k in pairs(type(headers) == "table" and headers or {}) do names[#names + 1] = tostring(k) end
                            table.sort(names)
                            print(string.format("[TraitorDash] Ignoring a poll answer without a valid signature (no commands applied). header=%s expected=%s got=%s body=%d bytes, sent: %s, headers: %s",
                                got and "present" or "MISSING",
                                tostring(expected):sub(1, 8), tostring(got):sub(1, 8), #(body or ""), tostring(payload):sub(1, 160), table.concat(names, ",")))
                        end
                        TraitorDash.SignatureFailing = true
                        return
                    end
                    if TraitorDash.SignatureFailing then
                        TraitorDash.SignatureFailing = nil
                        print("[TraitorDash] Poll answers are signed correctly again.")
                    end
                    -- The backend has seen these acknowledgements; keep only newer ones.
                    for _ = 1, #sentAcks do table.remove(TraitorDash.PendingAcks, 1) end
                    local data = util.JSONToTable(body)
                    if data and data.commands then
                        for _, cmd in ipairs(data.commands) do
                            local success, err = pcall(function()
                                if cmd.type == "convar" then
                                    local cv_name, cv_value
                                    if TraitorDash.ParseConVarCommand then
                                        cv_name, cv_value = TraitorDash.ParseConVarCommand(cmd.payload)
                                    end
                                    local cv = cv_name and GetConVar(cv_name)
                                    if cv and cv:GetName() == cv_name then
                                        print("[TraitorDash] CONVAR: " .. cv_name .. " " .. cv_value)
                                        -- One command, one value: cannot be chained with ; or a newline.
                                        RunConsoleCommand(cv_name, cv_value)
                                    else
                                        print("[TraitorDash] WARNING: Refused a ConVar command: " .. tostring(cmd.payload):sub(1, 80))
                                    end
                                elseif cmd.type == "sync" then
                                    print("[TraitorDash] Internal: Force Sync Triggered via API")
                                    TraitorDash.Sync(true)
                                elseif cmd.type == "data" then
                                    local p = cmd.payload
                                    if type(p) == "string" then
                                        p = util.JSONToTable(p)
                                    end
                                    
                                    if type(p) == "table" and TraitorDash.IsSafeDataKey and TraitorDash.IsSafeDataKey(p.key) then
                                        print("[TraitorDash] Applying " .. (p.dataType or "unknown") .. " update: " .. p.key .. " = " .. tostring(p.value))
                                        
                                        -- 1. Update ConVar if it exists
                                        local cv = TraitorDash.IsSettableConVarName(p.key) and GetConVar(p.key)
                                        if cv then
                                            print("[TraitorDash] -> Setting ConVar: " .. p.key)
                                            cv:SetString(tostring(p.value))
                                        end

                                        -- 2. Update Global Variable (for networking/sync)
                                        if p.dataType == "bool" then
                                            SetGlobalBool(p.key, p.value == true or p.value == 1 or p.value == "1")
                                        elseif p.dataType == "int" then
                                            SetGlobalInt(p.key, tonumber(p.value) or 0)
                                        elseif p.dataType == "string" then
                                            SetGlobalString(p.key, tostring(p.value))
                                        end
                                        
                                        -- 3. Update TTT2 internal data
                                        local t_ttt2 = _G.TTT2
                                        if type(t_ttt2) == "table" and t_ttt2.DATA and t_ttt2.DATA.Set then
                                            print("[TraitorDash] -> Setting TTT2.DATA: " .. p.key)
                                            t_ttt2.DATA.Set(p.key, p.value)
                                        end
                                    end
                                end
                            end)
                            if not success then
                                print("[TraitorDash] Command Execution Error: " .. tostring(err))
                            end
                            -- Acknowledge even a refused or failed command: re-sending it forever helps nobody.
                            if isnumber(cmd.id) then table.insert(TraitorDash.PendingAcks, cmd.id) end
                        end
                    end
                end
            end,
            failed = function(err) 
                -- Silently fail poller to avoid spam
            end
        })
    end)
    if not ok then print("[TraitorDash] Poll Runtime Error: " .. tostring(err)) end
end

function TraitorDash.Init()
    if TraitorDash.Initialized then return end
    TraitorDash.Initialized = true
    print("[TraitorDash] Bridge Initialized. Source: " .. debug.getinfo(TraitorDash.Init).source)
    
    -- Start poller immediately
    TraitorDash.Poll()
    
    -- Set up repeating timer
    timer.Create("TraitorDash_Poller", 10, 0, TraitorDash.Poll)
    
    -- Queue initial sync
    timer.Simple(5, TraitorDash.Sync)
end

concommand.Add("traitordash_sync", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    TraitorDash.Sync()
end)

concommand.Add("traitordash_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print("--- TraitorDash Status ---")
    print("Source: " .. debug.getinfo(TraitorDash.Sync).source)
    print("URL: " .. cv_url:GetString())
    print("Initialized: " .. tostring(TraitorDash.Initialized))
    print("Timer: " .. tostring(timer.Exists("TraitorDash_Poller")))
    print("RealTime: " .. RealTime())
    print("Last Heartbeat: " .. (TraitorDash.LastSuccess and (math.floor(RealTime() - TraitorDash.LastSuccess) .. "s ago") or "Never"))
end)

hook.Add("TTT2FinishedLoading", "TD_Init", TraitorDash.Init)
hook.Add("Initialize", "TD_Init", TraitorDash.Init)

-- Defensive TTT2 check to avoid "index a boolean value" errors
if type(TTT2) == "table" and TTT2.Loaded then 
    TraitorDash.Init() 
end
