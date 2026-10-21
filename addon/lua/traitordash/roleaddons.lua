-- TraitorDash: which Workshop addon does each role come from? (RFC 15, role descriptions)
--
--   traitordash_roleaddons
--
-- A mounted Workshop addon is a .gma file on the server. Its first part is a list of the files inside,
-- so the role files of an addon can be read without unpacking it: only that list is read, never the
-- contents. A role's folder (lua/terrortown/entities/roles/<name>/) then says which addon holds it.
-- Nothing is guessed from names. The result is printed and written to data/traitordash/roleaddons.json.

TraitorDash = TraitorDash or {}

local CHUNK = 65536
local MAX_LIST_BYTES = 8 * 1024 * 1024  -- the file list of an addon is read up to this much
local MAX_FILES = 200000
local MAX_NAME = 4096

--- A reader over a file object: bytes on demand, the buffer never holds more than a chunk and a bit.
local function Reader(f)
    return { f = f, data = "", pos = 1, read = 0, eof = false }
end

local function Fill(r, n)
    while #r.data - r.pos + 1 < n and not r.eof do
        if r.read >= MAX_LIST_BYTES then r.eof = true break end
        local chunk = r.f:Read(CHUNK)
        if type(chunk) ~= "string" or chunk == "" then r.eof = true break end
        r.read = r.read + #chunk
        r.data = r.data:sub(r.pos) .. chunk
        r.pos = 1
    end
    return #r.data - r.pos + 1 >= n
end

local function Skip(r, n)
    if not Fill(r, n) then return false end
    r.pos = r.pos + n
    return true
end

local function Bytes(r, n)
    if not Fill(r, n) then return nil end
    local s = r.data:sub(r.pos, r.pos + n - 1)
    r.pos = r.pos + n
    return s
end

--- A zero-terminated string, or nil when the file ends first or the string is longer than `max`.
local function CString(r, max)
    local parts, total = {}, 0
    while true do
        if not Fill(r, 1) then return nil end
        local e = r.data:find("\0", r.pos, true)
        if e then
            parts[#parts + 1] = r.data:sub(r.pos, e - 1)
            r.pos = e + 1
            return table.concat(parts)
        end
        total = total + (#r.data - r.pos + 1)
        if total > max then return nil end
        parts[#parts + 1] = r.data:sub(r.pos)
        r.pos = #r.data + 1
    end
end

--- Reads the list of files in a GMA (version 1 to 3) from `f` (anything with Read(n)). Calls `onFile(name)` for
--- each. Returns the addon's title and the number of files, or nil and why.
function TraitorDash.ReadGmaFiles(f, onFile)
    local r = Reader(f)
    if Bytes(r, 4) ~= "GMAD" then return nil, "not a GMA (it may be compressed)" end
    local version = Bytes(r, 1)
    if not version then return nil, "cut short" end
    version = version:byte()
    if version < 1 or version > 3 then return nil, "unknown GMA version " .. version end
    if not Skip(r, 16) then return nil, "cut short" end -- steam id, timestamp
    if version >= 2 then
        while true do -- required content: names until an empty one
            local s = CString(r, MAX_NAME)
            if s == nil then return nil, "cut short" end
            if s == "" then break end
        end
    end
    local title = CString(r, MAX_NAME)
    if title == nil or CString(r, 1024 * 1024) == nil or CString(r, MAX_NAME) == nil then return nil, "cut short" end -- title, description, author
    if not Skip(r, 4) then return nil, "cut short" end -- addon version

    local count = 0
    while true do
        local index = Bytes(r, 4)
        if not index then return nil, "cut short" end
        if index == "\0\0\0\0" then return title, count end
        local name = CString(r, MAX_NAME)
        if name == nil or not Skip(r, 12) then return nil, "cut short" end -- size (8), crc (4)
        count = count + 1
        if count > MAX_FILES then return nil, "too many files" end
        onFile(name)
    end
end

--- The role a file path belongs to, or nil: lua/terrortown/entities/roles/<name>/... or .../<name>.lua or sh_<name>.lua
function TraitorDash.RoleOfPath(path)
    local p = tostring(path):lower()
    local folder = p:match("^lua/terrortown/entities/roles/([^/]+)/")
    if folder then return folder end
    local single = p:match("^lua/terrortown/entities/roles/([^/]+)%.lua$")
    if single then return (single:gsub("^sh_", "")) end
    return nil
end

--- Reads every mounted addon's file list. Returns { roles = { name = { {wsid, title}, ... } }, scanned, unreadable = { {wsid, title, why} }, ms }.
function TraitorDash.FindRoleAddons()
    local started = SysTime()
    local out = { roles = {}, scanned = 0, unreadable = {} }
    for _, addon in ipairs(engine.GetAddons() or {}) do
        local wsid = tostring(addon.wsid or "")
        if addon.mounted and wsid:match("^%d+$") and #wsid <= 12 and type(addon.file) == "string" and addon.file ~= "" then
            local f = file.Open(addon.file, "rb", "GAME")
            if not f then
                out.unreadable[#out.unreadable + 1] = { wsid = wsid, title = tostring(addon.title or ""), why = "cannot open " .. addon.file }
            else
                local seen = {}
                local ok, title, err = pcall(TraitorDash.ReadGmaFiles, f, function(name)
                    local role = TraitorDash.RoleOfPath(name)
                    if role and not seen[role] then
                        seen[role] = true
                        local list = out.roles[role] or {}
                        list[#list + 1] = { wsid = wsid, title = tostring(addon.title or "") }
                        out.roles[role] = list
                    end
                end)
                f:Close()
                out.scanned = out.scanned + 1
                if not ok then
                    out.unreadable[#out.unreadable + 1] = { wsid = wsid, title = tostring(addon.title or ""), why = tostring(title) }
                elseif title == nil then
                    out.unreadable[#out.unreadable + 1] = { wsid = wsid, title = tostring(addon.title or ""), why = tostring(err) }
                end
            end
        end
    end
    out.ms = math.floor((SysTime() - started) * 1000)
    return out
end

concommand.Add("traitordash_roleaddons", function(ply)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end

    local r = TraitorDash.FindRoleAddons()
    local names = {}
    for name in pairs(r.roles) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
        local parts = {}
        for _, a in ipairs(r.roles[name]) do parts[#parts + 1] = a.title .. " (" .. a.wsid .. ")" end
        TraitorDash.Util.Say(name .. " <- " .. table.concat(parts, ", "))
    end
    for _, u in ipairs(r.unreadable) do
        TraitorDash.Util.Say("could not read " .. u.title .. " (" .. u.wsid .. "): " .. u.why)
    end
    file.CreateDir("traitordash")
    file.Write("traitordash/roleaddons.json", util.TableToJSON(r))
    TraitorDash.Util.Say(string.format("%d roles found in %d addons (%d could not be read), %d ms. Wrote data/traitordash/roleaddons.json.",
        #names, r.scanned, #r.unreadable, r.ms))
end)
