--- @ignore

-- The page of the TraitorDash round stats (RFC 16): one browser panel on the address the client built.

CLGAMEMODESUBMENU.base = "base_gamemodesubmenu"

CLGAMEMODESUBMENU.priority = 40
CLGAMEMODESUBMENU.title = "Round stats"

function CLGAMEMODESUBMENU:Populate(parent)
    local guide = TraitorDash and TraitorDash.RoleGuideClient
    local url = guide and guide.SectionUrl("stats")
    if not url then return end

    guide.Browser(parent, url)
end
