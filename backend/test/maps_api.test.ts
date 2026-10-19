import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 10, backend side: the bridge reports which maps the server has and which it will play
// (POST /api/v1/maps); the backend stores the latest report per server, replacing the previous one.

let api: any, db: any, token: string, serverId: string, Store: any

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
})

beforeEach(async () => {
  const added = Store.addServer('Maps') as any
  serverId = added.id
  token = added.token
  ;(await import('../src/routes/api')).mapsLimiter.reset()
})

const FP = 'ab'.repeat(32)

const map = (name: string, over: Record<string, unknown> = {}) => ({
  name, size: 22095766, fingerprint: FP,
  matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true,
  ...over,
})

const report = (over: Record<string, unknown> = {}) => ({
  current: 'ttt_a', next: 'ttt_b', gamemode: 'terrortown', pattern: '^ttt_',
  maps: [map('ttt_a', { isCurrent: true, votable: false }), map('ttt_b'), map('gm_construct', { matchesGamemode: false, inVotePool: false, votable: false })],
  mapvote: { present: true, configSource: 'merged', poolBasis: 'prefixes' },
  ...over,
})

const post = (body: unknown, auth: string | null = `Bearer ${token}`, id = serverId) =>
  api.request('/v1/maps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const stored = (id = serverId) => Store.getMaps(id)

describe('POST /api/v1/maps: the addons the maps come from', () => {
  test('keeps the Workshop IDs of the mounted map addons, once each, and drops what is not digits', async () => {
    await post(report({ mapAddons: ['3415635566', '3415635566', '12', 'x; rm -rf /', 5, '1234567890123', null] }))
    const row = db.prepare('SELECT map_addons FROM server_map_state WHERE server_id = ?').get(serverId)
    expect(JSON.parse(row.map_addons)).toEqual(['3415635566', '12'])
  })

  test('a report without them, or with something else, stores an empty list; and at most 300', async () => {
    await post(report({ mapAddons: 'nope' }))
    expect(JSON.parse(db.prepare('SELECT map_addons FROM server_map_state WHERE server_id = ?').get(serverId).map_addons)).toEqual([])
    await post(report({ mapAddons: Array.from({ length: 400 }, (_, i) => String(i + 1)) }))
    expect(JSON.parse(db.prepare('SELECT map_addons FROM server_map_state WHERE server_id = ?').get(serverId).map_addons)).toHaveLength(300)
  })
})

describe('POST /api/v1/maps: accepting a report', () => {
  test('stores the maps and the state, and answers how many', async () => {
    const res = await post(report())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, stored: 3 })

    const s = stored()
    expect(s.state).toMatchObject({ current: 'ttt_a', next: 'ttt_b', gamemode: 'terrortown', pattern: '^ttt_', poolBasis: 'prefixes', configSource: 'merged', voteAddon: true })
    expect(s.maps.map((m: any) => m.name)).toEqual(['gm_construct', 'ttt_a', 'ttt_b'])
    expect(s.maps.find((m: any) => m.name === 'ttt_b')).toMatchObject({ size: 22095766, fingerprint: FP, matchesGamemode: true, inVotePool: true, votable: true, isCurrent: false })
  })

  test('a new report replaces the previous one as a whole', async () => {
    await post(report())
    await post(report({ current: 'ttt_c', maps: [map('ttt_c', { isCurrent: true })] }))
    expect(stored().maps.map((m: any) => m.name)).toEqual(['ttt_c'])
    expect(stored().state.current).toBe('ttt_c')
  })

  test('unknown flags stay unknown (null), not false', async () => {
    await post(report({
      pattern: null,
      maps: [map('ttt_x', { matchesGamemode: null, inVotePool: null, votable: null, fingerprint: null })],
      mapvote: { present: false, configSource: 'none', poolBasis: null },
    }))
    const m = stored().maps[0]
    expect(m.matchesGamemode).toBeNull()
    expect(m.inVotePool).toBeNull()
    expect(m.votable).toBeNull()
    expect(m.fingerprint).toBeNull()
    expect(stored().state).toMatchObject({ pattern: null, poolBasis: null, voteAddon: false })
  })

  test('counts as a heartbeat', async () => {
    db.run('UPDATE servers SET last_seen = NULL WHERE id = ?', [serverId])
    await post(report())
    expect(Store.getServerById(serverId).last_seen).not.toBeNull()
  })

  test('two servers do not see each other\'s maps', async () => {
    const other = Store.addServer('Other') as any
    await post(report())
    await post(report({ maps: [map('ttt_other_only')] }), `Bearer ${other.token}`)
    expect(stored().maps.map((m: any) => m.name)).not.toContain('ttt_other_only')
    expect(stored(other.id).maps.map((m: any) => m.name)).toEqual(['ttt_other_only'])
  })

  test('deleting the server deletes its maps', async () => {
    await post(report())
    Store.deleteServer(serverId)
    expect(db.query('SELECT COUNT(*) AS n FROM server_maps WHERE server_id = ?').get(serverId).n).toBe(0)
    expect(db.query('SELECT COUNT(*) AS n FROM server_map_state WHERE server_id = ?').get(serverId).n).toBe(0)
  })
})

describe('POST /api/v1/maps: refusing a report', () => {
  test('needs the server\'s token', async () => {
    expect((await post(report(), null)).status).toBe(401)
    expect((await post(report(), 'Bearer wrong')).status).toBe(401)
    expect(stored().maps).toEqual([])
  })

  test.each([
    ['not JSON', 'nope'],
    ['no maps array', { current: 'ttt_a' }],
    ['maps is not an array', report({ maps: 'ttt_a' })],
    ['too many maps', report({ maps: Array.from({ length: 501 }, (_, i) => map(`ttt_m${i}`)) })],
    ['a map name that is not a name', report({ maps: [map('../etc/passwd')] })],
    ['an empty map name', report({ maps: [map('')] })],
    ['a map name that is too long', report({ maps: [map('a'.repeat(65))] })],
    ['a size that is not a number', report({ maps: [map('ttt_a', { size: 'big' })] })],
    ['a negative size', report({ maps: [map('ttt_a', { size: -1 })] })],
    ['a fingerprint that is not 64 hex characters', report({ maps: [map('ttt_a', { fingerprint: 'xyz' })] })],
    ['an uppercase fingerprint', report({ maps: [map('ttt_a', { fingerprint: FP.toUpperCase() })] })],
  ])('%s: 400, and the previous report is kept', async (_, body) => {
    await post(report())
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(stored().maps.map((m: any) => m.name)).toEqual(['gm_construct', 'ttt_a', 'ttt_b'])
  })

  test('the same map twice in one report keeps the first', async () => {
    const res = await post(report({ maps: [map('ttt_a', { size: 1 }), map('ttt_a', { size: 2 })] }))
    expect(await res.json()).toEqual({ success: true, stored: 1 })
    expect(stored().maps).toHaveLength(1)
    expect(stored().maps[0].size).toBe(1)
  })

  test('odd flag values are stored as unknown, not trusted', async () => {
    await post(report({ maps: [map('ttt_a', { votable: 'yes', inVotePool: 1, matchesGamemode: {} })] }))
    const m = stored().maps[0]
    expect([m.votable, m.inVotePool, m.matchesGamemode]).toEqual([null, null, null])
  })

  test('text fields are trimmed to a sane length and strange values dropped', async () => {
    await post(report({ current: 'x'.repeat(500), next: 5, pattern: 'y'.repeat(500), gamemode: 'terrortown', mapvote: { present: true, configSource: 'weird', poolBasis: 'something else' } }))
    const s = stored().state
    expect(s.current.length).toBeLessThanOrEqual(64)
    expect(s.next).toBeNull()
    expect(s.pattern.length).toBeLessThanOrEqual(128)
    expect(s.configSource).toBeNull()
    expect(s.poolBasis).toBeNull()
  })

  test('is rate limited per server, with Retry-After', async () => {
    const statuses: number[] = []
    let retryAfter = 0
    for (let i = 0; i < 8; i++) { const res = await post(report()); statuses.push(res.status); retryAfter = Number(res.headers.get('Retry-After')) }
    expect(statuses.slice(0, 6).every(s => s === 200)).toBe(true)
    expect(statuses.slice(6)).toEqual([429, 429])
    expect(retryAfter).toBeGreaterThan(0)
  })
})

describe('migration v9', () => {
  test('creates the two tables', () => {
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name)
    expect(cols('server_maps')).toEqual(expect.arrayContaining(['server_id', 'name', 'size', 'fingerprint', 'matches_gamemode', 'in_cycle', 'on_cooldown', 'is_current', 'in_vote_pool', 'votable', 'seen_at']))
    expect(cols('server_map_state')).toEqual(expect.arrayContaining(['server_id', 'current_map', 'next_map', 'gamemode', 'pattern', 'pool_basis', 'config_source', 'vote_addon', 'reported_at']))
  })
})
