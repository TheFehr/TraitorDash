import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { buildAnimationSet, buildRigged, eulerPointer, quat48 } from './helpers/rig_builder'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'

// RFC 22, 4.1: the posed player model of the replay: served to signed-in visitors when the game's files are switched on, built
// once, a failure not remembered, and the replay's payload says where to load it from.
// All test files share one process, so what is set in the environment is taken away again.
afterAll(() => { for (const k of ['OPEN_SIGNIN', 'MAP_GEOMETRY', 'GAME_CONTENT', 'PLAYER_MODEL']) delete process.env[k] })

let app: any, Store: any, pm: any, replay: any
const USER = '76561198000000042'
let serverId: string

const T = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -z]
const model = () => buildRigged({
  bones: [{ name: 'ValveBiped.Bip01_Pelvis', parent: -1, poseToBone: T(0) }, { name: 'ValveBiped.Bip01_Spine', parent: 0, pos: [0, 0, 10], poseToBone: T(10) }],
  vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2],
  weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 1 }], [{ bone: 1, weight: 1 }]],
})
const spine = { bone: 1, flags: 0x02, data: quat48(0, 0, Math.SQRT1_2) }
const loop = (name: string, move?: [number, number, number]) => ({ name, animations: [{ numFrames: 3, ...(move ? { move } : {}), entries: [spine] }] })
// a walking sequence of the real set: nine animations, the eight directions (as the engine lists them) and the standing one in the middle
const grid = (name: string, speed: number) => ({ name, animations: [[-1, 1], [-1, 0], [-1, -1], [0, 1], null, [0, -1], [1, 1], [1, 0], [1, -1]].map(d => ({ numFrames: 3, ...(d ? { move: [d[0]! * speed, d[1]! * speed, 0] as [number, number, number] } : {}), entries: [spine] })) })
const animations = buildAnimationSet([{ name: 'Bip01_Pelvis', parent: -1 }, { name: 'Bip01_Spine', parent: 0, pos: [0, 0, 10] }], [
  { name: 'idle_all_01', entries: [spine] },
  { name: 'cidle_all', entries: [{ bone: 1, flags: 0x08, data: eulerPointer([null, null, [1571]]) }] },
  grid('walk_all', 60), grid('run_all_01', 100), grid('cwalk_all', 50),
])

/** A stand-in for the game's files: asked for what it is told to have; counts the questions. */
function content(have: { model: boolean, anim: boolean } = { model: true, anim: true }) {
  const calls = { models: [] as string[][], animations: [] as string[] }
  return {
    calls,
    source: {
      models: async (names: string[]) => { calls.models.push(names); return have.model ? { models: new Map(names.map(n => [n, model()])) } : { models: new Map(), error: 'the download failed' } },
      animations: async (name: string) => { calls.animations.push(name); return have.anim ? { files: animations } : { files: null, error: 'the download failed' } },
    },
  }
}

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  pm = await import('../src/services/playermodel')
  replay = await import('../src/services/replay')
})
beforeEach(() => {
  serverId = (Store.addServer('Models') as any).id
  process.env.MAP_GEOMETRY = '1'; process.env.GAME_CONTENT = '1'; delete process.env.PLAYER_MODEL
  pm.setPlayerModelContent(null)
})

const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = USER) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))
const url = (q = '') => `/servers/${serverId}/playermodel.glb${q}`

describe('the route', () => {
  test('serves the moving model (a skin and its clips) as a binary glTF to a signed-in visitor, cached privately', async () => {
    pm.setPlayerModelContent(content().source)
    const r = await get(url())
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('model/gltf-binary')
    expect(r.headers.get('cache-control')).toContain('private')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe('glTF')
    const json = (b: Uint8Array) => JSON.parse(Buffer.from(b.subarray(20, 20 + new DataView(b.buffer, b.byteOffset).getUint32(12, true))).toString())
    expect(json(bytes).animations.map((a: any) => a.name)).toEqual(['idle', 'cidle', ...['walk', 'run', 'cwalk'].flatMap(g => ['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'].map(d => `${g}_${d}`))])
    expect(json(bytes).skins).toHaveLength(1)
    // ?pose= is one pose of it, still: no skin and no clips
    const still = new Uint8Array(await (await get(url('?pose=stand'))).arrayBuffer())
    expect(json(still).animations).toBeUndefined()
    expect(json(still).skins).toBeUndefined()
  })

  test('an anonymous visitor is asked to sign in, an unknown server, pose or a switched-off setting is a 404', async () => {
    pm.setPlayerModelContent(content().source)
    expect((await get(url(), null)).status).toBe(401)
    expect((await get('/servers/nope/playermodel.glb')).status).toBe(404)
    expect((await get(url('?pose=flying'))).status).toBe(404)
    expect((await get(url('?pose=crouch'))).status).toBe(200) // one pose of it, still
    process.env.GAME_CONTENT = '0'
    expect((await get(url())).status).toBe(404)
    process.env.GAME_CONTENT = '1'; process.env.MAP_GEOMETRY = '0'
    expect((await get(url())).status).toBe(404)
  })

  test('is built once for each pose and kept', async () => {
    const c = content()
    pm.setPlayerModelContent(c.source)
    await get(url()); await get(url()); await get(url('?pose=moving'))
    expect(c.calls.models).toHaveLength(1)
    expect(c.calls.animations).toEqual(['models/m_anm.mdl'])
    await get(url('?pose=stand'))
    await get(url('?pose=stand'))
    expect(c.calls.models).toHaveLength(2)
    await get(url('?pose=crouch'))
    expect(c.calls.models).toHaveLength(3)
  })

  test('a failure is a 404 and is not remembered', async () => {
    const down = content({ model: false, anim: true })
    pm.setPlayerModelContent(down.source)
    expect((await get(url())).status).toBe(404)
    expect((await get(url())).status).toBe(404)
    expect(down.calls.models).toHaveLength(2) // asked again
    const noAnim = content({ model: true, anim: false })
    pm.setPlayerModelContent(noAnim.source)
    expect((await get(url())).status).toBe(404)
    pm.setPlayerModelContent(content().source)
    expect((await get(url())).status).toBe(200)
  })

  test('the model is the setting PLAYER_MODEL when it is a model path, else the default', async () => {
    const c = content()
    pm.setPlayerModelContent(c.source)
    process.env.PLAYER_MODEL = 'models/player/arctic.mdl'
    await get(url())
    expect(c.calls.models[0]).toEqual(['models/player/arctic.mdl'])
    process.env.PLAYER_MODEL = '../../etc/passwd'
    expect(pm.playerModelName()).toBe(pm.DEFAULT_PLAYER_MODEL)
    delete process.env.PLAYER_MODEL
    expect(pm.playerModelName()).toBe('models/player/phoenix.mdl')
  })

  test('a model that cannot be read at all (the wrong kind of file) is a 404', async () => {
    pm.setPlayerModelContent({
      models: async (names: string[]) => ({ models: new Map(names.map(n => [n, { mdl: Buffer.alloc(300), vvd: Buffer.alloc(300), vtx: Buffer.alloc(300) }])) }),
      animations: async () => ({ files: animations }),
    })
    expect((await get(url())).status).toBe(404)
  })
})

describe('the replay payload', () => {
  const round = () => {
    const id = `round-${Math.random().toString(36).slice(2, 8)}`
    Store.recordRound(serverId, { roundId: id, map: 'ttt_a', startedAt: null, duration: 100, result: 'traitors', players: [{ steamId: USER, nick: 'N', role: 'traitor', team: 'traitors', survived: true, won: true }], deaths: [] })
    const track = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0, 200], players: [{ id: USER, segments: [{ from: 0, x: [1, 1], y: [1, 1], z: [0, 0], a: [0, 0] }] }], deaths: [] }
    Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 2 })
    Store.recordTrack(serverId, track, JSON.stringify(track))
    return id
  }

  test('the ETag follows the address of the model, so a browser that has the payload of an older build asks again', () => {
    const id = round()
    const first = replay.buildReplay(serverId, id)
    expect(first.etag).toBe(replay.buildReplay(serverId, id).etag)
    const was = process.env.GAME_CONTENT
    process.env.GAME_CONTENT = '0'
    expect(replay.buildReplay(serverId, id).etag).not.toBe(first.etag)
    process.env.GAME_CONTENT = was
  })

  test('names where the model is when the game\'s files are on, and not otherwise', () => {
    const id = round()
    const on = replay.buildReplay(serverId, id)
    expect(on.payload.playerModel).toMatch(new RegExp(`^/servers/${serverId}/playermodel\\.glb\\?v=[0-9a-f]+$`))
    process.env.GAME_CONTENT = '0'
    const off = replay.buildReplay(serverId, id)
    expect(off.payload.playerModel).toBeUndefined()
    expect(off.etag).not.toBe(on.etag) // a browser's copy of the payload is not kept across the switch
  })

  test('the storeys a player can get to are named for the bar, with the map\'s mesh, and change the ETag (RFC 21, 12)', async () => {
    const { surfacesToGlb } = await import('../src/maps/meshGlb')
    const FP = 'ef'.repeat(32)
    const floor = (z: number) => [0, 0, z, 256, 0, z, 256, 256, z, 0, 0, z, 256, 256, z, 0, 256, z]
    const { glb } = (await surfacesToGlb({ floors: [...floor(0), ...floor(-1500)], walls: [], fingerprint: FP, version: 20, revision: 1 }, { map: 'ttt_a' }))!
    Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
      maps: [{ name: 'ttt_a', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
    Store.setGeometryRequested(serverId, 'ttt_a', true, null)
    Store.startGeometry('ttt_a', FP)
    Store.finishGeometry('ttt_a', FP, { mesh: glb, info: { vertices: 8, triangles: 4, levels: 2 } })
    const id = round()
    const all = replay.buildReplay(serverId, id)
    expect(all.payload.background.listed).toBeUndefined() // not known: the bar offers every storey
    expect(all.payload.background.levels).toHaveLength(2)
    const some = replay.buildReplay(serverId, id, undefined, [2])
    expect(some.payload.background.listed).toEqual([2])
    expect(some.payload.background.levels).toHaveLength(2) // the heights of all storeys stay: a player's level is told from them
    expect(some.etag).not.toBe(all.etag)
  })
})
