import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { bspFingerprint, memorySource } from '../src/maps/bsp'
import { buildGeometry } from '../src/services/mapgeometry'
import { summarise, worldFacesByStatus, flagSetStatus, sizeText } from '../src/services/coveragereport'
import { asRecord, type CoverageRecord } from '../src/maps/coverage'
import { coverageMap, COVERAGE_ENTITIES } from './helpers/coverage_map'
import { PUBLIC_CSS } from '../src/components/styles'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'
process.env.MAP_GEOMETRY = '1'

// RFC 32, 5 and 9: the admin page that adds the coverage records of a server's maps. The records are the real ones, made by the geometry job from constructed maps.

const ADMIN = '76561198000000000', USER = '76561198000000009'
let app: any, Store: any, serverId: string
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])
const get = async (path: string, as: string | null = ADMIN) => app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: (await serializeSigned('steam_id', as, SECRET)).split(';')[0]! } : {} }))
const page = async () => { const r = await get(`/servers/${serverId}/map-coverage`); expect(r.status).toBe(200); return r.text() as Promise<string> }
const fingerprint = (f: Buffer) => bspFingerprint(f.subarray(0, 1036), f.length)

/** The cells of the first row that carries `attr`, as text. */
const cells = (html: string, attr: string): string[] => {
  const row = new RegExp(`<tr ${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>(.*?)</tr>`, 's').exec(html)?.[1]
  expect(row, attr).toBeDefined()
  return [...row!.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(m => m[1]!.replace(/<[^>]*>/g, '').trim())
}

const A = coverageMap()
// B has one more button and one more trigger than A
const B = coverageMap({ entities: COVERAGE_ENTITIES + '\n{ "classname" "func_button" "model" "*3" }\n{ "classname" "trigger_push" "model" "*4" }' })
const FPS = { a: fingerprint(A), b: fingerprint(B) }
let recordA: CoverageRecord, recordB: CoverageRecord

async function store(map: string, fp: string, info: unknown) {
  Store.setGeometryRequested(serverId, map, true, null)
  Store.startGeometry(map, fp)
  Store.finishGeometry(map, fp, { mesh: GLB, info })
}

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  serverId = (Store.addServer('Coverage') as any).id
  const ra = await buildGeometry(memorySource(A), 'ttt_cov_a', FPS.a), rb = await buildGeometry(memorySource(B), 'ttt_cov_b', FPS.b)
  if (!ra.ok || !rb.ok) throw new Error('the maps did not build')
  recordA = ra.info.coverage!; recordB = rb.info.coverage!
  const m = (name: string, fingerprint: string | null) => ({ name, size: 1, fingerprint, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true })
  const fpOld = 'cd'.repeat(32), fpQueued = 'ef'.repeat(32), fpEvil = '12'.repeat(32)
  Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
    maps: [m('ttt_cov_a', FPS.a), m('ttt_cov_b', FPS.b), m('ttt_cov_old', fpOld), m('ttt_cov_queued', fpQueued), m('ttt_cov_evil', fpEvil)] })
  await store('ttt_cov_a', FPS.a, ra.info)
  await store('ttt_cov_b', FPS.b, rb.info)
  await store('ttt_cov_old', fpOld, { vertices: 3, triangles: 1, levels: 1, water: 0 }) // a mesh from before the record: its info has none
  Store.setGeometryRequested(serverId, 'ttt_cov_queued', true, null) // asked for, not built
  // a record written by something else (or damaged): the page must show it as text
  const evil = JSON.parse(JSON.stringify(recordA)) as CoverageRecord
  evil.brush.push({ class: '<img src=x onerror=alert(1)>', entities: 1, faces: 1, status: 'unknown' })
  await store('ttt_cov_evil', fpEvil, { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: evil })
})
afterAll(() => { delete process.env.OPEN_SIGNIN; delete process.env.MAP_GEOMETRY })

describe('who may open it', () => {
  test('the route is declared admin in the tiers, and is a page of a server (not under /maps/:map)', async () => {
    const { TIERS } = await import('../src/routes/tiers')
    expect(TIERS['GET /servers/:serverId/map-coverage']).toBe('admin')
  })
  test('an anonymous visitor and a signed-in user are sent away; an admin gets the page', async () => {
    const anon = await get(`/servers/${serverId}/map-coverage`, null)
    expect(anon.status).toBe(302); expect(anon.headers.get('location')).toBe('/')
    const user = await get(`/servers/${serverId}/map-coverage`, USER)
    expect(user.status).toBe(302); expect(user.headers.get('location')).toBe('/')
    expect(await (await get(`/servers/${serverId}/map-coverage`, null)).text()).not.toContain('Map coverage')
    expect((await get(`/servers/${serverId}/map-coverage`)).status).toBe(200)
  })
  test('in the game\'s window (?embed=1) it is not offered even to an admin, and a server that is not there goes to the front page', async () => {
    expect((await get(`/servers/${serverId}/map-coverage?embed=1`)).status).toBe(302)
    const r = await get('/servers/no-such-server/map-coverage')
    expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/')
  })
})

describe('what it shows (the real records of two constructed maps, one map from before the record, one not built, one with a damaged record)', () => {
  test('the head is the head of the Maps section: the way back, the section buttons with Maps marked, then the title', async () => {
    const html = await page()
    const crumbs = html.indexOf('class="crumbs"'), nav = html.indexOf('class="sections"'), h1 = html.indexOf('<h1')
    expect(crumbs).toBeGreaterThan(-1); expect(nav).toBeGreaterThan(crumbs); expect(h1).toBeGreaterThan(nav)
    expect(/class="crumbs">(.*?)<\/div>/s.exec(html)![1]).toBe(`<a href="/servers/${serverId}/maps">All maps</a> / Map coverage`)
    expect(/<nav class="sections"[^>]*>(.*?)<\/nav>/s.exec(html)![1]).toMatch(/aria-current="page"[^>]*>🗺 Maps/)
    expect(html).toContain('<h1>Map coverage</h1>')
    expect(html).toContain('<title>Map coverage | Coverage</title>')
  })

  test('how many maps have a record and how many have none', async () => {
    const html = await page()
    expect(html).toMatch(/3 of 5 maps have one; without a record: 2/)
  })

  test('the totals by status add up to the hand count of the records', async () => {
    const html = await page()
    // Three maps have a record: a, b and evil (a copy of a with one more unknown class). Each has 10 world faces: 7 drawn, 3 invisible.
    // Brush entities (entities/faces) in a: drawn 2/2, invisible 1/1, gap 2/3, unknown 1/1. In b, one more button (2 faces) and one more trigger (1 face): invisible 2/2, gap 3/5. In evil: unknown 2/2.
    expect(cells(html, 'data-status-row="drawn"').slice(2)).toEqual(['21', '6', '6'])
    expect(cells(html, 'data-status-row="invisible"').slice(2)).toEqual(['9', '4', '4'])
    expect(cells(html, 'data-status-row="gap"').slice(2)).toEqual(['0', '7', '11'])
    expect(cells(html, 'data-status-row="not read"').slice(2)).toEqual(['0', '0', '0'])
    expect(cells(html, 'data-status-row="unknown"').slice(2)).toEqual(['0', '4', '4'])
  })

  test('the gaps are ranked by faces, with the number of maps, the totals and the map with the most', async () => {
    const html = await page()
    const keys = [...html.matchAll(/<tr data-gap="([^"]+)"/g)].map(m => m[1]!)
    // by faces: the button (2 + 4 + 2 = 8), then the mystery box and the water (3 each: the tie goes by entities, maps, then name)
    expect(keys.slice(0, 3)).toEqual(['class:func_button', 'class:func_mystery_box', 'class:func_water_analog'])
    // button: a 2 faces (1 entity), b 4 (2), evil 2 (1): 3 maps, 8 faces, 4 entities, the most in b
    const button = cells(html, 'data-gap="class:func_button"')
    expect(button.slice(0, 3)).toEqual(['func_button', 'class', 'gap'])
    expect(button.slice(3, 6)).toEqual(['3', '8', '4'])
    expect(button[6]).toBe('ttt_cov_b (4)')
    expect(html).toContain(`<a href="/servers/${serverId}/maps/ttt_cov_b">ttt_cov_b</a> (4)`)
    // ordered: every row has no more faces than the one before
    const faces = [...html.matchAll(/<tr data-gap="[^"]+">(.*?)<\/tr>/gs)].map(m => Number([...m[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)][4]![1]!.replace(/\D/g, '')))
    expect(faces).toEqual([...faces].sort((a, b) => b - a))
    // unknown classes are listed with the gaps, and marked
    expect(cells(html, 'data-gap="class:func_mystery_box"').slice(2, 3)).toEqual(['unknown'])
  })

  test('a map with no record, and one not built, are listed as such; the others link to their page', async () => {
    const html = await page()
    for (const m of ['ttt_cov_old', 'ttt_cov_queued']) {
      const row = cells(html, `data-map-row="${m}"`)
      expect(row.slice(1, 4), m).toEqual(['–', '–', '–'])
      expect(row[4], m).toMatch(/no record yet|3D queued/)
    }
    expect(cells(html, 'data-map-row="ttt_cov_old"')[4]).toBe('no record yet')
    expect(cells(html, 'data-map-row="ttt_cov_queued"')[4]).toBe('3D queued')
    expect(html).toContain(`<a href="/servers/${serverId}/maps/ttt_cov_a">ttt_cov_a</a>`)
    expect(cells(html, 'data-map-row="ttt_cov_b"').slice(1, 4)).toEqual(['5', '3', '1']) // gap faces: buttons 4 + water 1; gap entities 2 + 1; one unknown class
    // the rows are by gap faces, the maps without a record last
    expect([...html.matchAll(/<tr data-map-row="([^"]+)"/g)].map(m => m[1])).toEqual(['ttt_cov_b', 'ttt_cov_evil', 'ttt_cov_a', 'ttt_cov_old', 'ttt_cov_queued'])
  })

  test('each map with a record has its record in a details block: flags, outcomes, classes, point entities, lumps', async () => {
    const html = await page()
    const block = /<details data-record-of="ttt_cov_a">(.*?)<\/details>/s.exec(html)?.[1]
    expect(block).toBeDefined()
    for (const part of ['data-record-flags', 'data-record-outcome', 'data-record-brush', 'data-record-points', 'data-record-lumps']) expect(block, part).toContain(part)
    expect(block).toContain('func_mystery_box'); expect(block).toContain('NOLIGHT|BUMPLIGHT'); expect(block).toContain('skippedByMaterial')
    expect(html).not.toContain('data-record-of="ttt_cov_old"')
  })

  test('the parts of the file that are not read are listed with their sizes and counts', async () => {
    const html = await page()
    const table = /<table class="set" data-notread[^>]*>(.*?)<\/table>/s.exec(html)![1]!
    for (const part of ['lighting', 'overlays', 'cubemaps', 'detail props', 'visibility', 'fog and light entities']) expect(table, part).toContain(`<td>${part}</td>`)
    expect(cells(html, 'data-notread-row="fog and light entities"')[1]).toBe('12 entities') // 3 lights and a fog in each of the 3 records
    expect(cells(html, 'data-notread-row="overlays"')[1]).toBe('0 B, 3 overlay entities')
  })

  test('what the map file says is shown as text: a class name with markup is escaped', async () => {
    const html = await page()
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('no script, no inline style, every table in a box that scrolls, and the cards in the page\'s own column: it cannot jump, and it does not push a phone sideways', async () => {
    const html = await page()
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/ style="/)
    expect(html).toContain('class="stack"')
    for (const m of html.matchAll(/<table/g)) expect(html.slice(Math.max(0, m.index! - 40), m.index!), 'a table sits in .scrollx').toMatch(/class="scrollx">$/)
    expect((html.match(/<details/g) ?? []).length).toBe(3)
    expect(PUBLIC_CSS).toMatch(/\.f details\{margin-top:var\(--space-3\)\}/)
  })

  test('the maps page gives an admin a link to it, and nobody else', async () => {
    const maps = await (await get(`/servers/${serverId}/maps`)).text()
    expect(maps).toContain(`href="/servers/${serverId}/map-coverage"`)
    expect(maps).toContain('data-coverage-link')
    expect(await (await get(`/servers/${serverId}/maps`, USER)).text()).not.toContain('map-coverage')
    expect(await (await get(`/servers/${serverId}/maps`, null)).text()).not.toContain('map-coverage')
  })
})

describe('an old stored mesh and an empty server', () => {
  test('a stored info without a record loads, and gives no record', () => {
    const state = Store.getGeometryStates(serverId).get('ttt_cov_old')
    expect(state.status).toBe('parsed')
    expect(state.info.coverage).toBeUndefined()
    expect(asRecord(state.info.coverage)).toBeNull()
    expect(asRecord(Store.getGeometryStates(serverId).get('ttt_cov_a').info.coverage)).toEqual(recordA)
  })
  test('a server with no maps asked for, and one whose maps have no record, give a page that says so', async () => {
    const other = (Store.addServer('Empty') as any).id
    const html = await (await get(`/servers/${other}/map-coverage`)).text()
    expect(html).toContain('data-no-records'); expect(html).toContain('No map has had its 3D view asked for')
    expect(html).toContain('0 of 0 maps have one')
  })
})

describe('the sums (pure)', () => {
  const rec = (over: Partial<CoverageRecord> = {}): CoverageRecord => ({ ...JSON.parse(JSON.stringify(recordA)), ...over })

  test('a face is counted once, by its flags: unknown over gap over invisible over drawn; a face left out by its material is invisible', () => {
    expect(flagSetStatus('-')).toBe('drawn')
    expect(flagSetStatus('NOLIGHT|BUMPLIGHT')).toBe('drawn')
    expect(flagSetStatus('SKY|NOLIGHT')).toBe('invisible')
    expect(flagSetStatus('WARP|OTHER')).toBe('unknown')
    expect(worldFacesByStatus(recordA)).toEqual({ drawn: 7, invisible: 3, gap: 0, 'not read': 0, unknown: 0 })
    const total = Object.values(worldFacesByStatus(recordA)).reduce((a, b) => a + b, 0)
    expect(total).toBe(recordA.worldFaces)
  })

  test('the status is the registry\'s now: a class in a stored record that was classified since is counted by the new status', () => {
    const r = rec({ brush: [{ class: 'func_button', entities: 1, faces: 2, status: 'unknown' }] }) // the record was made when the class was not known
    const s = summarise([{ map: 'm', state: 'parsed', record: r }])
    expect(s.totals.gap).toMatchObject({ brushEntities: 1, brushFaces: 2 })
    expect(s.totals.unknown.brushEntities).toBe(0)
  })

  test('ranking: faces, then entities, then the number of maps, then the name; the map with the most is kept', () => {
    const mk = (cls: string, entities: number, faces: number) => rec({ brush: [{ class: cls, entities, faces, status: 'gap' }] })
    const s = summarise([
      { map: 'one', state: 'parsed', record: mk('func_button', 1, 5) }, { map: 'two', state: 'parsed', record: mk('func_button', 2, 9) },
      { map: 'three', state: 'parsed', record: mk('func_illusionary', 1, 14) }, { map: 'four', state: 'parsed', record: mk('func_breakable_surf', 3, 14) },
    ])
    // all three have 14 faces: the button has 3 entities in 2 maps, the breakable glass 3 in 1, the illusionary brush 1
    expect(s.gaps.map(g => g.key)).toEqual(['func_button', 'func_breakable_surf', 'func_illusionary'])
    expect(s.gaps[0]).toMatchObject({ maps: 2, faces: 14, entities: 3, top: { map: 'two', faces: 9, entities: 2 } })
    expect(s.rows.map(r => r.map)).toEqual(['four', 'three', 'two', 'one'])
  })

  test('maps without a record are counted and kept out of every sum; the totals are zero with none', () => {
    const s = summarise([{ map: 'a', state: 'parsed', record: null }, { map: 'b', state: 'queued', record: null }])
    expect(s).toMatchObject({ maps: 2, withRecord: 0, without: ['a', 'b'], gaps: [] })
    for (const t of Object.values(s.totals)) expect(t).toEqual({ worldFaces: 0, brushEntities: 0, brushFaces: 0 })
    expect(summarise([]).maps).toBe(0)
  })

  test('the lumps and the point features are summed over the maps with a record', () => {
    const s = summarise([{ map: 'a', state: 'parsed', record: recordA }, { map: 'b', state: 'parsed', record: recordB }, { map: 'c', state: 'parsed', record: null }])
    expect(s.pointFeatures).toEqual({ 'fog and light entities': 8, overlays: 2 })
    expect(s.lumps.lighting).toBe(0)
  })

  test('a flag the registry does not know is an unknown, and is ranked with the gaps, by its faces', () => {
    const r = rec({ flags: { '-': 5, 'WARP|OTHER': 3 } })
    const s = summarise([{ map: 'm', state: 'parsed', record: r }])
    expect(s.gaps.find(g => g.key === 'OTHER')).toMatchObject({ kind: 'flag', status: 'unknown', faces: 3, maps: 1 })
    expect(s.totals.unknown.worldFaces).toBe(3)
  })

  test('sizes read as bytes, KB or MB', () => {
    expect([0, 999, 1000, 27_808, 187_507, 999_999, 1_000_000, 6_557_672, 97_604_829].map(sizeText)).toEqual(['0 B', '999 B', '1 KB', '28 KB', '188 KB', '1000 KB', '1.0 MB', '6.6 MB', '98 MB'])
  })
})
