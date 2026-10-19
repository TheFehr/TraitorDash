import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 10: the Maps page shows what the bridge reported. Public like the round stats: map names and
// what the vote will offer are what players see in the game anyway.

let app: any, Store: any, serverId: string, emptyId: string, cookie: string

const FP = 'cd'.repeat(32)
const M = (name: string, over: Record<string, unknown> = {}) => ({
  name, size: 22_000_000, fingerprint: FP,
  matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true,
  ...over,
})
const R = (over: Record<string, unknown> = {}) => ({
  current: 'ttt_current', next: 'ttt_next', gamemode: 'terrortown', pattern: '^ttt_',
  poolBasis: 'prefixes', configSource: 'merged', voteAddon: true,
  maps: [
    M('ttt_current', { isCurrent: true, votable: false }),
    M('ttt_next'),
    M('ttt_resting', { onCooldown: true, votable: false, size: 243_312_804 }),
    M('ttt_cycled', { inCycle: true }),
    M('gm_construct', { matchesGamemode: false, inVotePool: false, votable: false, size: 5_000_000 }),
  ],
  ...over,
})

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  serverId = Store.addServer('Maps').id
  emptyId = Store.addServer('Fresh').id
  Store.setMaps(serverId, R())
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

const get = (path: string, withCookie = false) =>
  app.fetch(new Request(`http://x${path}`, { headers: withCookie ? { Cookie: cookie } : {} }))
const page = async (id = serverId) => (await get(`/servers/${id}/maps`)).text()
/** The page as a signed-in admin sees it; `all` is the opt-in for maps outside the vote pool. */
const adminPage = async (id = serverId, all = false) => (await get(`/servers/${id}/maps${all ? '?all=1' : ''}`, true)).text()
const rowsOf = (html: string) => html.split('<tbody')[1]!.split('<tr').slice(1)
const rowFor = (html: string, name: string) => rowsOf(html).find((r: string) => r.includes(`>${name}<`))

describe('the Maps page', () => {
  test('is public, and a guest gets no link into the rule settings', async () => {
    const res = await get(`/servers/${serverId}/maps`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(`href="/servers/${serverId}"`)
  })

  test('an admin gets the link back to the server', async () => {
    expect(await (await get(`/servers/${serverId}/maps`, true)).text()).toContain(`href="/servers/${serverId}"`)
  })

  test('an unknown server goes back to the home page', async () => {
    const res = await get('/servers/nope/maps')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  test('a guest sees the maps in the vote pool and nothing outside it', async () => {
    const html = await page()
    for (const name of ['ttt_current', 'ttt_next', 'ttt_resting', 'ttt_cycled']) expect(rowFor(html, name)).toBeDefined()
    expect(html).not.toContain('gm_construct')
    expect(html).not.toContain('Not in the pool')
    expect(html).not.toContain('outside the pool')
  })

  test('a guest does not get the sizes, nor a way to ask for the hidden maps', async () => {
    for (const path of [`/servers/${serverId}/maps`, `/servers/${serverId}/maps?all=1`]) {
      const html = await (await get(path)).text()
      expect(html).not.toContain(' MB')
      expect(html).not.toContain('>Size<')
      expect(html).not.toContain('gm_construct')
    }
  })

  test('a guest sees the counts that matter to players, not how many maps are on disk', async () => {
    const html = await page()
    expect(html).not.toContain('Maps on disk')
    expect(html).toMatch(/In the vote pool<\/div>\s*<div[^>]*>4</)
    expect(html).toMatch(/Votable now<\/div>\s*<div[^>]*>2</)
  })

  test('an admin sees the sizes, and the on-disk count', async () => {
    const html = await adminPage()
    expect(html).toContain('>Size<')
    expect(html).toContain('232 MB') // 243 312 804 bytes
    expect(html).toContain('21 MB')
    expect(html).toMatch(/Maps on disk<\/div>\s*<div[^>]*>5</)
  })

  test('an admin does not see the maps outside the pool until they ask', async () => {
    const html = await adminPage()
    expect(html).not.toContain('gm_construct')
    expect(html).toContain(`/servers/${serverId}/maps?all=1`)
    expect(html).toContain('Show 1 map outside the pool')
  })

  test('with ?all=1 an admin sees them, marked, with a way back', async () => {
    const html = await adminPage(serverId, true)
    expect(rowFor(html, 'gm_construct')).toContain('Not in the pool')
    expect(rowFor(html, 'gm_construct')).toContain('5 MB')
    expect(html).toContain('Hide maps outside the pool')
    expect(html).toContain(`href="/servers/${serverId}/maps"`)
  })

  test('no toggle when every map is in the pool or the pool is unknown', async () => {
    const all = Store.addServer('AllIn').id
    Store.setMaps(all, R({ maps: [M('ttt_a'), M('ttt_b')] }))
    expect(await adminPage(all)).not.toContain('outside the pool')
    const unknown = Store.addServer('Unk2').id
    Store.setMaps(unknown, R({ poolBasis: null, maps: [M('ttt_a', { inVotePool: null, votable: null })] }))
    const html = await adminPage(unknown)
    expect(html).not.toContain('outside the pool')
    expect(rowFor(html, 'ttt_a')).toBeDefined() // unknown is shown, not hidden
  })

  test('votable maps come before the others', async () => {
    const html = (await adminPage(serverId, true)).split('<tbody')[1]! // the table only: the summary cards name maps too
    const at = (name: string) => html.indexOf(name)
    expect(at('ttt_cycled')).toBeLessThan(at('ttt_next'))
    expect(at('ttt_next')).toBeLessThan(at('ttt_current'))
    expect(at('ttt_current')).toBeLessThan(at('gm_construct'))
    expect(at('gm_construct')).toBeLessThan(at('ttt_resting'))
  })

  test('says how the pool was decided: by the vote addon\'s prefixes, by the gamemode pattern, or unknown', async () => {
    expect(await page()).toContain('vote addon')
    const gm = Store.addServer('GM').id
    Store.setMaps(gm, R({ poolBasis: 'gamemode', configSource: 'none', voteAddon: false }))
    const gmHtml = await page(gm)
    expect(gmHtml).toContain('gamemode')
    expect(gmHtml).toContain('map pattern')
    const unknown = Store.addServer('Unknown').id
    Store.setMaps(unknown, R({ poolBasis: null, pattern: null, configSource: null, voteAddon: false, maps: [M('ttt_a', { inVotePool: null, votable: null, matchesGamemode: null })] }))
    const unknownHtml = await page(unknown)
    expect(unknownHtml).toContain('unknown')
    expect(unknownHtml).toMatch(/Votable now<\/div>\s*<div[^>]*>–</)
    expect(unknownHtml).toMatch(/In the vote pool<\/div>\s*<div[^>]*>–</)
  })

  test('each badge sits on the right map\'s row', async () => {
    const rows = rowsOf(await adminPage(serverId, true))
    const row = (name: string) => rows.find((r: string) => r.includes(`>${name}<`))!
    expect(row('ttt_next')).toContain('Next')
    expect(row('ttt_next')).toContain('Votable')
    expect(row('ttt_current')).not.toContain('Next')
    expect(row('ttt_current')).toContain('Current')
    expect(row('ttt_next')).not.toContain('Current')
    expect(row('ttt_resting')).toContain('Cooldown')
    expect(row('ttt_next')).not.toContain('Cooldown')
    expect(row('ttt_cycled')).toContain('In map cycle')
    expect(row('gm_construct')).toContain('Not in the pool')
    expect(row('ttt_next')).not.toContain('Not in the pool')
  })

  test('a map the bridge could not classify is not counted as votable or as in the pool', async () => {
    const mixed = Store.addServer('Mixed').id
    Store.setMaps(mixed, R({ maps: [M('ttt_yes'), M('ttt_unsure', { votable: null, inVotePool: null })] }))
    const html = await page(mixed)
    expect(html).toMatch(/In the vote pool<\/div>\s*<div[^>]*>1</)
    expect(html).toMatch(/Votable now<\/div>\s*<div[^>]*>1</)
  })

  test('says it is derived, so nobody takes it for what the vote addon reports', async () => {
    expect(await page()).toContain('worked out')
  })

  test('never shows the file fingerprint', async () => {
    expect(await page()).not.toContain(FP)
  })

  test('shows when the report arrived, in the viewer\'s timezone element', async () => {
    expect(await page()).toContain('datetime=')
  })

  test('text from the server is escaped', async () => {
    const evil = Store.addServer('Evil').id
    Store.setMaps(evil, R({ pattern: '<script>alert(1)</script>', current: '<b>x</b>' }))
    const html = await page(evil)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<b>x</b>')
  })

  test('a server that has not reported yet says so', async () => {
    const html = await page(emptyId)
    expect(html).toContain('No map report yet')
    expect(html).not.toContain('<table')
  })
})

describe('links to the Maps page', () => {
  test('the guest home page links to each server\'s maps', async () => {
    expect(await (await get('/')).text()).toContain(`href="/servers/${serverId}/maps"`)
  })

  test('the server page links to its maps', async () => {
    expect(await (await get(`/servers/${serverId}`, true)).text()).toContain(`href="/servers/${serverId}/maps"`)
  })

  test('the stats page links to the maps page', async () => {
    expect(await (await get(`/servers/${serverId}/stats`)).text()).toContain(`href="/servers/${serverId}/maps"`)
  })
})
