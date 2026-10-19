import { expect, test, describe } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import validator from 'gltf-validator'
import { surfacesToGlb, cropTriangles, planBounds, spawnBounds, expandBounds, removeSkybox } from '../src/services/meshGlb'

// RFC 11, 3.6: the exact geometry as glTF 2.0 (GLB): one node per level, floors and walls as two
// primitives, the playable area only. The Khronos reference validator is the test oracle.

const FP = 'ab'.repeat(32)
const base = { fingerprint: FP, version: 20, revision: 904 }

/** Two triangles covering a square on the plane z = `z`. */
const floor = (z: number, x0 = 0, y0 = 0, size = 64) => [
  x0, y0, z, x0 + size, y0, z, x0 + size, y0 + size, z,
  x0, y0, z, x0 + size, y0 + size, z, x0, y0 + size, z,
]
/** Two triangles covering an upright square from height z0 to z1 along x. */
const wall = (z0: number, z1: number, x0 = 0, y = 0, width = 64) => [
  x0, y, z0, x0 + width, y, z0, x0 + width, y, z1,
  x0, y, z0, x0 + width, y, z1, x0, y, z1,
]

const make = (floors: number[], walls: number[] = [], opts: Parameters<typeof surfacesToGlb>[1] = { map: 'ttt_test' }) =>
  surfacesToGlb({ ...base, floors, walls }, opts)
const ok = async (floors: number[], walls: number[] = [], opts?: Parameters<typeof surfacesToGlb>[1]) => (await make(floors, walls, opts))!
const read = (glb: Uint8Array) => new NodeIO().readBinary(glb)
const levelNodes = async (glb: Uint8Array) => (await read(glb)).getRoot().listScenes()[0]!.listChildren()[0]!.listChildren()

// Two storeys, each a big floor, with a wall on each.
const twoStoreys = () => ({
  floors: [...floor(0, 0, 0, 2000), ...floor(272, 0, 0, 2000)],
  walls: [...wall(0, 100, 0, 0, 500), ...wall(272, 372, 0, 0, 500)],
})

describe('surfacesToGlb: the file', () => {
  test('is valid glTF by the Khronos reference validator: no errors, no warnings', async () => {
    const { floors, walls } = twoStoreys()
    const r = await ok(floors, walls)
    const report = await validator.validateBytes(r.glb)
    expect(report.issues.numErrors).toBe(0)
    expect(report.issues.numWarnings).toBe(0)
    expect(report.info.version).toBe('2.0')
    expect(report.info.totalTriangleCount).toBe(r.info.triangles)
    expect(report.info.totalVertexCount).toBe(r.info.vertices)
  })

  test('is a binary glTF (GLB), and says in its extras what made it', async () => {
    const r = await ok(floor(0))
    expect(Buffer.from(r.glb.subarray(0, 4)).toString('latin1')).toBe('glTF')
    expect((await read(r.glb)).getRoot().getExtras().generator).toMatch(/TraitorDash/) // the library writes its own name into asset.generator
  })

  test('one scene with one root node that turns Source\'s Z-up into glTF\'s Y-up', async () => {
    const doc = await read((await ok(floor(0))).glb)
    const scenes = doc.getRoot().listScenes()
    expect(scenes).toHaveLength(1)
    const root = scenes[0]!.listChildren()
    expect(root).toHaveLength(1)
    expect(root[0]!.getName()).toBe('z-up')
    const q = root[0]!.getRotation()
    expect(q[0]).toBeCloseTo(-Math.SQRT1_2, 6); expect(q[1]).toBeCloseTo(0, 6); expect(q[2]).toBeCloseTo(0, 6); expect(q[3]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(root[0]!.getScale()).toEqual([1, 1, 1]) // units are kept as they are
  })

  test('records the map, its fingerprint and version, and the units, in extras', async () => {
    const doc = await read((await ok(floor(0), [], { map: 'ttt_a' })).glb)
    expect(doc.getRoot().getExtras()).toMatchObject({ map: 'ttt_a', fingerprint: FP, mapVersion: 20, mapRevision: 904 })
    expect(String(doc.getRoot().getExtras().units)).toMatch(/Source units/)
  })

  test('the same input gives the same bytes', async () => {
    const { floors, walls } = twoStoreys()
    const a = (await ok(floors, walls)).glb, b = (await ok(floors, walls)).glb
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  test('a small mesh has 16-bit indices, a big one 32-bit, and both are valid', async () => {
    const small = await read((await ok(floor(0))).glb)
    expect(small.getRoot().listAccessors().find(a => a.getType() === 'SCALAR')!.getArray()).toBeInstanceOf(Uint16Array)
    const soup: number[] = []
    for (let i = 0; i < 25_000; i++) soup.push(i * 10, 0, 0, i * 10 + 5, 0, 0, i * 10, 5, 0) // 75 000 vertices, none shared
    const big = await ok(soup)
    expect((await read(big.glb)).getRoot().listAccessors().find(a => a.getType() === 'SCALAR')!.getArray()).toBeInstanceOf(Uint32Array)
    const report = await validator.validateBytes(big.glb)
    expect(report.issues.numErrors + report.issues.numWarnings).toBe(0)
  })

  test('a real-sized map stays small (20 000 triangles under 400 KB)', async () => {
    const soup: number[] = []
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) soup.push(...floor(0, i * 64, j * 64, 64)) // a 100 x 100 grid of squares, vertices shared
    const r = await ok(soup)
    expect(r.info.triangles).toBe(20_000)
    expect(r.glb.length).toBeLessThan(400_000)
  })

  test('refuses input that is not triangles of three numbers each', async () => {
    await expect(make([1, 2, 3, 4])).rejects.toThrow(/triangles/)
    await expect(make([...floor(0), NaN])).rejects.toThrow()
    await expect(make(floor(0).map((v, i) => (i === 3 ? Infinity : v)))).rejects.toThrow(/finite/)
  })
})

describe('surfacesToGlb: the contents', () => {
  test('positions are the map\'s whole units, exactly', async () => {
    const soup = [...floor(48, -801, 1569, 64), ...wall(48, 144, -801, 1569, 64)]
    const doc = await read((await ok(floor(48, -801, 1569, 64), wall(48, 144, -801, 1569, 64))).glb)
    const seen = new Set<string>()
    for (const acc of doc.getRoot().listAccessors().filter(a => a.getType() === 'VEC3')) {
      const arr = acc.getArray() as Float32Array
      for (let i = 0; i < arr.length; i += 3) seen.add(`${arr[i]},${arr[i + 1]},${arr[i + 2]}`)
    }
    const expected = new Set<string>()
    for (let i = 0; i < soup.length; i += 3) expected.add(`${soup[i]},${soup[i + 1]},${soup[i + 2]}`)
    expect(seen).toEqual(expected)
  })

  test('shares vertices inside a primitive: a square is four vertices, not six', async () => {
    const r = await ok(floor(0))
    expect(r.info.vertices).toBe(4)
    expect(r.info.triangles).toBe(2)
  })

  test('one node per level, lowest first, each with the heights of its floors', async () => {
    const { floors, walls } = twoStoreys()
    const r = await ok(floors, walls)
    expect(r.info.levels.map(l => [l.index, l.lo, l.hi])).toEqual([[1, 0, 0], [2, 272, 272]])
    const nodes = await levelNodes(r.glb)
    expect(nodes.map(n => n.getName())).toEqual(['level-1', 'level-2'])
    expect(nodes[1]!.getExtras()).toMatchObject({ level: 2, lo: 272, hi: 272, floorTriangles: 2, wallTriangles: 2 })
  })

  test('floors and walls are two primitives with two materials', async () => {
    const { floors, walls } = twoStoreys()
    const nodes = await levelNodes((await ok(floors, walls)).glb)
    const prims = nodes[0]!.getMesh()!.listPrimitives()
    expect(prims.map(p => p.getMaterial()!.getName()).sort()).toEqual(['floor', 'wall'])
  })

  test('a ramp spans the heights of its corners: the level is from its lowest corner to its highest', async () => {
    const ramp = [0, 0, 0, 500, 0, 100, 500, 500, 100, 0, 0, 0, 500, 500, 100, 0, 500, 0] // two triangles rising from 0 to 100
    const r = await ok([...floor(272, 0, 0, 2000), ...ramp, ...floor(0, 0, 0, 2000)])
    expect(r.info.levels.map(l => [l.lo, l.hi])).toEqual([[0, 100], [272, 272]])
  })

  test('the materials are double sided: the file does not say which way a triangle faces', async () => {
    const { floors, walls } = twoStoreys()
    const nodes = await levelNodes((await ok(floors, walls)).glb)
    for (const p of nodes[0]!.getMesh()!.listPrimitives()) expect(p.getMaterial()!.getDoubleSided()).toBe(true)
  })

  test('a wall belongs to the level its height is nearest to', async () => {
    const floors = [...floor(0, 0, 0, 2000), ...floor(272, 0, 0, 2000)]
    const r = await ok(floors, [...wall(40, 100), ...wall(250, 300)]) // centres at 70 and 275
    expect(r.info.levels.map(l => [l.index, l.wallTriangles])).toEqual([[1, 2], [2, 2]])
  })

  test('a level with no walls has only the floor primitive', async () => {
    const { floors } = twoStoreys()
    const nodes = await levelNodes((await ok(floors, wall(0, 100))).glb)
    expect(nodes[1]!.getMesh()!.listPrimitives()).toHaveLength(1)
    expect(nodes[1]!.getMesh()!.listPrimitives()[0]!.getMaterial()!.getName()).toBe('floor')
  })

  test('many slivers at an odd height are not a level; they join the nearest one (levels are weighted by the ground they cover)', async () => {
    const slivers: number[] = []
    for (let i = 0; i < 60; i++) slivers.push(i * 100, 0, 700, i * 100 + 1, 0, 700, i * 100, 1, 700) // 60 triangles of half a unit square
    const { floors } = twoStoreys()
    const r = await ok([...floors, ...slivers])
    expect(r.info.levels).toHaveLength(2)
    expect(r.info.levels[1]!.hi).toBe(700)
  })

  test('a single storey is one node', async () => {
    const r = await ok([...floor(0, 0, 0, 500), ...floor(40, 600, 0, 500)])
    expect(r.info.levels).toHaveLength(1)
    expect((await levelNodes(r.glb))).toHaveLength(1)
  })

  test('a map with walls and no floors is one level of walls', async () => {
    const r = await ok([], wall(0, 100))
    expect(r.info.levels).toHaveLength(1)
    expect(r.info.levels[0]).toMatchObject({ floorTriangles: 0, wallTriangles: 2 })
    const report = await validator.validateBytes(r.glb)
    expect(report.issues.numErrors + report.issues.numWarnings).toBe(0)
  })

  test('triangles that collapsed to a line or a point in whole units are dropped and counted', async () => {
    const dead = [5, 5, 5, 5, 5, 5, 5, 5, 5, /* a point */ 0, 0, 0, 10, 0, 0, 20, 0, 0 /* a line */, 1, 1, 1, 1, 1, 1, 9, 9, 9 /* two equal corners */]
    const r = await ok([...floor(0), ...dead])
    expect(r.info.droppedDegenerate).toBe(3)
    expect(r.info.triangles).toBe(2)
    const report = await validator.validateBytes(r.glb)
    expect(report.issues.messages.filter((m: { code: string }) => m.code === 'ACCESSOR_INDEX_TRIANGLE_DEGENERATE')).toEqual([])
  })

  test('degenerate wall triangles are dropped and counted too', async () => {
    const r = await ok(floor(0), [...wall(0, 100), 7, 7, 7, 7, 7, 7, 7, 7, 7])
    expect(r.info.droppedDegenerate).toBe(1)
    expect(r.info.levels[0]!.wallTriangles).toBe(2)
  })

  test('nothing to draw is null, not an empty file', async () => {
    expect(await make([], [])).toBeNull()
    expect(await make([5, 5, 5, 5, 5, 5, 5, 5, 5])).toBeNull() // only a degenerate triangle
  })
})

describe('cropping to the playable area', () => {
  const bounds = { minX: 0, maxX: 1000, minY: 0, maxY: 1000 }

  test('keeps a triangle whose centre is inside, drops one whose centre is outside', () => {
    const inside = floor(0, 100, 100, 64), outside = floor(0, 5000, 5000, 64)
    expect(cropTriangles([...inside, ...outside], bounds)).toEqual(inside)
  })

  test('the edge of the bounds is inside', () => {
    const onEdge = [940, 970, 0, 1060, 970, 0, 1000, 1060, 0] // centre exactly (1000, 1000)
    const justOut = [940, 971, 0, 1060, 971, 0, 1000, 1061, 0] // centre (1000, 1001)
    expect(cropTriangles(onEdge, bounds)).toEqual(onEdge)
    expect(cropTriangles(justOut, bounds)).toEqual([])
  })

  test('the centre decides, not a corner: a long triangle with one corner outside is kept if its centre is inside', () => {
    const longTriangle = [-30, 500, 0, 300, 500, 0, 300, 800, 0] // centre (190, 600); the first corner is outside
    expect(cropTriangles(longTriangle, bounds)).toEqual(longTriangle)
    const other = [300, 500, 0, 5000, 500, 0, 5000, 800, 0] // first corner inside, centre far outside
    expect(cropTriangles(other, bounds)).toEqual([])
  })

  test('a huge slab with its centre far away is gone, a room next to the play area stays', () => {
    const skybox = floor(0, 10_000, 10_000, 20_000)
    const room = floor(0, 400, 400, 200)
    expect(cropTriangles([...skybox, ...room], bounds)).toEqual(room)
  })

  test('the GLB is cropped and says how much was taken away', async () => {
    const r = await ok([...floor(0, 100, 100, 64), ...floor(0, 90_000, 0, 64)], wall(0, 100, 50_000, 0), { map: 'm', crop: bounds })
    expect(r.info.triangles).toBe(2)
    expect(r.info.cropped).toEqual({ floors: 2, walls: 2 })
    expect((await read(r.glb)).getRoot().getExtras()).toMatchObject({ cropped: true })
  })

  test('without a crop nothing is removed and extras say so', async () => {
    const r = await ok([...floor(0, 100, 100, 64), ...floor(0, 90_000, 0, 64)])
    expect(r.info.triangles).toBe(4)
    expect(r.info.cropped).toEqual({ floors: 0, walls: 0 })
    expect((await read(r.glb)).getRoot().getExtras()).toMatchObject({ cropped: false })
  })

  test('a crop that removes everything is null', async () => {
    expect(await make(floor(0, 90_000, 0, 64), [], { map: 'm', crop: bounds })).toBeNull()
  })

  test('levels are found after the crop: a storey that is only in the skybox is not a level', async () => {
    const r = await ok([...floor(0, 0, 0, 800), ...floor(5000, 90_000, 90_000, 5000)], [], { map: 'm', crop: bounds })
    expect(r.info.levels).toHaveLength(1)
  })

  test('planBounds: the cells of the trace plan that have a floor, as whole cells', () => {
    const grid = { cell: 64, minx: -128, miny: 64, nx: 4, ny: 3, rows: ['||48|', '|48||', '|||'] }
    // floors at cells (2, 0) and (1, 1): columns 1..2, rows 0..1
    expect(planBounds(grid)).toEqual({ minX: -128 + 1 * 64, maxX: -128 + 3 * 64, minY: 64 + 0 * 64, maxY: 64 + 2 * 64 })
  })

  test('planBounds is null for a plan without floors', () => {
    expect(planBounds({ cell: 64, minx: 0, miny: 0, nx: 2, ny: 1, rows: ['|'] })).toBeNull()
  })

  test('spawnBounds: the box around the spawn points, null without any', () => {
    expect(spawnBounds([{ x: -10, y: 5 }, { x: 30, y: -7 }, { x: 0, y: 0 }])).toEqual({ minX: -10, maxX: 30, minY: -7, maxY: 5 })
    expect(spawnBounds([])).toBeNull()
  })

  test('expandBounds adds a margin on every side', () => {
    expect(expandBounds({ minX: 0, maxX: 10, minY: 0, maxY: 10 }, 256)).toEqual({ minX: -256, maxX: 266, minY: -256, maxY: 266 })
  })
})

describe('removing the 3D skybox', () => {
  // The skybox is a small scaled copy of the surroundings, built far from the map and marked by a sky_camera inside it.
  const main = () => [...floor(0, 0, 0, 800), ...floor(0, 900, 0, 800), ...wall(0, 100, 0, 0, 800)]
  const sky = () => [...floor(0, 50_000, 50_000, 600), ...floor(0, 50_700, 50_000, 600)]
  const camera = { x: 50_300, y: 50_300, z: 100 }
  const spawn = { class: 'info_player_start', x: 400, y: 400, z: 40 }
  const run = (floors: number[], walls: number[], skyCameras: { x: number, y: number, z: number }[], spawns = [spawn]) => removeSkybox({ floors, walls }, { skyCameras, spawns })

  test('removes the piece of geometry that holds the sky camera, and keeps the map', () => {
    const r = run([...main().slice(0, 36), ...sky()], [], [camera])
    expect(r.floors).toEqual(main().slice(0, 36))
    expect(r.removed).toEqual({ floors: 4, walls: 0 })
  })

  test('walls of the skybox go too, floors and walls separately counted', () => {
    const r = run([...floor(0, 0, 0, 800), ...floor(0, 50_000, 50_000, 600)], [...wall(0, 100, 0, 0, 800), ...wall(0, 100, 50_000, 50_000, 600)], [camera])
    expect(r.removed).toEqual({ floors: 2, walls: 2 })
    expect(r.walls).toEqual(wall(0, 100, 0, 0, 800))
  })

  test('without a sky camera nothing is removed (most maps have no 3D skybox)', () => {
    const f = [...main(), ...sky()]
    const r = run(f, [], [])
    expect(r.floors).toEqual(f)
    expect(r.removed).toEqual({ floors: 0, walls: 0 })
  })

  test('if the skybox is connected to the playable area it is left alone: it cannot be told apart', () => {
    const connected = [...floor(0, 0, 0, 800), ...floor(0, 800, 0, 800), ...floor(0, 1600, 0, 800)]
    const r = run(connected, [], [{ x: 2000, y: 400, z: 0 }])
    expect(r.removed).toEqual({ floors: 0, walls: 0 })
  })

  test('the camera is in the empty air of the skybox: it finds the piece next to its cell, but not one farther away', () => {
    const f = [...main(), ...sky()] // the sky floors end at x 51 300
    expect(run(f, [], [{ x: 51_300 + 900, y: 50_300, z: 100 }]).removed.floors).toBe(4) // one cell beyond the geometry
    expect(run(f, [], [{ x: 51_300 + 3000, y: 50_300, z: 100 }]).removed.floors).toBe(0) // three cells beyond: not part of it
    expect(run(f, [], [{ x: 50_300, y: 50_300, z: 100 + 1500 }]).removed.floors).toBe(4) // above it, also next to it
  })

  test('a sky camera that is not near any geometry removes nothing', () => {
    expect(run(main(), [], [{ x: -99_999, y: -99_999, z: 0 }]).removed).toEqual({ floors: 0, walls: 0 })
  })

  test('two separate skybox pieces, each with a camera, are both removed', () => {
    const f = [...main(), ...floor(0, 50_000, 50_000, 600), ...floor(0, -60_000, 50_000, 600)]
    const r = run(f, [], [camera, { x: -59_700, y: 50_300, z: 0 }])
    expect(r.removed.floors).toBe(4)
    expect(r.floors).toEqual(main())
  })

  test('never takes more than half of the map: a "skybox" that is most of it is probably the map', () => {
    const big = [...floor(0, 0, 0, 800), ...floor(0, 0, 900, 800)]
    const small = floor(0, 50_000, 50_000, 600)
    // the component with the camera is the larger one (4 of 6 triangles): leave everything
    const r = run([...big, ...small, ...floor(0, 0, 1800, 800)], [], [{ x: 400, y: 1300, z: 0 }], [])
    expect(r.removed).toEqual({ floors: 0, walls: 0 })
  })

  test('without spawns it still removes a clearly separate small piece', () => {
    const r = run([...main(), ...sky()], [], [camera], [])
    expect(r.removed.floors).toBe(4)
  })

  test('a piece the spawns are in is not the skybox even if the camera is in it', () => {
    const f = [...main(), ...sky()]
    const r = run(f, [], [camera], [{ class: 'info_player_start', x: 50_300, y: 50_300, z: 0 }])
    expect(r.removed).toEqual({ floors: 0, walls: 0 })
  })

  test('geometry less than a cell apart is one piece; more than a cell and a half apart is two', () => {
    const near = [...floor(0, 0, 0, 100), ...floor(0, 1500, 0, 100)] // centres 1500 apart: in different cells, adjacent
    expect(run(near, [], [{ x: 1550, y: 50, z: 0 }]).removed).toEqual({ floors: 0, walls: 0 }) // joined with the spawn's piece
    const far = [...floor(0, 0, 0, 100), ...floor(0, 5000, 0, 100)]
    expect(run(far, [], [{ x: 5050, y: 50, z: 0 }]).removed.floors).toBe(2)
  })

  test('keeps the order of what stays, and is deterministic', () => {
    const f = [...main(), ...sky()]
    expect(run(f, [], [camera])).toEqual(run(f, [], [camera]))
  })

  test('refuses input that is not triangles', () => {
    expect(() => run([1, 2, 3], [], [camera])).toThrow(/triangles/)
  })

  test('the result goes straight into the writer', async () => {
    const cleaned = run([...main(), ...sky()], wall(0, 100, 0, 0, 800), [camera])
    const r = await ok(cleaned.floors, cleaned.walls)
    expect(r.info.triangles).toBe(cleaned.floors.length / 9 + cleaned.walls.length / 9)
  })
})
