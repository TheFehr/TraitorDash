// Builds small Source (VBSP) map files for the tests, so no real map is committed. Only what the
// reader reads is filled in; everything else is empty. Layout: the 1036-byte header (identifier,
// version, 64 lump entries of offset/length/version/fourCC, map revision), then the lumps in order.
export const HEADER_BYTES = 1036

export const LUMP = {
  ENTITIES: 0, PLANES: 1, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14,
  TEXDATA: 2, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44, PAKFILE: 40, DISP_TRIS: 48,
} as const

export const SURF = { SKY: 0x4, SKY2D: 0x2, WARP: 0x8, TRIGGER: 0x40, NODRAW: 0x80, HINT: 0x100, SKIP: 0x200 } as const

export interface Plane { nx: number, ny: number, nz: number, dist: number }
export interface Face { plane: number, side?: number, firstEdge: number, numEdges: number, texinfo?: number, dispinfo?: number }
export interface Model { firstFace: number, numFaces: number }

export interface BspSpec {
  version?: number
  revision?: number
  planes?: Plane[]
  vertices?: [number, number, number][]
  edges?: [number, number][]
  surfedges?: number[]
  faces?: Face[]
  texinfoFlags?: number[]
  /** The material name of each texinfo (by index), as in the map's texture data lumps. */
  materials?: string[]
  models?: Model[]
  /** Displacement records (terrain): where the grid starts, where its vertices begin in the vertex lump, and its power (2 to 4). */
  displacements?: { startPosition: [number, number, number], vertStart: number, power: number }[]
  /** The displacement vertex lump: a direction and a distance each (the position is the interpolated base plus direction * distance). */
  dispVerts?: { vec: [number, number, number], dist: number }[]
  /** The text of the entity lump (the map's entities, as key/value blocks). */
  entities?: string
  /** Raw bytes put into a lump instead of what the spec would produce. */
  raw?: Partial<Record<number, Buffer>>
  /** Lumps to mark as compressed (a non-zero fourCC in the directory). */
  compressed?: number[]
  /** The static props (the `sprp` game lump): the model table, and one record per prop. `stride` is the record size (the real ones are 56 to 76). */
  staticProps?: { models: string[], props: { model: number, x: number, y: number, z: number, pitch?: number, yaw?: number, roll?: number }[], stride?: number
    /** Bytes after the last record (so the records are not a whole number), and a prop count that is not the real one. */
    strayBytes?: number, declaredProps?: number }
  /** The pakfile lump: a ZIP, or any bytes. */
  pak?: Buffer
  /** Bytes of junk in the pakfile lump (the big embedded-content lump the reader must never read). */
  pakfileBytes?: number
}

const plane = (p: Plane) => { const b = Buffer.alloc(20); b.writeFloatLE(p.nx, 0); b.writeFloatLE(p.ny, 4); b.writeFloatLE(p.nz, 8); b.writeFloatLE(p.dist, 12); return b }
const vertex = (v: [number, number, number]) => { const b = Buffer.alloc(12); v.forEach((n, i) => b.writeFloatLE(n, i * 4)); return b }
const edge = (e: [number, number]) => { const b = Buffer.alloc(4); b.writeUInt16LE(e[0], 0); b.writeUInt16LE(e[1], 2); return b }
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b }
const face = (f: Face) => {
  const b = Buffer.alloc(56)
  b.writeUInt16LE(f.plane, 0); b.writeUInt8(f.side ?? 0, 2); b.writeInt32LE(f.firstEdge, 4); b.writeInt16LE(f.numEdges, 8)
  b.writeInt16LE(f.texinfo ?? 0, 10); b.writeInt16LE(f.dispinfo ?? -1, 12)
  return b
}
const texinfo = (flags: number, texdata = 0) => { const b = Buffer.alloc(72); b.writeInt32LE(flags, 64); b.writeInt32LE(texdata, 68); return b }
const dispinfo = (d: { startPosition: [number, number, number], vertStart: number, power: number }) => {
  const b = Buffer.alloc(176)
  d.startPosition.forEach((n, i) => b.writeFloatLE(n, i * 4)); b.writeInt32LE(d.vertStart, 12); b.writeInt32LE(d.power, 20)
  return b
}
const dispvert = (v: { vec: [number, number, number], dist: number }) => {
  const b = Buffer.alloc(20)
  v.vec.forEach((n, i) => b.writeFloatLE(n, i * 4)); b.writeFloatLE(v.dist, 12)
  return b
}
const model = (m: Model) => { const b = Buffer.alloc(48); b.writeInt32LE(m.firstFace, 40); b.writeInt32LE(m.numFaces, 44); return b }

export function buildBsp(spec: BspSpec = {}): Buffer {
  const lumps: Buffer[] = Array.from({ length: 64 }, () => Buffer.alloc(0))
  lumps[LUMP.PLANES] = Buffer.concat((spec.planes ?? []).map(plane))
  lumps[LUMP.VERTEXES] = Buffer.concat((spec.vertices ?? []).map(vertex))
  lumps[LUMP.EDGES] = Buffer.concat((spec.edges ?? []).map(edge))
  lumps[LUMP.SURFEDGES] = Buffer.concat((spec.surfedges ?? []).map(int))
  lumps[LUMP.FACES] = Buffer.concat((spec.faces ?? []).map(face))
  const count = Math.max((spec.texinfoFlags ?? [0]).length, (spec.materials ?? []).length)
  lumps[LUMP.TEXINFO] = Buffer.concat(Array.from({ length: count }, (_, i) => texinfo((spec.texinfoFlags ?? [0])[i] ?? 0, i)))
  if (spec.materials) {
    // texture data: one record per material (the name is entry i of the string table); the strings are NUL-ended, one after another.
    lumps[LUMP.TEXDATA] = Buffer.concat(spec.materials.map((_, i) => { const b = Buffer.alloc(32); b.writeInt32LE(i, 12); return b }))
    let at = 0
    lumps[LUMP.TEXDATA_STRING_TABLE] = Buffer.concat(spec.materials.map(m => { const b = int(at); at += m.length + 1; return b }))
    lumps[LUMP.TEXDATA_STRING_DATA] = Buffer.concat(spec.materials.map(m => Buffer.from(m + '\0', 'latin1')))
  }
  lumps[LUMP.MODELS] = Buffer.concat((spec.models ?? [{ firstFace: 0, numFaces: (spec.faces ?? []).length }]).map(model))
  lumps[LUMP.DISPINFO] = Buffer.concat((spec.displacements ?? []).map(dispinfo))
  lumps[LUMP.DISP_VERTS] = Buffer.concat((spec.dispVerts ?? []).map(dispvert))
  lumps[LUMP.ENTITIES] = Buffer.from((spec.entities ?? '{ "classname" "worldspawn" }') + '\0')
  if (spec.pakfileBytes) lumps[LUMP.PAKFILE] = Buffer.alloc(spec.pakfileBytes, 0x50)
  if (spec.pak) lumps[LUMP.PAKFILE] = spec.pak
  for (const [i, raw] of Object.entries(spec.raw ?? {})) lumps[Number(i)] = raw!
  if (spec.staticProps) {
    const sp = spec.staticProps, stride = sp.stride ?? 64
    const table = Buffer.alloc(sp.models.length * 128); sp.models.forEach((m, i) => table.write(m, i * 128, 'latin1'))
    const records = Buffer.alloc(sp.props.length * stride)
    sp.props.forEach((p, i) => {
      const at = i * stride
      ;[p.x, p.y, p.z, p.pitch ?? 0, p.yaw ?? 0, p.roll ?? 0].forEach((n, k) => records.writeFloatLE(n, at + k * 4))
      records.writeUInt16LE(p.model, at + 24)
    })
    const body = Buffer.concat([int(sp.models.length), table, int(0), int(sp.declaredProps ?? sp.props.length), records, Buffer.alloc(sp.strayBytes ?? 0)])
    const before = lumps.slice(0, LUMP.GAME_LUMP).reduce((n, l) => n + l.length, 0)
    const dirEntry = Buffer.alloc(16)
    dirEntry.write('prps', 0, 'latin1') // the id 'sprp' is stored as a little-endian int, so the bytes are reversed
    dirEntry.writeUInt16LE(0, 4); dirEntry.writeUInt16LE(6, 6)
    dirEntry.writeInt32LE(HEADER_BYTES + before + 4 + 16, 8); dirEntry.writeInt32LE(body.length, 12)
    lumps[LUMP.GAME_LUMP] = Buffer.concat([int(1), dirEntry, body])
  }

  const header = Buffer.alloc(HEADER_BYTES)
  header.write('VBSP', 0, 'latin1')
  header.writeInt32LE(spec.version ?? 20, 4)
  header.writeInt32LE(spec.revision ?? 1, 1032)
  let offset = HEADER_BYTES
  const body: Buffer[] = []
  lumps.forEach((l, i) => {
    const at = 8 + i * 16
    header.writeInt32LE(l.length ? offset : 0, at)
    header.writeInt32LE(l.length, at + 4)
    header.writeInt32LE(0, at + 8)
    header.writeInt32LE((spec.compressed ?? []).includes(i) ? l.length : 0, at + 12) // fourCC: non-zero = compressed
    if (l.length) { body.push(l); offset += l.length }
  })
  return Buffer.concat([header, ...body])
}

/** Several flat quads, each of 64 by 64 at its own height, facing up, one face each (face i is the quad at heights[i]). */
export function flatQuads(heights: number[]): Required<Pick<BspSpec, 'planes' | 'vertices' | 'edges' | 'surfedges' | 'faces' | 'texinfoFlags'>> {
  const out = { texinfoFlags: heights.map(() => 0), planes: [] as Plane[], vertices: [] as [number, number, number][], edges: [[0, 0]] as [number, number][], surfedges: [] as number[], faces: [] as Face[] }
  heights.forEach((z, i) => {
    const v = out.vertices.length, e = out.edges.length
    out.planes.push({ nx: 0, ny: 0, nz: 1, dist: z })
    out.vertices.push([i * 100, 0, z], [i * 100 + 64, 0, z], [i * 100 + 64, 64, z], [i * 100, 64, z])
    out.edges.push([v, v + 1], [v + 1, v + 2], [v + 2, v + 3], [v + 3, v])
    out.faces.push({ plane: i, firstEdge: out.surfedges.length, numEdges: 4, texinfo: i })
    out.surfedges.push(e, e + 1, e + 2, e + 3)
  })
  return out
}

/** A quad on the plane z = `z`, facing up, as two vertices-per-edge records. Returns the spec parts. */
export function flatQuad(z: number, x0 = 0, y0 = 0, size = 64, up = true): Required<Pick<BspSpec, 'planes' | 'vertices' | 'edges' | 'surfedges' | 'faces'>> {
  return {
    planes: [{ nx: 0, ny: 0, nz: up ? 1 : -1, dist: up ? z : -z }],
    vertices: [[x0, y0, z], [x0 + size, y0, z], [x0 + size, y0 + size, z], [x0, y0 + size, z]],
    edges: [[0, 0], [0, 1], [1, 2], [2, 3], [3, 0]], // edge 0 is unused, as in real maps
    surfedges: [1, 2, 3, 4],
    faces: [{ plane: 0, firstEdge: 0, numEdges: 4 }],
  }
}

/**
 * A displacement on a flat quad at height `z`: the quad's face points at dispinfo 0, the grid has
 * (2^power + 1)^2 vertices, all with distance 0 unless `bump` raises one (index in the grid, height).
 */
export function flatDisplacement(power: number, z = 0, size = 64, opts: { start?: [number, number, number], bump?: Record<number, number>, up?: boolean } = {}) {
  const quad = flatQuad(z, 0, 0, size, opts.up ?? true)
  quad.faces[0]!.dispinfo = 0
  const n = (2 ** power + 1) ** 2
  return {
    ...quad,
    displacements: [{ startPosition: opts.start ?? [0, 0, z] as [number, number, number], vertStart: 0, power }],
    dispVerts: Array.from({ length: n }, (_, i) => ({ vec: [0, 0, 1] as [number, number, number], dist: opts.bump?.[i] ?? 0 })),
  }
}

/** A GMA (Garry's Mod addon archive, version 3) holding `files`. */
export function buildGma(files: Record<string, Buffer | string>, description = '{}'): Buffer {
  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])])
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const bodies = Object.values(files).map(v => (typeof v === 'string' ? Buffer.from(v) : v))
  const table = Object.keys(files).map((name, i) => Buffer.concat([u32(i + 1), cstr(name), u64(bodies[i]!.length), u32(0)]))
  return Buffer.concat([
    Buffer.from('GMAD'), Buffer.from([3]), u64(0), u64(0), cstr(''), cstr('test addon'), cstr(description), cstr('test'), u32(1),
    ...table, u32(0), ...bodies, u32(0),
  ])
}
