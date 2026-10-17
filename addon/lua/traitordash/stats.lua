-- TraitorDash round stats.
--
-- Hard rule: this must NEVER affect gameplay. So:
--   * hooks only copy a few small values into memory (no I/O, nothing per tick)
--   * every hook body runs inside pcall
--   * the single HTTP POST goes out asynchronously, once, after the round has ended
--   * a failed POST is logged and dropped: no queue, no retry
--   * the buffers are capped
-- A kill switch (traitordash_stats 0) turns all of it off without a restart.

TraitorDash = TraitorDash or {}

local cv_enabled = CreateConVar("traitordash_stats", "1", {FCVAR_ARCHIVE}, "Report round stats to TraitorDash (1/0).")
local cv_debug = CreateConVar("traitordash_stats_debug", "1", {FCVAR_ARCHIVE}, "Log what the stats tracker does (1/0).")

-- Bots have no SteamID64. They are only reported when this is on, with a synthetic ID per
-- slot, so the test scenario (stats_test.lua) can exercise the full path. Keep it 0 in play.
local cv_bots = CreateConVar("traitordash_stats_bots", "0", {}, "Also report bots, for testing (1/0).")

local MAX_PLAYERS = 128
local MAX_DEATHS = 512

local round = nil -- the round in progress, or nil

local function Dbg(...)
    if cv_debug:GetBool() then print("[TraitorDash:stats]", ...) end
end

-- Runs fn so that an error is logged instead of propagating into TTT2's hook runner.
local function Safe(name, fn)
    return function(...)
        if not cv_enabled:GetBool() then return end
        local ok, err = pcall(fn, ...)
        if not ok then print("[TraitorDash:stats] " .. name .. " error: " .. tostring(err)) end
    end
end

local function NewRoundId()
    return string.format("%x-%x-%x", os.time(), math.floor(SysTime() * 1000) % 0xFFFFFF, math.random(0, 0xFFFFFF))
end

-- TTT2 passes either a team name or a WIN_* number to TTTEndRound.
local function NormalizeResult(result)
    if isnumber(result) then
        if result == WIN_TRAITOR then return TEAM_TRAITOR end
        if result == WIN_INNOCENT then return TEAM_INNOCENT end
        if result == WIN_TIMELIMIT then return "timelimit" end
        return "none"
    end
    return tostring(result or "none")
end

-- On a time limit TTT2 reports "traitors lose", i.e. the innocent side wins.
local function WinningTeam(result)
    if result == "timelimit" then return TEAM_INNOCENT end
    if result == "none" then return nil end
    return result
end

local function RoleName(ply)
    local data = ply:GetSubRoleData()
    return data and data.name or "unknown"
end

local function PlayerId(ply)
    if ply:IsBot() then
        if not cv_bots:GetBool() then return nil end
        return "99900000" .. string.format("%04d", ply:EntIndex())
    end
    return ply:SteamID64()
end

local function Begin()
    round = { id = NewRoundId(), startedAt = os.time(), players = {}, deaths = {}, order = {} }

    for _, ply in ipairs(player.GetAll()) do
        if #round.order >= MAX_PLAYERS then break end
        -- Only players actually taking part (alive at round start); spectators are skipped.
        if IsValid(ply) and ply:IsTerror() then
            local sid = PlayerId(ply)
            if sid then
                round.players[sid] = { steam_id = sid, nick = ply:Nick(), role = RoleName(ply), team = ply:GetTeam() }
                round.order[#round.order + 1] = sid
            end
        end
    end

    Dbg(string.format("round %s began on %s with %d players", round.id, game.GetMap(), #round.order))
end

local function Death(victim, inflictor, attacker)
    if not round or #round.deaths >= MAX_DEATHS then return end
    if not IsValid(victim) or not victim:IsPlayer() then return end

    local vsid = PlayerId(victim)
    if not vsid or not round.players[vsid] then return end

    local asid = nil
    if IsValid(attacker) and attacker:IsPlayer() and attacker ~= victim then asid = PlayerId(attacker) end

    round.deaths[#round.deaths + 1] = { victim = vsid, attacker = asid, at = math.floor(os.time() - round.startedAt) }
    round.players[vsid].died = true
    Dbg(string.format("death: %s (%s) <- %s", round.players[vsid].nick, round.players[vsid].role, asid or "world"))
end

local function Send(payload)
    local baseUrl = GetConVar("traitordash_url"):GetString():gsub("[\"']", ""):gsub("/+$", "")
    local token = GetConVar("traitordash_token"):GetString()
    if baseUrl == "" or token == "" then return end

    HTTP({
        url = baseUrl .. "/api/v1/round",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. token },
        body = util.TableToJSON(payload),
        timeout = 15,
        success = function(code, body)
            if code == 200 then
                Dbg("round " .. payload.round_id .. " accepted: " .. tostring(body))
            else
                print("[TraitorDash:stats] round rejected (HTTP " .. tostring(code) .. "): " .. tostring(body):sub(1, 200))
            end
        end,
        failed = function(err)
            print("[TraitorDash:stats] round lost (backend unreachable): " .. tostring(err))
        end
    })
end

local function End(rawResult)
    -- A forced restart fires TTTEndRound without a result or a preceding TTTBeginRound.
    if not round then Dbg("round ended but none was in progress; ignored") return end
    local r = round
    round = nil

    local result = NormalizeResult(rawResult)
    local winners = WinningTeam(result)

    -- "Survived" means alive when the round ends, not "no death seen": a player who was revived
    -- survived, and one who disconnected mid-round did not (they are no longer in the player list).
    -- One pass over the player list per round.
    local alive = {}
    for _, ply in ipairs(player.GetAll()) do
        if IsValid(ply) and ply:IsTerror() then
            local sid = PlayerId(ply)
            if sid then alive[sid] = true end
        end
    end

    local players = {}
    for _, sid in ipairs(r.order) do
        local p = r.players[sid]
        players[#players + 1] = {
            steam_id = p.steam_id, nick = p.nick, role = p.role, team = p.team,
            survived = alive[sid] == true,
            won = winners ~= nil and p.team == winners,
        }
    end

    if #players == 0 then Dbg("round " .. r.id .. " had no reportable players; not sent") return end

    Dbg(string.format("round %s ended: result=%s, %d players, %d deaths, sending", r.id, result, #players, #r.deaths))
    Send({
        round_id = r.id,
        map = game.GetMap(),
        started_at = os.date("!%Y-%m-%dT%H:%M:%SZ", r.startedAt),
        duration = math.floor(os.time() - r.startedAt),
        result = result,
        players = players,
        deaths = r.deaths,
    })
end

hook.Add("TTTPrepareRound", "TraitorDash_StatsReset", Safe("prepare", function() round = nil end))
hook.Add("TTTBeginRound", "TraitorDash_StatsBegin", Safe("begin", Begin))
hook.Add("TTT2PostPlayerDeath", "TraitorDash_StatsDeath", Safe("death", Death))
hook.Add("TTTEndRound", "TraitorDash_StatsEnd", Safe("end", End))

concommand.Add("traitordash_stats_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print("[TraitorDash:stats] enabled=" .. tostring(cv_enabled:GetBool()) .. " debug=" .. tostring(cv_debug:GetBool()))
    if round then
        print(string.format("[TraitorDash:stats] round %s in progress: %d players, %d deaths", round.id, #round.order, #round.deaths))
    else
        print("[TraitorDash:stats] no round in progress")
    end
end)
