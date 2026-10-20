import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { existsSync } from 'node:fs'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 15, the look: each role in its own colour, roles that need more players than the round has
// put away, and the pages' fonts served by the app.

let app: any, Store: any, mod: any, Extractor: any, rv: any
let serverId: string
const get = (path: string) => app.fetch(new Request(`http://localhost${path}`))
const live = (name: string, value: string, role: string) => ({ name, role, present: true, value, default: null, min: null, max: null })

beforeAll(async () => {
  mod = await import('../src/index')
  app = mod.app
  Store = (await import('../src/services/Store')).Store
  Extractor = (await import('../src/services/Extractor')).Extractor
  rv = await import('../src/services/roleview')
})

beforeEach(() => {
  mod.resetRolePages()
  serverId = (Store.addServer('Look') as any).id
  Store.saveSchema(serverId, 'haunter', 'traitors', false, -1, [], 'h', 'x', '#ff00aa')
  Store.saveSchema(serverId, 'plain', 'innocents', false, -1, [], 'p', null)
  Store.saveSchema(serverId, 'dead', 'innocents', false, -1, [], 'd', null)
  Store.setConVarValues(serverId, [
    live('ttt_haunter_min_players', '8', 'haunter'), live('ttt_haunter_pct', '0.1', 'haunter'),
    live('ttt_dead_min_players', '2', 'dead'), live('ttt_dead_enabled', '0', 'dead'),
  ])
})

const card = (html: string, role: string) => html.match(new RegExp(`<a class="f ([a-z ]*)" style="--c:(#[0-9a-f]{6})" href="[^"]*/roles/${role}[?"][^>]*>.*?</a>`))

describe('colours', () => {
  test("a role's own colour is used, else its team's", async () => {
    const html = await (await get(`/servers/${serverId}/roles`)).text()
    expect(card(html, 'haunter')![2]!).toBe('#ff00aa')
    expect(card(html, 'plain')![2]!).toBe('#22c55e') // innocents
    expect(await (await get(`/servers/${serverId}/roles/haunter`)).text()).toContain('--c:#ff00aa')
  })
  test('a colour that is not #rrggbb is never stored', () => {
    for (const bad of ['red', '#fff', '#ff00aa;}x{', 'url(x)', '#GGGGGG', '']) {
      Store.saveSchema(serverId, 'haunter', 'traitors', false, -1, [], 'h2', 'x', bad)
      expect(Store.getRoles(serverId).find((r: any) => r.role_name === 'haunter').color).toBeNull()
    }
  })
  test('the colour reaches the page after a role is sent again', async () => {
    Store.saveSchema(serverId, 'haunter', 'traitors', false, -1, [], 'h3', 'x', '#00ff00')
    expect(await (await get(`/servers/${serverId}/roles/haunter`)).text()).toContain('--c:#00ff00')
  })
})

describe('players', () => {
  const list = async (q = '') => (await get(`/servers/${serverId}/roles${q}`)).text()
  test('without a count nothing is put away', async () => {
    const html = await list()
    expect(card(html, 'haunter')![1]!.trim()).toBe('')
    expect(html).not.toContain('Round of')
  })
  test('a role that needs more players than the round has is put away, and says how many are missing', async () => {
    const html = await list('?players=6')
    expect(card(html, 'haunter')![1]!).toContain('few')
    expect(card(html, 'haunter')![0]).toContain('needs 8+')
    expect(card(html, 'haunter')![0]).toContain('2 more players needed')
    expect(html).toContain('Round of <b>6 players</b>')
  })
  test('one player short reads in the singular; enough players makes the role active', async () => {
    expect(card(await list('?players=7'), 'haunter')![0]).toContain('1 more player needed')
    expect(card(await list('?players=8'), 'haunter')![1]!.trim()).toBe('')
  })
  test('roles that can appear come first, then the put away ones, then the disabled ones', async () => {
    Store.saveSchema(serverId, 'aaa', 'innocents', false, -1, [], 'a', null)
    Store.setConVarValues(serverId, [live('ttt_aaa_min_players', '20', 'aaa'), live('ttt_haunter_min_players', '8', 'haunter'), live('ttt_dead_enabled', '0', 'dead')])
    const names = async (q: string) => [...(await list(q)).matchAll(/<a class="f [a-z ]*" style="--c:#[0-9a-f]{6}" href="[^"]*\/roles\/([^?"]+)/g)].map(m => m[1])
    expect(await names('')).toEqual(['aaa', 'plain', 'haunter', 'dead'])
    expect(await names('?players=6')).toEqual(['plain', 'aaa', 'haunter', 'dead'])
    expect(await names('?players=8')).toEqual(['plain', 'haunter', 'aaa', 'dead'])
  })
  test('a role with no reported minimum is never put away', async () => {
    expect(card(await list('?players=1'), 'plain')![1]!.trim()).toBe('')
  })
  test('a disabled role stays disabled whatever the count', async () => {
    for (const q of ['', '?players=1', '?players=100']) expect(card(await list(q), 'dead')![1]).toContain('off')
  })
  test('a count that is not a whole number from 1 to 128 is ignored', async () => {
    for (const bad of ['0', '129', '-3', '1.5', 'abc', '', '9999', '8%20', '1e2', '%3Cscript%3E']) {
      const html = await list(`?players=${bad}`)
      expect(html, bad).not.toContain('Round of')
      expect(html, bad).not.toContain('<script')
    }
    expect(rv.parsePlayers('128')).toBe(128)
    expect(rv.parsePlayers('1')).toBe(1)
  })
  test('the count and the embed layout stay on every link', async () => {
    const html = await list('?players=6&embed=1&q=h')
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]!)
    expect(links.length).toBeGreaterThan(3)
    for (const l of links) expect(l).toContain('embed=1')
    // all but the "all" link, which is how to leave the count, carry it
    expect(links.filter(l => !l.includes('players='))).toHaveLength(1)
    expect(html).toContain('name="players" value="6"')
  })
  test('the role page says what is missing', async () => {
    const html = await (await get(`/servers/${serverId}/roles/haunter?players=5`)).text()
    expect(html).toContain('it needs 8+ players, and this round has 5')
    expect(html).toContain('3 more players needed')
    expect(await (await get(`/servers/${serverId}/roles/haunter?players=9`)).text()).not.toContain('Not in play yet')
  })
  test('pages for different counts are not mixed up by the cache or the validator', async () => {
    const a = await get(`/servers/${serverId}/roles?players=6`), b = await get(`/servers/${serverId}/roles?players=9`)
    expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'))
    expect(await a.text()).not.toBe(await b.text())
  })
})

describe('fonts', () => {
  test('every font the page asks for is served, with a long cache and the right type', async () => {
    const html = await (await get(`/servers/${serverId}/roles`)).text()
    const urls = [...html.matchAll(/url\((\/fonts\/[a-z0-9-]+\.woff2)\)/g)].map(m => m[1]!)
    expect(urls.length).toBe(4)
    for (const u of urls) {
      const r = await get(u)
      expect(r.status === 200).toBe(true)
      expect(r.headers.get('cache-control')).toContain('immutable')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(5000)
    }
  })
  test('the policy allows fonts from the app itself and nothing else', async () => {
    const csp = (await get(`/servers/${serverId}/roles`)).headers.get('content-security-policy')!
    expect(csp).toContain("font-src 'self'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src')
  })
  test('there is no font that is not there, and no way out of the folder', async () => {
    for (const u of ['/fonts/nope.woff2', '/fonts/../index.tsx', '/fonts/%2e%2e/index.tsx']) expect((await get(u)).status === 200).toBe(false)
  })
  test('the licence texts and the font files are in the repository', () => {
    for (const f of ['OFL-courier-prime.txt', 'OFL-barlow-condensed.txt', 'README.md']) expect(existsSync(`${import.meta.dir}/../src/fonts/${f}`), f).toBe(true)
  })
})

describe('the extractor reads ROLE.color', () => {
  const code = (body: string) => `function ROLE:PreInitialize()\n${body}\nend`
  test('a colour the role sets is returned as #rrggbb', async () => {
    expect((await Extractor.extractSchema(code('self.color = Color(10, 20, 30, 255)'))).color).toBe('#0a141e')
    expect((await Extractor.extractSchema(code('self.color = Color(209, 43, 39)'))).color).toBe('#d12b27')
  })
  test('no colour set, or one that is not a colour, gives null', async () => {
    for (const body of ['', 'self.color = Color(300, 0, 0)', 'self.color = Color(-1, 0, 0)', 'self.color = Color(1.5, 0, 0)', 'self.color = "red"', 'self.color = COLOR_NOT_DEFINED', 'self.color = Color("a", 0, 0)'])
      expect((await Extractor.extractSchema(code(body))).color, body).toBeNull()
  })
  test('a colour set in Initialize counts too', async () => {
    expect((await Extractor.extractSchema('function ROLE:Initialize() self.color = Color(1, 2, 3) end')).color).toBe('#010203')
  })
})
