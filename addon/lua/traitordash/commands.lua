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
-- SHA-256 over "token \n nonce \n body \n token", as lowercase hex. `sha256` is util.SHA256.
function TraitorDash.ExpectedSignature(token, nonce, body, sha256)
    return sha256(token .. "\n" .. nonce .. "\n" .. body .. "\n" .. token)
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

-- HTTP header names come back in whatever case the server sent them.
function TraitorDash.FindHeader(headers, name)
    if type(headers) ~= "table" then return nil end
    name = name:lower()
    for k, v in pairs(headers) do
        if type(k) == "string" and k:lower() == name then return v end
    end
    return nil
end
