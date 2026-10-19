import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 10, section 4.5: the bridge uploads a finished floor-plan scan (POST /api/v1/mapplan); the
// backend keeps the latest plan per server and map, visible to admins only.

let api: any, app: any, db: any, Store: any, token: string, serverId: string, cookie: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

beforeEach(async () => {
  const added = Store.addServer('Plans') as any
  serverId = added.id
  token = added.token
  ;(await import('../src/routes/api')).mapPlanLimiter.reset()
})

const FP = 'ab'.repeat(32)

// A 3 x 2 grid with 5 floors (one crouch-only): two in the first cell, nothing in the others.
const plan = (over: Record<string, unknown> = {}) => ({
  map: 'ttt_a', fingerprint: FP,
  cell: 64, minx: -801, miny: -1569, nx: 3, ny: 2, zmin: -2465, zmax: 9889,
  seeds: 107, traces: 14637, seconds: 0.08,
  rows: ['-160,48c|48|', '|272|-160'],
  ...over,
})

const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
  api.request('/v1/mapplan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('POST /api/v1/mapplan: accepting a plan', () => {
  test('stores the plan and answers with its size', async () => {
    const res = await post(plan())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, floorCells: 5 })

    const [meta] = Store.getMapPlans(serverId)
    expect(meta).toMatchObject({ map: 'ttt_a', fingerprint: FP, cell: 64, nx: 3, ny: 2, floorCells: 5, crouchFloors: 1, seeds: 107 })
    expect(typeof meta.scannedAt).toBe('string')

    const stored = JSON.parse(Store.getMapPlan(serverId, 'ttt_a'))
    expect(stored).toEqual({ cell: 64, minx: -801, miny: -1569, nx: 3, ny: 2, zmin: -2465, zmax: 9889, rows: ['-160,48c|48|', '|272|-160'] })
  })

  test('a new plan for the same map replaces the old one; another map is kept next to it', async () => {
    await post(plan())
    await post(plan({ map: 'ttt_b', rows: ['|48|', '||'] }))
    await post(plan({ rows: ['-160|48|', '||'] }))
    const metas = Store.getMapPlans(serverId)
    expect(metas.map((m: any) => m.map)).toEqual(['ttt_a', 'ttt_b'])
    expect(metas[0].floorCells).toBe(2)
    expect(metas[1].floorCells).toBe(1)
  })

  test('the fingerprint is optional', async () => {
    await post(plan({ fingerprint: undefined }))
    expect(Store.getMapPlans(serverId)[0].fingerprint).toBeNull()
  })

  test('counts as a heartbeat', async () => {
    db.run('UPDATE servers SET last_seen = NULL WHERE id = ?', [serverId])
    await post(plan())
    expect(Store.getServerById(serverId).last_seen).not.toBeNull()
  })

  test('a server only has its own plans', async () => {
    const other = Store.addServer('Other') as any
    await post(plan())
    expect(Store.getMapPlans(other.id)).toEqual([])
    expect(Store.getMapPlan(other.id, 'ttt_a')).toBeNull()
  })

  test('deleting the server deletes its plans', async () => {
    await post(plan())
    Store.deleteServer(serverId)
    expect(db.query('SELECT COUNT(*) AS n FROM map_plans WHERE server_id = ?').get(serverId).n).toBe(0)
  })

  test('the counts come from the rows, not from what the client says', async () => {
    await post(plan({ floorCells: 99999, crouchFloors: 99999 }))
    expect(Store.getMapPlans(serverId)[0]).toMatchObject({ floorCells: 5, crouchFloors: 1 })
  })

  test('a scan the size of a real map (233 x 207 cells) is accepted', async () => {
    const row = Array.from({ length: 233 }, (_, i) => (i % 3 === 0 ? '-160,48c' : '')).join('|')
    const res = await post(plan({ nx: 233, ny: 207, rows: Array.from({ length: 207 }, () => row) }))
    expect(res.status).toBe(200)
    expect(Store.getMapPlans(serverId)[0]).toMatchObject({ floorCells: 207 * 78 * 2, crouchFloors: 207 * 78 })
  })
})

describe('POST /api/v1/mapplan: refusing a plan', () => {
  test('needs the server\'s token', async () => {
    expect((await post(plan(), null)).status).toBe(401)
    expect((await post(plan(), 'Bearer wrong')).status).toBe(401)
    expect(Store.getMapPlans(serverId)).toEqual([])
  })

  const bad = (body: unknown) => async () => {
    await post(plan())
    expect((await post(body)).status).toBe(400)
    expect(Store.getMapPlans(serverId)).toHaveLength(1) // the stored plan is kept...
    expect(JSON.parse(Store.getMapPlan(serverId, 'ttt_a')).rows).toEqual(['-160,48c|48|', '|272|-160']) // ...unchanged
  }

  test('not JSON', bad('nope'))
  test('a map name that is not a name', bad(plan({ map: '../x' })))
  test('no map name', bad(plan({ map: undefined })))
  test('a cell size below 16', bad(plan({ cell: 8 })))
  test('a cell size above 512', bad(plan({ cell: 1024 })))
  test('a grid that is not whole numbers', bad(plan({ nx: 2.5 })))
  test('a grid larger than the scan allows (more than 250 000 cells)', bad(plan({ nx: 501, ny: 501, rows: Array(501).fill('|'.repeat(500)) })))
  test('a grid with zero cells', bad(plan({ nx: 0, ny: 0, rows: [] })))
  test('the wrong number of rows', bad(plan({ rows: ['-160|48|'] })))
  test('a row with the wrong number of cells', bad(plan({ rows: ['-160,48c|48', '|272|-160'] })))
  test('rows that are not strings', bad(plan({ rows: [1, 2] })))
  test('a floor that is not a whole height', bad(plan({ rows: ['-160.5,48c|48|', '|272|-160'] })))
  test('a floor with an unknown suffix', bad(plan({ rows: ['-160x|48|', '|272|-160'] })))
  test('text instead of a height', bad(plan({ rows: ['<script>|48|', '|272|-160'] })))
  test('a height outside any real map', bad(plan({ rows: ['99999|48|', '|272|-160'] })))
  test('a negative statistic', bad(plan({ seeds: -1 })))
  test('a statistic that is not a number', bad(plan({ seeds: 'many' })))
  test('a fingerprint that is not 64 lowercase hex characters', bad(plan({ fingerprint: 'XYZ' })))
  test('the origin or the heights not being numbers', bad(plan({ minx: 'left' })))

  test('a body larger than 2 MB is refused outright', async () => {
    const res = await post(JSON.stringify({ ...plan(), pad: 'x'.repeat(2_100_000) }))
    expect(res.status).toBe(413)
    expect(Store.getMapPlans(serverId)).toEqual([])
  })

  test('is rate limited per server, with Retry-After', async () => {
    const statuses: number[] = []
    let retryAfter = 0
    for (let i = 0; i < 5; i++) { const res = await post(plan()); statuses.push(res.status); retryAfter = Number(res.headers.get('Retry-After')) }
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    expect(retryAfter).toBeGreaterThan(0)
  })
})

describe('migration v10', () => {
  test('creates map_plans', () => {
    const cols = (db.query('PRAGMA table_info(map_plans)').all() as any[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['server_id', 'map_name', 'fingerprint', 'cell', 'nx', 'ny', 'floor_cells', 'crouch_floors', 'seeds', 'scanned_at', 'plan']))
  })
})

describe('the plan on the Maps page (admins only)', () => {
  const get = (path: string, withCookie = false) =>
    app.fetch(new Request(`http://x${path}`, { headers: withCookie ? { Cookie: cookie } : {} }))

  beforeEach(async () => {
    Store.setMaps(serverId, {
      current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: '^ttt_', poolBasis: 'prefixes', configSource: 'merged', voteAddon: true,
      maps: [{ name: 'ttt_a', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: true, inVotePool: true, votable: false },
             { name: 'ttt_b', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true }],
    })
    await post(plan())
  })

  test('an admin sees which maps have a plan, with its statistics and a download link', async () => {
    const html = await (await get(`/servers/${serverId}/maps`, true)).text()
    expect(html).toContain('Floor plans')
    expect(html).toContain('5 floor cells')
    expect(html).toContain('1 crouch-only')
    expect(html).toContain(`/servers/${serverId}/maps/ttt_a/plan.json`)
  })

  test('a guest sees nothing of it', async () => {
    const html = await (await get(`/servers/${serverId}/maps`)).text()
    expect(html).not.toContain('Floor plans')
    expect(html).not.toContain('plan.json')
  })

  test('a plan made for another version of the map is marked outdated', async () => {
    await post(plan({ fingerprint: 'cd'.repeat(32) }))
    expect(await (await get(`/servers/${serverId}/maps`, true)).text()).toContain('Outdated')
    await post(plan()) // matching again
    expect(await (await get(`/servers/${serverId}/maps`, true)).text()).not.toContain('Outdated')
  })

  test('the download is the plan as JSON, for admins', async () => {
    const res = await get(`/servers/${serverId}/maps/ttt_a/plan.json`, true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).rows).toEqual(['-160,48c|48|', '|272|-160'])
  })

  test('the download is refused for guests, and a missing plan or server is a 404', async () => {
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.json`)).status).toBe(401)
    expect((await get(`/servers/${serverId}/maps/ttt_b/plan.json`, true)).status).toBe(404)
    expect((await get('/servers/nope/maps/ttt_a/plan.json', true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/..%2Fx/plan.json`, true)).status).toBe(404)
  })
})
