-- TraitorDash: the client's part of the role guide (RFC 15, 4.5).
--
-- The server sends, once, the dashboard's public https address and this server's id on it. The
-- address of a page is built HERE from those two and a role name; the client never opens an address
-- it was sent, and the dashboard is not contacted until the player opens the tab or asks for a role.

if not CLIENT then return end

TraitorDash = TraitorDash or {}
if not TraitorDash.Util then include("traitordash/util.lua") end
local Util = TraitorDash.Util
local Guide = {}
TraitorDash.RoleGuideClient = Guide

Guide.base = nil
Guide.serverId = nil
Guide.wanted = nil     -- a role name to open on, consumed by the tab when it is built
Guide.announced = false
Guide.key = nil        -- what the game server sent to vouch for this player (RFC 16, 4)
Guide.panels = {}      -- the browser panels built for a section: { html = panel, section = "stats" | "maps" }

--- True when the server has told us where the guide is.
function Guide.Available()
    return Guide.base ~= nil and Guide.serverId ~= nil
end

--- The page for a role, or for the list when `name` is nil or "". Nil when unavailable or the name is not a plain name.
function Guide.Url(name)
    if not Guide.Available() then return nil end
    local url = Guide.base .. "/servers/" .. Guide.serverId .. "/roles"
    if name ~= nil and name ~= "" then
        if not Util.ValidName(name) then return nil end
        url = url .. "/" .. name
    end
    -- The page greys out the roles that need more players than are here now.
    local count = Util.PlayerCount(player and player.GetCount and player.GetCount())
    if count then return url .. "?embed=1&players=" .. count end
    return url .. "?embed=1"
end

--- Takes what the server sent. Anything that does not look right switches the guide off.
function Guide.SetInit(base, serverId)
    if Util.ValidBase(base) and Util.ValidServerId(serverId) then
        Guide.base, Guide.serverId = base, serverId
    else
        Guide.base, Guide.serverId = nil, nil
    end
end

local function Encode(text)
    return (text:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", c:byte()) end))
end

--- Takes the key the game server sent for this player. Anything that does not look like one is dropped.
function Guide.SetKey(key)
    if type(key) == "string" and #key <= 100 and key:match("^%d+%.%d+%.[%w_%-]+$") then
        local first = Guide.key == nil
        Guide.key = key
        if first then
            print("[TraitorDash] The game server vouched for you: round stats and maps can open replays and 3D views.")
            Guide.ReloadPanels()
        end
    else
        Guide.key = nil
    end
end

--- Opens again the pages that were built before the key came: TTT2 builds a menu page once, when it is
-- first opened, so a page built in the first seconds after joining would keep an address without the key.
function Guide.ReloadPanels()
    for i = #Guide.panels, 1, -1 do
        local p = Guide.panels[i]
        if not IsValid(p.html) then
            table.remove(Guide.panels, i)
        else
            local url = Guide.SectionUrl(p.section)
            if url then p.html:OpenURL(url) end
        end
    end
end

--- The page of a section of the guide: "stats" (round stats) or "maps". Nil when unavailable or the name is another.
-- With a key the address goes through the dashboard's game sign-in, which sets a session for this player
-- (a plain user) and then goes on to the page; without one it is the page itself, which is public.
function Guide.SectionUrl(section)
    if not Guide.Available() then return nil end
    if section ~= "stats" and section ~= "maps" then return nil end
    local path = "/servers/" .. Guide.serverId .. "/" .. section .. "?embed=1"
    if Guide.key then return Guide.base .. "/auth/game?k=" .. Guide.key .. "&to=" .. Encode(path) end
    return Guide.base .. path
end

--- A browser panel on `url`, as tall as the visible area of the menu page it sits in.
-- TTT2 puts a page into a scrolling area that grows to fit its content, so a panel docked to FILL
-- collapses to a thin strip; this one is given the height of the area instead.
function Guide.Browser(parent, url, section)
    local html = vgui.Create("DHTML", parent)
    html:Dock(TOP)
    html:OpenURL(url)
    if section then Guide.panels[#Guide.panels + 1] = { html = html, section = section } end
    if html.SetTall then
        html.Think = function(self)
            local area = parent
            while area and not area.GetCanvas and area.GetParent do area = area:GetParent() end
            local tall = (area and area.GetTall and area:GetTall()) or 0
            if tall < 300 then tall = 300 end
            if self:GetTall() ~= tall then self:SetTall(tall) end
        end
    end
    return html
end

local function Say(text)
    if chat and chat.AddText then chat.AddText(Color(255, 255, 255), "[Roles] ", Color(200, 200, 200), text) end
end

--- Our menu class in TTT2's menu list (a global it fills in), or nil.
local function FindMenu()
    if type(menusIndexed) ~= "table" then return nil end
    for _, m in ipairs(menusIndexed) do
        if m.type == "traitordash_roles" then return m end
    end
end

--- Opens the F1 menu on the tab, on a role when `name` is given. Falls back to a hint in chat.
function Guide.Open(name)
    if not Guide.Available() then return end
    if name ~= nil and name ~= "" and not Util.ValidName(name) then return end
    Guide.wanted = (name ~= "" and name) or nil
    local menu = FindMenu()
    if HELPSCRN and HELPSCRN.ShowMainMenu and HELPSCRN.ShowSubmenu and menu then
        HELPSCRN:ShowMainMenu()
        HELPSCRN:ShowSubmenu(menu)
    else
        Say("Open the Server roles tab in the F1 menu.")
    end
end

--- What the tab shows when it is built: the wanted role once, else the list. Also says once where from.
function Guide.TakeUrl()
    local url = Guide.Url(Guide.wanted)
    Guide.wanted = nil
    if url and not Guide.announced then
        Guide.announced = true
        Say("Opening the role guide from " .. (Guide.base:match("^https://([^/]+)") or Guide.base) .. ".")
    end
    return url
end

net.Receive("TraitorDash_RolesInit", function()
    Guide.SetInit(net.ReadString(), net.ReadString())
end)

net.Receive("TraitorDash_RolesKey", function()
    Guide.SetKey(net.ReadString())
end)

net.Receive("TraitorDash_RolesOpen", function()
    Guide.Open(net.ReadString())
end)
