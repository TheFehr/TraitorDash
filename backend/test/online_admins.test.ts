import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 2, 4: the heartbeat names the admins in the game; while there are some, the pages that edit a server say that
// in-game changes win. Who may edit on the web stays ADMIN_STEAM_IDS (RFC 5), whatever the game says.

let app: any, Store: any, cookie: string, serverId: string, token: string
const ADMIN = '76561198000000000', A = '76561198000000001', B = '76561198000000002'

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  cookie = (await serializeSigned('steam_id', ADMIN, 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

beforeEach(() => {
  const added = Store.addServer('Admins') as any
  serverId = added.id; token = added.token
})

const poll = (body: unknown) => app.fetch(new Request('http://localhost/api/v1/poll', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))
const page = async (path: string) => (await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }))).text()

describe('the store keeps the admins of the last heartbeat for a minute', () => {
  test('the SteamID64s of the last heartbeat; none before the first or after a minute', () => {
    expect(Store.getOnlineAdmins(serverId)).toEqual([])
    Store.setOnlineAdmins(serverId, [A, B], 1_000_000)
    expect(Store.getOnlineAdmins(serverId, 1_000_000 + 59_000)).toEqual([A, B])
    expect(Store.getOnlineAdmins(serverId, 1_000_000 + 61_000)).toEqual([])
  })
  test('a new heartbeat replaces the list, an empty one clears it', () => {
    Store.setOnlineAdmins(serverId, [A], Date.now())
    Store.setOnlineAdmins(serverId, [B], Date.now())
    expect(Store.getOnlineAdmins(serverId)).toEqual([B])
    Store.setOnlineAdmins(serverId, [], Date.now())
    expect(Store.getOnlineAdmins(serverId)).toEqual([])
  })
  test('a value that is not a SteamID64 is dropped, a list that is not a list is none, duplicates and more than 32 are cut', () => {
    Store.setOnlineAdmins(serverId, [A, 'x', 5, null, A, '<b>'], Date.now())
    expect(Store.getOnlineAdmins(serverId)).toEqual([A])
    Store.setOnlineAdmins(serverId, 'nope', Date.now())
    expect(Store.getOnlineAdmins(serverId)).toEqual([])
    Store.setOnlineAdmins(serverId, Array.from({ length: 50 }, (_, i) => `7656119800000${String(1000 + i)}`), Date.now())
    expect(Store.getOnlineAdmins(serverId)).toHaveLength(32)
  })
  test('one server\'s admins are not another\'s', () => {
    const other = (Store.addServer('Other') as any).id
    Store.setOnlineAdmins(serverId, [A], Date.now())
    expect(Store.getOnlineAdmins(other)).toEqual([])
  })
  test('a player a round knows is named by the nick', () => {
    Store.recordRound(serverId, { roundId: 'r-000001', map: 'ttt_a', startedAt: null, duration: 60, result: 'innocents', players: [{ steamId: A, nick: 'Alice', role: 'innocent', team: 'innocents', survived: true, won: true }], deaths: [] })
    Store.setOnlineAdmins(serverId, [A, B], Date.now())
    expect(Store.getOnlineAdmins(serverId)).toEqual(['Alice', B])
  })
})

describe('the notice on the pages that edit a server', () => {
  test('the heartbeat with admins puts the notice on the settings page, with their names escaped', async () => {
    Store.recordRound(serverId, { roundId: 'r-000002', map: 'ttt_a', startedAt: null, duration: 60, result: 'innocents', players: [{ steamId: A, nick: '<i>Eve</i>', role: 'innocent', team: 'innocents', survived: true, won: true }], deaths: [] })
    expect((await poll({ active_admins: [A] })).status).toBe(200)
    const html = await page(`/servers/${serverId}/settings`)
    expect(html).toContain('In-game changes take priority and may overwrite web-based edits.')
    expect(html).toContain('&lt;i&gt;Eve&lt;/i&gt;')
    expect(html).not.toContain('<i>Eve</i>')
  })
  test('with none in the game there is no notice, and a heartbeat that names none clears it', async () => {
    expect(await page(`/servers/${serverId}/settings`)).not.toContain('In-game changes take priority')
    await poll({ active_admins: [A] })
    expect(await page(`/servers/${serverId}/settings`)).toContain('In-game changes take priority')
    await poll({ active_admins: [] })
    expect(await page(`/servers/${serverId}/settings`)).not.toContain('In-game changes take priority')
  })
  test('a heartbeat without the field, or with garbage, keeps working and names nobody', async () => {
    expect((await poll({})).status).toBe(200)
    expect((await poll({ active_admins: 'x' })).status).toBe(200)
    expect(Store.getOnlineAdmins(serverId)).toEqual([])
  })
  test('naming someone does not make them an admin of the web', async () => {
    await poll({ active_admins: [A] })
    const cookieA = (await serializeSigned('steam_id', A, 'test-secret-test-secret-test-secret-0')).split(';')[0]!
    const r = await app.fetch(new Request(`http://localhost/servers/${serverId}/settings`, { headers: { Cookie: cookieA }, redirect: 'manual' }))
    expect(r.status).not.toBe(200)
  })
})
