import { expect, test, describe } from 'bun:test'
import { readHeader, extractSurfaces, extractSpawns, memorySource, bspFingerprint, BspError, type ByteSource } from '../src/services/bsp'
import { buildBsp, flatQuad, flatDisplacement, HEADER_BYTES, LUMP, SURF } from './helpers/bsp_builder'

// RFC 11, step 1: reading the surface geometry out of a Source map without reading the map. The
// reader only sees a ByteSource (a buffer, a file, later an HTTP range), asks for the 1036-byte
// header and then for the few lumps it needs, and refuses anything that does not add up.

const rejects = async (p: Promise<unknown>, reason?: RegExp) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(BspError)
  if (reason) expect((e as BspError).reason).toMatch(reason)
}

/** A source that remembers every read, and can pretend to be much bigger than the bytes it holds. */
const counting = (buf: Buffer, size = buf.length): ByteSource & { reads: [number, number][] } => {
  const reads: [number, number][] = []
  return {
    size, reads,
    async read(offset, length) { reads.push([offset, length]); return new Uint8Array(buf.subarray(offset, offset + length)) },
  }
}

describe('the header', () => {
  test('gives the version, the revision and the 64 lumps, and reads only the header', async () => {
    const src = counting(buildBsp({ version: 20, revision: 904, ...flatQuad(0) }))
    const h = await readHeader(src)
    expect(h.version).toBe(20)
    expect(h.revision).toBe(904)
    expect(h.lumps).toHaveLength(64)
    expect(h.lumps[LUMP.PLANES]).toMatchObject({ length: 20, compressed: false })
    expect(src.reads).toEqual([[0, HEADER_BYTES]])
  })

  test.each([19, 20, 21])('version %d is accepted', async (version) => {
    expect((await readHeader(memorySource(buildBsp({ version })))).version).toBe(version)
  })

  test.each([0, 17, 18, 22, 100, -1])('version %d is refused', async (version) => {
    await rejects(readHeader(memorySource(buildBsp({ version }))), /version/)
  })

  test('a file that does not start with VBSP is refused', async () => {
    const b = buildBsp(); b.write('rBSP', 0, 'latin1')
    await rejects(readHeader(memorySource(b)), /identifier/)
    await rejects(readHeader(memorySource(Buffer.from('PK\u0003\u0004' + 'x'.repeat(2000)))), /identifier/)
  })

  test('a file shorter than the header is refused, however it is cut', async () => {
    for (const n of [0, 3, 4, 100, HEADER_BYTES - 1]) await rejects(readHeader(memorySource(buildBsp().subarray(0, n))), /short|header/)
  })

  test('a source too small to hold the header is refused before anything is read', async () => {
    const src = counting(buildBsp(), 100)
    await rejects(readHeader(src), /shorter/)
    expect(src.reads).toEqual([])
  })

  test('a source that returns fewer bytes than asked is refused', async () => {
    const short: ByteSource = { size: 5000, async read() { return new Uint8Array(10) } }
    await rejects(readHeader(short), /short|header/)
  })

  const withLump = (i: number, offset: number, length: number) => {
    const b = buildBsp(flatQuad(0))
    b.writeInt32LE(offset, 8 + i * 16); b.writeInt32LE(length, 8 + i * 16 + 4)
    return b
  }

  test('a lump that reaches past the end of the file is refused, wherever the lump is', async () => {
    const size = buildBsp(flatQuad(0)).length
    await rejects(readHeader(memorySource(withLump(LUMP.PLANES, size - 4, 20))), /lump/)
    await rejects(readHeader(memorySource(withLump(LUMP.PAKFILE, size + 1000, 50))), /lump/) // even one that is never read
  })

  test('a lump with a negative or absurd offset or length is refused', async () => {
    for (const [o, l] of [[-1, 20], [HEADER_BYTES, -1], [0x7fffffff, 0x7fffffff], [HEADER_BYTES, 0x7fffffff]] as const) {
      await rejects(readHeader(memorySource(withLump(LUMP.VERTEXES, o, l))), /lump/)
    }
  })

  test('a lump that overlaps the header is refused', async () => {
    await rejects(readHeader(memorySource(withLump(LUMP.PLANES, 8, 20))), /header|lump/)
  })

  test('an empty lump may have any offset', async () => {
    const b = buildBsp(); b.writeInt32LE(123456789, 8 + LUMP.TEXINFO * 16); b.writeInt32LE(0, 8 + LUMP.TEXINFO * 16 + 4)
    await readHeader(memorySource(b))
  })

  test('a lump marked compressed is reported as compressed', async () => {
    const h = await readHeader(memorySource(buildBsp({ compressed: [LUMP.PLANES], ...flatQuad(0) })))
    expect(h.lumps[LUMP.PLANES]!.compressed).toBe(true)
    expect(h.lumps[LUMP.FACES]!.compressed).toBe(false)
  })
})

describe('the fingerprint (RFC 10, 3.1: the same value the game server computes)', () => {
  // The same literal is pinned in the bridge's suite (test/maps_bridge.test.ts): header filled with
  // 7, "VBSP", version 20, revision 904, and a file of 243 312 804 bytes.
  const headerFilled = () => { const b = Buffer.alloc(HEADER_BYTES, 7); b.write('VBSP', 0, 'latin1'); b.writeInt32LE(20, 4); b.writeInt32LE(904, 1032); return b }
  const LITERAL = 'a6f7661d5ae421cdbe7b1b4da2d6eae9d9f3583faaa5b01ff31509698ff1f3d6'

  test('matches the shared test vector', () => {
    expect(bspFingerprint(headerFilled(), 243_312_804)).toBe(LITERAL)
  })

  test('readHeader computes it from the first 1036 bytes and the size of the source, reading nothing else', async () => {
    // The lumps of this header are nonsense but lie inside a 243 MB file, so it passes the bounds checks.
    const src = counting(headerFilled(), 243_312_804)
    expect((await readHeader(src)).fingerprint).toBe(LITERAL)
    expect(src.reads).toEqual([[0, HEADER_BYTES]])
  })

  test('a different revision, size or lump table is a different fingerprint', () => {
    const a = headerFilled(), b = headerFilled(); b.writeInt32LE(905, 1032)
    const c = headerFilled(); c.writeInt32LE(7, 8 + 5 * 16 + 4)
    const f = [bspFingerprint(a, 1), bspFingerprint(b, 1), bspFingerprint(c, 1), bspFingerprint(a, 2)]
    expect(new Set(f).size).toBe(4)
  })

  test('is 64 lowercase hex characters, and the same twice', () => {
    expect(bspFingerprint(headerFilled(), 5)).toMatch(/^[0-9a-f]{64}$/)
    expect(bspFingerprint(headerFilled(), 5)).toBe(bspFingerprint(headerFilled(), 5))
  })

  test('refuses anything but exactly 1036 bytes, or a size that is not a whole number', () => {
    expect(() => bspFingerprint(Buffer.alloc(1035), 5)).toThrow(BspError)
    expect(() => bspFingerprint(Buffer.alloc(1037), 5)).toThrow(BspError)
    expect(() => bspFingerprint(headerFilled(), -1)).toThrow(BspError)
    expect(() => bspFingerprint(headerFilled(), 1.5)).toThrow(BspError)
  })
})

describe('surfaces', () => {
  const surfaces = (spec: Parameters<typeof buildBsp>[0], limits?: Parameters<typeof extractSurfaces>[1]) => extractSurfaces(memorySource(buildBsp(spec)), limits)

  test('a floor becomes two triangles, with whole-number coordinates, and nothing else', async () => {
    const s = await surfaces(flatQuad(48, 10, 20, 64))
    expect(s.floors).toHaveLength(2 * 3 * 3)
    expect(s.walls).toHaveLength(0)
    expect(new Set(s.floors.filter((_, i) => i % 3 === 2))).toEqual(new Set([48])) // every z
    expect(s.floors.every(Number.isInteger)).toBe(true)
    expect(s.stats).toMatchObject({ faces: 1, floorFaces: 1, wallFaces: 0, ceilingFaces: 0 })
  })

  test('coordinates are rounded to whole map units', async () => {
    const q = flatQuad(0)
    q.vertices = [[0.4, 0.6, 47.6], [64.4, 0.6, 47.6], [64.4, 64.6, 47.6], [0.4, 64.6, 47.6]]
    const s = await surfaces(q)
    expect(s.floors.slice(0, 3)).toEqual([0, 1, 48])
    expect(s.floors.every(Number.isInteger)).toBe(true)
  })

  test('a ceiling (facing down) is dropped', async () => {
    const s = await surfaces(flatQuad(200, 0, 0, 64, false))
    expect(s.floors).toHaveLength(0)
    expect(s.walls).toHaveLength(0)
    expect(s.stats.ceilingFaces).toBe(1)
  })

  test('the side of a face flips its plane: a floor plane seen from behind is a ceiling', async () => {
    const q = flatQuad(0); q.faces[0]!.side = 1
    const s = await surfaces(q)
    expect(s.floors).toHaveLength(0)
    expect(s.stats.ceilingFaces).toBe(1)
  })

  test('a ramp up to the walkable limit is a floor; steeper is a wall', async () => {
    const ramp = (nz: number) => { const q = flatQuad(0); q.planes[0] = { nx: Math.sqrt(1 - nz * nz), ny: 0, nz, dist: 0 }; return q }
    expect((await surfaces(ramp(0.7))).stats.floorFaces).toBe(1)
    expect((await surfaces(ramp(0.866))).stats.floorFaces).toBe(1)
    expect((await surfaces(ramp(0.69))).stats.wallFaces).toBe(1)
  })

  test('an upright face is a wall', async () => {
    const q = flatQuad(0); q.planes[0] = { nx: 1, ny: 0, nz: 0, dist: 0 }
    const s = await surfaces(q)
    expect(s.walls).toHaveLength(2 * 3 * 3)
    expect(s.floors).toHaveLength(0)
  })

  test.each([['sky', SURF.SKY], ['2d sky', SURF.SKY2D], ['trigger', SURF.TRIGGER], ['nodraw', SURF.NODRAW], ['hint', SURF.HINT], ['skip', SURF.SKIP]])(
    'a face with the %s flag is not geometry a player meets', async (_, flag) => {
      const s = await surfaces({ ...flatQuad(0), texinfoFlags: [flag] })
      expect(s.floors).toHaveLength(0)
      expect(s.stats.skipped).toBe(1)
    })

  test('a texture with other flags (lit, bump-mapped) is kept', async () => {
    expect((await surfaces({ ...flatQuad(0), texinfoFlags: [0x400 | 0x800] })).floors).toHaveLength(18)
  })

  test('only the world model counts: the faces of a door or a lift are not part of the floor plan', async () => {
    const a = flatQuad(0), b = flatQuad(100, 200, 0)
    const spec = {
      planes: [...a.planes, ...b.planes], vertices: [...a.vertices, ...b.vertices],
      edges: [...a.edges, [4, 5], [5, 6], [6, 7], [7, 4]] as [number, number][],
      surfedges: [...a.surfedges, 5, 6, 7, 8],
      faces: [...a.faces, { plane: 1, firstEdge: 4, numEdges: 4 }],
      models: [{ firstFace: 0, numFaces: 1 }, { firstFace: 1, numFaces: 1 }],
    }
    const s = await surfaces(spec)
    expect(s.floors).toHaveLength(18)
    expect(s.stats.otherModelFaces).toBe(1)
    expect(new Set(s.floors.filter((_, i) => i % 3 === 2))).toEqual(new Set([0]))
  })

  test('a reversed edge (a negative surfedge) uses the edge the other way round', async () => {
    const q = flatQuad(0); q.surfedges = [-4, -3, -2, -1]
    const s = await surfaces(q)
    expect(s.floors).toHaveLength(18)
    expect(new Set(s.floors.filter((_, i) => i % 3 === 2))).toEqual(new Set([0]))
  })

  test('a polygon with five corners is three triangles', async () => {
    const q = flatQuad(0)
    q.vertices.push([32, 96, 0]); q.edges = [[0, 0], [0, 1], [1, 2], [2, 4], [4, 3], [3, 0]]; q.surfedges = [1, 2, 3, 4, 5]
    q.faces[0]!.numEdges = 5
    expect((await surfaces(q)).floors).toHaveLength(3 * 3 * 3)
  })

  test('a map with no faces is an empty result, not an error', async () => {
    const s = await surfaces({})
    expect(s.floors).toHaveLength(0)
    expect(s.stats.faces).toBe(0)
  })

  test('the same map twice gives the same result', async () => {
    const spec = flatQuad(48)
    expect(await surfaces(spec)).toEqual(await surfaces(spec))
  })

  test('returns the fingerprint of the map it read', async () => {
    const buf = buildBsp(flatQuad(0))
    const a = await extractSurfaces(memorySource(buf))
    expect(a.fingerprint).toBe((await readHeader(memorySource(buf))).fingerprint)
  })
})

describe('surfaces: what it reads', () => {
  test('only the header and the surface lumps, never the embedded content', async () => {
    const buf = buildBsp({ ...flatQuad(0), pakfileBytes: 5_000_000 })
    const src = counting(buf)
    await extractSurfaces(src)
    const h = await readHeader(memorySource(buf))
    const pak = h.lumps[LUMP.PAKFILE]!
    expect(pak.length).toBe(5_000_000)
    for (const [o, l] of src.reads) expect(o + l <= pak.offset || o >= pak.offset + pak.length).toBe(true) // nothing inside the pakfile
    const bytes = src.reads.reduce((n, [, l]) => n + l, 0)
    expect(bytes).toBeLessThan(buf.length * 0.01)
    const entities = h.lumps[LUMP.ENTITIES]!
    for (const [o, l] of src.reads) expect(o + l <= entities.offset || o >= entities.offset + entities.length).toBe(true) // nor the entity text
  })

  test('works on a source that holds only the header and those lumps (a range-read file)', async () => {
    const buf = buildBsp({ ...flatQuad(0), pakfileBytes: 5_000_000 })
    const h = await readHeader(memorySource(buf))
    const sparse = Buffer.alloc(buf.length) // zeros everywhere the reader must not look
    buf.copy(sparse, 0, 0, HEADER_BYTES)
    for (const i of [LUMP.PLANES, LUMP.VERTEXES, LUMP.TEXINFO, LUMP.FACES, LUMP.EDGES, LUMP.SURFEDGES, LUMP.MODELS, LUMP.DISPINFO]) {
      const l = h.lumps[i]!; buf.copy(sparse, l.offset, l.offset, l.offset + l.length)
    }
    expect((await extractSurfaces(memorySource(sparse))).floors).toHaveLength(18)
  })
})

describe('surfaces: a file that does not add up is refused whole', () => {
  const bad = (name: string, spec: Parameters<typeof buildBsp>[0], reason: RegExp, limits?: Parameters<typeof extractSurfaces>[1]) =>
    test(name, async () => { await rejects(extractSurfaces(memorySource(buildBsp(spec)), limits), reason) })

  const q = () => flatQuad(0)
  const withFace = (f: Partial<ReturnType<typeof q>['faces'][0]>) => { const x = q(); Object.assign(x.faces[0]!, f); return x }

  bad('a plane number that does not exist', withFace({ plane: 5 }), /plane/)
  bad('a texinfo number that does not exist', withFace({ texinfo: 9 }), /texinfo/)
  bad('a negative texinfo number', withFace({ texinfo: -1 }), /texinfo/)
  bad('another model with a negative face count', { ...q(), models: [{ firstFace: 0, numFaces: 1 }, { firstFace: 0, numFaces: -1 }] }, /model 1/)
  bad('a face with fewer than three edges', withFace({ numEdges: 2 }), /edges/)
  bad('a face with absurdly many edges', withFace({ numEdges: 5000 }), /has 5000 edges/)
  bad('a face with a negative edge count', withFace({ numEdges: -3 }), /has -3 edges/)
  bad('a face that reaches past the surfedges', withFace({ firstEdge: 2 }), /surfedge/)
  bad('a face with a negative first edge', withFace({ firstEdge: -1 }), /surfedge/)
  bad('a surfedge that names no edge', { ...q(), surfedges: [1, 2, 3, 99] }, /edge/)
  bad('a surfedge of zero edges away from any edge', { ...q(), surfedges: [1, 2, 3, -99] }, /edge/)
  bad('an edge that names a vertex that does not exist (walked backwards, so its second vertex is used)', { ...q(), edges: [[0, 0], [0, 1], [1, 2], [2, 3], [3, 40]], surfedges: [1, 2, 3, -4] }, /vertex/)
  bad('an edge that names a vertex that does not exist (its first vertex is used)', { ...q(), edges: [[0, 0], [0, 1], [1, 2], [2, 3], [40, 0]] }, /vertex/)
  bad('a model whose faces are not there', { ...q(), models: [{ firstFace: 0, numFaces: 50 }] }, /model|face/)
  bad('a model with a negative face range', { ...q(), models: [{ firstFace: -1, numFaces: 1 }] }, /model|face/)
  bad('no models at all', { ...q(), raw: { [LUMP.MODELS]: Buffer.alloc(0) } }, /model/)
  bad('a vertex that is not a number', { ...q(), vertices: [[NaN, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0]] }, /vertex|number|finite/)
  bad('a vertex that is infinite', { ...q(), vertices: [[Infinity, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0]] }, /vertex|number|finite/)
  bad('a vertex far outside any map', { ...q(), vertices: [[1e9, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0]] }, /range|vertex/)
  bad('a plane normal that is not a number', { ...q(), planes: [{ nx: NaN, ny: 0, nz: 1, dist: 0 }] }, /plane|number|finite/)
  bad('a lump whose size is not a whole number of records (planes of 21 bytes)', { ...q(), raw: { [LUMP.PLANES]: Buffer.alloc(21) } }, /multiple|size|record/)
  bad('a lump whose size is not a whole number of records (faces of 57 bytes)', { ...q(), raw: { [LUMP.FACES]: Buffer.alloc(57) } }, /multiple|size|record/)
  bad('a compressed lump it needs', { ...q(), compressed: [LUMP.FACES] }, /compressed/)
  bad('a compressed vertex lump', { ...q(), compressed: [LUMP.VERTEXES] }, /compressed/)
  bad('too many faces for the limit', q(), /too many|limit/, { maxFaces: 0 })
  bad('too many vertices for the limit', q(), /too many|limit/, { maxVertices: 3 })
  bad('more bytes to read than the limit', q(), /too many|limit|bytes/, { maxBytes: 10 })

  test('a compressed lump it does not need is no problem', async () => {
    await extractSurfaces(memorySource(buildBsp({ ...flatQuad(0), compressed: [LUMP.PAKFILE, LUMP.ENTITIES, 5, 8, 20], pakfileBytes: 100 })))
  })

  test('a bad face in the middle gives an error and no partial result', async () => {
    const a = flatQuad(0)
    const spec = {
      ...a, faces: [...a.faces, { plane: 0, firstEdge: 100, numEdges: 4 }],
      models: [{ firstFace: 0, numFaces: 2 }],
    }
    await rejects(extractSurfaces(memorySource(buildBsp(spec))), /surfedge/)
  })

  test('the error says what is wrong and carries no file content', async () => {
    const e = await extractSurfaces(memorySource(buildBsp(withFace({ plane: 5 })))).then(() => null, (x: unknown) => x as BspError)
    expect(e).toBeInstanceOf(BspError)
    expect(e!.message.length).toBeLessThan(200)
  })
})

describe('displacements (terrain)', () => {
  const surfaces = (spec: Parameters<typeof buildBsp>[0], limits?: Parameters<typeof extractSurfaces>[1]) => extractSurfaces(memorySource(buildBsp(spec)), limits)
  const zs = (t: number[]) => t.filter((_, i) => i % 3 === 2)
  const xs = (t: number[]) => t.filter((_, i) => i % 3 === 0)
  const ys = (t: number[]) => t.filter((_, i) => i % 3 === 1)

  test.each([[2, 4], [3, 8], [4, 16]])('a power-%d displacement is a %d x %d grid of cells, two triangles each', async (power, cells) => {
    const s = await surfaces(flatDisplacement(power, 48))
    expect(s.floors).toHaveLength(cells * cells * 2 * 9)
    expect(s.stats).toMatchObject({ displacements: 1, displacementTriangles: cells * cells * 2, floorFaces: 0 })
    expect(new Set(zs(s.floors))).toEqual(new Set([48]))
  })

  test('the grid covers the quad exactly: from corner to corner, evenly', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 64))
    expect(Math.min(...xs(s.floors))).toBe(0)
    expect(Math.max(...xs(s.floors))).toBe(64)
    expect(Math.min(...ys(s.floors))).toBe(0)
    expect(Math.max(...ys(s.floors))).toBe(64)
    expect(new Set(xs(s.floors))).toEqual(new Set([0, 16, 32, 48, 64]))
  })

  test('a vertex pushed along its direction raises the ground there', async () => {
    // power 2 is 5 x 5 vertices; vertex 12 is the middle one
    const s = await surfaces(flatDisplacement(2, 0, 64, { bump: { 12: 20 } }))
    const all = [...s.floors, ...s.walls] // a 20-unit bump over 16-unit cells is steeper than a player can walk: its sides are walls
    expect(Math.max(...zs(all))).toBe(20)
    const peak = all.findIndex((v, i) => i % 3 === 2 && v === 20)
    expect([all[peak - 2], all[peak - 1]]).toEqual([32, 32]) // at the middle of the quad
  })

  test('a steep hill gives wall triangles next to the floor triangles', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 64, { bump: { 12: 200 } }))
    expect(s.walls.length).toBeGreaterThan(0)
    expect(s.floors.length).toBeGreaterThan(0) // the flat rim is still ground
  })

  test('which corner is the start does not move the grid: the same flat ground comes out', async () => {
    const corners: [number, number, number][] = [[0, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0]]
    const counts = []
    for (const start of corners) {
      const s = await surfaces(flatDisplacement(2, 0, 64, { start }))
      counts.push(s.floors.length)
      expect(Math.max(...xs(s.floors))).toBe(64)
    }
    expect(new Set(counts)).toEqual(new Set([32 * 9]))
  })

  test('the start corner decides where the first vertex of the grid is (a raised vertex 0 appears at that corner)', async () => {
    for (const [start, at] of [[[0, 0, 0], [0, 0]], [[64, 0, 0], [64, 0]], [[64, 64, 0], [64, 64]], [[0, 64, 0], [0, 64]]] as const) {
      const s = await surfaces(flatDisplacement(2, 0, 64, { start: [...start], bump: { 0: 30 } }))
      const all = [...s.floors, ...s.walls]
      const peak = all.findIndex((v, i) => i % 3 === 2 && v === 30)
      expect([all[peak - 2], all[peak - 1]]).toEqual([...at])
    }
  })

  test('a start position that is only near a corner uses the nearest one', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 64, { start: [60, 3, 0], bump: { 0: 30 } }))
    const all = [...s.floors, ...s.walls]
    const peak = all.findIndex((v, i) => i % 3 === 2 && v === 30)
    expect([all[peak - 2], all[peak - 1]]).toEqual([64, 0])
  })

  test('is floor whichever way round the face\'s corners are listed (the face\'s own plane decides which side is up)', async () => {
    const d = flatDisplacement(2, 0, 64)
    d.surfedges = [-4, -3, -2, -1]
    expect((await surfaces(d)).floors).toHaveLength(32 * 9)
  })

  // A quad that is not horizontal, built by hand: corners A, B, C, D on a plane with the given normal.
  const quad = (corners: [number, number, number][], normal: [number, number, number], side = 0, bump: Record<number, [[number, number, number], number]> = {}, start = corners[0]!) => ({
    planes: [{ nx: normal[0], ny: normal[1], nz: normal[2], dist: 0 }],
    vertices: corners, edges: [[0, 0], [0, 1], [1, 2], [2, 3], [3, 0]] as [number, number][], surfedges: [1, 2, 3, 4],
    faces: [{ plane: 0, side, firstEdge: 0, numEdges: 4, dispinfo: 0 }],
    displacements: [{ startPosition: start, vertStart: 0, power: 2 }],
    dispVerts: Array.from({ length: 25 }, (_, i) => ({ vec: bump[i]?.[0] ?? [0, 0, 1] as [number, number, number], dist: bump[i]?.[1] ?? 0 })),
  })

  test('the start position is compared in all three dimensions (on a wall the corners differ only in height)', async () => {
    const wall: [number, number, number][] = [[0, 0, 0], [0, 64, 0], [0, 64, 64], [0, 0, 64]]
    for (const [start, at] of [[[0, 0, 0], [0, 0, 0]], [[0, 0, 64], [0, 0, 64]], [[0, 64, 64], [0, 64, 64]]] as const) {
      const s = await surfaces(quad(wall, [1, 0, 0], 0, { 0: [[1, 0, 0], 30] }, [...start]))
      const all = [...s.floors, ...s.walls]
      const peak = all.findIndex((v, i) => i % 3 === 0 && v === 30) // the vertex pushed 30 along x
      expect([all[peak + 1], all[peak + 2]]).toEqual([at[1], at[2]])
    }
  })

  test('the diagonal of a cell alternates like a chessboard, so neighbouring cells do not share a direction', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 64))
    const tri = (n: number) => { const t = s.floors.slice(n * 9, n * 9 + 9); return [[t[0]!, t[1]!], [t[3]!, t[4]!], [t[6]!, t[7]!]] as [number, number][] }
    const shared = (a: [number, number][], b: [number, number][]) => a.filter(p => b.some(q => q[0] === p[0] && q[1] === p[1]))
    const diag = (n: number) => { const [p, q] = shared(tri(n), tri(n + 1)); return Math.sign((q![0] - p![0]) * (q![1] - p![1])) }
    // triangles 0-1 are cell (0,0), 2-3 are cell (0,1), 4-5 (0,2)
    expect(diag(0)).not.toBe(0)
    expect(diag(2)).toBe(-diag(0))
    expect(diag(4)).toBe(diag(0))
  })

  test('a displacement that has collapsed to a point draws nothing, not a pile of empty triangles', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 0))
    expect(s.floors).toHaveLength(0)
    expect(s.walls).toHaveLength(0)
  })

  test('the side of the plane is the whole normal, not only its height: a tilted quad seen from behind is a ceiling', async () => {
    const tilted: [number, number, number][] = [[0, 0, 0], [64, 0, 64], [64, 64, 64], [0, 64, 0]]
    const n: [number, number, number] = [-0.7071068, 0, 0.7071068]
    const reversed = [...tilted].reverse() // the same quad, the corners in the other order: the answer must not depend on it
    for (const corners of [tilted, reversed]) {
      expect((await surfaces(quad(corners, n, 0))).floors).toHaveLength(32 * 9)
      expect((await surfaces(quad(corners, n, 1))).floors).toHaveLength(0)
    }
  })

  test('a displacement whose face looks down is a ceiling: dropped, and counted', async () => {
    const s = await surfaces(flatDisplacement(2, 0, 64, { up: false }))
    expect(s.floors).toHaveLength(0)
    expect(s.walls).toHaveLength(0)
    expect(s.stats.ceilingFaces).toBe(0) // faces: the displacement is counted by its triangles
    expect(s.stats.displacementTriangles).toBe(32)
  })

  test('a displacement with a skip texture (nodraw) is skipped like any face', async () => {
    const s = await surfaces({ ...flatDisplacement(2), texinfoFlags: [SURF.NODRAW] })
    expect(s.floors).toHaveLength(0)
    expect(s.stats.skipped).toBe(1)
    expect(s.stats.displacements).toBe(0)
  })

  test('two displacements side by side, each with its own vertices', async () => {
    const a = flatDisplacement(2, 0, 64), b = flatDisplacement(2, 100, 64)
    const spec = {
      planes: [...a.planes, ...b.planes], vertices: [...a.vertices, ...b.vertices.map(v => [v[0] + 200, v[1], v[2]] as [number, number, number])],
      edges: [...a.edges, [4, 5], [5, 6], [6, 7], [7, 4]] as [number, number][], surfedges: [...a.surfedges, 5, 6, 7, 8],
      faces: [...a.faces, { plane: 1, firstEdge: 4, numEdges: 4, dispinfo: 1 }],
      displacements: [a.displacements[0]!, { startPosition: [200, 0, 100] as [number, number, number], vertStart: 25, power: 2 }],
      dispVerts: [...a.dispVerts, ...b.dispVerts],
    }
    const s = await surfaces(spec)
    expect(s.floors).toHaveLength(2 * 32 * 9)
    expect(new Set(zs(s.floors))).toEqual(new Set([0, 100]))
    expect(s.stats.displacements).toBe(2)
  })

  test('a displacement on a door or a lift (another model) is not part of the world', async () => {
    const d = flatDisplacement(2)
    const s = await surfaces({ ...d, models: [{ firstFace: 0, numFaces: 0 }, { firstFace: 0, numFaces: 1 }] })
    expect(s.floors).toHaveLength(0)
    expect(s.stats.otherModelFaces).toBe(1)
  })

  test('reads the two displacement lumps and nothing beyond what it needs', async () => {
    const buf = buildBsp({ ...flatDisplacement(3), pakfileBytes: 1_000_000 })
    const src = counting(buf)
    await extractSurfaces(src)
    const h = await readHeader(memorySource(buf))
    const touched = (i: number) => src.reads.some(([o, l]) => o >= h.lumps[i]!.offset && o + l <= h.lumps[i]!.offset + h.lumps[i]!.length)
    expect(touched(LUMP.DISPINFO)).toBe(true)
    expect(touched(LUMP.DISP_VERTS)).toBe(true)
    expect(touched(LUMP.PAKFILE)).toBe(false)
  })

  const bad = (name: string, spec: Parameters<typeof buildBsp>[0], reason: RegExp, limits?: Parameters<typeof extractSurfaces>[1]) =>
    test(name, async () => { await rejects(extractSurfaces(memorySource(buildBsp(spec)), limits), reason) })
  const d2 = () => flatDisplacement(2, 0, 64)

  bad('a face that names a displacement that does not exist', { ...d2(), displacements: [] }, /displacement/)
  bad('a displacement that is not on a quad (five corners)', (() => {
    const d = d2(); d.vertices.push([32, 96, 0]); d.edges = [[0, 0], [0, 1], [1, 2], [2, 4], [4, 3], [3, 0]]; d.surfedges = [1, 2, 3, 4, 5]; d.faces[0]!.numEdges = 5
    return d
  })(), /quad|four/)
  for (const power of [0, 1, 5, 20, -1]) bad(`a displacement of power ${power}`, { ...d2(), displacements: [{ ...d2().displacements[0]!, power }] }, /power/)
  bad('displacement vertices that run past the vertex lump', { ...d2(), displacements: [{ ...d2().displacements[0]!, vertStart: 10 }] }, /displacement vert/)
  bad('a negative first displacement vertex', { ...d2(), displacements: [{ ...d2().displacements[0]!, vertStart: -1 }] }, /displacement vert/)
  bad('too few displacement vertices for the power', { ...d2(), dispVerts: d2().dispVerts.slice(0, 10) }, /displacement vert/)
  bad('a start position that is not a number', { ...d2(), displacements: [{ ...d2().displacements[0]!, startPosition: [NaN, 0, 0] }] }, /displacement|start|finite/)
  bad('a vertex direction that is not a number', { ...d2(), dispVerts: d2().dispVerts.map((v, i) => (i === 3 ? { vec: [NaN, 0, 1] as [number, number, number], dist: 1 } : v)) }, /displacement|finite/)
  bad('a vertex distance that is infinite', { ...d2(), dispVerts: d2().dispVerts.map((v, i) => (i === 3 ? { vec: v.vec, dist: Infinity } : v)) }, /displacement|finite/)
  bad('a vertex pushed far outside any map', { ...d2(), dispVerts: d2().dispVerts.map((v, i) => (i === 3 ? { vec: v.vec, dist: 1e9 } : v)) }, /range|displacement/)
  bad('a displacement lump that is not whole records', { ...d2(), raw: { [LUMP.DISPINFO]: Buffer.alloc(177) } }, /multiple|whole|record/)
  bad('a displacement vertex lump that is not whole records', { ...d2(), raw: { [LUMP.DISP_VERTS]: Buffer.alloc(21) } }, /multiple|whole|record/)
  bad('a compressed displacement lump', { ...d2(), compressed: [LUMP.DISPINFO] }, /compressed/)
  bad('a compressed displacement vertex lump', { ...d2(), compressed: [LUMP.DISP_VERTS] }, /compressed/)
  bad('more displacement vertices than the limit', d2(), /too many|limit/, { maxVertices: 20 })
})

describe('spawn points (the entity lump)', () => {
  const ent = (cls: string, origin?: string, extra = '') => `{\n"classname" "${cls}"\n${origin === undefined ? '' : `"origin" "${origin}"\n`}${extra}}\n`
  const spawns = (entities: string, limits?: Parameters<typeof extractSpawns>[1]) => extractSpawns(memorySource(buildBsp({ entities })), limits)

  test('lists the player spawns with their origin and class, and nothing else', async () => {
    const s = await spawns(ent('worldspawn') + ent('info_player_start', '-100 200.5 32') + ent('light', '5 5 5') + ent('info_player_deathmatch', '10 20 30') + ent('prop_physics', '1 2 3'))
    expect(s).toEqual([{ class: 'info_player_start', x: -100, y: 200.5, z: 32 }, { class: 'info_player_deathmatch', x: 10, y: 20, z: 30 }])
  })

  test.each(['info_player_start', 'info_player_deathmatch', 'info_player_terrorist', 'info_player_counterterrorist', 'info_player_teamspawn'])('%s is a spawn', async (cls) => {
    expect(await spawns(ent(cls, '1 2 3'))).toHaveLength(1)
  })

  test('a class that only looks similar is not a spawn', async () => {
    expect(await spawns(ent('info_player', '1 2 3') + ent('xinfo_player_start', '1 2 3') + ent('info_target', '1 2 3'))).toEqual([])
  })

  test('an empty entity lump, or one without spawns, is an empty list, not an error', async () => {
    expect(await spawns('')).toEqual([])
    expect(await spawns(ent('worldspawn'))).toEqual([])
  })

  test('an origin that is missing or not three finite numbers is skipped', async () => {
    const s = await spawns(ent('info_player_start') + ent('info_player_start', '1 2') + ent('info_player_start', 'a b c') + ent('info_player_start', '1 2 NaN') + ent('info_player_start', '1 2 3 4') + ent('info_player_start', '7 8 9'))
    expect(s).toEqual([{ class: 'info_player_start', x: 7, y: 8, z: 9 }])
  })

  test('an origin far outside any map is skipped', async () => {
    expect(await spawns(ent('info_player_start', '1e9 0 0') + ent('info_player_start', '0 0 -999999'))).toEqual([])
  })

  test('keys in any order, other keys around them, and Windows line endings', async () => {
    const text = '{\r\n"targetname" "a"\r\n"origin" "1 2 3"\r\n"angles" "0 90 0"\r\n"classname" "info_player_start"\r\n}\r\n'
    expect(await spawns(text)).toEqual([{ class: 'info_player_start', x: 1, y: 2, z: 3 }])
  })

  test('a block that is never closed, and stray text, do not break the ones before', async () => {
    const s = await spawns(ent('info_player_start', '1 2 3') + '"stray" "text"\n}\n}\n{\n"classname" "info_player_start"\n"origin" "4 5 6"\n')
    expect(s).toEqual([{ class: 'info_player_start', x: 1, y: 2, z: 3 }]) // the stray text is not glued to the closed block, and the open one is not emitted
  })

  test('too many entities for the limit is refused', async () => {
    await rejects(spawns(ent('worldspawn') + ent('light') + ent('light'), { maxEntities: 2 }), /too many entities/)
  })

  test('an entity lump over the size limit is refused before it is read', async () => {
    const buf = buildBsp({ entities: ent('info_player_start', '1 2 3') })
    const src = counting(buf)
    await rejects(extractSpawns(src, { maxEntityBytes: 10 }), /entity lump/)
    expect(src.reads).toEqual([[0, HEADER_BYTES]]) // only the header was read
  })

  test('a compressed entity lump is refused', async () => {
    await rejects(extractSpawns(memorySource(buildBsp({ entities: ent('info_player_start', '1 2 3'), compressed: [LUMP.ENTITIES] }))), /compressed/)
  })

  test('reads the header and the entity lump, nothing else', async () => {
    const buf = buildBsp({ ...flatQuad(0), entities: ent('info_player_start', '1 2 3'), pakfileBytes: 1_000_000 })
    const src = counting(buf)
    await extractSpawns(src)
    const h = await readHeader(memorySource(buf))
    const e = h.lumps[LUMP.ENTITIES]!
    expect(src.reads).toHaveLength(2)
    expect(src.reads[1]).toEqual([e.offset, e.length])
  })

  test('a map file that is not a map is refused, as everywhere', async () => {
    await rejects(extractSpawns(memorySource(Buffer.from('nope'))), /short|header/)
  })
})
