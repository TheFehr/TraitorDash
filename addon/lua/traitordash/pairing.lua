-- TraitorDash: pairing a game server with the dashboard (RFC 9).
--
--   traitordash_connect <url> <code>
--
-- The dashboard shows a short single-use code. This command sends it to <url>/api/v1/pair, gets
-- the server's API token back, and stores url and token in data/traitordash/config.json (RFC 8).
-- Redeeming a code replaces the server's token, so nothing is sent until the result can be stored.
-- Neither the code nor the token is ever printed.

TraitorDash = TraitorDash or {}

local CONFIG_PATH = "traitordash/config.json"
local PROBE_PATH = "traitordash/.write_test"
local TIMEOUT = 15

local pending = false -- one pairing at a time

local function Say(msg) print("[TraitorDash] " .. msg) end

--- The canonical code, or nil if what was typed cannot be one. Same rules as the backend:
--- upper case, no dashes or spaces, O -> 0, I and L -> 1; Crockford base32, 10 characters.
function TraitorDash.NormalizePairingCode(raw)
    local code = tostring(raw or ""):upper():gsub("[%-%s]", ""):gsub("O", "0"):gsub("[IL]", "1")
    if #code ~= 10 or not code:match("^[0-9A-HJKMNP-TV-Z]+$") then return nil end
    return code
end

-- Can we store what pairing returns? Redeeming a code rotates the token: if the new one could
-- not be kept, the server would be locked out. So find out first.
local function CanWriteData()
    file.CreateDir("traitordash")
    file.Write(PROBE_PATH, "ok")
    local ok = file.Exists(PROBE_PATH, "DATA")
    if ok then file.Delete(PROBE_PATH) end
    return ok
end

local function Finish(base, body)
    local data = util.JSONToTable(body or "")
    local token = type(data) == "table" and data.token
    local name = type(data) == "table" and data.name
    if type(token) ~= "string" or #token ~= 64 or not token:match("^[0-9a-f]+$") or type(name) ~= "string" then
        Say("Pairing failed: unexpected answer from " .. base .. " (is that a TraitorDash dashboard?).")
        return
    end

    local json = util.TableToJSON({ url = base, token = token })
    file.Write(CONFIG_PATH, json)
    if file.Read(CONFIG_PATH, "DATA") ~= json then
        Say("The new token could not be saved to data/" .. CONFIG_PATH .. ". Open the dashboard and use 'Regen token' for this server, then set it up by hand.")
        return
    end

    TraitorDash.ReloadConfig()
    Say("Connected as «" .. name .. "». Syncing roles…")
    TraitorDash.Sync()
    TraitorDash.Poll()
end

local FAILURES = {
    [400] = "invalid or expired code. Create a new one in the dashboard (Connect).",
    [429] = "Too many attempts; wait a minute and try again.",
    [404] = "this dashboard does not support pairing. Use the server's token instead (see the README).",
}

concommand.Add("traitordash_connect", function(ply, cmd, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    args = args or {}

    if not args[1] or not args[2] then
        Say("Usage: traitordash_connect <url> <code>   (both are shown in the dashboard under Connect)")
        return
    end
    if pending then
        Say("A pairing is already in progress.")
        return
    end

    local base = tostring(args[1]):gsub("[\"']", ""):gsub("/+$", "")
    if base == "" or not TraitorDash.IsTrustedTransport(base) then
        Say("Refusing " .. base .. ": the pairing code and the token travel over this connection, so it must be https:// (or a private address).")
        return
    end

    local code = TraitorDash.NormalizePairingCode(table.concat(args, "", 2))
    if not code then
        Say("That does not look like a pairing code. It has 10 letters and digits, like ABCDE-FGHJK.")
        return
    end

    if not CanWriteData() then
        Say("Cannot write to data/traitordash. Pairing would replace this server's token with one it could not keep, so nothing was sent.")
        return
    end

    pending = true
    local sent = pcall(HTTP, {
        url = base .. "/api/v1/pair",
        method = "POST",
        headers = { ["Content-Type"] = "application/json" },
        body = util.TableToJSON({ code = code }),
        timeout = TIMEOUT,
        success = function(status, body)
            pending = false
            if status == 200 then
                local ok, err = pcall(Finish, base, body)
                if not ok then Say("Pairing failed: " .. tostring(err)) end
            else
                Say("Pairing failed: " .. (FAILURES[status] or ("HTTP " .. tostring(status))))
            end
        end,
        failed = function(reason)
            pending = false
            Say("Could not reach " .. base .. ": " .. tostring(reason))
        end,
    })
    if not sent then
        pending = false
        Say("Pairing failed: the request could not be made.")
    end
end)
