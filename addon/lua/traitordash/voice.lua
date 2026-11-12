-- TraitorDash voice state (RFC 27).
--
-- Tells the dashboard three things, and nothing else: the round's phase, the WHOLE list of the living, and the nicks of everyone who is
-- connected (alive or dead, for the voice page's list of who is on; it says nothing about who is alive). The dashboard turns that
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

local cv_mute = CreateConVar("traitordash_voice_mute_game", "0", {FCVAR_ARCHIVE}, "Turn the game's own voice off (sv_voiceenable 0) while the dashboard's voice chat is used (1/0).")

local TIMER = "TraitorDash_VoiceState"
local CHECK_EVERY = 0.25 -- seconds between looks at who is alive (a loop over about ten players: cheap)
local DEATH_GRACE = 2 -- seconds a player who has just died counts as dead whatever the team still says
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
-- Who has just died, by SteamID64, and when: the death hook says a player died, but the game may change their team a moment after it, and a
-- look in between would still see them alive and keep them audible to the living until the next look. A death is therefore counted at
-- once, from the hook; it is undone by the player spawning again (a revival), and in any case after DEATH_GRACE seconds, when the team
-- itself is the answer again.
local justDied = {}
local function JustDied(sid)
    local at = justDied[sid]
    if not at then return false end
    if CurTime() - at >= DEATH_GRACE then justDied[sid] = nil return false end
    return true
end

local function Alive()
    local list = {}
    for _, ply in ipairs(player.GetAll()) do
        if IsValid(ply) and not ply:IsBot() and ply:IsTerror() then
            local sid = ply:SteamID64()
            if sid and #sid == 17 and #list < MAX_ALIVE and not JustDied(sid) then list[#list + 1] = sid end
        end
    end
    table.sort(list)
    return list
end

-- A nick fit for the wire: no control characters, valid UTF-8 (anything else is reduced to ASCII), at most 32 characters.
local function CleanNick(raw)
    local n = tostring(raw or ""):gsub("%c", " ")
    if utf8 and utf8.len then
        if not utf8.len(n) then n = n:gsub("[\128-\255]", "?") end
        local cut = utf8.offset(n, 33)
        if cut then n = n:sub(1, cut - 1) end
    else
        n = n:sub(1, 32)
    end
    return n
end

-- Everyone who is connected as a person, alive or dead, by SteamID64, with their nick: for the voice page's list of who is on
-- (RFC 27, 7). It says nothing about who is alive, so it cannot give a death away.
local function Names()
    local names, keyParts = {}, {}
    for _, ply in ipairs(player.GetAll()) do
        if IsValid(ply) and not ply:IsBot() then
            local sid = ply:SteamID64()
            if sid and #sid == 17 and #keyParts < MAX_ALIVE then
                local nick = CleanNick(ply:Nick())
                if nick ~= "" then
                    names[sid] = nick
                    keyParts[#keyParts + 1] = sid .. "=" .. nick
                end
            end
        end
    end
    table.sort(keyParts)
    return names, table.concat(keyParts, ";")
end

local function Send(phase, list, names)
    local cfg = TraitorDash.GetConfig and TraitorDash.GetConfig()
    if not cfg or not cfg.url or cfg.token == "" then return end
    local map = game.GetMap()
    if noEndpointOn == map then return end
    seq = seq + 1
    local json = util.TableToJSON({ boot = boot, seq = seq, phase = phase, alive = list, names = names })
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
    local names, namesKey = Names()
    local key = phase .. "|" .. table.concat(list, ",") .. "|" .. namesKey
    local now = CurTime()
    if key == lastKey and now - lastSentAt < REPEAT_EVERY then return end
    lastKey, lastSentAt = key, now
    Send(phase, list, names)
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

-- The game's own voice (RFC 27, 6): with traitordash_voice_mute_game on, sv_voiceenable is held at 0, so a player who is on the dashboard's
-- voice chat does not hear everyone twice. What it was is remembered only when this file changed it: if server.cfg already says 0,
-- switching this off leaves it 0; if this turned it off, switching this off puts back what it was. server.cfg runs again at every map, so
-- the value is asserted again when a round is prepared.
local savedVoiceEnable = nil
local function ApplyGameVoice()
    local sv = GetConVar and GetConVar("sv_voiceenable")
    if not sv or not RunConsoleCommand then return end
    if cv_mute:GetBool() then
        if sv:GetInt() ~= 0 then
            if savedVoiceEnable == nil then savedVoiceEnable = sv:GetString() end
            RunConsoleCommand("sv_voiceenable", "0")
        end
    elseif savedVoiceEnable ~= nil then
        RunConsoleCommand("sv_voiceenable", savedVoiceEnable)
        savedVoiceEnable = nil
    end
end
local function SafeApplyGameVoice()
    local ok, err = pcall(ApplyGameVoice)
    if not ok then print("[TraitorDash:voice] could not set the game's voice: " .. tostring(err)) end
end

-- The round's own events make the change known at once instead of at the next look (a revival: the player is alive again, so
-- the group changes now). The look itself does the work, so a hook that fires twice changes nothing.
local function Soon()
    if cv_voice:GetBool() then timer.Simple(0, SafeCheck) end
end

hook.Add("TTTPrepareRound", "TraitorDash_VoicePrepare", function() hookPhase = "prep"; Soon(); SafeApplyGameVoice() end)
hook.Add("TTTBeginRound", "TraitorDash_VoiceBegin", function() hookPhase = "active"; Soon() end)
hook.Add("TTTEndRound", "TraitorDash_VoiceEnd", function() hookPhase = "over"; Soon() end)
hook.Add("TTT2PostPlayerDeath", "TraitorDash_VoiceDeath", function(victim)
    if not cv_voice:GetBool() then return end
    if IsValid(victim) and victim.SteamID64 then
        local sid = victim:SteamID64()
        if sid and #sid == 17 then justDied[sid] = CurTime() end
    end
    Soon()
    timer.Simple(0.15, SafeCheck) -- and again a moment later, in case the game was not done with the death yet
end)
hook.Add("PlayerSpawn", "TraitorDash_VoiceSpawn", function(ply)
    if IsValid(ply) and ply.SteamID64 then justDied[ply:SteamID64() or ""] = nil end -- a spawn is a revival (or a new round): alive again
    Soon()
end)
hook.Add("PlayerDisconnected", "TraitorDash_VoiceLeft", Soon)
hook.Add("TTT2AddedEvent", "TraitorDash_VoiceEvent", Soon)

if cvars and cvars.AddChangeCallback then
    cvars.AddChangeCallback("traitordash_voice", function() Apply() end, "TraitorDash_VoiceSwitch")
    cvars.AddChangeCallback("traitordash_voice_mute_game", function() SafeApplyGameVoice() end, "TraitorDash_VoiceMuteGame")
end
Apply()
SafeApplyGameVoice()

concommand.Add("traitordash_voice_status", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    print(string.format("[TraitorDash:voice] enabled=%s phase=%s alive=%d messages sent=%d", tostring(cv_voice:GetBool()), Phase(), #Alive(), seq))
end)
