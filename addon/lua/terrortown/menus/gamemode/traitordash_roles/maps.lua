--- @ignore

-- The page of the TraitorDash maps (RFC 16): one browser panel on the address the client built.

CLGAMEMODESUBMENU.base = "base_gamemodesubmenu"

CLGAMEMODESUBMENU.priority = 30
CLGAMEMODESUBMENU.title = "Maps"

function CLGAMEMODESUBMENU:Populate(parent)
    local guide = TraitorDash and TraitorDash.RoleGuideClient
    local url = guide and guide.SectionUrl("maps")
    if not url then return end

    guide.Browser(parent, url)
end
