import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'

// RFC 13, 6.3: the admin page for the view log.
// All test files share one process, so what is set in the environment is taken away again.
afterAll(() => { delete process.env.OPEN_SIGNIN })

let app: any, Store: any
const ADMIN = '76561198000000000', U1 = '76561198000000041', U2 = '76561198000000042'
let serverId: string

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
})
beforeEach(() => { serverId = (Store.addServer('Views') as any).id })

const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = null) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))

describe('the view log page', () => {
  test('the store lists the newest views and counts them for each account', () => {
    Store.logView(serverId, U1, 'VIEW_REPLAY', 'r-1', 90)
    Store.logView(serverId, U1, 'VIEW_REPLAY', 'r-2', 90)
    Store.logView(serverId, U1, 'VIEW_MESH', 'ttt_a', 90)
    Store.logView(serverId, U2, 'VIEW_REPLAY', 'r-1', 90)
    Store.logView(serverId, U2, 'VIEW_REPLAY', 'r-1', 90) // within the hour: no new row
    const all = Store.getViews(serverId)
    expect(all.rows.length).toBe(4)
    expect(all.accounts[0]).toMatchObject({ steamId: U1, views: 3, things: 3 })
    expect(all.accounts[1]).toMatchObject({ steamId: U2, views: 1, things: 1 })
    expect(Store.getViews(serverId, { steamId: U2 }).rows.length).toBe(1)
    expect(Store.getViews(serverId, { action: 'VIEW_MESH' }).rows.map((r: any) => r.what)).toEqual(['ttt_a'])
    expect(Store.getViews('other').rows).toEqual([])
  })

  test('an admin sees the accounts and the views, with links to what was opened', async () => {
    Store.logView(serverId, U1, 'VIEW_REPLAY', 'round-0001', 90)
    Store.logView(serverId, U1, 'VIEW_MESH', 'ttt_airbus_b3', 90)
    const r = await get(`/servers/${serverId}/views`, ADMIN)
    expect(r.status).toBe(200)
    const t = await r.text()
    // a page without a doctype is in quirks mode, where a table takes the page's pale text colour onto the cream card
    expect(t.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(t).toContain('data-view-accounts'); expect(t).toContain('data-view-rows')
    expect(t).toContain(U1)
    expect(t).toContain(`/servers/${serverId}/rounds/round-0001`)
    expect(t).toContain(`/servers/${serverId}/maps/ttt_airbus_b3`)
    expect(t).toContain(`views?player=${U1}`)
  })

  test('the filters narrow it, and a filter with nothing keeps the way out', async () => {
    Store.logView(serverId, U1, 'VIEW_REPLAY', 'round-0001', 90)
    Store.logView(serverId, U2, 'VIEW_MESH', 'ttt_a', 90)
    const one = await (await get(`/servers/${serverId}/views?player=${U1}`, ADMIN)).text()
    expect(one).toContain('round-0001'); expect(one).not.toContain('ttt_a</a>'); expect(one).toContain('All accounts')
    const maps = await (await get(`/servers/${serverId}/views?what=map`, ADMIN)).text()
    expect(maps).not.toContain('round-0001'); expect(maps).toContain('ttt_a')
    const none = await (await get(`/servers/${serverId}/views?player=${U2}&what=replay`, ADMIN)).text()
    expect(none).toContain('data-no-views'); expect(none).toContain('All accounts')
    expect(none).toContain(`href="/servers/${serverId}/views?what=replay"`)
  })

  test('a visitor, a signed-in user and an unknown server get nothing', async () => {
    Store.logView(serverId, U1, 'VIEW_REPLAY', 'round-0001', 90)
    for (const as of [null, U1]) {
      const r = await get(`/servers/${serverId}/views`, as)
      expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/')
      expect(await r.text()).not.toContain('round-0001')
    }
    expect((await get('/servers/nope/views', ADMIN)).status).toBe(302)
  })

  test('the server page links to it for an admin', async () => {
    expect(await (await get(`/servers/${serverId}`, ADMIN)).text()).toContain(`/servers/${serverId}/views`)
  })
})
