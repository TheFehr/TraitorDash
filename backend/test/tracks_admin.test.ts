import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 12, 3.4: an admin sees what a server keeps of position tracks, changes how much, and pins
// a round's track. Every change needs an admin session, a same-site Origin, and is audited.

let app: any, Store: any, db: any, cookie: string, serverId: string, token: string
const ADMIN = '76561198000000000', A = '76561198000000001'
let n = 0

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', ADMIN, 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

beforeEach(async () => {
  Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 300, maxMb: 300, maxPinned: 2 })
  const added = Store.addServer('Admin') as any
  serverId = added.id; token = added.token
})

const req = (path: string, init: RequestInit = {}, auth = true) =>
  app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(auth ? { Cookie: cookie } : {}), ...(init.headers as any) } }))
const form = (path: string, body: string, auth = true, headers: Record<string, string> = {}) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body }, auth)

/** A round with a stored track. */
async function tracked() {
  const id = `round-${String(++n).padStart(6, '0')}`
  Store.recordRound(serverId, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'innocents', players: [{ steamId: A, nick: 'a', role: 'innocent', team: 'innocents', survived: true, won: true }], deaths: [] })
  const track = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0], players: [{ id: A, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [] }
  Store.recordTrack(serverId, track, JSON.stringify(track))
  return id
}
const audit = (action: string) => db.query('SELECT steam_id, details FROM audit_log WHERE server_id = ? AND action = ?').all(serverId, action) as any[]

describe('the limits card', () => {
  test('an admin sees the usage and the limits on the stats page; a guest sees none of it', async () => {
    await tracked()
    const html = await (await req(`/servers/${serverId}/stats?view=rounds`)).text()
    expect(html).toContain('data-tracks')
    expect(html).toMatch(/1 track, 0\.0 MB used of 200 tracks \/ 200 MB/)
    expect(html).toContain('At most 300 tracks and 300 MB')
    const guest = await (await req(`/servers/${serverId}/stats?view=rounds`, {}, false)).text()
    expect(guest).not.toContain('data-tracks')
    expect(guest).not.toContain('Position tracks')
  })

  test('saving sets the server\'s own limits, an empty field falls back, and the audit log says who', async () => {
    const r = await form(`/servers/${serverId}/tracks/limits`, 'count=7&mb=')
    expect(r.status).toBe(302)
    expect(Store.getTrackLimits(serverId)).toMatchObject({ count: 7, mb: 200, own: { count: 7, mb: null } })
    expect(audit('TRACK_LIMITS_CHANGED')).toEqual([{ steam_id: ADMIN, details: 'count=7 mb=default' }])
    await form(`/servers/${serverId}/tracks/limits`, 'count=&mb=')
    expect(Store.getTrackLimits(serverId).own).toEqual({ count: null, mb: null })
  })

  test('0 is allowed; above the ceiling, negative or not a number is refused and changes nothing', async () => {
    expect((await form(`/servers/${serverId}/tracks/limits`, 'count=0&mb=0')).status).toBe(302)
    expect(Store.getTrackLimits(serverId)).toMatchObject({ count: 0, mb: 0 })
    for (const body of ['count=301&mb=', 'count=&mb=301', 'count=-1&mb=', 'count=abc&mb=', 'count=1.5&mb=']) {
      expect((await form(`/servers/${serverId}/tracks/limits`, body)).status).toBe(400)
    }
    expect(Store.getTrackLimits(serverId).own).toEqual({ count: 0, mb: 0 })
    expect(audit('TRACK_LIMITS_CHANGED')).toHaveLength(1)
  })

  test('lowering the limit removes the surplus at once', async () => {
    const ids = [await tracked(), await tracked(), await tracked()]
    await form(`/servers/${serverId}/tracks/limits`, 'count=1&mb=')
    expect(ids.map(i => Store.hasTrack(serverId, i))).toEqual([false, false, true])
  })

  test('not an admin: 401; a page from another site: 403; an unknown server: 404; nothing changes', async () => {
    expect((await form(`/servers/${serverId}/tracks/limits`, 'count=5&mb=', false)).status).toBe(401)
    expect((await form(`/servers/${serverId}/tracks/limits`, 'count=5&mb=', true, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await form(`/servers/nope/tracks/limits`, 'count=5&mb=')).status).toBe(404)
    expect(Store.getTrackLimits(serverId).own).toEqual({ count: null, mb: null })
    expect(audit('TRACK_LIMITS_CHANGED')).toHaveLength(0)
  })
})

describe('pinning', () => {
  test('an admin pins and unpins, and the audit log says who', async () => {
    const id = await tracked()
    expect((await form(`/servers/${serverId}/rounds/${id}/pin`, 'pin=1')).status).toBe(302)
    expect(Store.getTrack(serverId, id).meta.pinned).toBe(true)
    expect(audit('TRACK_PINNED')).toEqual([{ steam_id: ADMIN, details: id }])
    await form(`/servers/${serverId}/rounds/${id}/pin`, 'pin=0')
    expect(Store.getTrack(serverId, id).meta.pinned).toBe(false)
    expect(audit('TRACK_UNPINNED')).toHaveLength(1)
  })

  test('the card counts the pins', async () => {
    const id = await tracked()
    await form(`/servers/${serverId}/rounds/${id}/pin`, 'pin=1')
    expect(await (await req(`/servers/${serverId}/stats?view=rounds`)).text()).toMatch(/1 pinned, kept regardless; at most 2/)
  })

  test('at the maximum a pin is refused with a message; a round without a track is 404', async () => {
    const ids = [await tracked(), await tracked(), await tracked()]
    await form(`/servers/${serverId}/rounds/${ids[0]}/pin`, 'pin=1')
    await form(`/servers/${serverId}/rounds/${ids[1]}/pin`, 'pin=1')
    const r = await form(`/servers/${serverId}/rounds/${ids[2]}/pin`, 'pin=1')
    expect(r.status).toBe(409)
    expect(await r.text()).toMatch(/unpin one first/)
    expect(Store.getTrack(serverId, ids[2]!).meta.pinned).toBe(false)
    expect((await form(`/servers/${serverId}/rounds/round-nothing/pin`, 'pin=1')).status).toBe(404)
    expect(audit('TRACK_PINNED')).toHaveLength(2)
  })

  test('not an admin: 401; a page from another site: 403; another server\'s round: 404', async () => {
    const id = await tracked()
    expect((await form(`/servers/${serverId}/rounds/${id}/pin`, 'pin=1', false)).status).toBe(401)
    expect((await form(`/servers/${serverId}/rounds/${id}/pin`, 'pin=1', true, { Origin: 'https://evil.example' })).status).toBe(403)
    const other = (Store.addServer('Other') as any).id
    expect((await form(`/servers/${other}/rounds/${id}/pin`, 'pin=1')).status).toBe(404)
    expect(Store.getTrack(serverId, id).meta.pinned).toBe(false)
  })
})
