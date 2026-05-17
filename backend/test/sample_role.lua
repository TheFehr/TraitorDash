-- Sample TTT2 Role for Testing TraitorDash Extraction

function ROLE:AddToSettingsMenu(parent)
    parent:MakeCheckBox({
        label = "Enable Sample Role",
        convar = "ttt_sample_enabled"
    })

    parent:MakeSlider({
        label = "Sample Speed",
        convar = "ttt_sample_speed",
        min = 0,
        max = 100,
        decimal = 0
    })

    parent:MakeComboBox({
        label = "Sample Mode",
        convar = "ttt_sample_mode",
        choices = {
            "Aggressive",
            "Passive",
            "Stealth"
        }
    })
    
    -- Conditional UI
    if GetConVar("ttt_sample_advanced"):GetBool() then
        parent:MakeTextEntry({
            label = "Advanced Note",
            convar = "ttt_sample_note"
        })
    end
end
