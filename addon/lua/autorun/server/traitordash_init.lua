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

    -- Position tracking is optional and off by default (traitordash_track); stats.lua calls it.
    local okTrack, errTrack = pcall(include, "traitordash/track.lua")
    if not okTrack then print("[TraitorDash] Position tracking failed to load: " .. tostring(errTrack)) end

    -- Stats are optional: a failure here must never take the bridge down with it.
    local ok, err = pcall(include, "traitordash/stats.lua")
    if not ok then print("[TraitorDash] Stats tracker failed to load: " .. tostring(err)) end

    -- Console-only bot scenario for exercising the stats tracker (see the file header).
    local okTest, errTest = pcall(include, "traitordash/stats_test.lua")
    if not okTest then print("[TraitorDash] Stats test scenario failed to load: " .. tostring(errTest)) end
end
