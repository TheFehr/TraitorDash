--- @ignore

-- The server info tab of TraitorDash (RFC 15, RFC 16): the role guide, the round stats and the maps.
-- It is for everybody (not an admin menu) and only shown while the server has told the client where
-- the guide is. The icon is TTT2's own roles icon.

CLGAMEMODEMENU.base = "base_gamemodemenu"

CLGAMEMODEMENU.icon = Material("vgui/ttt/vskin/helpscreen/roles")
CLGAMEMODEMENU.title = "Server info"
CLGAMEMODEMENU.description = "Roles, round stats and maps of this server"
CLGAMEMODEMENU.priority = 50

function CLGAMEMODEMENU:ShouldShow()
    local guide = TraitorDash and TraitorDash.RoleGuideClient
    return guide ~= nil and guide.Available() and self:HasVisibleSubmenus()
end
