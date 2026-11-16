import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { bspFingerprint, memorySource } from '../src/maps/bsp'
import { buildGeometry } from '../src/services/mapgeometry'
import { summarise } from '../src/services/coveragereport'
import type { CoverageRecord } from '../src/maps/coverage'
import { buildBsp, flatQuads } from './helpers/bsp_builder'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'
process.env.MAP_GEOMETRY = '1'

// RFC 35, 5 and 7: the card "Where moving parts start" of the coverage page, from the records of constructed maps (made by the geometry job), and the sums behind it.

const ADMIN = '76561198000000000'
let app: any, Store: any, serverId: string, emptyId: string
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])
const get = async (path: string) => app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]! } }))
const page = async (id = serverId) => { const r = await get(`/servers/${id}/map-coverage`); expect(r.status).toBe(200); return r.text() as Promise<string> }
const fingerprint = (f: Buffer) => bspFingerprint(f.subarray(0, 1036), f.length)
const cells = (html: string, attr: string): string[] => {
  const row = new RegExp(`<tr ${attr}[^>]*>(.*?)</tr>`, 's').exec(html)?.[1]
  expect(row, attr).toBeDefined()
  return [...row!.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(m => m[1]!.replace(/<[^>]*>/g, '').trim())
}

/** A map of one model for each entity, each a quad of its own with a box of 10 by 10 by 10. */
const ent = (cls: string, model: number, extra = '') => `{ "classname" "${cls}" "model" "*${model}" ${extra} }`
function map(entities: string[]): Buffer {
  const quads = flatQuads([0, ...entities.map((_, i) => 100 + i)])
  return buildBsp({ ...quads, entities: ['{ "classname" "worldspawn" }', ...entities].join('\n'), models: [{ firstFace: 0, numFaces: 1 }, ...entities.map((_, i) => ({ firstFace: i + 1, numFaces: 1, maxs: [10, 10, 10] as [number, number, number] }))] })
}
const OPEN = '"spawnpos" "1" "movedir" "0 0 0"', LOST = '"spawnpos" "1"'
const MAPS: Record<string, Buffer> = {
  ttt_s35_a: map([ent('func_door', 1, OPEN), ent('func_door', 2, OPEN), ent('func_door', 3, LOST), ent('func_door', 4)]),
  ttt_s35_b: map([ent('func_door_rotating', 1, '"spawnpos" "1"'), ent('func_movelinear', 2, '"startposition" "1" "movedir" "0 0 0" "movedistance" "10"'), ent('func_door', 3)]),
  ttt_s35_c: map([ent('func_door', 1), ent('func_door', 2)]),
  ttt_s35_d: map([ent('func_door', 1, LOST), ent('func_door', 2, LOST)]),
}
const records: Record<string, CoverageRecord> = {}
const withoutStarts = (name: string): CoverageRecord => { const r = JSON.parse(JSON.stringify(records[name])); delete r.startStates; return r }

async function store(map: string, fp: string, info: unknown) {
  Store.setGeometryRequested(serverId, map, true, null)
  Store.startGeometry(map, fp)
  Store.finishGeometry(map, fp, { mesh: GLB, info })
}

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  serverId = (Store.addServer('Starts') as any).id
  emptyId = (Store.addServer('NoStarts') as any).id
  const m = (name: string, fingerprint: string | null) => ({ name, size: 1, fingerprint, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true })
  const fpOld = 'cd'.repeat(32), fpOnly = 'ab'.repeat(32)
  const list = [...Object.keys(MAPS).map(n => m(n, fingerprint(MAPS[n]!))), m('ttt_s35_old', fpOld)]
  Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: list })
  for (const [name, file] of Object.entries(MAPS)) {
    const r = await buildGeometry(memorySource(file), name, fingerprint(file))
    if (!r.ok) throw new Error(r.error)
    records[name] = r.info.coverage!
    await store(name, fingerprint(file), r.info)
  }
  // a mesh from before RFC 35: its record has none
  await store('ttt_s35_old', fpOld, { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: withoutStarts('ttt_s35_c') })
  // a server whose only map has a record without start states
  Store.setMaps(emptyId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [m('ttt_s35_only_old', fpOnly)] })
  Store.setGeometryRequested(emptyId, 'ttt_s35_only_old', true, null)
  Store.startGeometry('ttt_s35_only_old', fpOnly)
  Store.finishGeometry('ttt_s35_only_old', fpOnly, { mesh: GLB, info: { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: withoutStarts('ttt_s35_c') } })
})
afterAll(() => { delete process.env.OPEN_SIGNIN; delete process.env.MAP_GEOMETRY })

describe('the records of the constructed maps', () => {
  test('each has its counts (the page is made of these)', () => {
    expect(records['ttt_s35_a']!.startStates).toMatchObject({ closed: 1, openPlaced: 2, openLeftOut: 1 })
    expect(records['ttt_s35_b']!.startStates).toMatchObject({ closed: 1, openPlaced: 2, openLeftOut: 0, startPositioned: 1 })
    expect(records['ttt_s35_c']!.startStates).toMatchObject({ closed: 2, openPlaced: 0, openLeftOut: 0 })
    expect(records['ttt_s35_d']!.startStates).toMatchObject({ closed: 0, openPlaced: 0, openLeftOut: 2 })
  })
})

describe('the sums (pure)', () => {
  const inputs = () => [...Object.entries(records).map(([map, record]) => ({ map, state: 'parsed', record })), { map: 'ttt_s35_old', state: 'parsed', record: withoutStarts('ttt_s35_c') }, { map: 'ttt_s35_none', state: 'queued', record: null }]

  test('the totals are the sums over the maps that have the counts; a record without them and a map without a record are left out', () => {
    const s = summarise(inputs()).starts
    expect(s.withData).toBe(4)
    expect(s.totals).toEqual({ closed: 4, openPlaced: 4, openLeftOut: 3, startPositioned: 1 })
    expect(s.byClass).toEqual({
      func_door: { closed: 4, openPlaced: 2, openLeftOut: 3 }, func_door_rotating: { closed: 0, openPlaced: 1, openLeftOut: 0 }, func_movelinear: { closed: 0, openPlaced: 1, openLeftOut: 0 },
    })
  })
  test('the maps are ranked by parts that moved or were left out, then by those left out, then by name', () => {
    const s = summarise(inputs()).starts
    // a: 3 (1 left out); d: 2 (2 left out); b: 2 (0 left out); c: 0
    expect(s.rows.map(r => r.map)).toEqual(['ttt_s35_a', 'ttt_s35_d', 'ttt_s35_b', 'ttt_s35_c'])
    expect(summarise(inputs().reverse()).starts.rows.map(r => r.map)).toEqual(['ttt_s35_a', 'ttt_s35_d', 'ttt_s35_b', 'ttt_s35_c'])
  })
  test('the name breaks a tie of everything else', () => {
    const rec = (name: string) => ({ map: name, state: 'parsed', record: { ...records['ttt_s35_c']!, startStates: { closed: 1, openPlaced: 1, openLeftOut: 1, startPositioned: 0, byClass: {} } } })
    expect(summarise([rec('zz'), rec('aa'), rec('mm')]).starts.rows.map(r => r.map)).toEqual(['aa', 'mm', 'zz'])
  })
  test('nothing counted: zeros and no rows', () => {
    expect(summarise([]).starts).toEqual({ withData: 0, totals: { closed: 0, openPlaced: 0, openLeftOut: 0, startPositioned: 0 }, byClass: {}, rows: [] })
  })
})

describe('the card', () => {
  test('it is there, between the gaps and the maps, with the totals by class and in all', async () => {
    const html = await page()
    const gaps = html.indexOf('data-coverage-gaps'), card = html.indexOf('data-coverage-starts'), maps = html.indexOf('data-coverage-maps')
    expect(gaps).toBeGreaterThan(-1); expect(card).toBeGreaterThan(gaps); expect(maps).toBeGreaterThan(card)
    expect(html).toContain('<h2 class="ft">Where moving parts start</h2>')
    expect(cells(html, 'data-start-all')).toEqual(['All', '4', '4', '3'])
    expect(cells(html, 'data-start-class="func_door"')).toEqual(['func_door', '4', '2', '3'])
    expect(cells(html, 'data-start-class="func_door_rotating"')).toEqual(['func_door_rotating', '0', '1', '0'])
    expect(cells(html, 'data-start-class="func_movelinear"')).toEqual(['func_movelinear', '0', '1', '0'])
    expect(html).toMatch(/Over the 4 maps whose record has them/)
  })
  test('the maps are listed by what moved or was left out, linked to their page; a map from before RFC 35 is not in the card', async () => {
    const html = await page()
    const card = /data-coverage-starts.*?data-coverage-maps/s.exec(html)![0]
    expect([...card.matchAll(/<tr data-start-row="([^"]+)"/g)].map(m => m[1])).toEqual(['ttt_s35_a', 'ttt_s35_d', 'ttt_s35_b', 'ttt_s35_c'])
    expect(cells(html, 'data-start-row="ttt_s35_a"')).toEqual(['ttt_s35_a', '1', '2', '1'])
    expect(cells(html, 'data-start-row="ttt_s35_d"')).toEqual(['ttt_s35_d', '0', '0', '2'])
    expect(html).toContain(`<a href="/servers/${serverId}/maps/ttt_s35_a">ttt_s35_a</a>`)
    expect(card).not.toContain('ttt_s35_old')
    // the old map is still a map of the page, with its record
    expect(html).toContain('data-map-row="ttt_s35_old"')
  })
  test('a server whose records have no start states yet says so, with no table', async () => {
    const html = await page(emptyId)
    expect(html).toContain('data-no-starts')
    expect(html).not.toContain('data-start-all'); expect(html).not.toContain('data-start-rows')
    expect(html).toContain('data-coverage-starts')
  })
  test('no inline style, no script, every table of the card in a box that scrolls, the card in the page\'s own column (it cannot make the page jump)', async () => {
    const html = await page()
    const card = /<div class="f c-violet" data-coverage-starts[^>]*>.*?<div class="f c-green" data-coverage-maps/s.exec(html)![0]
    expect(card).not.toMatch(/ style="/); expect(card).not.toContain('<script')
    for (const m of card.matchAll(/<table/g)) expect(card.slice(Math.max(0, m.index! - 40), m.index!)).toMatch(/class="scrollx">$/)
    expect(html).toContain('class="stack"')
  })
})
