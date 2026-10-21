-- TraitorDash Loader
if SERVER then
    -- The role guide's client file includes this one, so players must be sent it.
    AddCSLuaFile("traitordash/util.lua")

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

    -- A console tool for measuring the server's frame time (RFC 12); it does nothing until started.
    local okFt, errFt = pcall(include, "traitordash/frametime.lua")
    if not okFt then print("[TraitorDash] Frame-time tool failed to load: " .. tostring(errFt)) end

    -- The role guide in the F1 menu (RFC 15): the server's part. Optional; off without a public_url.
    local okRg, errRg = pcall(include, "traitordash/rolemenu.lua")
    if not okRg then print("[TraitorDash] Role guide failed to load: " .. tostring(errRg)) end

    -- Stats are optional: a failure here must never take the bridge down with it.
    local ok, err = pcall(include, "traitordash/stats.lua")
    if not ok then print("[TraitorDash] Stats tracker failed to load: " .. tostring(err)) end

    -- Console-only bot scenario for exercising position tracking (see the file header).
    local okTt, errTt = pcall(include, "traitordash/track_test.lua")
    if not okTt then print("[TraitorDash] Track test scenario failed to load: " .. tostring(errTt)) end

    -- Console-only bot scenario for exercising the stats tracker (see the file header).
    local okTest, errTest = pcall(include, "traitordash/stats_test.lua")
    if not okTest then print("[TraitorDash] Stats test scenario failed to load: " .. tostring(errTest)) end
end
