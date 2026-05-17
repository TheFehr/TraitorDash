import { Extractor } from './src/services/Extractor'

const roleCode = `
local ROLE = roles.GetByAbbreviation("test")
function ROLE:AddToSettingsMenu(parent)
    parent:MakeCheckBox({
        label = "Test Label",
        convar = "test_convar"
    })
end
`

async function test() {
    try {
        console.log('Starting Extraction Test...')
        const schema = await Extractor.extractSchema(roleCode)
        console.log('Extracted Schema:', JSON.stringify(schema, null, 2))
    } catch (e) {
        console.error('Extraction Failed:', e)
    }
}

test()
