import { expect, test, describe } from 'bun:test'
import { readHeader, extractSurfaces, memorySource, bspFingerprint, BspError, type ByteSource } from '../src/services/bsp'
import { buildBsp, flatQuad, HEADER_BYTES, LUMP, SURF } from './helpers/bsp_builder'

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

  test('a displacement (terrain) is counted and left out, as the first version does not draw it', async () => {
    const q = flatQuad(0); q.faces[0]!.dispinfo = 0
    const s = await surfaces({ ...q, dispinfoCount: 1 })
    expect(s.floors).toHaveLength(0)
    expect(s.stats.displacements).toBe(1)
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
