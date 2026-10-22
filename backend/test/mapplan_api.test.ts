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

describe('floor plans: the Maps page links, the map\'s own page shows (admins only)', () => {
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

  const mapPage = async (name: string, withCookie = true) => (await get(`/servers/${serverId}/maps/${name}`, withCookie)).text()

  test('the Maps page marks the maps that have a plan, and links every map to its page, for admins', async () => {
    const html = await (await get(`/servers/${serverId}/maps`, true)).text()
    const rows = html.split('<div class="f"').slice(1)
    const row = (n: string) => rows.find((r: string) => r.includes(`>${n}</a>`))!
    // every map is a card that opens the map's file; a map with a plan also links straight to its own page
    expect(row('ttt_a')).toContain(`href="/servers/${serverId}/maps/ttt_a/rounds"`)
    expect(row('ttt_b')).toContain(`href="/servers/${serverId}/maps/ttt_b/rounds"`)
    expect(row('ttt_a')).toContain(`href="/servers/${serverId}/maps/ttt_a"`)
    expect(row('ttt_b')).not.toContain(`href="/servers/${serverId}/maps/ttt_b"`)
    expect(row('ttt_a')).toContain('Floor plan')
    expect(row('ttt_b')).not.toContain('Floor plan')
    // and the file of a map leads an admin to its own page
    const file = await (await get(`/servers/${serverId}/maps/ttt_b/rounds`, true)).text()
    expect(file).toContain(`href="/servers/${serverId}/maps/ttt_b"`)
  })

  test('the Maps page itself carries no pictures, no legend and no list of plans', async () => {
    const html = await (await get(`/servers/${serverId}/maps`, true)).text()
    expect(html).not.toContain('<img')
    expect(html).not.toContain('How to read these pictures')
    expect(html).not.toContain('plan.svg')
    expect(html).not.toContain('FLOOR PLANS')
    expect(html).not.toContain('>Floor plans<')
  })

  test('a plan made for another version of the map is marked outdated on the list too', async () => {
    await post(plan({ fingerprint: 'cd'.repeat(32) }))
    expect(await (await get(`/servers/${serverId}/maps`, true)).text()).toContain('Outdated')
  })

  test('a guest gets no links and no marks on the Maps page', async () => {
    const html = await (await get(`/servers/${serverId}/maps`)).text()
    expect(html).not.toContain(`/maps/ttt_a"`)
    expect(html).not.toContain('Floor plan')
    expect(html).not.toContain('plan.json')
  })

  test('an admin sees the map\'s page: its status, and the plan with its statistics and the download links', async () => {
    const html = await mapPage('ttt_a')
    expect(html).toContain('ttt_a')
    expect(html).toContain('Current') // its status, as in the list
    expect(html).toContain('5 floor cells')
    expect(html).toContain('1 crouch-only')
    expect(html).toContain(`/servers/${serverId}/maps/ttt_a/plan.json`)
    expect(html).toContain(`href="/servers/${serverId}/maps/ttt_a/plan.svg"`) // all floors
  })

  test('the map\'s page has a way back to the list, and the plans of other maps are not on it', async () => {
    await post(plan({ map: 'ttt_b', rows: ['|48|', '||'] }))
    const html = await mapPage('ttt_a')
    expect(html).toContain(`href="/servers/${serverId}/maps"`)
    expect(html).not.toContain('ttt_b/plan.svg')
  })

  test('a guest is sent back to the Maps page, and so is an unknown map or server', async () => {
    const guest = await get(`/servers/${serverId}/maps/ttt_a`)
    expect(guest.status).toBe(302)
    expect(guest.headers.get('location')).toBe(`/servers/${serverId}/maps`)
    const unknown = await get(`/servers/${serverId}/maps/ttt_nothing`, true)
    expect(unknown.status).toBe(302)
    expect(unknown.headers.get('location')).toBe(`/servers/${serverId}/maps`)
    const noServer = await get('/servers/nope/maps/ttt_a', true)
    expect(noServer.status).toBe(302)
    expect(noServer.headers.get('location')).toBe('/')
  })

  test('a map that was reported but has no plan yet says how to make one', async () => {
    const html = await mapPage('ttt_b')
    expect(html).toContain('No floor plan yet')
    expect(html).toContain('traitordash_mapscan')
    expect(html).not.toContain('<img')
  })

  test('a map that only has a plan (it left the report) still has its page', async () => {
    await post(plan({ map: 'ttt_gone', rows: ['|48|', '||'] }))
    const res = await get(`/servers/${serverId}/maps/ttt_gone`, true)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('plan.svg?level=1')
  })

  test('a map name that is not a name is no page', async () => {
    expect((await get(`/servers/${serverId}/maps/..%2Fx`, true)).status).toBe(302)
  })

  test('a plan made for another version of the map is marked outdated on its page, and not when they match again', async () => {
    await post(plan({ fingerprint: 'cd'.repeat(32) }))
    expect(await mapPage('ttt_a')).toContain('Outdated')
    await post(plan()) // matching again
    expect(await mapPage('ttt_a')).not.toContain('Outdated')
    expect(await (await get(`/servers/${serverId}/maps`, true)).text()).not.toContain('Outdated')
  })

  test('the download is the plan as JSON, for admins', async () => {
    const res = await get(`/servers/${serverId}/maps/ttt_a/plan.json`, true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).rows).toEqual(['-160,48c|48|', '|272|-160'])
  })

  test('the map\'s page shows its plan as a picture', async () => {
    const admin = await mapPage('ttt_a')
    expect(admin).toContain(`<img`)
    expect(admin).toContain(`src="/servers/${serverId}/maps/ttt_a/plan.svg?level=1"`)
  })

  test('a plan with several storeys gets a picture and a caption for each, and a link to the overview', async () => {
    const cells = (z: number, n: number) => Array(n).fill(String(z))
    const flat = [...cells(48, 40), ...cells(272, 40), ...cells(416, 40)]
    const rows = Array.from({ length: 6 }, (_, j) => flat.slice(j * 20, j * 20 + 20).concat(Array(20).fill('')).slice(0, 20).join('|'))
    expect((await post(plan({ map: 'ttt_tall', nx: 20, ny: 6, rows }))).status).toBe(200)
    const html = await mapPage('ttt_tall')
    for (const n of [1, 2, 3]) expect(html).toContain(`/servers/${serverId}/maps/ttt_tall/plan.svg?level=${n}`)
    expect(html).not.toContain('ttt_tall/plan.svg?level=4')
    expect(html).toContain('Level 1')
    expect(html).toContain('Level 3')
    expect(html).toContain(`href="/servers/${serverId}/maps/ttt_tall/plan.svg"`) // the overview
  })

  test('one storey of a plan can be fetched; a storey that does not exist is a 404', async () => {
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=1`, true)).status).toBe(200)
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=2`, true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=0`, true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=abc`, true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=1.5`, true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg?level=1`)).status).toBe(401)
  })

  test('the map\'s page comes with a legend: colours, crouch-only, no floor, north, cell size', async () => {
    const html = await mapPage('ttt_a')
    expect(html).toContain('How to read these pictures')
    expect(html).toContain('lowest floor of the level')
    expect(html).toContain('highest floor of the level')
    expect(html).toContain('Crouch-only')
    expect(html).toContain('No floor a player can reach')
    expect(html).toContain('North is up')
    expect(html).toContain('64 units') // the cell size of the stored plan
    expect(html).toContain('hsl(240 70% 50%)') // the same blue the pictures use
    expect(html).toContain('hsl(0 70% 50%)')
  })

  test('the legend\'s scale runs from the picture\'s blue (left) to its red (right), and shows the faint crouch-only mark', async () => {
    const html = await mapPage('ttt_a')
    const legend = html.split('data-legend="plans"')[1]!.split('How to read these pictures</b>')[1]!.split('North is up')[0]!
    expect(legend).toMatch(/linear-gradient\(to right, hsl\(240 70% 50%\),.*hsl\(0 70% 50%\)\)/)
    expect(legend).toContain('opacity:.4') // the crouch-only mark is drawn faint, as in the pictures
    expect(legend).toContain('class="wd"') // ... with its white dot
  })

  test('each picture\'s caption gives its level, its own heights and its floor cells (the scale itself is in the picture)', async () => {
    const cells = (z: number, n: number) => Array(n).fill(String(z))
    const flat = [...cells(48, 40), ...cells(272, 40)]
    const rows = Array.from({ length: 4 }, (_, j) => flat.slice(j * 20, j * 20 + 20).concat(Array(20).fill('')).slice(0, 20).join('|'))
    expect((await post(plan({ map: 'ttt_scale', nx: 20, ny: 4, rows }))).status).toBe(200)
    const html = await mapPage('ttt_scale')
    expect(html).toContain('Level 1 of 2: 48 units, 40 floor cells')
    expect(html).toContain('Level 2 of 2: 272 units, 40 floor cells')
    expect(html).not.toContain('data-scale') // no second scale bar under the pictures: each picture carries its own
  })

  test('a level that spans heights says from where to where', async () => {
    const rows = ['48|100|130|230|272|' + '272|'.repeat(0)].map(r => r.replace(/\|$/, ''))
    expect((await post(plan({ map: 'ttt_span', nx: 5, ny: 1, rows }))).status).toBe(200)
    expect(await mapPage('ttt_span')).toMatch(/Level 1 of \d: 48 to \d+ units/)
  })

  test('the picture is an SVG with a content-security policy that allows nothing to run or load', async () => {
    const res = await get(`/servers/${serverId}/maps/ttt_a/plan.svg`, true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('<svg')
    expect(body).toContain('<title>ttt_a</title>')
  })

  test('the picture is refused for guests, and a missing plan or server is a 404', async () => {
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.svg`)).status).toBe(401)
    expect((await get(`/servers/${serverId}/maps/ttt_b/plan.svg`, true)).status).toBe(404)
    expect((await get('/servers/nope/maps/ttt_a/plan.svg', true)).status).toBe(404)
  })

  test('a plan too large to draw answers 422, and the JSON download still works', async () => {
    const row = Array.from({ length: 300 }, (_, i) => (i % 2 ? '48' : '272')).join('|')
    expect((await post(plan({ map: 'ttt_big', nx: 300, ny: 300, rows: Array(300).fill(row) }))).status).toBe(200)
    expect((await get(`/servers/${serverId}/maps/ttt_big/plan.svg`, true)).status).toBe(422)
    expect((await get(`/servers/${serverId}/maps/ttt_big/plan.json`, true)).status).toBe(200)
  })

  test('the download is refused for guests, and a missing plan or server is a 404', async () => {
    expect((await get(`/servers/${serverId}/maps/ttt_a/plan.json`)).status).toBe(401)
    expect((await get(`/servers/${serverId}/maps/ttt_b/plan.json`, true)).status).toBe(404)
    expect((await get('/servers/nope/maps/ttt_a/plan.json', true)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/..%2Fx/plan.json`, true)).status).toBe(404)
  })
})
