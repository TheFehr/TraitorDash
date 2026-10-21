-- TraitorDash: small checks and helpers shared by the server files and the client file of the role
-- guide. Nothing here touches the game, so it loads on both sides.
--
-- The rules mirror backend/src/services/validators.ts; backend/test/validators_agree.test.ts runs
-- both against one list of cases. Change them together.

TraitorDash = TraitorDash or {}
if TraitorDash.Util then return end

local Util = {}
TraitorDash.Util = Util

-- A role or map name in an address: letters, digits and _ . - and starting with a letter or digit
-- (never "." or ".."). All safe in an address as they are, so nothing needs encoding.
Util.NAME_PATTERN = "^%w[%w_%.%-]*$"
Util.MAX_NAME = 64
Util.MAX_BASE = 200
-- The most players a page is asked about; the backend's parsePlayers uses the same limit.
Util.MAX_PLAYERS = 128

function Util.ValidName(name)
    return type(name) == "string" and #name >= 1 and #name <= Util.MAX_NAME and name:match(Util.NAME_PATTERN) ~= nil
end

--- A server id as the dashboard hands them out: letters, digits and dashes, at most 64.
function Util.ValidServerId(id)
    return type(id) == "string" and #id >= 1 and #id <= 64 and id:match("^[%w%-]+$") ~= nil
end

--- Checks an https address players can reach. True, or false and why: "scheme", "chars" or "long".
function Util.CheckBase(base)
    if type(base) ~= "string" then return false, "scheme" end
    local host, rest = base:match("^https://([%w%.%-]+:?%d*)(.*)$")
    if not host or host == "" or host:sub(1, 1) == "." or host:sub(1, 1) == "-" then return false, "scheme" end
    if rest ~= "" and not rest:match("^/[%w%-_%./]*$") then return false, "chars" end
    if #base > Util.MAX_BASE then return false, "long" end
    return true
end

function Util.ValidBase(base)
    return (Util.CheckBase(base))
end

--- The number of players as a page address wants it: a whole number from 1 to 128, else nil.
function Util.PlayerCount(count)
    if type(count) == "number" and count >= 1 and count <= Util.MAX_PLAYERS and count == math.floor(count) then return count end
    return nil
end

function Util.Trim(s)
    return (tostring(s):gsub("^%s+", ""):gsub("%s+$", ""))
end

--- A console line with the addon's name in front.
function Util.Say(msg)
    print("[TraitorDash] " .. msg)
end
