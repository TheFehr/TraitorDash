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
] as const
const L = { PLANES: 1, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14 } as const
const RECORD = { PLANES: 20, VERTEXES: 12, TEXINFO: 72, FACES: 56, EDGES: 4, SURFEDGES: 4, MODELS: 48 } as const

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
  stats: { faces: number, floorFaces: number, wallFaces: number, ceilingFaces: number, skipped: number, displacements: number, otherModelFaces: number }
}

/**
 * The floors (surfaces a player can stand on) and the walls of the world model, as triangles.
 * Ceilings, sky, triggers and the like are left out; so are doors and lifts (other brush models)
 * and displacements (terrain), which are counted in `stats` and not drawn in this version.
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
  if (nFaces > lim.maxFaces) throw new BspError(`too many faces (${nFaces}, the limit is ${lim.maxFaces})`)
  if (nVerts > lim.maxVertices) throw new BspError(`too many vertices (${nVerts}, the limit is ${lim.maxVertices})`)
  if (nModels < 1) throw new BspError('the map has no world model')

  const planes = data[L.PLANES]!, verts = data[L.VERTEXES]!, tex = data[L.TEXINFO]!, faces = data[L.FACES]!
  const edges = data[L.EDGES]!, surf = data[L.SURFEDGES]!, models = data[L.MODELS]!

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
  const stats = { faces: numFaces, floorFaces: 0, wallFaces: 0, ceilingFaces: 0, skipped: 0, displacements: 0, otherModelFaces }
  for (let f = firstFace; f < firstFace + numFaces; f++) {
    const at = f * RECORD.FACES
    const plane = faces.getUint16(at, true), side = faces.getUint8(at + 2)
    const firstEdge = faces.getInt32(at + 4, true), numEdges = faces.getInt16(at + 8, true)
    const texinfo = faces.getInt16(at + 10, true), dispinfo = faces.getInt16(at + 12, true)

    if (plane >= nPlanes) throw new BspError(`face ${f} names a plane that does not exist`)
    if (texinfo < 0 || texinfo >= nTex) throw new BspError(`face ${f} names a texinfo that does not exist`)
    if (numEdges < 3 || numEdges > MAX_FACE_EDGES) throw new BspError(`face ${f} has ${numEdges} edges`)
    if (firstEdge < 0 || firstEdge + numEdges > nSurf) throw new BspError(`face ${f} reaches past the surfedges`)

    if (dispinfo >= 0) { stats.displacements++; continue }
    if ((tex.getInt32(texinfo * RECORD.TEXINFO + 64, true) & SKIP_FLAGS) !== 0) { stats.skipped++; continue }

    const nx = planes.getFloat32(plane * RECORD.PLANES, true), ny = planes.getFloat32(plane * RECORD.PLANES + 4, true)
    const nzRaw = planes.getFloat32(plane * RECORD.PLANES + 8, true)
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nzRaw)) throw new BspError(`plane ${plane} is not a finite number`)
    const nz = side ? -nzRaw : nzRaw
    if (nz <= -FLOOR_NZ + 1e-6) { stats.ceilingFaces++; continue }
    const isFloor = nz + 1e-6 >= FLOOR_NZ
    if (isFloor) stats.floorFaces++; else stats.wallFaces++

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
    const out = isFloor ? floors : walls
    for (let k = 1; k + 1 < corner.length; k++) {
      for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) out.push(Math.round(xyz[v * 3]!), Math.round(xyz[v * 3 + 1]!), Math.round(xyz[v * 3 + 2]!))
    }
  }

  return { fingerprint: header.fingerprint, version: header.version, revision: header.revision, floors, walls, stats }
}
