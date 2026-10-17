import { expect, test, describe } from 'bun:test'
import { RoleConfigForm } from '../src/components/RoleConfigForm'

// The element types TTT2 role files can declare through their settings menu. The extractor
// records them as the spy saw them; each must render as the matching control.
const decode = (h: string) => h.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
const render = (schema: any[]) => decode(String(<RoleConfigForm serverId="s1" role="r" schema={schema} />))

describe('settings-menu elements', () => {
  test('MakeHelp is an info box and an extraction error is a hint, neither is editable', () => {
    const h = render([
      { type: 'MakeHelp', args: { label: 'Explains things' } },
      { type: 'error', args: { label: 'Could not read the menu' } },
    ])
    expect(h).toContain('Explains Things')
    expect(h).toContain('Extraction Hint:')
    expect(h).toContain('Could Not Read The Menu')
    expect(h).not.toContain('<input')
    expect(h).not.toContain('<select')
  })

  test('MakeCheckbox is a toggle bound to its ConVar', () => {
    const h = render([{ type: 'MakeCheckbox', args: { label: 'Enabled', convar: 'ttt_r_enabled' } }])
    expect(h).toMatch(/<input[^>]*type="checkbox"[^>]*id="ttt_r_enabled"|<input[^>]*id="ttt_r_enabled"[^>]*type="checkbox"/)
    expect(h).toContain("x-model=\"current['ttt_r_enabled']\"")
  })

  test('MakeSlider is a range with its own bounds and a step that follows `decimal`', () => {
    const whole = render([{ type: 'MakeSlider', args: { label: 'Armor', convar: 'ttt_r_armor', min: 0, max: 100, decimal: 0 } }])
    expect(whole).toContain('type="range"')
    expect(whole).toContain('min="0"')
    expect(whole).toContain('max="100"')
    expect(whole).toContain('step="1"')
    expect(render([{ type: 'MakeSlider', args: { label: 'Rate', convar: 'ttt_r_rate', min: 0, max: 1, decimal: 2 } }])).toContain('step="0.1"')
  })

  test('MakeComboBox lists its choices', () => {
    const h = render([{ type: 'MakeComboBox', args: { label: 'Mode', convar: 'ttt_r_mode', choices: ['a', 'b'] } }])
    expect(h).toContain('<select')
    expect(h).toContain('<option value="a">a</option>')
    expect(h).toContain('<option value="b">b</option>')
    expect(render([{ type: 'MakeComboBox', args: { label: 'Mode', convar: 'ttt_r_mode' } }])).toContain('<select')
  })

  test('MakeTextEntry is a text field', () => {
    const h = render([{ type: 'MakeTextEntry', args: { label: 'Name', convar: 'ttt_r_name' } }])
    expect(h).toContain('type="text"')
    expect(h).toContain("x-model=\"current['ttt_r_name']\"")
  })

  test('an element type nobody knows is named, not dropped or crashed on', () => {
    const h = render([{ type: 'MakeFancyThing', args: { label: 'x', convar: 'ttt_r_x' } }])
    expect(h).toContain('Unsupported element type: MakeFancyThing')
  })

  test('a missing type or label does not break the form', () => {
    expect(() => render([{ args: {} }, { type: null, args: { convar: 'ttt_r_y' } }])).not.toThrow()
  })
})
