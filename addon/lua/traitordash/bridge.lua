-- TraitorDash GMod Side: TraitorLink Bridge
-- Scans for roles and pushes them to the backend for schema extraction

TraitorDash = TraitorDash or {}
TraitorDash.RoleCodeCache = TraitorDash.RoleCodeCache or {}
TraitorDash.RegisteredCallbacks = TraitorDash.RegisteredCallbacks or {}
TraitorDash.ConVarToRoles = TraitorDash.ConVarToRoles or {}

local cv_url = CreateConVar("traitordash_url", "http://localhost:3000", {FCVAR_ARCHIVE, FCVAR_PROTECTED}, "The base URL of the TraitorDash backend.")
local cv_token = CreateConVar("traitordash_token", "dev-token-123", {FCVAR_ARCHIVE, FCVAR_PROTECTED}, "The API token for authenticating with the backend.")

function TraitorDash.GetActiveAdmins()
    local admins = {}
    for _, ply in ipairs(player.GetAll()) do
        local hasAccess = ply:IsSuperAdmin()
        if CAMI then
            hasAccess = hasAccess or CAMI.PlayerHasAccess(ply, "ttt2_conf_edit")
        end
        
        if hasAccess then
            table.insert(admins, ply:SteamID64() or ply:SteamID())
        end
    end
    return admins
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
                            -- Re-ingestion due to convar change should probably be forced or recalculated
                            local newHash = util.MD5(cached)
                            TraitorDash.IngestRole(rName, cached, newHash, false)
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

            -- Recursively look for localization files in the addon path
            -- We try to find the 'lang/en/' folder relative to 'lua/'
            local luaPos = foundPath:find("lua/")
            if luaPos then
                local addonRoot = foundPath:sub(1, luaPos + 3) -- includes 'lua/'
                local langDir = addonRoot .. "terrortown/lang/en/"
                local files, _ = file.Find(langDir .. "*", "LUA")
                for _, f in ipairs(files or {}) do
                    if f:match("%.lua$") or f:match("%.json$") then
                        local langContent = file.Read(langDir .. f, "LUA")
                        if langContent then
                            content = content .. "\n\n--[[ --- TRAITORDASH: LANG/EN/" .. f:upper() .. " --- ]]\n\n" .. langContent
                            table.insert(extraFiles, "lang/" .. f)
                        end
                    end
                end
            end

            local extraMsg = #extraFiles > 0 and (" (incl. " .. table.concat(extraFiles, ", ") .. ")") or ""
            print("[TraitorDash] Queueing " .. name .. " from " .. foundPath .. extraMsg)
            
            -- Cache the code for dynamic re-ingestion
            TraitorDash.RoleCodeCache[name] = content
            
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

    processNext()
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

        local payload = util.TableToJSON({
            active_admins = TraitorDash.GetActiveAdmins(),
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
            success = function(code, body)
                if code == 200 then
                    TraitorDash.LastSuccess = RealTime()
                    local data = util.JSONToTable(body)
                    if data and data.commands then
                        for _, cmd in ipairs(data.commands) do
                            if cmd.type == "convar" then
                                print("[TraitorDash] CONVAR: " .. tostring(cmd.payload))
                                game.ConsoleCommand(tostring(cmd.payload) .. "\n")
                            elseif cmd.type == "data" then
                                local p = cmd.payload
                                if type(p) == "table" and p.key then
                                    print("[TraitorDash] DATA: " .. p.key .. " = " .. tostring(p.value))
                                    if p.dataType == "bool" then
                                        SetGlobalBool(p.key, p.value == true or p.value == 1 or p.value == "1")
                                    elseif p.dataType == "int" then
                                        SetGlobalInt(p.key, tonumber(p.value) or 0)
                                    elseif p.dataType == "string" then
                                        SetGlobalString(p.key, tostring(p.value))
                                    end
                                    
                                    if TTT2 and TTT2.DATA and TTT2.DATA.Set then
                                        TTT2.DATA.Set(p.key, p.value)
                                    end
                                end
                            end
                        end
                    end
                end
            end,
            failed = function(err) 
                -- Silently fail poller to avoid spam
            end
        })
    end)
    if not ok then print("[TraitorDash] Poll Error: " .. tostring(err)) end
end

function TraitorDash.Init()
    if TraitorDash.Initialized then return end
    TraitorDash.Initialized = true
    print("[TraitorDash] Bridge Active.")
    
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
if TTT2 and TTT2.Loaded then TraitorDash.Init() end
