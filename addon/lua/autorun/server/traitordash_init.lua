-- TraitorDash Loader
if SERVER then
    -- GMod include paths are relative to the 'lua/' folder
    local path = "traitordash/bridge.lua"
    
    if file.Exists(path, "LUA") then
        print("[TraitorDash] Loading bridge from " .. path)
        include(path)
    else
        print("[TraitorDash] ERROR: Could not find " .. path)
    end
end
