import { expect, test, describe } from 'bun:test'
import { RoleConfigForm } from '../src/components/RoleConfigForm'

// What the extractor produces for the real survivalist role (names verified against a live server).
const survivalist = [
  ['pct', 0.15, 'ttt_survivalist_pct'],
  ['maximum', 2, 'ttt_survivalist_max'],
  ['minPlayers', 7, 'ttt_survivalist_min_players'],
  ['minKarma', 400, 'ttt_survivalist_karma_min'],
  ['credits', 1, 'ttt_surv_credits_starting'],
  ['creditsAwardDeadEnable', 1, 'ttt_surv_credits_award_dead_enb'],
  ['creditsAwardKillEnable', 0, 'ttt_surv_credits_award_kill_enb'],
  ['togglable', true, 'ttt_survivalist_enabled'],
  ['shopFallback', 'detective', 'ttt_surv_shop_fallback'],
].map(([key, value, convar]) => ({ type: 'conVarData', args: { key, value, convar } }))

// Attribute values are HTML-escaped in the output; a browser decodes them, so compare decoded.
const decode = (h: string) => h.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
const html = decode(String(<RoleConfigForm serverId="s1" role="survivalist" schema={survivalist} />))
// the rendered <input> tag for one ConVar
const input = (convar: string) => html.match(new RegExp(`<input[^>]*id="${convar}"[^>]*>`))?.[0] ?? ''

describe('RoleConfigForm controls', () => {
  test('numbers are number inputs, never sliders, and are not capped at 100', () => {
    const karma = input('ttt_survivalist_karma_min')
    expect(karma).toContain('type="number"')
    expect(karma).not.toContain('max=')
    expect(html).not.toContain('type="range"')
  })

  test('pct is bounded to 0..1 with a fine step', () => {
    const pct = input('ttt_survivalist_pct')
    expect(pct).toContain('max="1"')
    expect(pct).toContain('step="0.01"')
  })

  test('on/off settings are toggles, including the 0/1 "…Enable" ones', () => {
    for (const c of ['ttt_survivalist_enabled', 'ttt_surv_credits_award_dead_enb', 'ttt_surv_credits_award_kill_enb']) {
      expect(input(c)).toContain('type="checkbox"')
    }
  })

  test('credits is a number even though it is 1 (not a toggle)', () => {
    expect(input('ttt_surv_credits_starting')).toContain('type="number"')
  })

  test('text settings stay text', () => {
    expect(input('ttt_surv_shop_fallback')).toContain('type="text"')
  })

  test('only changed fields are sent, and unchecked toggles still submit 0', () => {
    expect(html).toContain('dirtyKeys()')
    expect(html).toContain("(v ? '1' : '0')")
  })

  test('the real starting values are in the model unclamped', () => {
    expect(html).toContain('"ttt_survivalist_karma_min":400')
  })
})

describe('legacy element types', () => {
  test('MakeCheckbox (as the mock emits it) is a toggle, not "unsupported"', () => {
    const out = decode(String(<RoleConfigForm serverId="s" role="r" schema={[{ type: 'MakeCheckbox', args: { label: 'Foo', convar: 'ttt_foo' } }]} />))
    expect(out).toContain('type="checkbox"')
    expect(out).not.toContain('Unsupported element type')
  })
})

describe('labels', () => {
  test("standard conVarData keys use TTT2's own wording, with the ConVar name underneath", () => {
    expect(html).toContain('Role distribution per player')
    expect(html).toContain('every fifth player')
    expect(html).toContain('Lower limit of Karma to consider distribution')
    expect(html).toContain('Lower limit of players to consider distribution')
    expect(html).toContain('Upper limit of players assigned for this role')
    expect(html).toContain('Starting credits')
    expect(html).toContain('Enable role')
    expect(html).toContain('Enable credits award for high value player kill')
    expect(html).toContain('ttt_survivalist_karma_min</span>')
    expect(html).not.toContain('>Pct<')
    expect(html).not.toContain('>MinKarma<')
  })

  test('unknown keys are de-camel-cased', () => {
    const out = decode(String(<RoleConfigForm serverId="s" role="r" schema={[{ type: 'conVarData', args: { key: 'someNewThing', value: 5, convar: 'ttt_r_some_new_thing' } }]} />))
    expect(out).toContain('Some New Thing')
  })
})

describe('live values from the server', () => {
  const live = {
    ttt_survivalist_pct: { role: 'survivalist', present: true, value: '1', default: '0.15', min: 0, max: 1, updatedAt: 'x' },
    ttt_survivalist_karma_min: { role: 'survivalist', present: true, value: '400', default: '400', min: 0, max: 1000, updatedAt: 'x' },
    ttt_survivalist_enabled: { role: 'survivalist', present: true, value: '0', default: '1', min: 0, max: 1, updatedAt: 'x' },
    ttt_surv_shop_fallback: { role: 'survivalist', present: false, value: null, default: null, min: null, max: null, updatedAt: 'x' },
    // not in the role file's schema, but the server has them
    ttt_survivalist_random: { role: 'survivalist', present: true, value: '25', default: '100', min: 0, max: 100, updatedAt: 'x' },
    ttt_survivalist_traitor_button: { role: 'survivalist', present: true, value: '0', default: '0', min: 0, max: 1, updatedAt: 'x' },
    // another role's ConVar must not leak in
    ttt_detective_hats: { role: 'detective', present: true, value: '0', default: '0', min: 0, max: 1, updatedAt: 'x' },
  }
  const withLive = decode(String(<RoleConfigForm serverId="s1" role="survivalist" schema={survivalist} live={live} />))
  const liveInput = (convar: string) => withLive.match(new RegExp(`<input[^>]*id="${convar}"[^>]*>`))?.[0] ?? ''

  test('starts from what the server reports, not from the role default', () => {
    expect(withLive).toContain('"ttt_survivalist_pct":1,')       // reported 1, role default is 0.15
    expect(withLive).toContain('"ttt_survivalist_enabled":false') // reported 0, role default is true
  })

  test("uses the server's own bounds", () => {
    expect(liveInput('ttt_survivalist_karma_min')).toContain('max="1000"')
  })

  test('tags where each value came from', () => {
    expect(withLive).toContain('title="Value reported by the game server"')
    expect(withLive).toContain("title=\"Not reported by the server yet: showing the role's default\"") // e.g. credits
    expect(withLive).toContain('not on server') // ttt_surv_shop_fallback
  })

  test('settings only the server knows about show up as extras with the right controls', () => {
    expect(withLive).toContain('Other settings found on the server')
    expect(withLive).toContain('Chance this role is distributed')
    expect(liveInput('ttt_survivalist_random')).toContain('type="number"')
    expect(liveInput('ttt_survivalist_random')).toContain('max="100"')
    expect(liveInput('ttt_survivalist_traitor_button')).toContain('type="checkbox"')
  })

  test("another role's ConVars are not shown", () => {
    expect(withLive).not.toContain('ttt_detective_hats')
  })

  test('without live data the form still works and says everything is a default', () => {
    expect(html).not.toContain('Other settings found on the server')
    expect(html).toContain('>default</span>')
  })
})
