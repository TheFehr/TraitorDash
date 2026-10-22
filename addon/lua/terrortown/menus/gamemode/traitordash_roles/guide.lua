--- @ignore

-- The page of the TraitorDash role guide: one browser panel on the address the client built.

CLGAMEMODESUBMENU.base = "base_gamemodesubmenu"

CLGAMEMODESUBMENU.priority = 50
CLGAMEMODESUBMENU.title = "Server roles"

function CLGAMEMODESUBMENU:Populate(parent)
    local url = TraitorDash and TraitorDash.RoleGuideClient and TraitorDash.RoleGuideClient.TakeUrl()
    if not url then return end

    TraitorDash.RoleGuideClient.Browser(parent, url)
end
