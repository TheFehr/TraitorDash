import { createHash } from 'node:crypto'

// RFC 11: the surface geometry of a Source (VBSP) map, read without reading the map. A map file is
// 100-250 MB, 95% of it embedded content (the pakfile lump) that is of no use here, so the reader
// never takes a whole file: it asks a ByteSource for the 1036-byte header (identifier, version, a
// directory of 64 lumps, the map revision) and then for the few lumps that describe surfaces.
// The source can be a buffer, a file on disk or, later, an HTTP range request.
//
// The file is untrusted (Workshop content), so every offset, length, count and index is checked
// before it is used, and a file that fails any check is refused whole with a short reason.

export const HEADER_BYTES = 1036
const LUMPS = 64

export class BspError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'BspError'
  }
}

export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export const memorySource = (buf: Uint8Array): ByteSource => ({
  size: buf.length,
  async read(offset, length) { return buf.subarray(offset, offset + length) },
})

export interface Lump { index: number, offset: number, length: number, version: number, compressed: boolean }
export interface BspHeader { version: number, revision: number, lumps: Lump[], fingerprint: string }

/**
 * Which version of the file this is (RFC 10, 3.1): the SHA-256 of the lowercase hex of the header,
 * a colon, and the file size in decimal. The game server computes the same value from the same
 * bytes; both suites pin one literal.
 */
export function bspFingerprint(header: Uint8Array, size: number): string {
  if (header.length !== HEADER_BYTES) throw new BspError(`a fingerprint needs exactly ${HEADER_BYTES} header bytes`)
  if (!Number.isInteger(size) || size < 0) throw new BspError('a fingerprint needs the file size as a whole number')
  return createHash('sha256').update(`${Buffer.from(header).toString('hex')}:${size}`).digest('hex')
}

export async function readHeader(src: ByteSource): Promise<BspHeader> {
  if (src.size < HEADER_BYTES) throw new BspError(`the file is shorter than the ${HEADER_BYTES}-byte header`)
  const bytes = await src.read(0, HEADER_BYTES)
  if (bytes.length !== HEADER_BYTES) throw new BspError('short read of the header')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'VBSP') throw new BspError('not a Source map (the identifier is not VBSP)')
  const version = dv.getInt32(4, true)
  if (version < 19 || version > 21) throw new BspError(`unsupported map version ${version} (19 to 21 are read)`)

  const lumps: Lump[] = []
  for (let i = 0; i < LUMPS; i++) {
    const at = 8 + i * 16
    const offset = dv.getInt32(at, true)
    const length = dv.getInt32(at + 4, true)
    if (length < 0 || (length > 0 && offset < 0)) throw new BspError(`lump ${i} has a negative offset or length`)
    if (length > 0) {
      if (offset < HEADER_BYTES) throw new BspError(`lump ${i} overlaps the header`)
      if (offset + length > src.size) throw new BspError(`lump ${i} reaches past the end of the file`)
    }
    lumps.push({ index: i, offset, length, version: dv.getInt32(at + 8, true), compressed: dv.getUint32(at + 12, true) !== 0 })
  }
  return { version, revision: dv.getInt32(1032, true), lumps, fingerprint: bspFingerprint(bytes, src.size) }
}

// ---- the surfaces ---------------------------------------------------------------------------------

// The lumps that describe surfaces: where they are in the directory, what they are called in an
// error message, and how many bytes one record takes. Nothing else in the file is ever read.
const NEEDED = [
  { i: 1, name: 'planes', record: 20 }, { i: 3, name: 'vertices', record: 12 }, { i: 6, name: 'texinfo', record: 72 },
  { i: 7, name: 'faces', record: 56 }, { i: 12, name: 'edges', record: 4 }, { i: 13, name: 'surfedges', record: 4 },
  { i: 14, name: 'models', record: 48 },
  { i: 26, name: 'displacement info', record: 176 }, { i: 33, name: 'displacement vertices', record: 20 },
] as const
const L = { PLANES: 1, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14, DISPINFO: 26, DISPVERTS: 33 } as const
const RECORD = { PLANES: 20, VERTEXES: 12, TEXINFO: 72, FACES: 56, EDGES: 4, SURFEDGES: 4, MODELS: 48, DISPINFO: 176, DISPVERTS: 20 } as const

// Faces a player never meets: sky, triggers, nodraw, hints, skip.
const SKIP_FLAGS = 0x4 | 0x2 | 0x40 | 0x80 | 0x100 | 0x200
const FLOOR_NZ = 0.7 // the steepest slope a player can walk up
const MAX_FACE_EDGES = 4096
const MAX_COORD = 131_072 // Source maps are at most +-16384; room to spare, far from float garbage

export interface SurfaceLimits { maxFaces?: number, maxVertices?: number, maxBytes?: number }
const DEFAULT_LIMITS = { maxFaces: 1_000_000, maxVertices: 2_000_000, maxBytes: 64 * 1024 * 1024 }

export interface Surfaces {
  fingerprint: string
  version: number
  revision: number
  /** Triangles as flat x, y, z, x, y, z, ... in whole map units. */
  floors: number[]
  walls: number[]
  stats: {
    faces: number, floorFaces: number, wallFaces: number, ceilingFaces: number, skipped: number, otherModelFaces: number
    /** Displacements (terrain) drawn, and the triangles they made (ceilings among them are dropped like any ceiling). */
    displacements: number, displacementTriangles: number
  }
}

/**
 * The floors (surfaces a player can stand on) and the walls of the world model, as triangles.
 * Ceilings, sky, triggers and the like are left out, and so are doors and lifts (other brush
 * models). A displacement (terrain) is turned into its grid of triangles: the face's four corners
 * are interpolated across the grid and every vertex is pushed along its own direction.
 */
export async function extractSurfaces(src: ByteSource, limits: SurfaceLimits = {}): Promise<Surfaces> {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const header = await readHeader(src)

  // Check every lump before reading any of them.
  let total = 0
  for (const { i, name, record } of NEEDED) {
    const lump = header.lumps[i]!
    if (lump.compressed) throw new BspError(`the ${name} lump is compressed, which is not supported`)
    if (lump.length % record !== 0) throw new BspError(`the ${name} lump is not a whole number of ${record}-byte records`)
    total += lump.length
  }
  if (total > lim.maxBytes) throw new BspError(`the surface lumps are ${total} bytes, over the limit of ${lim.maxBytes}`)

  const data: Record<number, DataView> = {}
  for (const { i, name } of NEEDED) {
    const lump = header.lumps[i]!
    if (lump.length === 0) { data[i] = new DataView(new ArrayBuffer(0)); continue }
    const bytes = await src.read(lump.offset, lump.length)
    if (bytes.length !== lump.length) throw new BspError(`short read of the ${name} lump`)
    data[i] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const count = (i: number, record: number) => header.lumps[i]!.length / record
  const nPlanes = count(L.PLANES, RECORD.PLANES), nVerts = count(L.VERTEXES, RECORD.VERTEXES), nTex = count(L.TEXINFO, RECORD.TEXINFO)
  const nFaces = count(L.FACES, RECORD.FACES), nEdges = count(L.EDGES, RECORD.EDGES), nSurf = count(L.SURFEDGES, RECORD.SURFEDGES)
  const nModels = count(L.MODELS, RECORD.MODELS)
  const nDispInfo = count(L.DISPINFO, RECORD.DISPINFO), nDispVerts = count(L.DISPVERTS, RECORD.DISPVERTS)
  if (nFaces > lim.maxFaces) throw new BspError(`too many faces (${nFaces}, the limit is ${lim.maxFaces})`)
  if (nVerts > lim.maxVertices) throw new BspError(`too many vertices (${nVerts}, the limit is ${lim.maxVertices})`)
  if (nDispVerts > lim.maxVertices) throw new BspError(`too many displacement vertices (${nDispVerts}, the limit is ${lim.maxVertices})`)
  if (nModels < 1) throw new BspError('the map has no world model')

  const planes = data[L.PLANES]!, verts = data[L.VERTEXES]!, tex = data[L.TEXINFO]!, faces = data[L.FACES]!
  const edges = data[L.EDGES]!, surf = data[L.SURFEDGES]!, models = data[L.MODELS]!
  const dispInfo = data[L.DISPINFO]!, dispVerts = data[L.DISPVERTS]!

  // The vertices are checked once, all of them: a corrupt coordinate is refused even if no face uses it.
  const xyz = new Float64Array(nVerts * 3)
  for (let v = 0; v < nVerts * 3; v++) {
    const n = verts.getFloat32(v * 4, true)
    if (!Number.isFinite(n)) throw new BspError(`vertex ${Math.floor(v / 3)} is not a finite number`)
    if (Math.abs(n) > MAX_COORD) throw new BspError(`vertex ${Math.floor(v / 3)} is out of range`)
    xyz[v] = n
  }

  const firstFace = models.getInt32(40, true), numFaces = models.getInt32(44, true)
  if (firstFace < 0 || numFaces < 0 || firstFace + numFaces > nFaces) throw new BspError('the world model names faces that do not exist')
  let otherModelFaces = 0
  for (let m = 1; m < nModels; m++) {
    const n = models.getInt32(m * RECORD.MODELS + 44, true)
    if (n < 0) throw new BspError(`model ${m} has a negative face count`)
    otherModelFaces += n
  }

  const floors: number[] = [], walls: number[] = []
  const stats = { faces: numFaces, floorFaces: 0, wallFaces: 0, ceilingFaces: 0, skipped: 0, otherModelFaces, displacements: 0, displacementTriangles: 0 }
  for (let f = firstFace; f < firstFace + numFaces; f++) {
    const at = f * RECORD.FACES
    const plane = faces.getUint16(at, true), side = faces.getUint8(at + 2)
    const firstEdge = faces.getInt32(at + 4, true), numEdges = faces.getInt16(at + 8, true)
    const texinfo = faces.getInt16(at + 10, true), dispinfo = faces.getInt16(at + 12, true)

    if (plane >= nPlanes) throw new BspError(`face ${f} names a plane that does not exist`)
    if (texinfo < 0 || texinfo >= nTex) throw new BspError(`face ${f} names a texinfo that does not exist`)
    if (numEdges < 3 || numEdges > MAX_FACE_EDGES) throw new BspError(`face ${f} has ${numEdges} edges`)
    if (firstEdge < 0 || firstEdge + numEdges > nSurf) throw new BspError(`face ${f} reaches past the surfedges`)

    if ((tex.getInt32(texinfo * RECORD.TEXINFO + 64, true) & SKIP_FLAGS) !== 0) { stats.skipped++; continue }

    let nx = planes.getFloat32(plane * RECORD.PLANES, true), ny = planes.getFloat32(plane * RECORD.PLANES + 4, true)
    let nz = planes.getFloat32(plane * RECORD.PLANES + 8, true)
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) throw new BspError(`plane ${plane} is not a finite number`)
    if (side) { nx = -nx; ny = -ny; nz = -nz } // the side of the plane the face is on

    // The corners, in order: a surfedge is an edge index, negative when the edge is walked backwards.
    const corner: number[] = []
    for (let k = 0; k < numEdges; k++) {
      const se = surf.getInt32((firstEdge + k) * RECORD.SURFEDGES, true)
      const e = Math.abs(se)
      if (e >= nEdges) throw new BspError(`face ${f} names an edge that does not exist`)
      const v = edges.getUint16(e * RECORD.EDGES + (se < 0 ? 2 : 0), true)
      if (v >= nVerts) throw new BspError(`an edge of face ${f} names a vertex that does not exist`)
      corner.push(v)
    }

    if (dispinfo >= 0) {
      stats.displacements++
      displacement(f, dispinfo, corner, [nx, ny, nz])
      continue
    }

    if (nz <= -FLOOR_NZ + 1e-6) { stats.ceilingFaces++; continue }
    const isFloor = nz + 1e-6 >= FLOOR_NZ
    if (isFloor) stats.floorFaces++; else stats.wallFaces++
    const out = isFloor ? floors : walls
    for (let k = 1; k + 1 < corner.length; k++) {
      for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) out.push(Math.round(xyz[v * 3]!), Math.round(xyz[v * 3 + 1]!), Math.round(xyz[v * 3 + 2]!))
    }
  }

  /**
   * One displacement: the face's four corners are the base quad; the grid starts at the corner
   * nearest `startPosition`; the position of vertex (i, j) is the bilinear interpolation across the
   * quad plus its direction times its distance. Each cell becomes two triangles, the diagonal
   * alternating like a chessboard. A triangle is a floor, a wall or a ceiling by its own slope, with
   * the face's plane deciding which way is "out" (so the order of the corners does not matter).
   */
  function displacement(f: number, index: number, corner: number[], out: [number, number, number]) {
    if (index >= nDispInfo) throw new BspError(`face ${f} names a displacement that does not exist`)
    if (corner.length !== 4) throw new BspError(`face ${f} has a displacement but ${corner.length} corners: a displacement is on a quad`)
    const at = index * RECORD.DISPINFO
    const start = [dispInfo.getFloat32(at, true), dispInfo.getFloat32(at + 4, true), dispInfo.getFloat32(at + 8, true)]
    const vertStart = dispInfo.getInt32(at + 12, true), power = dispInfo.getInt32(at + 20, true)
    if (!start.every(Number.isFinite)) throw new BspError(`displacement ${index} has a start position that is not a finite number`)
    if (power < 2 || power > 4) throw new BspError(`displacement ${index} has power ${power} (2 to 4 are read)`)
    const size = (1 << power) + 1
    if (vertStart < 0 || vertStart + size * size > nDispVerts) throw new BspError(`displacement ${index} reaches past the displacement vertex lump`)

    // The grid starts at the corner nearest the start position.
    const pos = (v: number) => [xyz[v * 3]!, xyz[v * 3 + 1]!, xyz[v * 3 + 2]!] as const
    let first = 0, best = Infinity
    for (let k = 0; k < 4; k++) {
      const p = pos(corner[k]!)
      const d = (p[0] - start[0]!) ** 2 + (p[1] - start[1]!) ** 2 + (p[2] - start[2]!) ** 2
      if (d < best) { best = d; first = k }
    }
    const c = [0, 1, 2, 3].map(k => pos(corner[(first + k) % 4]!))
    const grid = new Float64Array(size * size * 3)
    const last = size - 1
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const left = [0, 1, 2].map(a => c[0]![a]! + (c[1]![a]! - c[0]![a]!) * (i / last))
        const right = [0, 1, 2].map(a => c[3]![a]! + (c[2]![a]! - c[3]![a]!) * (i / last))
        const v = (vertStart + i * size + j) * RECORD.DISPVERTS
        const dist = dispVerts.getFloat32(v + 12, true)
        for (let a = 0; a < 3; a++) {
          const dir = dispVerts.getFloat32(v + a * 4, true)
          const n = left[a]! + (right[a]! - left[a]!) * (j / last) + dir * dist
          if (!Number.isFinite(n)) throw new BspError(`displacement ${index} has a vertex that is not a finite number`)
          if (Math.abs(n) > MAX_COORD) throw new BspError(`displacement ${index} has a vertex out of range`)
          grid[(i * size + j) * 3 + a] = n
        }
      }
    }

    const g = (i: number, j: number) => [grid[(i * size + j) * 3]!, grid[(i * size + j) * 3 + 1]!, grid[(i * size + j) * 3 + 2]!] as const
    const emit = (a: readonly number[], b: readonly number[], d: readonly number[]) => {
      stats.displacementTriangles++
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!]
      let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!)
      if (len < 1e-9) return // a flat-out degenerate triangle covers nothing
      if (n[0]! * out[0] + n[1]! * out[1] + n[2]! * out[2] < 0) n = n.map(x => -x) // point it out of the face
      const nz = n[2]! / len
      if (nz <= -FLOOR_NZ + 1e-6) return // a ceiling
      const target = nz + 1e-6 >= FLOOR_NZ ? floors : walls
      for (const p of [a, b, d]) target.push(Math.round(p[0]!), Math.round(p[1]!), Math.round(p[2]!))
    }
    for (let i = 0; i < last; i++) {
      for (let j = 0; j < last; j++) {
        const A = g(i, j), B = g(i, j + 1), C = g(i + 1, j + 1), D = g(i + 1, j)
        if ((i + j) % 2 === 0) { emit(A, B, C); emit(A, C, D) } else { emit(A, B, D); emit(B, C, D) }
      }
    }
  }

  return { fingerprint: header.fingerprint, version: header.version, revision: header.revision, floors, walls, stats }
}

// ---- the entities we need: spawn points and the 3D skybox camera ---------------------------------

export interface Spawn { class: string, x: number, y: number, z: number }
export interface Point { x: number, y: number, z: number }
export interface SpawnLimits { maxEntities?: number, maxEntityBytes?: number }
const SPAWN_CLASS = /^info_player_[a-z_]+$/

/** An entity's origin as a point, or null unless it is three finite numbers inside any map. */
function originOf(entity: Record<string, string>): Point | null {
  const origin = entity['origin']
  if (!origin) return null
  const parts = origin.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || !parts.every(n => Number.isFinite(n) && Math.abs(n) <= MAX_COORD)) return null
  return { x: parts[0]!, y: parts[1]!, z: parts[2]! }
}

/**
 * Where players start (the `info_player_*` entities) and where the 3D skybox camera is (`sky_camera`,
 * which sits inside the skybox section, far from the map), from the entity lump: a few tens of KB
 * of text, blocks of "key" "value" lines in braces. Only the header and that one lump are read.
 */
export async function extractMapEntities(src: ByteSource, limits: SpawnLimits = {}): Promise<{ spawns: Spawn[], skyCameras: Point[] }> {
  const maxEntities = limits.maxEntities ?? 100_000
  const maxBytes = limits.maxEntityBytes ?? 4 * 1024 * 1024
  const header = await readHeader(src)
  const lump = header.lumps[0]!
  if (lump.compressed) throw new BspError('the entity lump is compressed, which is not supported')
  if (lump.length > maxBytes) throw new BspError(`the entity lump is ${lump.length} bytes, over the limit of ${maxBytes}`)
  const spawns: Spawn[] = [], skyCameras: Point[] = []
  if (lump.length === 0) return { spawns, skyCameras }
  const bytes = await src.read(lump.offset, lump.length)
  if (bytes.length !== lump.length) throw new BspError('short read of the entity lump')
  const text = Buffer.from(bytes).toString('latin1')

  let entity: Record<string, string> | null = null
  let key: string | null = null
  let count = 0
  for (const m of text.matchAll(/"([^"\r\n]*)"|([{}])/g)) {
    const brace = m[2]
    if (brace === '{') {
      if (++count > maxEntities) throw new BspError(`too many entities (the limit is ${maxEntities})`)
      entity = {}; key = null
    } else if (brace === '}') {
      const cls = entity?.['classname']
      const at = entity && cls ? originOf(entity) : null
      if (cls && at) {
        if (SPAWN_CLASS.test(cls)) spawns.push({ class: cls, ...at })
        else if (cls === 'sky_camera') skyCameras.push(at)
      }
      entity = null; key = null
    } else if (entity) {
      if (key === null) key = m[1]!
      else { entity[key] = m[1]!; key = null }
    }
  }
  return { spawns, skyCameras }
}

/** The player spawns of a map (see extractMapEntities). */
export async function extractSpawns(src: ByteSource, limits: SpawnLimits = {}): Promise<Spawn[]> {
  return (await extractMapEntities(src, limits)).spawns
}
