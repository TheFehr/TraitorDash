-- TraitorDash voice state (RFC 27).
--
-- Tells the dashboard two things, and nothing else: the round's phase and the WHOLE list of the living. The dashboard turns that
-- into who hears whom in its own voice chat (living hear the living, dead hear everyone; outside a round everyone hears everyone).
-- No role, team or position is sent, so the voice side cannot leak one.
--
-- Hard rule, the same as stats.lua and track.lua: this must NEVER hurt the game.
--   * it is off unless traitordash_voice is 1, and then does nothing but a timer twice a second (not Think); off creates no timer
--   * the check runs inside pcall and costs a loop over the players
--   * a message is the whole list, never "X died": a lost or late one cannot leave anyone in the wrong group (revivals, RFC 27, 3);
--     the same state is sent again every few seconds, and `seq` lets the dashboard drop a message that arrives after a newer one
--   * a failed send is dropped: no queue, no retry (the next one says it all)

TraitorDash = TraitorDash or {}
local Voice = {}
TraitorDash.Voice = Voice

local cv_voice = CreateConVar("traitordash_voice", "0", {FCVAR_ARCHIVE}, "Send the round phase and the list of the living to the dashboard for its voice chat (1/0).")

local TIMER = "TraitorDash_VoiceState"
local CHECK_EVERY = 0.5 -- seconds between looks at who is alive
local REPEAT_EVERY = 5  -- seconds before an unchanged state is sent again
local MAX_ALIVE = 128

local boot = os.time() -- tells the dashboard that seq started again from 1 (the server restarted)
local seq = 0
local hookPhase = "over"
local lastKey = nil
local lastSentAt = -math.huge
local noEndpointOn = nil

-- The phase of the round: TTT's own round state when it can be asked, else what the round hooks last said.
local function Phase()
    if GetRoundState and ROUND_ACTIVE then
        local s = GetRoundState()
        if s == ROUND_ACTIVE then return "active" end
        if s == ROUND_POST then return "over" end
        return "prep" -- waiting for players, or preparing
    end
    return hookPhase
end

-- The living players who are people, by SteamID64, in a fixed order. IsTerror is what TTT counts as alive: a player being revived
-- is not one until the game says so, and a spectator never is.
local function Alive()
    local list = {}
    for _, ply in ipairs(player.GetAll()) do
        if IsValid(ply) and not ply:IsBot() and ply:IsTerror() then
            local sid = ply:SteamID64()
            if sid and #sid == 17 and #list < MAX_ALIVE then list[#list + 1] = sid end
        end
    end
    table.sort(list)
    return list
end

local function Send(phase, list)
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    local map = game.GetMap()
    if noEndpointOn == map then return end
    seq = seq + 1
    local json = util.TableToJSON({ boot = boot, seq = seq, phase = phase, alive = list })
    if not json then return end
    HTTP({
        url = cfg.url .. "/api/v1/voice",
        method = "POST",
        headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. cfg.token },
        body = json,
        timeout = 5,
        success = function(code)
            if code == 404 then
                noEndpointOn = map
                print("[TraitorDash:voice] the backend has no voice endpoint (too old?); not trying again on this map")
            end
        end,
        failed = function() end, -- the next message says it all
    })
end

-- One look: sends when the phase or the list changed, or when it is time to say the same again.
function Voice.Check()
    local phase = Phase()
    local list = Alive()
    local key = phase .. "|" .. table.concat(list, ",")
    local now = CurTime()
    if key == lastKey and now - lastSentAt < REPEAT_EVERY then return end
    lastKey, lastSentAt = key, now
    Send(phase, list)
end

local function SafeCheck()
    local ok, err = pcall(Voice.Check)
    if not ok then print("[TraitorDash:voice] error: " .. tostring(err)) end
end

local function Start()
    if timer.Exists(TIMER) then return end
    lastKey = nil -- the first look always sends
    timer.Create(TIMER, CHECK_EVERY, 0, SafeCheck)
end

local function Stop()
    if timer.Exists(TIMER) then timer.Remove(TIMER) end
    lastKey = nil
end

local function Apply()
    if cv_voice:GetBool() then Start() else Stop() end
end

-- The round's own events make the change known at once instead of at the next look (a revival: the player is alive again, so
-- the group changes now). The look itself does the work, so a hook that fires twice changes nothing.
local function Soon()
    if cv_voice:GetBool() then timer.Simple(0, SafeCheck) end
end

hook.Add("TTTPrepareRound", "TraitorDash_VoicePrepare", function() hookPhase = "prep"; Soon() end)
hook.Add("TTTBeginRound", "TraitorDash_VoiceBegin", function() hookPhase = "active"; Soon() end)
hook.Add("TTTEndRound", "TraitorDash_VoiceEnd", function() hookPhase = "over"; Soon() end)
hook.Add("TTT2PostPlayerDeath", "TraitorDash_VoiceDeath", Soon)
hook.Add("PlayerSpawn", "TraitorDash_VoiceSpawn", Soon)
hook.Add("PlayerDisconnected", "TraitorDash_VoiceLeft", Soon)
hook.Add("TTT2AddedEvent", "TraitorDash_VoiceEvent", Soon)

if cvars and cvars.AddChangeCallback then
    cvars.AddChangeCallback("traitordash_voice", function() Apply() end, "TraitorDash_VoiceSwitch")
end
Apply()

concommand.Add("traitordash_voice_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print(string.format("[TraitorDash:voice] enabled=%s phase=%s alive=%d messages sent=%d", tostring(cv_voice:GetBool()), Phase(), #Alive(), seq))
end)
