--- @ignore

-- The role guide tab of TraitorDash (RFC 15): what each role does and how it appears on this server.
-- It is for everybody (not an admin menu) and only shown while the server has told the client where
-- the guide is. The icon is TTT2's own roles icon.

CLGAMEMODEMENU.base = "base_gamemodemenu"

CLGAMEMODEMENU.icon = Material("vgui/ttt/vskin/helpscreen/roles")
CLGAMEMODEMENU.title = "Server roles"
CLGAMEMODEMENU.description = "What each role does and how often it appears on this server"
CLGAMEMODEMENU.priority = 50

function CLGAMEMODEMENU:ShouldShow()
    local guide = TraitorDash and TraitorDash.RoleGuideClient
    return guide ~= nil and guide.Available() and self:HasVisibleSubmenus()
end
