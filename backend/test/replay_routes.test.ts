import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { gunzipSync } from 'node:zlib'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 12, 3.5 and RFC 13: the replay's page and its data are for signed-in users; the data says
// which background to draw and carries the track; views are logged; a track is cached privately.

let app: any, Store: any, db: any, gates: any, glb: any, surfacesToGlb: any
const ADMIN = '76561198000000000', USER = '76561198000000042', USER2 = '76561198000000043'
const P1 = '76561198000000001', P2 = '76561198000000002', BOT = '999000000007'
let serverId: string, n = 0, MESH: Uint8Array

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  gates = await import('../src/services/gates')
  glb = await import('../src/services/replay')
  surfacesToGlb = (await import('../src/maps/meshGlb')).surfacesToGlb
  const floor = (z: number) => [0, 0, z, 256, 0, z, 256, 256, z, 0, 0, z, 256, 256, z, 0, 256, z]
  MESH = (await surfacesToGlb({ floors: [...floor(0), ...floor(300)], walls: [], fingerprint: FP, version: 20, revision: 1 }, { map: 'ttt_a' })).glb
})
afterAll(() => { for (const k of ['OPEN_SIGNIN', 'MAP_GEOMETRY', 'VIEW_LOG_DAYS']) delete process.env[k] })

const FP = 'ab'.repeat(32)
const cookieFor = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const req = async (path: string, as: string | null = null, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(as ? { Cookie: await cookieFor(as) } : {}), ...(init.headers as any) } }))

beforeEach(() => {
  process.env.OPEN_SIGNIN = '1'
  process.env.MAP_GEOMETRY = '1'
  gates.resetGates()
  db.run('DELETE FROM map_geometry'); db.run('DELETE FROM map_geometry_requests')
  db.run("DELETE FROM audit_log WHERE action IN ('VIEW_REPLAY', 'VIEW_MESH')")
  serverId = (Store.addServer('Replay') as any).id
  Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 2 })
})

const reportMaps = (fp: string | null = FP) => Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
  maps: [{ name: 'ttt_a', size: 1, fingerprint: fp, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
const withMesh = () => {
  reportMaps()
  Store.setGeometryRequested(serverId, 'ttt_a', true, null)
  Store.startGeometry('ttt_a', FP)
  Store.finishGeometry('ttt_a', FP, { mesh: MESH, info: { vertices: 8, triangles: 4, levels: 2 } })
}
const withPlan = (fingerprint: string | null = FP) => {
  reportMaps()
  const rows = [Array(8).fill('0').join('|'), Array(8).fill('300').join('|')]
  db.run('INSERT OR REPLACE INTO map_plans (server_id, map_name, fingerprint, plan, cell, nx, ny, floor_cells, crouch_floors, seeds, scanned_at) VALUES (?, ?, ?, ?, 64, 8, 2, 16, 0, 1, ?)',
    [serverId, 'ttt_a', fingerprint, JSON.stringify({ cell: 64, minx: 0, miny: 0, nx: 8, ny: 2, zmin: 0, zmax: 300, rows }), new Date().toISOString()])
}

/** A round with players, and a track for it unless `track` is false. */
function round(opts: { track?: boolean, players?: string[], fingerprint?: string | null, map?: string } = {}) {
  const id = `round-${String(++n).padStart(6, '0')}`
  const players = opts.players ?? [P1, P2]
  Store.recordRound(serverId, { roundId: id, map: opts.map ?? 'ttt_a', startedAt: null, duration: 120, result: 'traitors',
    players: players.map((p, i) => ({ steamId: p, nick: `Nick${i}`, role: i ? 'innocent' : 'traitor', team: i ? 'innocents' : 'traitors', survived: !i, won: !i })), deaths: [] })
  if (opts.track !== false) {
    const track = { roundId: id, map: opts.map ?? 'ttt_a', fingerprint: opts.fingerprint === undefined ? FP : opts.fingerprint, truncated: false, degraded: false, t: [0, 200, 200],
      players: players.map(p => ({ id: p, segments: [{ from: 0, x: [10, 1, 1], y: [10, 0, 0], z: [0, 0, 0], a: [0, 8, 8] }] })),
      deaths: [{ victim: players[1], attacker: players[0], t: 400, vx: 12, vy: 10, vz: 0, ax: 10, ay: 10, az: 0, weapon: 'weapon_ttt_m16' }] }
    Store.recordTrack(serverId, track, JSON.stringify(track))
  }
  return id
}
const data = (id: string, as: string | null = USER, q = '', init: RequestInit = {}) => req(`/servers/${serverId}/rounds/${id}/track.json${q}`, as, init)

describe('track.json', () => {
  test('an anonymous visitor gets 401 with a body that says sign-in is needed; a user and an admin get the round', async () => {
    const id = round()
    const anon = await data(id, null)
    expect(anon.status).toBe(401)
    expect(await anon.json()).toEqual({ error: 'Sign-in required', signin: '/auth/steam' })
    for (const as of [USER, ADMIN]) {
      const r = await data(id, as)
      expect(r.status).toBe(200)
      const body = await r.json() as any
      expect(body.round).toMatchObject({ id, map: 'ttt_a', result: 'traitors', duration: 120 })
      expect(body.players.map((p: any) => p.id)).toEqual([P1, P2])
      expect(body.players[0]).toMatchObject({ nick: 'Nick0', role: 'traitor', team: 'traitors' })
      expect(body.track.t).toEqual([0, 200, 200])
      expect(body.track.deaths[0]).toMatchObject({ victim: P2, attacker: P1, weapon: 'weapon_ttt_m16' })
      expect(body.trackInfo).toEqual({ truncated: false, degraded: false, fingerprint: FP, pinned: false })
    }
  })

  test("carries each role's own colour (team colour for a role without one), and a new colour changes the validator", async () => {
    const id = round()
    Store.saveSchema(serverId, 'traitor', 'traitors', false, -1, [], 'h', null, '#d12b27')
    Store.saveSchema(serverId, 'innocent', 'innocents', false, -1, [], 'h', null)
    const first = await data(id)
    const body = await first.json() as any
    expect(body.colours).toEqual({ traitor: '#d12b27', innocent: '#22c55e' })
    Store.saveSchema(serverId, 'traitor', 'traitors', false, -1, [], 'h2', null, '#112233')
    const second = await data(id)
    expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'))
    expect((await second.json() as any).colours.traitor).toBe('#112233')
  })

  test('carries where each player ended and the revivals of the round (RFC 14); a victim outside the round is left out', async () => {
    const id = round()
    db.run('UPDATE round_players SET end_role = ?, end_team = ? WHERE server_id = ? AND round_id = ? AND steam_id = ?', ['zombie', 'zombies', serverId, id, P2])
    db.run('INSERT INTO round_revives (server_id, round_id, victim, reviver, how, why, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)', [serverId, id, P2, P1, 'weapon_ttt_defibrillator', 'revived_by_player', 90])
    db.run('INSERT INTO round_revives (server_id, round_id, victim, reviver, how, why, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)', [serverId, id, '76561190000000999', null, null, null, 95])
    const body = await (await data(id)).json() as any
    expect(body.players[1]).toMatchObject({ role: 'innocent', team: 'innocents', endRole: 'zombie', endTeam: 'zombies' })
    expect(body.players[0]).toMatchObject({ endRole: null, endTeam: null })
    expect(body.revives).toEqual([{ victim: P2, reviver: P1, how: 'weapon_ttt_defibrillator', why: 'revived_by_player', at: 90 }])
  })

  test('with sign-in closed a user is anonymous (401); an admin gets it', async () => {
    const id = round()
    delete process.env.OPEN_SIGNIN
    expect((await data(id, USER)).status).toBe(401)
    expect((await data(id, ADMIN)).status).toBe(200)
  })

  test('a round without a track, an unknown round and another server\'s round are 404', async () => {
    expect((await data(round({ track: false }))).status).toBe(404)
    expect((await data('round-nothing-1')).status).toBe(404)
    const other = (Store.addServer('Other') as any).id
    const id = round()
    expect((await req(`/servers/${other}/rounds/${id}/track.json`, USER)).status).toBe(404)
  })

  test('a bot-only test round is hidden unless ?bots=1', async () => {
    const id = round({ players: [BOT, '999000000008'] })
    expect((await data(id)).status).toBe(404)
    const r = await data(id, USER, '?bots=1')
    expect(r.status).toBe(200)
    expect((await r.json() as any).players).toHaveLength(2)
  })

  test('is cached privately with an ETag; If-None-Match answers 304 with no body', async () => {
    const id = round()
    const r = await data(id)
    const etag = r.headers.get('etag')!
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/)
    expect(r.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(r.headers.get('vary')).toMatch(/Accept-Encoding/)
    const again = await data(id, USER, '', { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    expect((await data(id, USER, '', { headers: { 'If-None-Match': 'W/"other"' } })).status).toBe(200)
  })

  test('the ETag changes when the pin or the background does, and is the same for every viewer', async () => {
    const id = round()
    const a = (await data(id, USER)).headers.get('etag')
    expect((await data(id, USER2)).headers.get('etag')).toBe(a)
    Store.pinTrack(serverId, id, true, ADMIN)
    const pinned = (await data(id, USER)).headers.get('etag')
    expect(pinned).not.toBe(a)
    withMesh()
    expect((await data(id, USER)).headers.get('etag')).not.toBe(pinned)
  })

  test('is sent compressed when the browser accepts it, and the same JSON comes out', async () => {
    const id = round()
    const plain = await (await data(id)).text()
    const gz = await data(id, USER, '', { headers: { 'Accept-Encoding': 'gzip, br' } })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(plain)
  })

  test('is limited per account: 30 a minute, then 429 with Retry-After', async () => {
    const id = round()
    for (let i = 0; i < 30; i++) expect((await data(id, USER)).status).toBe(200)
    const over = await data(id, USER)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await data(id, USER2)).status).toBe(200)
  })

  describe('the background', () => {
    test('the mesh when the map has one, with its levels from the GLB, and no plan', async () => {
      withMesh(); withPlan()
      const b = (await (await data(round())).json() as any).background
      expect(b.kind).toBe('mesh')
      expect(b.meshUrl).toBe(`/servers/${serverId}/maps/ttt_a/mesh.glb`)
      expect(b.levels).toEqual([{ index: 1, lo: 0, hi: 0 }, { index: 2, lo: 300, hi: 300 }])
      expect(b.plan).toBeUndefined()
      expect(b.mismatch).toBe(false)
    })
    test('the floor plan when there is no mesh, with its grid and levels', async () => {
      withPlan()
      const b = (await (await data(round())).json() as any).background
      expect(b.kind).toBe('plan')
      expect(b.plan).toMatchObject({ cell: 64, nx: 8, ny: 2 })
      expect(b.plan.rows).toHaveLength(2)
      expect(b.levels.map((l: any) => l.index)).toEqual([1, 2])
      expect(b.meshUrl).toBeUndefined()
    })
    test('nothing when there is neither', async () => {
      reportMaps()
      const b = (await (await data(round())).json() as any).background
      expect(b).toMatchObject({ kind: 'none', levels: [], mismatch: false })
    })
    test('a mesh or plan for another version of the map is flagged; an unknown version is not', async () => {
      withMesh()
      expect((await (await data(round({ fingerprint: 'cd'.repeat(32) }))).json() as any).background.mismatch).toBe(true)
      expect((await (await data(round({ fingerprint: null }))).json() as any).background.mismatch).toBe(false)
      db.run('DELETE FROM map_geometry')
      withPlan('ef'.repeat(32))
      expect((await (await data(round())).json() as any).background.mismatch).toBe(true)
    })
  })

  describe('the view log', () => {
    const views = (id = USER) => db.query("SELECT details FROM audit_log WHERE steam_id = ? AND action = 'VIEW_REPLAY'").all(id) as any[]
    test('one VIEW_REPLAY row with the SteamID64 and the round; again within the hour writes none; another round or user writes one', async () => {
      const a = round(), b = round()
      await data(a); await data(a); await data(a, USER, '', { headers: { 'If-None-Match': 'x' } })
      expect(views()).toEqual([{ details: a }])
      await data(b); await data(a, USER2)
      expect(views().map(v => v.details).sort()).toEqual([a, b].sort())
      expect(views(USER2)).toHaveLength(1)
    })
    test('anonymous requests, a 404 and VIEW_LOG_DAYS=0 write none', async () => {
      const id = round()
      await data(id, null); await data('round-nothing-1')
      process.env.VIEW_LOG_DAYS = '0'
      await data(id)
      expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'VIEW_REPLAY'").get().n).toBe(0)
    })
  })
})

describe('the replay page', () => {
  const page = async (id: string, as: string | null = USER, q = '') => { const r = await req(`/servers/${serverId}/rounds/${id}/replay${q}`, as); return { status: r.status, loc: r.headers.get('location'), text: await r.text() } }

  test('an anonymous visitor is sent to sign-in and brought back; with sign-in closed, to the stats', async () => {
    const id = round()
    const r = await page(id, null)
    expect(r.status).toBe(302)
    expect(r.loc).toBe(`/auth/steam?next=${encodeURIComponent(`/servers/${serverId}/rounds/${id}/replay`)}`)
    expect((await page(id, null, '?bots=1')).loc).toContain(encodeURIComponent('?bots=1'))
    delete process.env.OPEN_SIGNIN
    expect((await page(id, null)).loc).toBe(`/servers/${serverId}/stats`)
  })

  test('a signed-in user gets the viewer, its data address and their own ID (to open on their player)', async () => {
    const id = round()
    const r = await page(id)
    expect(r.status).toBe(200)
    expect(r.text).toContain('data-replay')
    expect(r.text).toContain(`data-src="/servers/${serverId}/rounds/${id}/track.json"`)
    expect(r.text).toContain(`data-viewer="${USER}"`)
    expect(r.text).toContain('/public/replay.js')
    expect(r.text).toContain('data-scrub')
    expect(r.text).toContain('data-cam="top"')
    expect(r.text).toContain('not what they could see') // the fixed line: it is not a line-of-sight source
    expect(r.text).not.toContain('data-pin')
    expect(r.text).toContain('Traitors')
    expect(r.text).toContain('2:00')
  })

  test('a round without a track says so; an unknown round and a bot-only round go back to the stats', async () => {
    const r = await page(round({ track: false }))
    expect(r.status).toBe(200)
    expect(r.text).toContain('data-no-track')
    expect(r.text).not.toContain('data-replay ')
    expect((await page('round-nothing-1')).loc).toBe(`/servers/${serverId}/stats`)
    const bot = round({ players: [BOT, '999000000008'] })
    expect((await page(bot)).loc).toBe(`/servers/${serverId}/stats`)
    expect((await page(bot, USER, '?bots=1')).status).toBe(200)
  })

  test('the bots choice is carried to the data address', async () => {
    const bot = round({ players: [BOT, '999000000008'] })
    expect((await page(bot, USER, '?bots=1')).text).toContain(`/track.json?bots=1`)
  })

  test('an admin gets the pin button, and pinning brings them back to the replay; a user does not', async () => {
    const id = round()
    const admin = await page(id, ADMIN)
    expect(admin.text).toContain('data-pin')
    expect(admin.text).toContain('Pin this round')
    const pin = await req(`/servers/${serverId}/rounds/${id}/pin`, ADMIN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pin=1&next=${encodeURIComponent(`/servers/${serverId}/rounds/${id}/replay`)}` })
    expect(pin.status).toBe(302)
    expect(pin.headers.get('location')).toBe(`/servers/${serverId}/rounds/${id}/replay`)
    const after = await page(id, ADMIN)
    expect(after.text).toContain('Unpin this round')
    expect(after.text).toContain('data-pinned')
    expect((await page(id, USER)).text).toContain('data-pinned') // everyone sees that it is pinned
    expect((await page(id, USER)).text).not.toContain('data-pin ')
  })

  test('pinning never sends the admin anywhere but a path on this site', async () => {
    const id = round()
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example', '/%2F/evil.example']) {
      const r = await req(`/servers/${serverId}/rounds/${id}/pin`, ADMIN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pin=0&next=${encodeURIComponent(next)}` })
      expect(r.headers.get('location'), next).toBe(`/servers/${serverId}/stats?view=rounds`)
    }
  })
})

describe('the round list', () => {
  const stats = async (as: string | null) => (await req(`/servers/${serverId}/stats?view=rounds`, as)).text()

  test('a round with a track has a replay link: to a signed-in visitor the page, to an anonymous one a sign-in link when sign-in is open', async () => {
    const id = round(); round({ track: false })
    const user = await stats(USER)
    expect(user).toContain('data-replay-link')
    expect(user).toContain(`href="/servers/${serverId}/rounds/${id}/replay"`)
    expect((user.match(/data-replay-link/g) ?? []).length).toBe(1) // only the round with a track
    const anon = await stats(null)
    expect(anon).toContain('data-replay-signin')
    expect(anon).toContain(encodeURIComponent(`/servers/${serverId}/rounds/${id}/replay`))
    expect(anon).not.toContain('data-replay-link')
    delete process.env.OPEN_SIGNIN
    const closed = await stats(null)
    expect(closed).toContain('data-replay-locked')
    expect(closed).not.toContain('data-replay-signin')
  })

  test('a pinned round is marked for everyone', async () => {
    const id = round()
    Store.pinTrack(serverId, id, true, ADMIN)
    expect(await stats(null)).toContain('📌')
  })

  test('without any track there is no Replay column', async () => {
    round({ track: false })
    expect(await stats(USER)).not.toContain('p-3">Replay</th>')
  })
})

describe('glbLevels', () => {
  test('reads the levels the writer named, and nothing from anything else', () => {
    expect(glb.glbLevels(MESH)).toEqual([{ index: 1, lo: 0, hi: 0 }, { index: 2, lo: 300, hi: 300 }])
    expect(glb.glbLevels(new Uint8Array(0))).toEqual([])
    expect(glb.glbLevels(new Uint8Array(64))).toEqual([])
    const bad = MESH.slice(); bad[12] = 0xff; bad[13] = 0xff; bad[14] = 0xff // a length that runs past the file
    expect(glb.glbLevels(bad)).toEqual([])
  })
})
