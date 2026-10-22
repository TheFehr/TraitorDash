--- @ignore

-- The page of the TraitorDash role guide tab: one browser panel on the address the client built.

CLGAMEMODESUBMENU.base = "base_gamemodesubmenu"

CLGAMEMODESUBMENU.priority = 50
CLGAMEMODESUBMENU.title = "Server roles"

function CLGAMEMODESUBMENU:Populate(parent)
    local url = TraitorDash and TraitorDash.RoleGuideClient and TraitorDash.RoleGuideClient.TakeUrl()
    if not url then return end

    local html = vgui.Create("DHTML", parent)
    html:Dock(TOP)
    html:OpenURL(url)

    -- TTT2 puts a page into a scrolling area that grows to fit its content, so a panel docked to
    -- FILL collapses to a thin strip. Give the browser the height of the visible area instead.
    if html.SetTall then
        html.Think = function(self)
            local area = parent
            while area and not area.GetCanvas and area.GetParent do area = area:GetParent() end
            local tall = (area and area.GetTall and area:GetTall()) or 0
            if tall < 300 then tall = 300 end
            if self:GetTall() ~= tall then self:SetTall(tall) end
        end
    end
end
