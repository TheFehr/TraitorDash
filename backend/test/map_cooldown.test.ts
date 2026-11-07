import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 10, 4.5: the maps page can show the vote's cooldown or ignore it.
let app: any, Store: any, applyCooldown: any
const ADMIN = '76561198000000000', USER = '76561198000000041'
let serverId: string

beforeAll(async () => {
  app = (await import('../src/index')).app
  const store = await import('../src/services/Store')
  Store = store.Store; applyCooldown = store.applyCooldown
})
const report = {
  current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: null, poolBasis: 'prefixes', configSource: 'file', voteAddon: true,
  maps: [
    { name: 'ttt_a', size: 1, fingerprint: null, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: true, inVotePool: true, votable: false },
    { name: 'ttt_b', size: 1, fingerprint: null, matchesGamemode: true, inCycle: false, onCooldown: true, isCurrent: false, inVotePool: true, votable: false },
    { name: 'ttt_c', size: 1, fingerprint: null, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true },
    { name: 'ttt_d', size: 1, fingerprint: null, matchesGamemode: false, inCycle: false, onCooldown: true, isCurrent: false, inVotePool: false, votable: false },
  ],
}
beforeEach(() => { serverId = (Store.addServer('Cool') as any).id; Store.setMaps(serverId, report) })

const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = null) => app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))
const post = async (path: string, body: string, as: string | null = null) =>
  app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(as ? { Cookie: await cookie(as) } : {}) }, body }))

describe('the map cooldown switch', () => {
  test('it is on by default: the vote\'s cooldown is shown, as before', () => {
    expect(Store.getMapCooldown(serverId)).toBe(true)
    const { maps, state } = Store.getMaps(serverId)
    expect(state.cooldown).toBe(true)
    expect(maps.find((m: any) => m.name === 'ttt_b')).toMatchObject({ onCooldown: true, votable: false })
  })

  test('off: a map held back only by the cooldown is votable and not marked; the running map and maps outside the pool keep what the vote said', () => {
    Store.setMapCooldown(serverId, false)
    const { maps, state } = Store.getMaps(serverId)
    expect(state.cooldown).toBe(false)
    const by = (n: string) => maps.find((m: any) => m.name === n)
    expect(by('ttt_b')).toMatchObject({ onCooldown: false, votable: true })
    expect(by('ttt_a')).toMatchObject({ isCurrent: true, votable: false })
    expect(by('ttt_c')).toMatchObject({ votable: true })
    expect(by('ttt_d')).toMatchObject({ onCooldown: false, votable: false }) // not in the pool: no cooldown to show, still not votable
    Store.setMapCooldown(serverId, true)
    expect(Store.getMaps(serverId).maps.find((m: any) => m.name === 'ttt_b').onCooldown).toBe(true)
  })

  test('applyCooldown leaves a map alone when the cooldown is on or the map is not on it', () => {
    const m = report.maps[1]!
    expect(applyCooldown(m, true)).toBe(m)
    expect(applyCooldown(report.maps[2]!, false)).toBe(report.maps[2]!)
  })

  test('the switch is on the settings page, saved with the replay limits; the maps page follows it; nobody else can use it', async () => {
    const page = await (await get(`/servers/${serverId}/settings`, ADMIN)).text()
    expect(page).toContain('data-maps-cooldown'); expect(page).toContain('id="maps_cooldown"'); expect(page).toContain('&quot;maps_cooldown&quot;:true')
    expect(await (await get(`/servers/${serverId}/maps`, ADMIN)).text()).toContain('Cooldown</i>')
    const r = await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=0', ADMIN)
    expect(r.status).toBe(200)
    expect((await r.json()).map_cooldown).toBe(false)
    expect(Store.getMapCooldown(serverId)).toBe(false)
    const after = await (await get(`/servers/${serverId}/maps`, ADMIN)).text()
    expect(after).not.toContain('Cooldown</i>'); expect(after).toContain('data-cooldown-ignored')
    expect(await (await get(`/servers/${serverId}/settings`, ADMIN)).text()).toContain('&quot;maps_cooldown&quot;:false')
    expect(await (await get(`/servers/${serverId}/maps`, USER)).text()).not.toContain('data-cooldown-ignored')
    for (const as of [null, USER]) expect((await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=1', as)).status).toBe(401)
    expect(Store.getMapCooldown(serverId)).toBe(false)
    await post(`/api/track-limits/${serverId}`, 'count=&mb=', ADMIN) // a save that does not say leaves it as it is
    expect(Store.getMapCooldown(serverId)).toBe(false)
    await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=1', ADMIN)
    expect(Store.getMapCooldown(serverId)).toBe(true)
  })

  test('a change is audited, and a save that changes nothing is not', async () => {
    const db = (await import('../src/services/Database')).default as any
    const audit = () => db.query("SELECT action FROM audit_log WHERE server_id = ? AND action LIKE 'MAP_COOLDOWN_%'").all(serverId).map((r: any) => r.action)
    await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=1', ADMIN)
    expect(audit()).toEqual([])
    await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=0', ADMIN)
    await post(`/api/track-limits/${serverId}`, 'count=&mb=&cooldown=0', ADMIN)
    expect(audit()).toEqual(['MAP_COOLDOWN_IGNORED'])
  })
})
