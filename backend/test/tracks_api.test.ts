import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 12, 3.3 and 3.4: POST /api/v1/track stores one track per reported round, strictly checked,
// and the retention limits (count, size, pins) decide how many are kept.

let api: any, db: any, Store: any, token: string, serverId: string, other: { id: string, token: string }, n = 0
const A = '76561198000000001', B = '76561198000000002'

beforeAll(async () => {
  const mod = await import('../src/routes/api')
  api = mod.default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
})

beforeEach(async () => {
  const mod = await import('../src/routes/api')
  mod.trackLimiter.reset(); mod.roundLimiter.reset()
  const t = await import('../src/services/tracks')
  Store.setTrackConfig(t.TRACK_DEFAULTS)
  const added = Store.addServer('Tracks') as any
  serverId = added.id; token = added.token
  other = Store.addServer('Other') as any
})

const post = (path: string, body: unknown, tok = token) => api.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** Reports a round (as the bridge does first) and returns its id. */
const EXTRA = ['76561198000000003', '76561198000000004']
async function round(tok = token, map = 'ttt_example', more: string[] = []) {
  const id = `round-${String(++n).padStart(6, '0')}`
  const r = await post('/v1/round', { round_id: id, map, result: 'innocents', duration: 300, players: [{ steam_id: A, nick: 'a', role: 'innocent', team: 'innocents' }, { steam_id: B, nick: 'b', role: 'traitor', team: 'traitors' }, ...more.map(m => ({ steam_id: m, nick: m, role: 'innocent', team: 'innocents' }))], deaths: [] }, tok)
  expect(r.status).toBe(200)
  return id
}

const track = (roundId: string, over: Record<string, unknown> = {}) => ({
  round_id: roundId, map: 'ttt_example', t: [0, 200, 200],
  players: [{ id: A, segments: [{ from: 0, x: [10, 1, 1], y: [10, 0, 0], z: [5, 0, 0], a: [1, 1, 1] }] }],
  deaths: [{ victim: B, attacker: A, t: 400, vx: 1, vy: 2, vz: 3, ax: 4, ay: 5, az: 6 }],
  ...over,
})
const count = (id = serverId) => (db.query('SELECT COUNT(*) AS n FROM round_tracks WHERE server_id = ?').get(id) as any).n

describe('POST /api/v1/track', () => {
  test('stores a track for a reported round, once; a repeat changes nothing', async () => {
    const id = await round()
    const r = await post('/v1/track', track(id))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, stored: true })
    const again = await post('/v1/track', track(id, { t: [0, 100, 100] }))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ success: true, stored: false })
    expect(count()).toBe(1)
    expect(Store.getTrack(serverId, id).track.t).toEqual([0, 200, 200])
  })

  test('the stored track reads back as it was sent', async () => {
    const id = await round()
    await post('/v1/track', track(id, { fingerprint: 'ab'.repeat(32), truncated: true }))
    const got = Store.getTrack(serverId, id)
    expect(got.meta).toMatchObject({ map: 'ttt_example', fingerprint: 'ab'.repeat(32), truncated: true, degraded: false, pinned: false })
    expect(got.meta.bytes).toBe(Buffer.byteLength(JSON.stringify(got.track)))
    expect(got.track.players[0].segments[0].x).toEqual([10, 1, 1])
  })

  test('needs the server token', async () => {
    const id = await round()
    expect((await api.request('/v1/track', { method: 'POST', body: JSON.stringify(track(id)) })).status).toBe(401)
    expect((await post('/v1/track', track(id), 'nope')).status).toBe(401)
    expect(count()).toBe(0)
  })

  test('refuses a round the server has not reported, and another server\'s round', async () => {
    expect((await post('/v1/track', track('round-unknown-1'))).status).toBe(400)
    const theirs = await round(other.token)
    expect((await post('/v1/track', track(theirs))).status).toBe(400)
    expect(count()).toBe(0)
    expect(count(other.id)).toBe(0)
  })

  test('refuses a track that does not fit, and stores nothing', async () => {
    const id = await round()
    for (const bad of [
      track(id, { t: [0, 1.5] }),
      track(id, { players: [{ id: '76561198999999999', segments: [] }] }),
      track(id, { map: 'ttt_other' }),
      track(id, { players: [{ id: A, segments: [{ from: 0, x: [9999], y: [0], z: [0], a: [0] }] }] }),
      '{not json',
      'null',
    ]) {
      const r = await post('/v1/track', bad)
      expect(r.status).toBe(400)
    }
    expect(count()).toBe(0)
  })

  test('a body over 8 MB is a 413 and stores nothing', async () => {
    const id = await round()
    const r = await post('/v1/track', JSON.stringify({ ...track(id), pad: 'x'.repeat(8 * 1024 * 1024 + 1) }))
    expect(r.status).toBe(413)
    expect(count()).toBe(0)
  })

  test('is rate limited per server', async () => {
    const id = await round()
    let last = 0
    for (let i = 0; i < 11; i++) last = (await post('/v1/track', 'null')).status
    expect(last).toBe(429)
    const wait = await post('/v1/track', track(id))
    expect(wait.status).toBe(429)
    expect(wait.headers.get('Retry-After')).toBeTruthy()
    // another server is not held up
    const theirs = await round(other.token)
    expect((await post('/v1/track', track(theirs), other.token)).status).toBe(200)
  })

  test('is deleted with its round and with its server', async () => {
    const id = await round()
    await post('/v1/track', track(id))
    Store.deleteServer(serverId)
    expect(count()).toBe(0)
  })
})

describe('retention', () => {
  const put = async (extra: Record<string, unknown> = {}) => {
    const id = await round()
    const r = await post('/v1/track', track(id, extra))
    return { id, status: r.status, body: await r.json() as any }
  }
  const has = (id: string) => Store.hasTrack(serverId, id)

  test('keeps the newest by count and drops the oldest', async () => {
    Store.setTrackConfig({ ...Store.getTrackConfig(), keepCount: 3 })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await put()).id)
    expect(ids.map(has)).toEqual([false, false, true, true, true])
  })

  test('keeps the newest by size when the bytes are exceeded first', async () => {
    const a = await put()
    const size = Store.getTrack(serverId, a.id).meta.bytes
    // room for two tracks of this size, but not three (mb is whole, so the limit is set on the row's bytes directly)
    Store.setTrackConfig({ ...Store.getTrackConfig(), keepMb: 1 })
    db.run('UPDATE round_tracks SET bytes = ? WHERE server_id = ?', [Math.floor(0.4 * 1024 * 1024), serverId])
    const b = await put(), c = await put()
    db.run('UPDATE round_tracks SET bytes = ? WHERE server_id = ?', [Math.floor(0.4 * 1024 * 1024), serverId])
    Store.enforceTrackLimits(serverId)
    expect([a.id, b.id, c.id].map(has)).toEqual([false, true, true])
    expect(size).toBeGreaterThan(0)
  })

  test('a server\'s own limits override the default, within the ceiling', async () => {
    Store.setTrackConfig({ keepCount: 10, keepMb: 10, maxCount: 20, maxMb: 20, maxPinned: 5 })
    expect(Store.getTrackLimits(serverId)).toMatchObject({ count: 10, mb: 10 })
    Store.setTrackLimits(serverId, 2, null)
    expect(Store.getTrackLimits(serverId)).toMatchObject({ count: 2, mb: 10, own: { count: 2, mb: null } })
    Store.setTrackLimits(serverId, 99, 99) // a stored value above the ceiling is held to it
    expect(Store.getTrackLimits(serverId)).toMatchObject({ count: 20, mb: 20 })
  })

  test('0 accepts a track and stores nothing', async () => {
    Store.setTrackLimits(serverId, 0, null)
    const r = await put()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, stored: false })
    expect(count()).toBe(0)
    Store.setTrackLimits(serverId, null, 0)
    expect((await put()).body.stored).toBe(false)
    expect(count()).toBe(0)
  })

  test('lowering a limit removes the surplus at once; start-up applies every server\'s', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await put()).id)
    expect(count()).toBe(4)
    Store.setTrackLimits(serverId, 1, null)
    expect(ids.map(has)).toEqual([false, false, false, true])
    db.run('UPDATE servers SET track_keep_count = 0 WHERE id = ?', [serverId])
    Store.enforceAllTrackLimits()
    expect(count()).toBe(0)
  })

  test('a track larger than the whole size limit is a 413 that says so', async () => {
    Store.setTrackConfig({ ...Store.getTrackConfig(), keepMb: 1 })
    const id = await round(token, 'ttt_example', EXTRA)
    // about 1.4 MB of positions: whole-number steps, so each sample is small but there are many
    const n = 50_000
    const t = Array(Math.min(n, 20_000)).fill(100)
    const m = t.length
    const body = track(id, { t, players: [A, B, ...EXTRA].map(pid => ({ id: pid, segments: [{ from: 0, x: Array(m).fill(1234), y: Array(m).fill(1234), z: Array(m).fill(0), a: Array(m).fill(0) }] })) })
    for (const p of body.players) for (const k of ['x', 'y', 'z', 'a'] as const) (p.segments[0] as any)[k][0] = 0
    // keep every position in range: alternate direction
    for (const p of body.players) { const s = p.segments[0] as any; for (let i = 1; i < m; i++) { s.x[i] = i % 2 ? 1234 : -1234; s.y[i] = i % 2 ? 1234 : -1234 } }
    const r = await post('/v1/track', body)
    expect(r.status).toBe(413)
    expect((await r.json() as any).error).toMatch(/1 MB/)
    expect(count()).toBe(0)
  })
})

describe('pinning', () => {
  const put = async () => { const id = await round(); await post('/v1/track', track(id)); return id }

  test('a pinned track survives the limits while unpinned ones go', async () => {
    Store.setTrackConfig({ ...Store.getTrackConfig(), keepCount: 2 })
    const first = await put()
    expect(Store.pinTrack(serverId, first, true, A)).toBe('ok')
    const rest: string[] = []
    for (let i = 0; i < 4; i++) rest.push(await put())
    expect(Store.hasTrack(serverId, first)).toBe(true)
    expect(rest.map(r => Store.hasTrack(serverId, r))).toEqual([false, false, true, true])
    expect(Store.getTrackUsage(serverId)).toMatchObject({ count: 3, pinned: 1 })
    expect(Store.getTrack(serverId, first).meta.pinned).toBe(true)
  })

  test('unpinning puts a track under the limits again', async () => {
    Store.setTrackConfig({ ...Store.getTrackConfig(), keepCount: 1 })
    const a = await put()
    Store.pinTrack(serverId, a, true, A)
    const b = await put()
    expect(Store.pinTrack(serverId, a, false, A)).toBe('ok')
    expect([a, b].map(r => Store.hasTrack(serverId, r))).toEqual([false, true])
  })

  test('the number of pins is capped, and an unknown round cannot be pinned', async () => {
    Store.setTrackConfig({ ...Store.getTrackConfig(), maxPinned: 2 })
    const ids = [await put(), await put(), await put()]
    expect(Store.pinTrack(serverId, ids[0]!, true, A)).toBe('ok')
    expect(Store.pinTrack(serverId, ids[1]!, true, A)).toBe('ok')
    expect(Store.pinTrack(serverId, ids[2]!, true, A)).toBe('max')
    expect(Store.pinTrack(serverId, ids[0]!, true, A)).toBe('ok') // already pinned: no change
    expect(Store.pinTrack(serverId, 'nope', true, A)).toBe('none')
    expect(Store.getTrackUsage(serverId).pinned).toBe(2)
  })

  test('marks which rounds have a track', async () => {
    const a = await put(), b = await round()
    Store.pinTrack(serverId, a, true, A)
    const m = Store.getTrackedRounds(serverId, [a, b])
    expect([...m.keys()]).toEqual([a])
    expect(m.get(a)).toEqual({ pinned: true })
    expect(Store.getTrackedRounds(serverId, []).size).toBe(0)
  })
})
