-- TraitorDash stats test scenario. Console-only; do NOT run it with real players online.
--
--   traitordash_stats_test [bots]      (default 4 bots, 2-12)
--
-- Plays one complete, scripted round with bots through the REAL TTT2 flow:
--   1. adds bots, freezes their AI (bot_zombie), turns on traitordash_stats_bots
--   2. restarts the round and waits for the active phase
--   3. a traitor bot kills every non-traitor bot, one every 2 seconds, with the traitor as
--      the attacker (so TTT2PostPlayerDeath gets a real attacker)
--   4. TTT2's own win checker ends the round; the stats hooks send the round as usual
--   5. kicks the bots and restores the settings
-- Watch the server console for [TraitorDash:stats] lines, then the backend log for
-- "[Stats] Round ... stored".

if not SERVER then return end

local running = false
local MAX_WAIT = 150 -- seconds to reach the active phase (prep time + slack)

local function Say(msg) print("[TraitorDash:stats-test] " .. msg) end

local function Cleanup(bots, reason)
    for _, b in ipairs(bots) do
        if IsValid(b) then b:Kick("TraitorDash stats test finished") end
    end
    RunConsoleCommand("bot_zombie", "0")
    RunConsoleCommand("traitordash_stats_bots", "0")
    timer.Remove("TraitorDash_StatsTest")
    hook.Remove("TTTEndRound", "TraitorDash_StatsTestEnd")
    running = false
    Say("done: " .. reason)
end

concommand.Add("traitordash_stats_test", function(ply, _, args)
    if IsValid(ply) then return end -- server console / rcon only
    if running then Say("already running") return end
    if not TTT2 or not gameloop then Say("TTT2 gameloop not available") return end

    for _, p in ipairs(player.GetHumans()) do
        if IsValid(p) then Say("refusing: a real player (" .. p:Nick() .. ") is online; this restarts the round") return end
    end

    local want = math.Clamp(tonumber(args[1]) or 4, 2, 12)
    running = true
    local bots = {}
    Say("starting with " .. want .. " bots")

    RunConsoleCommand("traitordash_stats_bots", "1")
    RunConsoleCommand("bot_zombie", "1")
    for i = 1, want do RunConsoleCommand("bot") end

    local started = CurTime()
    local killQueue, nextKill, restarted, ended = nil, 0, false, false

    hook.Add("TTTEndRound", "TraitorDash_StatsTestEnd", function(result)
        ended = true
        Say("TTTEndRound fired, result=" .. tostring(result) .. " (stats should send it now)")
        -- give the async POST a moment before the bots (and their data) go away
        timer.Simple(5, function() Cleanup(bots, "round reported; check the backend log for '[Stats] Round'") end)
    end)

    timer.Create("TraitorDash_StatsTest", 1, 0, function()
        local ok, err = pcall(function()
            if ended then return end
            if CurTime() - started > MAX_WAIT then
                return Cleanup(bots, "FAILED: no round finished within " .. MAX_WAIT .. "s")
            end

            bots = {}
            for _, p in ipairs(player.GetBots()) do bots[#bots + 1] = p end
            if #bots < want then return end -- still joining

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
                    return Cleanup(bots, "FAILED: no traitor bot was assigned; try again with more bots")
                end
                killQueue.killer = killer
                Say(string.format("active: %s (%s) will kill %d bots", killer:Nick(), killer:GetSubRoleData().name, #killQueue))
                nextKill = CurTime() + 2
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
                nextKill = CurTime() + 2
            end
        end)
        if not ok then Cleanup(bots, "FAILED: " .. tostring(err)) end
    end)
end)
