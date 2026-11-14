-- TraitorDash: the client's part of `!voice` (RFC 31, 11).
--
-- After the player's own `!voice` the server sends the one-time code; it is put on the clipboard so it can be pasted into the field on the
-- voice page. Only a string with exactly the shape of a code is ever copied: nothing else a server (or anything pretending to be one) sends
-- can put text on a player's clipboard. Anything else is ignored silently.

if not CLIENT then return end

-- The same shape as CODE_SHAPE in traitordash/voice.lua: XXX-XXX from digits 2-9 and consonants without L.
local CODE_SHAPE = "^[2-9BCDFGHJKMNPQRSTVWXYZ][2-9BCDFGHJKMNPQRSTVWXYZ][2-9BCDFGHJKMNPQRSTVWXYZ]%-[2-9BCDFGHJKMNPQRSTVWXYZ][2-9BCDFGHJKMNPQRSTVWXYZ][2-9BCDFGHJKMNPQRSTVWXYZ]$"

net.Receive("TraitorDash_VoiceCode", function()
    local code = net.ReadString()
    if type(code) ~= "string" or #code ~= 7 or not code:match(CODE_SHAPE) then return end
    SetClipboardText(code)
end)
