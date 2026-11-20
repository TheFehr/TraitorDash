import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySource, readHeader } from '../src/maps/bsp'
import { buildPropSet, type StockModels } from '../src/maps/propset'
import { buildBsp, buildGma, flatQuad } from './helpers/bsp_builder'
import { buildModel as modelFiles, buildZip } from './helpers/model_builder'
import { fakeAddons, fakeSteam, items } from './helpers/workshop_fake'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// RFC 40, 3.3, 3.4 and 6: the Workshop content source: a model found in the index, built from the addon that holds it with the materials it names.

let db: any, W: any, Q: any, C: any
beforeAll(async () => {
  db = (await import('../src/services/Database')).default
  W = await import('../src/services/workshopStore')
  Q = await import('../src/services/workshopQueue')
  C = await import('../src/services/workshopContent')
})

/** A Source texture (RGBA8888, one mip) of w by w pixels. */
function vtf(w: number, k: number): Buffer {
  const out = Buffer.alloc(80 + w * w * 4)
  out.write('VTF\0', 0, 'latin1'); out.writeUInt32LE(7, 4); out.writeUInt32LE(2, 8); out.writeUInt32LE(80, 12)
  out.writeUInt16LE(w, 16); out.writeUInt16LE(w, 18); out.writeUInt16LE(1, 24); out.writeInt32LE(0, 52); out.writeUInt8(1, 56)
  out.writeInt32LE(-1, 57); out.writeUInt16LE(1, 63)
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) out.set([(k * 40) & 255, (x * 9 + k) & 255, (y * 9) & 255, 255], 80 + (y * w + x) * 4)
  return out
}
const vmt = (tex: string, extra = '') => `"VertexLitGeneric"\n{\n  "$basetexture" "${tex}"\n${extra}}\n`

const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [10, 0, 0], C_: [number, number, number] = [0, 10, 0]
const UV: [number, number][] = [[0, 0], [1, 0], [0, 1]]
const gun = modelFiles({
  textures: ['wall', 'decal', 'ghost'], cdTextures: ['models\\test\\'],
  meshes: [0, 1, 2].map(material => ({ material, vertices: [A, B, C_], tris: [0, 1, 2], uvs: UV })),
})
const crate = modelFiles({ textures: ['wall'], meshes: [{ vertices: [A, B, C_], tris: [0, 1, 2], uvs: UV }] })
const hostile = modelFiles({ textures: ['..\\..\\..\\etc\\passwd', 'wall'], cdTextures: ['models\\test\\'], meshes: [{ material: 0, vertices: [A, B, C_], tris: [0, 1, 2] }, { material: 1, vertices: [A, B, C_], tris: [0, 1, 2] }] })

// addon 10 holds the gun and its own decal; 20 holds the wall material (another addon); 30 holds unrelated things; 40 holds a crate and a broken model
const addons = () => ({
  '10': buildGma({
    'models/weapons/w_gun.mdl': gun.mdl, 'models/weapons/w_gun.vvd': gun.vvd, 'models/weapons/w_gun.dx90.vtx': gun.vtx,
    'materials/models/test/decal.vmt': vmt('models/test/decal'), 'materials/models/test/decal.vtf': vtf(8, 3),
    'models/weapons/w_hostile.mdl': hostile.mdl, 'models/weapons/w_hostile.vvd': hostile.vvd, 'models/weapons/w_hostile.dx90.vtx': hostile.vtx,
  }),
  '20': buildGma({ 'materials/models/test/wall.vmt': vmt('models/test/wall'), 'materials/models/test/wall.vtf': vtf(8, 1), 'lua/a.lua': 'x' }),
  '30': buildGma({ 'sound/x.wav': 'x' }),
  '40': buildGma({
    'models/props/crate.mdl': crate.mdl, 'models/props/crate.vvd': crate.vvd, 'models/props/crate.dx90.vtx': crate.vtx,
    'models/props/broken.mdl': Buffer.alloc(400), 'models/props/broken.vvd': Buffer.alloc(100), 'models/props/broken.dx90.vtx': Buffer.alloc(100),
  }),
})
const steamOf = () => fakeSteam({ '1': items('10', '20', '30', '40') }, { '10': { title: 'Gun', time_updated: 1 }, '20': { title: 'Materials', time_updated: 1 }, '30': { title: 'Sounds', time_updated: 1 }, '40': { title: 'Props', time_updated: 1 } })

let fake: ReturnType<typeof fakeAddons>, root: string, steam: ReturnType<typeof steamOf>
beforeEach(async () => {
  for (const t of ['workshop_addons', 'workshop_files', 'workshop_dirs', 'workshop_models', 'workshop_meta']) db.run(`DELETE FROM ${t}`)
  process.env.WORKSHOP_COLLECTION = '1'
  root = mkdtempSync(join(tmpdir(), 'ws-content-'))
  fake = fakeAddons(addons())
  steam = steamOf()
  C.setWorkshopKick(null)
})
afterEach(() => { delete process.env.WORKSHOP_COLLECTION; fake.done(); rmSync(root, { recursive: true, force: true }) })

const index = () => Q.runWorkshopQueue({ fetcher: fake.fetcher, http: steam.post, collection: '1', delayMs: 0 })
const build = (path: string, over: Record<string, unknown> = {}) => { C.queueModelBuild(path); return C.buildModel(path, { fetcher: fake.fetcher, root, ...over }) }
const glbOf = async (path: string) => new NodeIO().readBinary(await C.workshopModelGlb(path, root))
const row = (path: string) => W.modelStatus(path)

describe('building a model from its addon', () => {
  test('the model is found in the index, its addon fetched again, the files and the materials of another addon copied into the cache, the GLB written', async () => {
    await index()
    fake.log.length = 0
    const report = await build('models/weapons/w_gun.mdl')
    expect(row('models/weapons/w_gun.mdl')).toMatchObject({ status: 'built', error: null })
    // the addon that holds the model first, then the addon that holds the wall material; nothing else
    expect(fake.log.map(l => l.id)).toEqual(['10', '20'])
    expect(report).toMatchObject({ addons: 2, triangles: 3, missing: 1 })
    expect(fake.jobsLeft()).toBe(0)
    const doc = await glbOf('models/weapons/w_gun.mdl')
    const prims = doc.getRoot().listMeshes().flatMap((m: any) => m.listPrimitives())
    expect(prims).toHaveLength(3)
    expect(doc.getRoot().listTextures()).toHaveLength(2) // wall (addon 20) and decal (addon 10); ghost has none
    expect(doc.getRoot().listMaterials().some((m: any) => m.getBaseColorTexture() === null)).toBe(true) // the ghost: a plain colour
    // only what the model needs is in the cache: its three files and the materials it names, never the lua or the sounds
    const cached = (d: string) => readdirSync(join(root, d))
    expect(cached('models').sort()).toEqual([...new Set(cached('models').map(f => f))].sort())
    expect(cached('models')).toHaveLength(3)
    expect(cached('textures')).toHaveLength(4) // two materials, two textures
  })

  test('a material found nowhere falls back to a plain colour (RFC 36); the game\'s own material fills it when the stock has it', async () => {
    await index()
    const stock = async (paths: string[]) => ({ files: new Map(paths.filter(p => p === 'materials/models/test/ghost.vmt' || p === 'materials/models/test/ghost.vtf').map(p => [p, p.endsWith('vmt') ? Buffer.from(vmt('models/test/ghost')) : vtf(8, 9)] as [string, Uint8Array])) })
    const report = await build('models/weapons/w_gun.mdl', { stock })
    expect(report).toMatchObject({ missing: 0, fromStock: 1 })
    expect((await glbOf('models/weapons/w_gun.mdl')).getRoot().listTextures()).toHaveLength(3)
  })

  test('the model is not in the index yet: unknown, not a failure; after the index has it, the next run builds it', async () => {
    C.queueModelBuild('models/props/crate.mdl')
    const deps = { fetcher: fake.fetcher, http: steam.post, collection: '1', delayMs: 0, build: (p: string) => C.buildModel(p, { fetcher: fake.fetcher, root }).then(() => {}) }
    await Q.runWorkshopQueue({ ...deps, build: async (p: string) => { await C.buildModel(p, { fetcher: fake.fetcher, root }) } }, { sync: true })
    // one run: the model is asked for first (unknown), the addons are indexed, the models it did not know get one more look
    expect(row('models/props/crate.mdl')?.status).toBe('built')
  })

  test('a model that no addon holds stays unknown, and is looked at again at the next run', async () => {
    await index()
    expect(C.queueModelBuild('models/none/nothing.mdl')).toBe(true)
    await build('models/none/nothing.mdl')
    expect(row('models/none/nothing.mdl')).toMatchObject({ status: 'unknown' })
    W.resumeModels()
    expect(row('models/none/nothing.mdl')?.status).toBe('queued')
  })

  test('a build failure is local: a model that cannot be read fails, the next one builds', async () => {
    await index()
    C.queueModelBuild('models/props/broken.mdl'); C.queueModelBuild('models/props/crate.mdl')
    await Q.runWorkshopQueue({ fetcher: fake.fetcher, http: steam.post, collection: '1', delayMs: 0, build: async (p: string) => { await C.buildModel(p, { fetcher: fake.fetcher, root }) } }, { sync: false })
    expect(row('models/props/broken.mdl')).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not be read/) })
    expect(row('models/props/crate.mdl')?.status).toBe('built')
    expect(await C.workshopModelGlb('models/props/broken.mdl', root)).toBeNull()
    expect(fake.jobsLeft()).toBe(0)
  })

  test('a member over the size limit is refused, with the reason, and the download is deleted', async () => {
    await index()
    await build('models/weapons/w_gun.mdl', { maxMemberBytes: 100 })
    expect(row('models/weapons/w_gun.mdl')).toMatchObject({ status: 'failed', error: expect.stringMatching(/larger than the limit/) })
    expect(fake.jobsLeft()).toBe(0)
    expect(await C.workshopModelGlb('models/weapons/w_gun.mdl', root)).toBeNull()
  })

  test('a download that fails fails the build of that model only', async () => {
    await index()
    const broken = fakeAddons({})
    await build('models/props/crate.mdl', { fetcher: broken.fetcher })
    expect(row('models/props/crate.mdl')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Addon 40/) })
    broken.done()
  })

  test('a model that names a material by a path with ".." is not looked for anywhere and writes nothing outside the cache', async () => {
    await index()
    const report = await build('models/weapons/w_hostile.mdl')
    expect(row('models/weapons/w_hostile.mdl')?.status).toBe('built')
    expect(report).toMatchObject({ addons: 2 }) // the addon of the model and the one of the wall; the hostile name asked for nothing
    expect(readdirSync(root).sort()).toEqual(['glb', 'models', 'textures'])
    expect(readdirSync(join(root, 'textures'))).toHaveLength(2) // the wall: vmt and vtf
    expect(readdirSync(join(root, '..')).includes('passwd')).toBe(false)
  })

  test('an archive that lists a name with ".." holds nothing reachable under it', async () => {
    const evil = buildGma({ 'models/props/e.mdl': crate.mdl, 'models/props/e.vvd': crate.vvd, 'models/props/e.dx90.vtx': crate.vtx, 'materials/models/test/../../../x.vmt': 'x' })
    fake.done(); fake = fakeAddons({ ...addons(), '50': evil })
    steam = fakeSteam({ '1': items('10', '20', '30', '40', '50') })
    await index()
    expect(db.prepare("SELECT COUNT(*) AS n FROM workshop_files WHERE path LIKE '%..%'").get().n).toBe(0)
    expect(W.cleanPath('materials/../x.vmt')).toBeNull()
    expect(W.cleanPath('/etc/passwd')).toBeNull()
    expect(W.cleanPath('a\\..\\b')).toBeNull()
    expect(W.cleanPath('Models\\Props\\A.MDL')).toBe('models/props/a.mdl')
  })
})

describe('the source of the pipeline', () => {
  test('a model built into the cache is served to the pipeline with its materials; one that is not built is unavailable, and queued', async () => {
    await index()
    const wc = C.workshopContent(root)
    expect((await wc.models(['models/props/crate.mdl'])).models.size).toBe(0)
    expect(row('models/props/crate.mdl')?.status).toBe('queued') // the map-mesh trigger
    await build('models/props/crate.mdl')
    const got = await wc.models(['models/props/crate.mdl', 'models/props/other.mdl'])
    expect([...got.models.keys()]).toEqual(['models/props/crate.mdl'])
    expect(Buffer.from(got.models.get('models/props/crate.mdl')!.mdl).equals(crate.mdl)).toBe(true)
    const tex = await wc.textures(['materials/models/test/wall.vmt', 'materials/models/test/wall.vtf', 'materials/models/test/none.vtf', 'materials/../../etc/passwd.vtf'])
    expect([...tex.files.keys()].sort()).toEqual(['materials/models/test/wall.vmt', 'materials/models/test/wall.vtf'])
  })

  test('the sources are asked in order: the game before the workshop, and the workshop only for what the game lacks', async () => {
    const asked: string[][] = []
    const game: StockModels = async names => { asked.push(['game', ...names]); return { models: new Map(names.filter(n => n === 'models/a.mdl').map(n => [n, { mdl: Buffer.from('G'), vvd: Buffer.from('G'), vtx: Buffer.from('G') }])) } }
    const ws: StockModels = async names => { asked.push(['workshop', ...names]); return { models: new Map(names.map(n => [n, { mdl: Buffer.from('W'), vvd: Buffer.from('W'), vtx: Buffer.from('W') }])) } }
    const got = await C.chainModels(game, ws)(['models/a.mdl', 'models/b.mdl'])
    expect(Buffer.from(got.models.get('models/a.mdl')!.mdl).toString()).toBe('G') // an addon cannot replace a stock model
    expect(Buffer.from(got.models.get('models/b.mdl')!.mdl).toString()).toBe('W')
    expect(asked).toEqual([['game', 'models/a.mdl', 'models/b.mdl'], ['workshop', 'models/b.mdl']])
    const none = await C.chainModels(null, undefined, game)(['models/a.mdl'])
    expect(none.models.size).toBe(1)
  })

  test('in a map\'s props: the pack first, then the game, then the workshop', async () => {
    const tri = (n: number) => modelFiles({ meshes: [{ vertices: [A, B, C_], tris: Array.from({ length: n * 3 }, (_, i) => i % 3) }] })
    const [fromPack, fromGame, fromWorkshop, onlyGame, onlyWorkshop] = [tri(1), tri(2), tri(3), tri(4), tri(5)]
    const pack = { 'models/t/x.mdl': fromPack.mdl, 'models/t/x.vvd': fromPack.vvd, 'models/t/x.dx90.vtx': fromPack.vtx }
    const names = ['models/t/x.mdl', 'models/t/g.mdl', 'models/t/w.mdl', 'models/t/none.mdl']
    const src = memorySource(buildBsp({ ...flatQuad(0), pak: buildZip(pack), staticProps: { models: names, props: names.map((_, i) => ({ model: i, x: 100 + i * 50, y: 100, z: 0, yaw: 0 })) } }))
    const header = await readHeader(src)
    const as = (m: typeof fromGame) => ({ mdl: m.mdl, vvd: m.vvd, vtx: m.vtx })
    const game: StockModels = async ns => ({ models: new Map(ns.filter(n => n === 'models/t/x.mdl' || n === 'models/t/g.mdl').map(n => [n, as(n.endsWith('x.mdl') ? fromGame : onlyGame)])) })
    const ws: StockModels = async ns => ({ models: new Map(ns.filter(n => n !== 'models/t/none.mdl').map(n => [n, as(n.endsWith('x.mdl') ? fromWorkshop : n.endsWith('g.mdl') ? fromWorkshop : onlyWorkshop)])) })
    const { set, report } = await buildPropSet(src, header, [], { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, undefined, C.chainModels(game, ws))
    expect(report).toMatchObject({ drawnModels: 3, unavailable: 1, fromGame: 2 })
    // told apart by the triangles each model brings: x is the pack's (1), g the game's (4), w the workshop's (5)
    const triangles = (name: string) => (set.models.find(m => m.name === name)!.solid.length) / 9
    expect(['models/t/x.mdl', 'models/t/g.mdl', 'models/t/w.mdl'].map(triangles)).toEqual([1, 4, 5])
  })
})

describe('the triggers', () => {
  test('a model path is queued once; the same path in another spelling is the same model; nothing that is not a model path', async () => {
    await index()
    expect(C.queueModelBuild('models/weapons/w_gun.mdl')).toBe(true)
    expect(C.queueModelBuild('Models\\Weapons\\W_GUN.mdl')).toBe(false)
    expect(C.queueModelBuild('./models/weapons/w_gun.mdl')).toBe(false)
    for (const bad of ['', 'models/../x.mdl', 'materials/a.vmt', '/models/a.mdl', 'models/a.mdl; rm', 'models/a.txt']) expect(C.queueModelBuild(bad)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM workshop_models').get().n).toBe(1)
  })

  test('a track\'s weapon models: the list is deduplicated (the call RFC 39 makes)', async () => {
    await index()
    expect(C.queueTrackModels(['models/weapons/w_gun.mdl', 'models/weapons/w_gun.mdl', 'models/props/crate.mdl', 'x'])).toBe(2)
    expect(C.queueTrackModels(['models/props/crate.mdl'])).toBe(0)
  })

  test('a map\'s unavailable props: queued when the index holds them (or may yet), not when the index is complete and lacks them', async () => {
    const wc = C.workshopContent(root)
    W.upsertAddons([{ id: '10', title: null, updated: 0, order: 0 }], 'collection') // pending: the index may still learn
    await wc.models(['models/maybe/later.mdl'])
    expect(row('models/maybe/later.mdl')?.status).toBe('queued')
    db.run('DELETE FROM workshop_models'); db.run('DELETE FROM workshop_addons')
    fake.done(); fake = fakeAddons(addons())
    await index()
    await wc.models(['models/props/crate.mdl', 'models/not/anywhere.mdl'])
    expect(row('models/props/crate.mdl')?.status).toBe('queued')
    expect(row('models/not/anywhere.mdl')).toBeNull()
  })

  test('the queue is started when a model is queued', async () => {
    await index()
    let kicks = 0
    C.setWorkshopKick(() => { kicks++ })
    C.queueModelBuild('models/props/crate.mdl')
    C.queueModelBuild('models/props/crate.mdl')
    expect(kicks).toBe(1)
  })

  test('with the feature off nothing queues, and the source is only an empty cache', async () => {
    await index()
    delete process.env.WORKSHOP_COLLECTION
    let kicks = 0
    C.setWorkshopKick(() => { kicks++ })
    expect(C.queueModelBuild('models/props/crate.mdl')).toBe(false)
    expect(C.queueTrackModels(['models/props/crate.mdl'])).toBe(0)
    await C.workshopContent(root).models(['models/props/crate.mdl'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM workshop_models').get().n).toBe(0)
    expect(kicks).toBe(0)
    for (const bad of ['', 'abc', '12 3']) { process.env.WORKSHOP_COLLECTION = bad; expect(C.queueModelBuild('models/props/crate.mdl')).toBe(false) }
  })

  test('a models-only run builds what was asked for and does not index', async () => {
    W.upsertAddons([{ id: '10', title: null, updated: 0, order: 0 }], 'collection')
    C.queueModelBuild('models/props/crate.mdl')
    const built: string[] = []
    await Q.runWorkshopQueue({ fetcher: fake.fetcher, delayMs: 0, build: async (p: string) => { built.push(p); W.setModel(p, 'built') } }, { sync: false, modelsOnly: true })
    expect(built).toEqual(['models/props/crate.mdl'])
    expect(fake.log).toHaveLength(0)
    expect(existsSync(root)).toBe(true)
  })
})
