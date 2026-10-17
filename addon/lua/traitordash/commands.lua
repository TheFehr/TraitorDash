-- TraitorDash: what the bridge is willing to do when the backend tells it to change something.
--
-- The backend is trusted to carry admin changes, not to be a remote console: a compromised
-- backend, or a poisoned role file that got a bad ConVar name past it, must not be able to run
-- `quit`, read or change `rcon_password`, or chain commands with `;` or a newline. So the bridge
-- re-validates everything itself and applies ConVars with RunConsoleCommand(name, value), which
-- takes ONE command and cannot be chained.

TraitorDash = TraitorDash or {}

-- Only TTT / TTT2 ConVars may be changed (ttt_*, ttt2_*). Everything else, including
-- rcon_password, sv_password and sv_setsteamaccount, is refused.
function TraitorDash.IsSettableConVarName(name)
    return type(name) == "string" and #name <= 80 and name:match("^ttt2?_[%w_]+$") ~= nil
end

-- Parses exactly what the backend formats (`name value` or `name "value with spaces"`),
-- and nothing else. Returns name, value, or nil when the payload is anything other than that.
function TraitorDash.ParseConVarCommand(payload)
    if type(payload) ~= "string" or #payload > 200 then return nil end

    local name, value = payload:match('^([%w_]+) "([%w_.: %-]*)"$')
    if not name then name, value = payload:match("^([%w_]+) ([%w_.:%-]*)$") end
    if not name or not TraitorDash.IsSettableConVarName(name) then return nil end

    return name, value
end

-- Keys for the generic `data` update (a ConVar and/or a TTT2 data value): plain identifiers.
function TraitorDash.IsSafeDataKey(key)
    return type(key) == "string" and #key <= 80 and key:match("^[%w_]+$") ~= nil
end

-- Commands change the server, so they are only accepted over a channel nobody on the way
-- can alter: https, or http to this machine / a private network.
function TraitorDash.IsTrustedTransport(url)
    if type(url) ~= "string" then return false end
    local lower = url:lower()
    if lower:match("^https://") then return true end
    local host = lower:match("^http://([^/:]+)")
    if not host then return false end
    if host == "localhost" then return true end
    local a, b = host:match("^(%d+)%.(%d+)%.%d+%.%d+$")
    if not a then return false end
    a, b = tonumber(a), tonumber(b)
    return a == 127 or a == 10 or (a == 192 and b == 168) or (a == 172 and b >= 16 and b <= 31)
end

-- The backend signs every poll answer (see services/signing.ts; keep the two identical):
-- SHA-256 over "token \n nonce \n commands-json \n token", as lowercase hex. `sha256` is util.SHA256.
function TraitorDash.ExpectedSignature(token, nonce, commandsJson, sha256)
    return sha256(token .. "\n" .. nonce .. "\n" .. commandsJson .. "\n" .. token)
end

-- The signature is the last key of the answer, `{"commands":<json>,"sig":"<hex>"}`, because a
-- response header did not reach GMod's HTTP callback. Returns the exact bytes of <json> and the
-- hex signature, or nil. The pattern is anchored at both ends and greedy, so only the real
-- trailing signature counts, whatever the commands contain.
function TraitorDash.SplitSignedBody(body)
    if type(body) ~= "string" then return nil end
    local commandsJson, sig = body:match('^{"commands":(.*),"sig":"(%x+)"}$')
    return commandsJson, sig
end

-- Compares without stopping at the first difference.
function TraitorDash.SignatureMatches(expected, got)
    if type(expected) ~= "string" or type(got) ~= "string" or #expected ~= #got or #expected == 0 then return false end
    local diff = 0
    for i = 1, #expected do
        if expected:byte(i) ~= got:byte(i) then diff = diff + 1 end
    end
    return diff == 0
end

-- The backend URL every sender uses: cleaned, and only if the channel is trusted (the token
-- travels with every request, and what comes back changes the server). Warns once.
function TraitorDash.TrustedBaseUrl(raw)
    local base = (tostring(raw or ""):gsub("[\"']", ""):gsub("/+$", ""))
    if base == "" then return nil end
    if not TraitorDash.IsTrustedTransport(base) then
        if not TraitorDash.WarnedTransport then
            TraitorDash.WarnedTransport = true
            print("[TraitorDash] Not talking to the backend: traitordash_url must be https:// (or a private address), because the token is sent with every request.")
        end
        return nil
    end
    return base
end
