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

// RFC 37, 5 and 6: the card "Entities not in the world at round start" of the coverage page, from the records of constructed maps (made by the geometry job), and the sums behind it.

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

/** Entity i (a brush of model i+1 when it has a `*`) in a map whose models each own a quad of their own. */
const ent = (cls: string, model: number, name: string) => `{ "classname" "${cls}" "model" "*${model}" "targetname" "${name}" }`
const tpl = (...names: string[]) => `{ "classname" "point_template" "spawnflags" "2" ${names.map((n, i) => `"Template${String(i + 1).padStart(2, '0')}" "${n}"`).join(' ')} }`
function map(entities: string[], models: number): Buffer {
  const quads = flatQuads([0, ...Array.from({ length: models }, (_, i) => 100 + i)])
  return buildBsp({ ...quads, entities: ['{ "classname" "worldspawn" }', ...entities].join('\n'), models: [{ firstFace: 0, numFaces: 1 }, ...Array.from({ length: models }, (_, i) => ({ firstFace: i + 1, numFaces: 1, maxs: [10, 10, 10] as [number, number, number] }))] })
}
const prop = (name: string) => `{ "classname" "prop_dynamic" "model" "models/p.mdl" "origin" "1 2 3" "targetname" "${name}" }`
const MAPS: Record<string, Buffer> = {
  // 4 physboxes and 1 brush left out in three classes, two templates
  ttt_s37_a: map([ent('func_physbox', 1, 'p1'), ent('func_physbox', 2, 'p2'), ent('func_physbox', 3, 'p3'), ent('func_physbox', 4, 'p4'), ent('func_brush', 5, 'b1'), prop('x1'), tpl('p1', 'p2', 'p3'), tpl('p4', 'b1', 'x1')], 5),
  // one prop, one template
  ttt_s37_b: map([prop('x1'), prop('free'), tpl('x1')], 0),
  // a template, nothing named
  ttt_s37_c: map([ent('func_physbox', 1, 'p1'), tpl('nobody')], 1),
  // no template at all
  ttt_s37_d: map([ent('func_physbox', 1, 'p1')], 1),
}
const records: Record<string, CoverageRecord> = {}
const without = (name: string): CoverageRecord => { const r = JSON.parse(JSON.stringify(records[name])); delete r.templated; return r }

async function store(map: string, fp: string, info: unknown) {
  Store.setGeometryRequested(serverId, map, true, null)
  Store.startGeometry(map, fp)
  Store.finishGeometry(map, fp, { mesh: GLB, info })
}

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  serverId = (Store.addServer('Templates') as any).id
  emptyId = (Store.addServer('NoTemplates') as any).id
  const m = (name: string, fingerprint: string | null) => ({ name, size: 1, fingerprint, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true })
  const fpOld = 'cd'.repeat(32), fpOnly = 'ab'.repeat(32)
  Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [...Object.keys(MAPS).map(n => m(n, fingerprint(MAPS[n]!))), m('ttt_s37_old', fpOld)] })
  for (const [name, file] of Object.entries(MAPS)) {
    const r = await buildGeometry(memorySource(file), name, fingerprint(file))
    if (!r.ok) throw new Error(r.error)
    records[name] = r.info.coverage!
    await store(name, fingerprint(file), r.info)
  }
  await store('ttt_s37_old', fpOld, { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: without('ttt_s37_d') })
  Store.setMaps(emptyId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [m('ttt_s37_only_old', fpOnly)] })
  Store.setGeometryRequested(emptyId, 'ttt_s37_only_old', true, null)
  Store.startGeometry('ttt_s37_only_old', fpOnly)
  Store.finishGeometry('ttt_s37_only_old', fpOnly, { mesh: GLB, info: { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: without('ttt_s37_d') } })
})
afterAll(() => { delete process.env.OPEN_SIGNIN; delete process.env.MAP_GEOMETRY })

describe('the records of the constructed maps', () => {
  test('each has its counts (the page is made of these)', () => {
    expect(records['ttt_s37_a']!.templated).toEqual({ templates: 2, entities: 6, byClass: [{ class: 'func_physbox', count: 4 }, { class: 'func_brush', count: 1 }, { class: 'prop_dynamic', count: 1 }] })
    expect(records['ttt_s37_b']!.templated).toEqual({ templates: 1, entities: 1, byClass: [{ class: 'prop_dynamic', count: 1 }] })
    expect(records['ttt_s37_c']!.templated).toEqual({ templates: 1, entities: 0, byClass: [] })
    expect(records['ttt_s37_d']!.templated).toEqual({ templates: 0, entities: 0, byClass: [] })
  })
})

describe('the sums (pure)', () => {
  const inputs = () => [...Object.entries(records).map(([map, record]) => ({ map, state: 'parsed', record })), { map: 'ttt_s37_old', state: 'parsed', record: without('ttt_s37_d') }, { map: 'ttt_s37_none', state: 'queued', record: null }]

  test('the totals are the sums over the maps that have the counts; a record without them and a map without a record are left out', () => {
    const t = summarise(inputs()).templated
    expect(t.withData).toBe(4)
    expect(t.totals).toEqual({ templates: 4, entities: 7, maps: 2, otherEntities: 0, spawnedAtStart: 0 })
    expect(t.byClass).toEqual([{ class: 'func_physbox', count: 4 }, { class: 'func_brush', count: 1 }, { class: 'prop_dynamic', count: 2 }].sort((a, b) => b.count - a.count || (a.class < b.class ? -1 : 1)))
  })
  test('the classes are ranked by count, then name, and the maps by entities left out, then templates, then name', () => {
    const t = summarise(inputs()).templated
    expect(t.byClass.map(c => c.class)).toEqual(['func_physbox', 'prop_dynamic', 'func_brush'])
    expect(t.rows.map(r => r.map)).toEqual(['ttt_s37_a', 'ttt_s37_b', 'ttt_s37_c', 'ttt_s37_d'])
    expect(summarise(inputs().reverse()).templated.rows.map(r => r.map)).toEqual(['ttt_s37_a', 'ttt_s37_b', 'ttt_s37_c', 'ttt_s37_d'])
    expect(t.rows[0]!.top.map(c => c.class)).toEqual(['func_physbox', 'func_brush', 'prop_dynamic'])
  })
  test('classes beyond the 30 a record keeps are summed as other entities', () => {
    const rec = { ...records['ttt_s37_d']!, templated: { templates: 1, entities: 10, byClass: [{ class: 'a', count: 4 }], other: { classes: 3, entities: 6 } } }
    const t = summarise([{ map: 'x', state: 'parsed', record: rec }, { map: 'y', state: 'parsed', record: rec }]).templated
    expect(t.totals.otherEntities).toBe(12); expect(t.totals.entities).toBe(20)
  })
  test('nothing counted: zeros and no rows', () => {
    expect(summarise([]).templated).toEqual({ withData: 0, totals: { templates: 0, entities: 0, maps: 0, otherEntities: 0, spawnedAtStart: 0 }, byClass: [], rows: [] })
  })
})

describe('the card', () => {
  test('it is there, after the moving parts and before the textures, with the classes and the total', async () => {
    const html = await page()
    const starts = html.indexOf('data-coverage-starts'), card = html.indexOf('data-coverage-templated'), textures = html.indexOf('data-coverage-textures')
    expect(starts).toBeGreaterThan(-1); expect(card).toBeGreaterThan(starts); expect(textures).toBeGreaterThan(card)
    expect(html).toContain('<h2 class="ft">Entities not in the world at round start</h2>')
    expect(cells(html, 'data-templated-all')).toEqual(['All', '7'])
    expect(cells(html, 'data-templated-class="func_physbox"')).toEqual(['func_physbox', '4'])
    expect(cells(html, 'data-templated-class="prop_dynamic"')).toEqual(['prop_dynamic', '2'])
    expect(html).toMatch(/Over the 4 maps whose record has them/)
  })
  test('the classes are in rank order in the table', async () => {
    const card = /data-templated-totals.*?<\/table>/s.exec(await page())![0]
    expect([...card.matchAll(/<tr data-templated-class="([^"]+)"/g)].map(m => m[1])).toEqual(['func_physbox', 'prop_dynamic', 'func_brush'])
  })
  test('the maps are listed by entities left out, linked to their page, with their templates and largest classes; a map from before RFC 37 is not in the card', async () => {
    const html = await page()
    const card = /data-coverage-templated.*?data-coverage-textures/s.exec(html)![0]
    expect([...card.matchAll(/<tr data-templated-row="([^"]+)"/g)].map(m => m[1])).toEqual(['ttt_s37_a', 'ttt_s37_b', 'ttt_s37_c', 'ttt_s37_d'])
    expect(cells(html, 'data-templated-row="ttt_s37_a"')).toEqual(['ttt_s37_a', '2', '6', 'func_physbox 4, func_brush 1, prop_dynamic 1'])
    expect(cells(html, 'data-templated-row="ttt_s37_d"')).toEqual(['ttt_s37_d', '0', '0', '–'])
    expect(html).toContain(`<a href="/servers/${serverId}/maps/ttt_s37_a">ttt_s37_a</a>`)
    expect(card).not.toContain('ttt_s37_old')
    expect(html).toContain('data-map-row="ttt_s37_old"')
  })
  test('a server whose records have no counts yet says so, with no table', async () => {
    const html = await page(emptyId)
    expect(html).toContain('data-no-templated')
    expect(html).not.toContain('data-templated-all'); expect(html).not.toContain('data-templated-rows')
    expect(html).toContain('data-coverage-templated')
  })
  test('no inline style, no script, every table of the card in a box that scrolls, the card in the page\'s own column (it cannot make the page jump), the colour of a card that exists', async () => {
    const html = await page()
    const card = /<div class="f c-mint" data-coverage-templated[^>]*>.*?<div class="f c-blue" data-coverage-textures/s.exec(html)![0]
    expect(card).not.toMatch(/ style="/); expect(card).not.toContain('<script')
    for (const m of card.matchAll(/<table/g)) expect(card.slice(Math.max(0, m.index! - 40), m.index!)).toMatch(/class="scrollx">$/)
    expect(html).toContain('class="stack"')
    expect(html).toContain('.c-mint{--c:#34d399}')
  })
})
