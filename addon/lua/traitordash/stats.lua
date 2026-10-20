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
local MAX_REVIVES = 512
local NOTE_SECONDS = 30 -- how long a defibrillator attempt may wait for its revival (RFC 14, 4.2)

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

-- A class, role or reason name as the backend accepts it: letters, digits, underscore, dot, hyphen.
local function CleanName(v)
    if v == nil then return nil end
    local s = tostring(v):gsub("[^%w_.%-]", ""):sub(1, 64)
    return s ~= "" and s or nil
end

local function PlayerId(ply)
    if ply:IsBot() then
        if not cv_bots:GetBool() then return nil end
        return "99900000" .. string.format("%04d", ply:EntIndex())
    end
    return ply:SteamID64()
end

local function Begin()
    round = { id = NewRoundId(), startedAt = os.time(), players = {}, deaths = {}, order = {}, revives = {}, notes = {}, settling = {} }
    local tracked = {}

    for _, ply in ipairs(player.GetAll()) do
        if #round.order >= MAX_PLAYERS then break end
        -- Only players actually taking part (alive at round start); spectators are skipped.
        if IsValid(ply) and ply:IsTerror() then
            local sid = PlayerId(ply)
            if sid then
                local role, team = RoleName(ply), ply:GetTeam()
                -- `role` and `team` stay the state at the start; `end_role` and `end_team` follow the
                -- round (RFC 14, 4.4) and `ply` lets the revival event find the player again.
                round.players[sid] = { steam_id = sid, nick = ply:Nick(), role = role, team = team, end_role = role, end_team = team, ply = ply }
                round.order[#round.order + 1] = sid
                tracked[#tracked + 1] = { sid = sid, ply = ply }
            end
        end
    end

    Dbg(string.format("round %s began on %s with %d players", round.id, game.GetMap(), #round.order))
    -- Position tracking (track.lua, RFC 12) is opt-in and does nothing unless traitordash_track is 1.
    if TraitorDash.Track then TraitorDash.Track.Begin(round.id, tracked) end
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
    -- A revival that comes with no defibrillator is put down to the role the player died as (RFC 14, 4.2).
    round.players[vsid].dead = true
    round.players[vsid].death_role = CleanName(RoleName(victim))
    if TraitorDash.Track then TraitorDash.Track.Death(victim, inflictor, attacker, vsid, asid) end
    Dbg(string.format("death: %s (%s) <- %s", round.players[vsid].nick, round.players[vsid].role, asid or "world"))
end

-- ---- Role changes and revivals (RFC 14) ----

local function ElapsedSeconds() return math.floor(os.time() - round.startedAt) end

-- A role or team changed: the state is read once the change has settled, on the next tick, because
-- the role and the team are set in one call that fires both hooks.
local function RoleHook(ply)
    if not round or not IsValid(ply) then return end
    local sid = PlayerId(ply)
    local p = sid and round.players[sid]
    if not p or round.settling[sid] then return end
    local r = round
    r.settling[sid] = true
    timer.Simple(0, function()
        r.settling[sid] = nil
        if round ~= r or not IsValid(ply) then return end
        local ok, err = pcall(function()
            local role, team = RoleName(ply), ply:GetTeam()
            if role == p.end_role and team == p.end_team then return end -- it ended up where it was
            p.end_role, p.end_team = role, team
            if TraitorDash.Track then TraitorDash.Track.RoleChanged(sid, CleanName(role), CleanName(team)) end
            Dbg(string.format("role change: %s is now %s (%s)", p.nick, role, tostring(team)))
        end)
        if not ok then print("[TraitorDash:stats] role change error: " .. tostring(err)) end
    end)
end

-- The defibrillator announces every attempt before it starts (owner, the body, the weapon). The note
-- waits for the revival of that player. This handler must return nothing: an answer blocks the revival.
local function DefibAttempt(owner, ragdoll, defib)
    if not round then return end
    local victim = CORPSE and CORPSE.GetPlayer and CORPSE.GetPlayer(ragdoll)
    if not IsValid(victim) then return end
    local vsid = PlayerId(victim)
    if not vsid or not round.players[vsid] then return end
    local by = IsValid(owner) and PlayerId(owner) or nil
    if by and not round.players[by] then by = nil end
    local class = IsValid(defib) and defib.GetClass and defib:GetClass() or nil
    round.notes[vsid] = {
        by = by, how = CleanName(class), why = IsValid(defib) and CleanName(defib.revivalReason) or nil, at = CurTime(),
    }
end

-- TTT2 logs a respawn event for every revival; the hook gives the exact moment.
local function AddedEvent(name, event)
    if not round or EVENT_RESPAWN == nil or name ~= EVENT_RESPAWN then return end
    local data = event and event.event
    local sid64 = data and data.sid64
    local sid, p
    for _, s in ipairs(round.order) do
        local q = round.players[s]
        if q.dead and IsValid(q.ply) and ((sid64 and tostring(q.ply:SteamID64()) == tostring(sid64)) or (q.ply:IsBot() and data and q.nick == data.nick)) then
            sid, p = s, q
            break
        end
    end
    if not p then return end
    p.dead = false

    local info = { how = p.death_role and ("role:" .. p.death_role) or nil }
    local note = round.notes[sid]
    round.notes[sid] = nil
    if note and CurTime() - note.at <= NOTE_SECONDS then info = { by = note.by, how = note.how, why = note.why } end

    if #round.revives < MAX_REVIVES then
        round.revives[#round.revives + 1] = { victim = sid, reviver = info.by, how = info.how, why = info.why, at = ElapsedSeconds() }
    end
    if TraitorDash.Track then TraitorDash.Track.Revive(sid, info) end
    Dbg(string.format("revival: %s by %s (%s)", p.nick, info.by or "unknown", info.how or "unknown"))
end

-- `accepted` runs when the backend has accepted the round (the position track is sent after that).
local function Send(payload, accepted)
    -- Same configuration as the bridge (config.lua): the file or the ConVars, https or private only.
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    local baseUrl, token = cfg.url, cfg.token

    HTTP({
        url = baseUrl .. "/api/v1/round",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. token },
        body = util.TableToJSON(payload),
        timeout = 15,
        success = function(code, body)
            if code == 200 then
                Dbg("round " .. payload.round_id .. " accepted: " .. tostring(body))
                if accepted then
                    local ok, err = pcall(accepted)
                    if not ok then print("[TraitorDash:stats] track upload error: " .. tostring(err)) end
                end
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
    -- The recording always stops with the round, whatever happens to the report below.
    local track = TraitorDash.Track and TraitorDash.Track.Finish(r.id) or nil

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
        -- The last look: a player still here may have changed since the hooks (the hooks do the rest).
        if IsValid(p.ply) then
            local ok, role, team = pcall(function() return RoleName(p.ply), p.ply:GetTeam() end)
            if ok then p.end_role, p.end_team = role, team end
        end
        players[#players + 1] = {
            steam_id = p.steam_id, nick = p.nick, role = p.role, team = p.team,
            end_role = p.end_role, end_team = p.end_team,
            survived = alive[sid] == true,
            -- Whoever ended on the winning team won, whatever team they began on (RFC 14, 4.4).
            won = winners ~= nil and (p.end_team or p.team) == winners,
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
        revives = r.revives,
    }, track and function() TraitorDash.Track.Upload(track) end or nil)
end

hook.Add("TTTPrepareRound", "TraitorDash_StatsReset", Safe("prepare", function() round = nil end))
hook.Add("TTTBeginRound", "TraitorDash_StatsBegin", Safe("begin", Begin))
hook.Add("TTT2PostPlayerDeath", "TraitorDash_StatsDeath", Safe("death", Death))
hook.Add("TTTEndRound", "TraitorDash_StatsEnd", Safe("end", End))
hook.Add("TTT2UpdateSubrole", "TraitorDash_StatsRole", Safe("role", RoleHook))
hook.Add("TTT2UpdateTeam", "TraitorDash_StatsTeam", Safe("team", RoleHook))
hook.Add("TTT2AddedEvent", "TraitorDash_StatsRevive", Safe("revive", AddedEvent))
-- Safe() returns nothing, which the defibrillator needs: any answer from this hook blocks the revival.
hook.Add("TTT2AttemptDefibPlayer", "TraitorDash_StatsDefib", Safe("defib", DefibAttempt))

concommand.Add("traitordash_stats_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print("[TraitorDash:stats] enabled=" .. tostring(cv_enabled:GetBool()) .. " debug=" .. tostring(cv_debug:GetBool()))
    if round then
        print(string.format("[TraitorDash:stats] round %s in progress: %d players, %d deaths", round.id, #round.order, #round.deaths))
    else
        print("[TraitorDash:stats] no round in progress")
    end
end)
