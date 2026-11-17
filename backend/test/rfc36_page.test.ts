import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { bspFingerprint, memorySource } from '../src/maps/bsp'
import { buildGeometry } from '../src/services/mapgeometry'
import { summarise } from '../src/services/coveragereport'
import type { CoverageRecord } from '../src/maps/coverage'
import { asRecord } from '../src/maps/coverage'
import { buildBsp, flatQuads } from './helpers/bsp_builder'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'
process.env.MAP_GEOMETRY = '1'

// RFC 36, 4 and 6: the card "Textures" of the coverage page and the sums behind it, from the records of constructed maps; a record without the counts loads.

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
const CENSUS: Record<string, { materials: number, textured: number, notFound: number, notDecodable: number, ceiling: number, pngBytes: number, glbBytes: number }> = {
  ttt_s36_big: { materials: 90, textured: 80, notFound: 6, notDecodable: 3, ceiling: 1, pngBytes: 5_400_000, glbBytes: 9_100_000 },
  ttt_s36_mid: { materials: 76, textured: 76, notFound: 0, notDecodable: 0, ceiling: 0, pngBytes: 100_486, glbBytes: 2_308_460 },
  ttt_s36_tie: { materials: 10, textured: 9, notFound: 1, notDecodable: 0, ceiling: 0, pngBytes: 12_000, glbBytes: 2_308_460 },
  ttt_s36_small: { materials: 3, textured: 3, notFound: 0, notDecodable: 0, ceiling: 0, pngBytes: 900, glbBytes: 40_000 },
}
const MAPS: Record<string, Buffer> = {
  ttt_s36_big: map([ent('func_door', 1)]), ttt_s36_mid: map([ent('func_door', 1), ent('func_door', 2)]),
  ttt_s36_tie: map([ent('func_door', 1), ent('func_door', 2), ent('func_door', 3)]), ttt_s36_small: map([ent('func_door', 1), ent('func_door', 2), ent('func_door', 3), ent('func_door', 4)]),
  ttt_s36_old: map([ent('func_door', 1), ent('func_door', 2), ent('func_door', 3), ent('func_door', 4), ent('func_door', 5)]),
}
const records: Record<string, CoverageRecord> = {}
const without = (r: CoverageRecord): CoverageRecord => { const c = JSON.parse(JSON.stringify(r)); delete c.textures; return c }

async function store(map: string, fp: string, info: unknown, id = serverId) {
  Store.setGeometryRequested(id, map, true, null)
  Store.startGeometry(map, fp)
  Store.finishGeometry(map, fp, { mesh: GLB, info })
}

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  serverId = (Store.addServer('Textures') as any).id
  emptyId = (Store.addServer('NoTextures') as any).id
  const m = (name: string, fingerprint: string | null) => ({ name, size: 1, fingerprint, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true })
  Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [...Object.keys(MAPS).map(n => m(n, fingerprint(MAPS[n]!)))] })
  for (const [name, file] of Object.entries(MAPS)) {
    const r = await buildGeometry(memorySource(file), name, fingerprint(file))
    if (!r.ok) throw new Error(r.error)
    const record = name === 'ttt_s36_old' ? without(r.info.coverage!) : { ...r.info.coverage!, textures: CENSUS[name]! }
    records[name] = record
    await store(name, fingerprint(file), { ...r.info, coverage: record })
  }
  const only = map([ent('func_door', 1), ent('func_door', 2), ent('func_door', 3), ent('func_door', 4), ent('func_door', 5), ent('func_door', 6)])
  Store.setMaps(emptyId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [m('ttt_s36_only_old', fingerprint(only))] })
  await store('ttt_s36_only_old', fingerprint(only), { vertices: 3, triangles: 1, levels: 1, water: 0, coverage: without(records['ttt_s36_old']!) }, emptyId)
})
afterAll(() => { delete process.env.OPEN_SIGNIN; delete process.env.MAP_GEOMETRY })

describe('the record keeps the counts, and an old record loads', () => {
  test('the counts survive the check of a stored record', () => {
    const r = records['ttt_s36_big']!
    expect(asRecord(JSON.parse(JSON.stringify(r)))?.textures).toEqual(CENSUS['ttt_s36_big']!)
  })
  test('a record from before RFC 36 has none and still loads', () => {
    const r = asRecord(JSON.parse(JSON.stringify(records['ttt_s36_old'])))
    expect(r).not.toBeNull(); expect(r!.textures).toBeUndefined(); expect('textures' in r!).toBe(false)
  })
  test('numbers are sanitised: a negative, a text or a missing key drops the census (never a wrong number on the page), fractions are made whole', () => {
    const base = JSON.parse(JSON.stringify(records['ttt_s36_big']))
    for (const bad of [{ glbBytes: -1 }, { pngBytes: 'a lot' }, { ceiling: null }, { materials: Infinity }, { textured: undefined }]) {
      const r = asRecord({ ...base, textures: { ...base.textures, ...bad } })
      expect(r, JSON.stringify(bad)).not.toBeNull(); expect(r!.textures, JSON.stringify(bad)).toBeUndefined()
    }
    expect(asRecord({ ...base, textures: 'nonsense' })!.textures).toBeUndefined()
    expect(asRecord({ ...base, textures: { ...base.textures, glbBytes: 1234.7 } })!.textures!.glbBytes).toBe(1234)
  })
})

describe('the sums (pure)', () => {
  const inputs = () => [...Object.entries(records).map(([map, record]) => ({ map, state: 'parsed', record })), { map: 'ttt_s36_none', state: 'queued', record: null }]
  test('the totals are the sums over the maps that have the counts; an old record and a map without a record are left out', () => {
    const t = summarise(inputs()).textures
    expect(t.withData).toBe(4)
    expect(t.totals).toEqual({ materials: 179, textured: 168, notFound: 7, notDecodable: 3, ceiling: 1, pngBytes: 5_513_386, glbBytes: 13_756_920, fallback: 11 })
    expect(t.totals.textured + t.totals.fallback).toBe(t.totals.materials)
  })
  test('the maps are ranked by the size of the GLB, the largest first, a tie by name, whatever the order they come in', () => {
    expect(summarise(inputs()).textures.rows.map(r => r.map)).toEqual(['ttt_s36_big', 'ttt_s36_mid', 'ttt_s36_tie', 'ttt_s36_small'])
    expect(summarise(inputs().reverse()).textures.rows.map(r => r.map)).toEqual(['ttt_s36_big', 'ttt_s36_mid', 'ttt_s36_tie', 'ttt_s36_small'])
    expect(summarise(inputs()).textures.rows[0]).toMatchObject({ map: 'ttt_s36_big', fallback: 10 })
  })
  test('nothing counted: zeros and no rows', () => {
    expect(summarise([]).textures).toEqual({ withData: 0, totals: { materials: 0, textured: 0, notFound: 0, notDecodable: 0, ceiling: 0, pngBytes: 0, glbBytes: 0, fallback: 0 }, rows: [] })
  })
})

describe('the card', () => {
  test('it is there, between the moving-parts card and the maps, with the totals', async () => {
    const html = await page()
    const starts = html.indexOf('data-coverage-starts'), card = html.indexOf('data-coverage-textures'), maps = html.indexOf('data-coverage-maps')
    expect(starts).toBeGreaterThan(-1); expect(card).toBeGreaterThan(starts); expect(maps).toBeGreaterThan(card)
    expect(html).toContain('<h2 class="ft">Textures</h2>')
    expect(cells(html, 'data-texture-all')).toEqual(['All', '179', '168', '11', '5.5 MB', '14 MB'])
    expect(html).toMatch(/Over the 4 maps whose record has them/)
    expect(html).toContain('7 not found, 3 not decodable, 1 left out because a safety ceiling was reached')
  })
  test('the maps are listed by GLB size, linked, with materials, textured, fallback, PNG and GLB; a map from before RFC 36 is not in the card', async () => {
    const html = await page()
    const card = /data-coverage-textures.*?data-coverage-maps/s.exec(html)![0]
    expect([...card.matchAll(/<tr data-texture-row="([^"]+)"/g)].map(m => m[1])).toEqual(['ttt_s36_big', 'ttt_s36_mid', 'ttt_s36_tie', 'ttt_s36_small'])
    expect(cells(html, 'data-texture-row="ttt_s36_big"')).toEqual(['ttt_s36_big', '90', '80', '10', '5.4 MB', '9.1 MB'])
    expect(cells(html, 'data-texture-row="ttt_s36_mid"')).toEqual(['ttt_s36_mid', '76', '76', '0', '100 KB', '2.3 MB'])
    expect(cells(html, 'data-texture-row="ttt_s36_small"')).toEqual(['ttt_s36_small', '3', '3', '0', '900 B', '40 KB'])
    expect(html).toContain(`<a href="/servers/${serverId}/maps/ttt_s36_big">ttt_s36_big</a>`)
    expect(card).not.toContain('ttt_s36_old')
    expect(html).toContain('data-map-row="ttt_s36_old"')
  })
  test('a server whose records have no counts yet says so, with no table', async () => {
    const html = await page(emptyId)
    expect(html).toContain('data-no-textures')
    expect(html).not.toContain('data-texture-all'); expect(html).not.toContain('data-texture-rows')
    expect(html).toContain('data-coverage-textures')
  })
  test('no inline style, no script, every table of the card in a box that scrolls, the card in the page\'s own column (it cannot make the page jump)', async () => {
    const html = await page()
    const card = /<div class="f c-[a-z]+" data-coverage-textures[^>]*>.*?<div class="f c-green" data-coverage-maps/s.exec(html)![0]
    expect(card).not.toMatch(/ style="/); expect(card).not.toContain('<script')
    expect([...card.matchAll(/<table/g)].length).toBe(2)
    for (const m of card.matchAll(/<table/g)) expect(card.slice(Math.max(0, m.index! - 40), m.index!)).toMatch(/class="scrollx">$/)
    expect(html).toContain('class="stack"')
  })
})
