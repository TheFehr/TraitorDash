-- TraitorDash position-tracking test scenario (RFC 12). Console-only; do NOT run it with real players online.
--
--   traitordash_track_test [bots] [seconds] [off]     (defaults: 8 bots, 90 seconds)
--
-- Plays one scripted round with bots that WALK (they turn at random, turn away from walls and jump
-- now and then), with position tracking on, so a replay has something to show:
--   1. remembers traitordash_track, traitordash_stats_bots and bot_zombie, then turns tracking and
--      the reporting of bots on (with "off" as the third word tracking stays OFF: the control run
--      for comparing the server's frame time with and without it, see traitordash_frametime)
--   2. clears old bots, adds the new ones, restarts the round and waits for the active phase
--   3. the bots walk; from 30% of the time on a traitor bot kills the others, one at a time, spread
--      over the rest of it, so the round ends by itself at about the given length
--   4. after the round has ended it waits for the stats and the track to be sent, kicks the bots and
--      puts every setting back as it was
-- Watch the console for [TraitorDash:track] lines (the round-end line, "track encoded", "accepted"),
-- then open the round's replay in the dashboard with ?bots=1 added: bot-only rounds are hidden
-- otherwise. A failure at any point also puts the settings back.

if not SERVER then return end

local running = false
local MAX_WAIT = 240   -- seconds to reach the active phase and finish (prep time + the round + slack)
local AFTER_END = 12   -- seconds to let the async stats and track requests go out
local WATCHED = { "traitordash_track", "traitordash_stats_bots", "bot_zombie" }

local function Say(msg) print("[TraitorDash:track-test] " .. msg) end

local function Restore(saved)
    for _, name in ipairs(WATCHED) do
        if saved[name] ~= nil then RunConsoleCommand(name, saved[name]) end
    end
end

local function Cleanup(saved, reason)
    for _, b in ipairs(player.GetBots()) do
        if IsValid(b) then b:Kick("TraitorDash track test finished") end
    end
    Restore(saved)
    timer.Remove("TraitorDash_TrackTest")
    hook.Remove("TTTEndRound", "TraitorDash_TrackTestEnd")
    hook.Remove("StartCommand", "TraitorDash_TrackTestMove")
    running = false
    Say("done: " .. reason)
end

-- Random walk: keep going forward, turn now and then, turn away when stuck against something.
local walk = setmetatable({}, { __mode = "k" })

local function Move(ply, cmd)
    if not IsValid(ply) or not ply:IsBot() or not ply:IsTerror() then return end
    local now = CurTime()
    local st = walk[ply]
    if not st then
        st = { yaw = math.random(0, 359), nextTurn = now + math.Rand(1.5, 4) }
        walk[ply] = st
    end
    if ply:GetVelocity():Length2D() < 25 then st.stuck = st.stuck or now else st.stuck = nil end
    if now >= st.nextTurn or (st.stuck and now - st.stuck > 0.6) then
        st.yaw = (st.yaw + (st.stuck and math.random(110, 250) or math.random(40, 140))) % 360
        st.nextTurn = now + math.Rand(1.5, 4)
        st.stuck = nil
    end
    cmd:ClearMovement()
    cmd:ClearButtons()
    cmd:SetViewAngles(Angle(0, st.yaw, 0))
    cmd:SetForwardMove(450)
    if math.random() < 0.01 then cmd:SetButtons(IN_JUMP) end
end

concommand.Add("traitordash_track_test", function(ply, _, args)
    if IsValid(ply) then return end -- server console / rcon only
    if running then Say("already running") return end
    if not TTT2 or not gameloop then Say("TTT2 gameloop not available") return end

    for _, p in ipairs(player.GetHumans()) do
        if IsValid(p) then Say("refusing: a real player (" .. p:Nick() .. ") is online; this restarts the round") return end
    end

    local want = math.Clamp(tonumber(args[1]) or 8, 2, 16)
    local seconds = math.Clamp(tonumber(args[2]) or 90, 30, 300)
    local control = tostring(args[3] or ""):lower() == "off"
    running = true

    local saved = {}
    for _, name in ipairs(WATCHED) do
        local cv = GetConVar(name)
        saved[name] = cv and cv:GetString() or nil
    end

    Say(string.format("starting with %d bots for about %d s, position tracking %s", want, seconds, control and "OFF (control run)" or "ON"))
    RunConsoleCommand("traitordash_track", control and "0" or "1")
    RunConsoleCommand("traitordash_stats_bots", "1")
    RunConsoleCommand("bot_zombie", "0") -- the stats test freezes bots; these have to move

    local leftover = player.GetBots()
    for _, b in ipairs(leftover) do b:Kick("TraitorDash track test: clearing old bots") end
    if #leftover > 0 then Say("kicked " .. #leftover .. " leftover bots first") end

    timer.Simple(#leftover > 0 and 2 or 0, function()
        if not running then return end
        for _ = 1, want do RunConsoleCommand("bot") end
    end)

    hook.Add("StartCommand", "TraitorDash_TrackTestMove", function(p, cmd)
        local ok, err = pcall(Move, p, cmd)
        if not ok then print("[TraitorDash:track-test] movement error: " .. tostring(err)) hook.Remove("StartCommand", "TraitorDash_TrackTestMove") end
    end)

    local started = CurTime()
    local restarted, ended, killQueue, nextKill, interval = false, false, nil, 0, 0

    hook.Add("TTTEndRound", "TraitorDash_TrackTestEnd", function(result)
        ended = true
        Say("TTTEndRound fired, result=" .. tostring(result) .. "; waiting " .. AFTER_END .. " s for the stats and the track to be sent")
        timer.Simple(AFTER_END, function() Cleanup(saved, "round over; look for the [TraitorDash:track] lines above, then open the replay with ?bots=1") end)
    end)

    timer.Create("TraitorDash_TrackTest", 1, 0, function()
        local ok, err = pcall(function()
            if ended then return end
            if CurTime() - started > MAX_WAIT then
                return Cleanup(saved, "FAILED: no round finished within " .. MAX_WAIT .. " s")
            end

            local bots = player.GetBots()
            if #bots < want then return end -- still joining
            if #bots > want then
                for i = want + 1, #bots do bots[i]:Kick("TraitorDash track test: surplus bot") end
                return
            end

            if not restarted then
                restarted = true
                Say(#bots .. " bots present; restarting the round")
                RunConsoleCommand("ttt_roundrestart")
                return
            end

            if gameloop.GetRoundState() ~= ROUND_ACTIVE then return end

            if not killQueue then
                local killer
                killQueue = {}
                for _, b in ipairs(bots) do
                    if b:GetTeam() == TEAM_TRAITOR and not killer then killer = b
                    elseif b:GetTeam() ~= TEAM_TRAITOR then killQueue[#killQueue + 1] = b end
                end
                if not killer then
                    return Cleanup(saved, "FAILED: no traitor bot was assigned; try again with more bots")
                end
                killQueue.killer = killer
                -- the kills start at 30% of the time and are spread over the rest of it
                interval = math.max(3, seconds * 0.7 / math.max(1, #killQueue))
                nextKill = CurTime() + seconds * 0.3
                Say(string.format("active: %s (%s) will kill %d bots, one every %.0f s from %.0f s on", killer:Nick(), killer:GetSubRoleData().name, #killQueue, interval, seconds * 0.3))
                return
            end

            if CurTime() >= nextKill and #killQueue > 0 then
                local victim = table.remove(killQueue, 1)
                if IsValid(victim) and victim:IsTerror() then
                    local dmg = DamageInfo()
                    dmg:SetAttacker(killQueue.killer)
                    dmg:SetInflictor(killQueue.killer)
                    dmg:SetDamage(100000)
                    dmg:SetDamageType(DMG_BULLET)
                    Say("killing " .. victim:Nick())
                    victim:TakeDamageInfo(dmg)
                end
                nextKill = CurTime() + interval
            end
        end)
        if not ok then Cleanup(saved, "FAILED: " .. tostring(err)) end
    end)
end)
