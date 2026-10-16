import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

// Same values as save.test.ts: modules are shared across test files, and session.ts reads these once.
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

const { isRoleEnabled, roleMetrics, METRICS } = await import('../src/services/roles')
const { ServerDashboard, filterState } = await import('../src/components/ServerDashboard')

const lv = (value: string | null, present = true) => ({ role: null, present, value, default: null, min: null, max: null, updatedAt: 'x' })

describe('isRoleEnabled', () => {
  test('off only when the server reported its ConVar and it is 0 / false', () => {
    expect(isRoleEnabled({ ttt_zombie_enabled: lv('0') }, 'zombie')).toBe(false)
    expect(isRoleEnabled({ ttt_zombie_enabled: lv('false') }, 'zombie')).toBe(false)
    expect(isRoleEnabled({ ttt_zombie_enabled: lv('1') }, 'zombie')).toBe(true)
  })

  test('unknown counts as enabled, so the default filter never hides what it cannot tell is off', () => {
    expect(isRoleEnabled({}, 'zombie')).toBe(true)                                   // never reported
    expect(isRoleEnabled({ ttt_zombie_enabled: lv(null, false) }, 'zombie')).toBe(true) // ConVar does not exist
    expect(isRoleEnabled({ ttt_zombie_enabled: lv(null) }, 'zombie')).toBe(true)         // no value
  })

  test("one role's setting does not affect another", () => {
    expect(isRoleEnabled({ ttt_zombie_enabled: lv('0') }, 'vampire')).toBe(true)
  })
})

// The filter logic ships to the browser as a string, so run it here against fake tiles.
describe('role overview filter (Alpine state)', () => {
  const tile = (role: string, team: string, enabled: boolean) => ({ dataset: { role, team, enabled: enabled ? '1' : '0' } })
  const tiles = [
    tile('traitor', 'traitors', true),
    tile('vampire', 'traitors', false),
    tile('innocent', 'innocents', true),
    tile('survivalist', 'innocents', true),
    tile('sheriff', 'detectives', false),
  ]
  const make = () => {
    const state: any = new Function(`return ${filterState}`)()
    state.$root = { querySelectorAll: () => tiles }
    state.$watch = () => {}
    return state
  }

  test('enabled only is ON by default and hides disabled roles', () => {
    const s = make()
    expect(s.enabledOnly).toBe(true)
    expect(s.shown()).toBe(3)
    expect(s.total()).toBe(5)
    expect(s.visible(tiles[1])).toBe(false) // vampire, disabled
  })

  test('turning it off shows everything', () => {
    const s = make()
    s.enabledOnly = false
    expect(s.shown()).toBe(5)
  })

  test('team and text filters combine with it', () => {
    const s = make()
    s.team = 'innocents'
    expect(s.shown()).toBe(2)
    s.q = 'SURV'
    expect(s.shown()).toBe(1)
    s.enabledOnly = false
    s.team = 'detectives'
    s.q = ''
    expect(s.shown()).toBe(1) // the disabled sheriff, now visible
  })

  test('a team section hides when none of its roles match', () => {
    const s = make()
    const section = (...ts: any[]) => ({ querySelectorAll: () => ts })
    expect(s.sectionVisible(section(tiles[4]))).toBe(false)             // only a disabled role
    expect(s.sectionVisible(section(tiles[4], tiles[0]))).toBe(true)
  })

  test('the remembered choices (filter, sort, grouping) are restored, and a storage failure is harmless', () => {
    const g: any = globalThis
    const s = make()
    g.localStorage = { getItem: () => JSON.stringify({ enabledOnly: false, sortBy: 'pct', desc: false, flat: true }), setItem: () => {} }
    s.init()
    expect(s).toMatchObject({ enabledOnly: false, sortBy: 'pct', desc: false, flat: true })

    // junk in storage never breaks the page or sets an unknown sort
    const j = make()
    g.localStorage = { getItem: () => JSON.stringify({ sortBy: 'nonsense', enabledOnly: 'yes' }), setItem: () => {} }
    j.init()
    expect(j).toMatchObject({ enabledOnly: true, sortBy: 'name' })

    const t = make()
    g.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => t.init()).not.toThrow()
    expect(t.enabledOnly).toBe(true)
    delete g.localStorage
  })
})

// Sorting: tiles carry data-<metric> numbers; the browser ranks them and prints the value on each card.
describe('role overview sorting (Alpine state)', () => {
  const tile = (role: string, data: Record<string, string> = {}) =>
    ({ dataset: { role, team: 'x', enabled: '1', ...data } })
  const zombie = tile('zombie', { pct: '0.4', pctText: '40 %', max: '1000000000', maxText: 'unlimited', minPlayers: '', minPlayersText: '—' })
  const alpha = tile('alpha', { pct: '0.15', pctText: '15 %', max: '2', maxText: '2', minPlayers: '7', minPlayersText: '7' })
  const beta = tile('beta', { pct: '1', pctText: '100 %', max: '4', maxText: '4', minPlayers: '3', minPlayersText: '3' })
  const nodata = tile('nodata', { pct: '', pctText: '—', max: '', maxText: '—', minPlayers: '', minPlayersText: '—' })
  const all = [zombie, alpha, beta, nodata]

  const make = () => {
    const watchers: Record<string, (v: any) => void> = {}
    const state: any = new Function(`return ${filterState}`)()
    state.$root = { querySelectorAll: () => all }
    state.$watch = (key: string, fn: (v: any) => void) => { watchers[key] = fn }
    state.init()
    state.watchers = watchers
    return state
  }
  const order = (s: any) => [...all].sort((a, b) => s.rank(a) - s.rank(b)).map(t => t.dataset.role)

  test('by name, A to Z by default', () => {
    expect(order(make())).toEqual(['alpha', 'beta', 'nodata', 'zombie'])
  })

  test('by name, reversed', () => {
    const s = make(); s.desc = true
    expect(order(s)).toEqual(['zombie', 'nodata', 'beta', 'alpha'])
  })

  test('picking a number starts highest first (and name goes back to A-Z)', () => {
    const s = make()
    s.sortBy = 'pct'; s.watchers.sortBy('pct')
    expect(s.desc).toBe(true)
    s.sortBy = 'name'; s.watchers.sortBy('name')
    expect(s.desc).toBe(false)
  })

  test('by distribution, highest first, and the roles with no value are always last', () => {
    const s = make(); s.sortBy = 'pct'; s.desc = true
    expect(order(s)).toEqual(['beta', 'zombie', 'alpha', 'nodata'])
    s.desc = false
    expect(order(s)).toEqual(['alpha', 'zombie', 'beta', 'nodata']) // nodata still last, not first
  })

  test('unlimited max sorts as the largest', () => {
    const s = make(); s.sortBy = 'max'; s.desc = true
    expect(order(s)).toEqual(['zombie', 'beta', 'alpha', 'nodata'])
  })

  test('ties fall back to the role name, so the order is stable', () => {
    const a = tile('b-role', { pct: '0.5', pctText: '50 %' }); const b = tile('a-role', { pct: '0.5', pctText: '50 %' })
    const s: any = new Function(`return ${filterState}`)()
    s.$root = { querySelectorAll: () => [a, b] }; s.sortBy = 'pct'
    expect(s.rank(b)).toBeLessThan(s.rank(a))
  })

  test('each card prints the value it is sorted by, labelled', () => {
    const s = make()
    expect(s.valueText(alpha)).toBe('')                       // sorting by name: nothing extra
    s.sortBy = 'pct'
    expect(s.valueText(alpha)).toBe('Role distribution: 15 %')
    expect(s.valueText(zombie)).toBe('Role distribution: 40 %')
    expect(s.valueText(nodata)).toBe('Role distribution: —')   // visibly "no value", not blank
    s.sortBy = 'max'
    expect(s.valueText(zombie)).toBe('Max players: unlimited')
    s.sortBy = 'minPlayers'
    expect(s.valueText(beta)).toBe('Min players: 3')
  })
})

describe('role overview markup', () => {
  const server = { id: 's1', name: 'DRAI', last_seen: null }
  const roles = [
    { role_name: 'traitor', team: 'traitors', is_policing: 0, baserole: -1, enabled: true },
    { role_name: 'vampire', team: 'traitors', is_policing: 0, baserole: 1, enabled: false },
    { role_name: 'sheriff', team: 'innocents', is_policing: 1, baserole: 2, enabled: true },
  ]
  const html = String(<ServerDashboard server={server} roles={roles} />)

  test('every tile carries what the filter needs, and disabled ones are marked', () => {
    expect(html).toMatch(/data-role="vampire"[^>]*data-team="traitors"[^>]*data-enabled="0"/)
    expect(html).toMatch(/data-role="traitor"[^>]*data-enabled="1"/)
    expect(html).toContain('>disabled<')
  })

  test('the filter bar is there, with the team list and the enabled-only switch', () => {
    expect(html).toContain('Enabled only')
    expect(html).toContain('All teams')
    expect(html).toContain('<option value="detectives">Detectives</option>')
    expect(html).toContain('Filter roles...')
  })

  test('no bar on a server without roles', () => {
    const empty = String(<ServerDashboard server={server} roles={[]} />)
    expect(empty).not.toContain('Enabled only')
    expect(empty).toContain('No roles detected')
  })
})

describe('roleMetrics', () => {
  const lv = (value: string | null, role: string | null = null, present = true) => ({ role, present, value, default: null, min: null, max: null, updatedAt: 'x' })
  const live = {
    ttt_survivalist_pct: lv('1', 'survivalist'),
    ttt_survivalist_max: lv('2', 'survivalist'),
    ttt_survivalist_min_players: lv('7', 'survivalist'),
    ttt_survivalist_karma_min: lv('400', 'survivalist'),
    ttt_survivalist_random: lv('25', 'survivalist'),
    ttt_surv_credits_starting: lv('1', 'survivalist'),
    ttt_detective_credits_starting: lv('9', 'detective'),
  }

  test('reads each value, with the text the card will print', () => {
    const m = roleMetrics(live, 'survivalist')
    expect(m.pct).toEqual({ sort: 1, text: '100 %' })
    expect(m.max).toEqual({ sort: 2, text: '2' })
    expect(m.minPlayers).toEqual({ sort: 7, text: '7' })
    expect(m.minKarma).toEqual({ sort: 400, text: '400' })
    expect(m.random).toEqual({ sort: 25, text: '25 %' })
  })

  test('credits are found through the role the bridge tagged them with (the ConVar uses the abbr)', () => {
    expect(roleMetrics(live, 'survivalist').credits).toEqual({ sort: 1, text: '1' })
    expect(roleMetrics(live, 'detective').credits).toEqual({ sort: 9, text: '9' }) // not survivalist's
  })

  test('max 0 means no limit', () => {
    const m = roleMetrics({ ttt_x_max: lv('0', 'x') }, 'x')
    expect(m.max.text).toBe('unlimited')
    expect(m.max.sort).toBeGreaterThan(1000)
  })

  test('a fraction is shown as a percentage without float noise', () => {
    expect(roleMetrics({ ttt_x_pct: lv('0.150000', 'x') }, 'x').pct.text).toBe('15 %')
    expect(roleMetrics({ ttt_x_pct: lv('0.13', 'x') }, 'x').pct.text).toBe('13 %')
  })

  test('nothing reported, a missing ConVar and non-numbers all read as no value', () => {
    for (const live of [{}, { ttt_x_pct: lv(null, 'x', false) }, { ttt_x_pct: lv('abc', 'x') }, { ttt_x_pct: lv('', 'x') }]) {
      expect(roleMetrics(live as any, 'x').pct).toEqual({ sort: null, text: '—' })
    }
  })

  test("another role's values never leak in", () => {
    expect(roleMetrics(live, 'vampire').pct.sort).toBeNull()
  })

  test('every metric the overview offers is computed', () => {
    expect(Object.keys(roleMetrics({}, 'x')).sort()).toEqual(Object.keys(METRICS).sort())
  })
})

describe('sort controls and card markup', () => {
  const server = { id: 's1', name: 'DRAI', last_seen: null }
  const metrics = {
    pct: { sort: 0.15, text: '15 %' }, max: { sort: 2, text: '2' }, minPlayers: { sort: null, text: '—' },
    minKarma: { sort: 400, text: '400' }, random: { sort: 25, text: '25 %' }, credits: { sort: 1, text: '1' },
  }
  const html = String(<ServerDashboard server={server} roles={[{ role_name: 'survivalist', team: 'innocents', is_policing: 1, baserole: 0, enabled: true, metrics }]} />)

  test('offers every metric to sort by, a direction switch and the one-list option', () => {
    expect(html).toContain('Sort by')
    expect(html).toContain('<option value="name">Name</option>')
    for (const [key, m] of Object.entries(METRICS)) expect(html).toContain(`<option value="${key}">${m.label}</option>`)
    expect(html).toContain('One list (ignore teams)')
  })

  test('each card carries the sort values and the text it prints (kebab-cased data attributes)', () => {
    expect(html).toContain('data-pct="0.15"')
    expect(html).toContain('data-pct-text="15 %"')
    expect(html).toContain('data-min-players=""')           // no value: empty, so it sorts last
    expect(html).toContain('data-min-players-text="—"')
    expect(html).toContain('data-min-karma="400"')
  })

  test('each card has a place for the sorted value, shown only when not sorting by name', () => {
    expect(html).toContain('x-show="sortBy !== &#39;name&#39;"')
    expect(html).toContain('valueText($el.closest(&#39;[data-role]&#39;))')
  })

  test('style bindings are the OBJECT form, so sorting cannot undo what x-show hides', () => {
    // The string form replaces the whole style attribute and wipes the display:none that x-show sets:
    // hidden (disabled / filtered-out) roles reappeared as soon as the sort changed.
    expect(html).toContain('x-bind:style="{ order: rank($el) }"')
    const tags = html.match(/<[^>]+>/g) ?? []
    const offenders = tags.filter(t => /\sx-show=/.test(t) && /\sx-bind:style="(?!\{)/.test(t))
    expect(offenders).toEqual([])
  })

  test('a role without metrics (no live data at all) still renders, with "no value" attributes', () => {
    const bare = String(<ServerDashboard server={server} roles={[{ role_name: 'x', team: 'innocents', is_policing: 0, baserole: -1, enabled: true }]} />)
    expect(bare).toContain('data-pct=""')
    expect(bare).toContain('data-pct-text="—"')
  })
})

describe('GET /servers/:id (through the real app)', () => {
  let app: any, serverId: string, cookie: string

  beforeAll(async () => {
    app = (await import('../src/index')).default
    const { Store } = await import('../src/services/Store')
    serverId = Store.addServer('Overview').id
    for (const name of ['traitor', 'zombie', 'newrole']) Store.saveSchema(serverId, name, 'traitors', false, -1, [])
    Store.setConVarValues(serverId, [
      { name: 'ttt_traitor_enabled', role: 'traitor', present: true, value: '1' },
      { name: 'ttt_zombie_enabled', role: 'zombie', present: true, value: '0' },
      // newrole has no report at all
    ])
    cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
  })

  test('marks roles from the live state; a role with no report counts as enabled', async () => {
    const res = await app.fetch(new Request(`http://x/servers/${serverId}`, { headers: { Cookie: cookie } }))
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toMatch(/data-role="zombie"[^>]*data-enabled="0"/)
    expect(html).toMatch(/data-role="traitor"[^>]*data-enabled="1"/)
    expect(html).toMatch(/data-role="newrole"[^>]*data-enabled="1"/)
  })

  test('the overview carries the live values the cards sort by', async () => {
    const { Store } = await import('../src/services/Store')
    Store.setConVarValues(serverId, [{ name: 'ttt_traitor_pct', role: 'traitor', present: true, value: '0.34' }])
    const res = await app.fetch(new Request(`http://x/servers/${serverId}`, { headers: { Cookie: cookie } }))
    const html = await res.text()
    expect(html).toMatch(/data-role="traitor"[^>]*data-pct="0.34"[^>]*data-pct-text="34 %"/)
    expect(html).toMatch(/data-role="newrole"[^>]*data-pct=""/) // not reported: sorts last
  })

  test('the sidebar dims a disabled role', async () => {
    const res = await app.fetch(new Request(`http://x/sidebar/${serverId}`, { headers: { Cookie: cookie } }))
    const html = await res.text()
    const rows: string[] = String(html).split('<a ').slice(1)
    const row = (role: string) => rows.find(r => r.includes(`/roles/${role}"`)) ?? ''
    expect(row('zombie')).toContain('opacity-50')
    expect(row('zombie')).toContain('Disabled on this server')
    expect(row('traitor')).not.toContain('opacity-50')
    expect(row('newrole')).not.toContain('opacity-50')
  })
})
