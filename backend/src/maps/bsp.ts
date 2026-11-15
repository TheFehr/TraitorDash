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
  { i: 2, name: 'texture data', record: 32 }, { i: 44, name: 'texture data string table', record: 4 }, { i: 43, name: 'texture data strings', record: 1 },
  { i: 26, name: 'displacement info', record: 176 }, { i: 33, name: 'displacement vertices', record: 20 },
] as const
const L = { PLANES: 1, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14, DISPINFO: 26, DISPVERTS: 33 } as const
const RECORD = { PLANES: 20, VERTEXES: 12, TEXINFO: 72, FACES: 56, EDGES: 4, SURFEDGES: 4, MODELS: 48, DISPINFO: 176, DISPVERTS: 20 } as const

// Faces a player never meets: sky, triggers, nodraw, hints, skip.
const SKIP_FLAGS = 0x4 | 0x2 | 0x40 | 0x80 | 0x100 | 0x200
// A liquid surface (water, lava, slime): drawn as water, never as a floor (RFC 18, 4.1).
const SURF_WARP = 0x8

/** The surface flags of a texinfo in the BSP format (`SURF_*` of the SDK's bspflags.h), by bit. The coverage record names a face's flags with these (RFC 32). */
export const SURFACE_FLAGS: readonly (readonly [number, string])[] = [
  [0x1, 'LIGHT'], [0x2, 'SKY2D'], [0x4, 'SKY'], [0x8, 'WARP'], [0x10, 'TRANS'], [0x20, 'NOPORTAL'], [0x40, 'TRIGGER'], [0x80, 'NODRAW'],
  [0x100, 'HINT'], [0x200, 'SKIP'], [0x400, 'NOLIGHT'], [0x800, 'BUMPLIGHT'], [0x1000, 'NOSHADOWS'], [0x2000, 'NODECALS'], [0x4000, 'NOCHOP'], [0x8000, 'HITBOX'],
]
const NAMED_FLAGS = SURFACE_FLAGS.reduce((n, [bit]) => n | bit, 0)

/** A face's flags as one name, in the order of the bits (`NOLIGHT|BUMPLIGHT`); `-` for none; bits the format does not name are `OTHER`. */
export const flagSetName = (flags: number): string => {
  const names = SURFACE_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name)
  if ((flags & ~NAMED_FLAGS) !== 0) names.push('OTHER')
  return names.length ? names.join('|') : '-'
}

/**
 * What the face loop counts for the coverage record (RFC 32, 4), for the faces of the world model: by flag set, and by what became of the face. Counting only:
 * nothing here decides anything. `byMaterial` is how many faces were left out for the name of their material, by the rule that did it.
 */
export interface FaceTally {
  worldFaces: number
  byFlags: Record<string, number>
  byOutcome: { floor: number, wall: number, ceiling: number, water: number, displacement: number, skippedByFlag: number, skippedByMaterial: number }
  byMaterial: { sky: number, tools: number }
}

/**
 * Materials that are never a surface a player stands on or walks along, though their flags say nothing (RFC 18, 4.1a):
 * a sky picture pasted on ordinary brushes, the geometry of a 3D skybox, and the helper materials under `tools/`. The
 * rule is narrow on purpose: `skyscraper`, `skybridge` and `skynetmountain` are real buildings in real maps.
 * `material` is the name in the map, lower case.
 */
export const isNotSurfaceMaterial = (material: string): boolean =>
  material.includes('skybox') || /(^|\/)[a-z0-9_]*sky$/.test(material) || material.startsWith('tools/')

/** The brush entities that stand still: their faces are drawn with the world (RFC 18, 4.2). Doors, lifts, trains, buttons and triggers are not. */
/** A brush entity that stands still: which model, and where it stands (its faces are stored around the model's own origin). */
/**
 * A brush entity placed in the world. `movable`: it can move (a door, a lift, a collapsing building), and is drawn where the map file puts it, apart from the rest.
 * `water`: a water brush (RFC 33, 4.2): only its upward liquid faces are kept, as water, and x, y, z already include the move by `startposition`.
 * `decoration`: a brush a player sees and walks through (RFC 33, 4.4): its faces go to a group of their own and are no floors or walls.
 */
export interface Fixture { model: number, x: number, y: number, z: number, pitch: number, yaw: number, roll: number, movable?: boolean, water?: boolean, decoration?: boolean, class?: string, name?: string }

/**
 * A part that can move, as the mesh holds it (RFC 20, 4.2): its triangles are local to the entity's origin (as the map file stores
 * them), and the entity's origin and angles place them. `model` is the number the game gives the entity (`*N`), the join with it.
 */
export interface MovablePart { model: number, class: string, name?: string, x: number, y: number, z: number, pitch: number, yaw: number, roll: number, triangles: number[]
  /** The face each triangle came from (an index into `faces`, as the floors have): its mapping is the texture's own, for coordinates local to the part. */
  faces?: number[] }

/** Source's angles (pitch, yaw, roll, degrees) as a 3 by 3 matrix: a turn by roll about X, then pitch about Y, then yaw about Z (the same as `angleQuaternion` in the mesh writer). */
export function angleMatrix(pitch: number, yaw: number, roll: number): number[] {
  const [sp, cp, sy, cy, sr, cr] = [Math.sin(pitch * Math.PI / 180), Math.cos(pitch * Math.PI / 180), Math.sin(yaw * Math.PI / 180), Math.cos(yaw * Math.PI / 180), Math.sin(roll * Math.PI / 180), Math.cos(roll * Math.PI / 180)]
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ]
}

export const FIXTURE_CLASSES = /^func_(brush|wall|breakable|lod|wall_toggle|breakable_surf|monitor|conveyor|reflective_glass)$/
/** Brush entities that can move: doors, lifts and sliding buildings, turning parts, trains, buttons and levers, pushable crates. Their model sits where the mapper put it (a door shut, a button out). */
export const MOVABLE_CLASSES = /^(func_door|func_door_rotating|func_movelinear|func_rotating|func_tracktrain|func_tanktrain|func_button|func_rot_button|momentary_rot_button|func_physbox|func_physbox_multiplayer)$/
/** The water brush (RFC 33, 4.2): a pool that a map raises or lowers. */
export const WATER_CLASSES = /^func_water_analog$/
/** Brushes a player sees and walks through (RFC 33, 4.4): drawn in a group of their own, never a floor or a wall. */
export const DECORATION_CLASSES = /^func_illusionary$/
const FLOOR_NZ = 0.7 // the steepest slope a player can walk up
const MAX_FACE_EDGES = 4096
const MAX_COORD = 131_072 // Source maps are at most +-16384; room to spare, far from float garbage

export interface SurfaceLimits { maxFaces?: number, maxVertices?: number, maxBytes?: number }
const DEFAULT_LIMITS = { maxFaces: 1_000_000, maxVertices: 2_000_000, maxBytes: 64 * 1024 * 1024 }

/**
 * How a face is textured (RFC 18, 5): the material it names, the two vectors that project a point of the map onto the texture
 * (`u = (x * s[0] + y * s[1] + z * s[2] + s[3]) / width`, and the same with `t` for v), and the size of the texture those are
 * counted in. A brush entity's faces are stored around its own origin, so a face of one carries where it was put.
 */
export interface FaceMapping {
  material: string
  s: number[]
  t: number[]
  width: number
  height: number
  /** For a brush entity: where its origin was put and the turn that was applied (a row-major 3 by 3), so the face's own space can be found again. */
  placed?: { origin: [number, number, number], turn: number[] | null }
}

/** The texture coordinates of a point of the map, for the face mapping it was drawn with (v is down, as in the file of the texture). */
export function mappedUv(m: FaceMapping, x: number, y: number, z: number): [number, number] {
  let px = x, py = y, pz = z
  if (m.placed) {
    const dx = x - m.placed.origin[0], dy = y - m.placed.origin[1], dz = z - m.placed.origin[2], r = m.placed.turn
    // placed = R * local + origin, so local = R^T * (placed - origin)
    if (r) { px = r[0]! * dx + r[3]! * dy + r[6]! * dz; py = r[1]! * dx + r[4]! * dy + r[7]! * dz; pz = r[2]! * dx + r[5]! * dy + r[8]! * dz } else { px = dx; py = dy; pz = dz }
  }
  const w = m.width > 0 ? m.width : 1, h = m.height > 0 ? m.height : 1
  return [(px * m.s[0]! + py * m.s[1]! + pz * m.s[2]! + m.s[3]!) / w, (px * m.t[0]! + py * m.t[1]! + pz * m.t[2]! + m.t[3]!) / h]
}

/** One face of the map as the triangles that came from it remember it: how it is textured (an index into `mappings`). */
export interface FaceRecord {
  mapping: number
  /** A displacement triangle's blend between the two textures of a material that has two (0 the first, 4 the second): the mean of the alpha its corners carry. */
  blend?: number
}

export interface Surfaces {
  fingerprint: string
  version: number
  revision: number
  /** Triangles as flat x, y, z, x, y, z, ... in whole map units. */
  floors: number[]
  walls: number[]
  /** For each triangle of `floors` and of `walls`, the face it came from: an index into `faces`. */
  floorFaces: number[]
  wallFaces: number[]
  faces: FaceRecord[]
  mappings: FaceMapping[]
  /** The upward-facing triangles of liquid surfaces; not floors. */
  water: number[]
  /** The triangles of brush entities that can move (any slope), where the map file puts them. */
  movable: number[]
  /** The triangles of decoration brushes (`func_illusionary`, RFC 33, 4.4), any slope, and for each the face it came from (an index into `faces`, as the floors have). Not floors, not walls. */
  decoration: number[]
  decorationFaces: number[]
  /** The same triangles, a part at a time, local to the part's origin (one entry for each model number). */
  movableParts: MovablePart[]
  /** What the faces of the world model were, for the coverage record (RFC 32). */
  tally: FaceTally
  stats: {
    faces: number, floorFaces: number, wallFaces: number, ceilingFaces: number, skipped: number, otherModelFaces: number
    /** Faces left out because of the name of their material, liquid surfaces seen, and brush-entity models drawn with the world. */
    skippedByMaterial: number, waterFaces: number, fixtureModels: number, movableFaces: number
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
export async function extractSurfaces(src: ByteSource, limits: SurfaceLimits = {}, fixtures: Fixture[] = []): Promise<Surfaces> {
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
  const texData = data[2]!, texTable = data[44]!, texStrings = data[43]!
  const nTexData = count(2, 32), nTexTable = count(44, 4)

  /** The lower-case name of the material of a texinfo. A name that cannot be found is '' (and is no reason to leave a face out). */
  const materialNames = new Map<number, string>()
  const materialOf = (texinfo: number): string => {
    const known = materialNames.get(texinfo)
    if (known !== undefined) return known
    let name = ''
    const di = tex.getInt32(texinfo * RECORD.TEXINFO + 68, true)
    if (di >= 0 && di < nTexData) {
      const ti = texData.getInt32(di * 32 + 12, true)
      if (ti >= 0 && ti < nTexTable) {
        let at = texTable.getInt32(ti * 4, true)
        if (at >= 0) for (; at < texStrings.byteLength && name.length < 256; at++) { const c = texStrings.getUint8(at); if (c === 0) break; name += String.fromCharCode(c) }
      }
    }
    name = name.toLowerCase()
    materialNames.set(texinfo, name)
    return name
  }

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
  // The world model, and the models of the brush entities that stand still. Others (doors, lifts) are counted, not drawn.
  const drawn = new Set<number>([0])
  const standing = new Map<number, Fixture>()
  for (const fx of fixtures) if (Number.isInteger(fx.model) && fx.model > 0 && fx.model < nModels && !standing.has(fx.model)) { drawn.add(fx.model); standing.set(fx.model, fx) }
  const ranges: [number, number, Fixture | null][] = [[firstFace, numFaces, null]]
  let otherModelFaces = 0
  for (let m = 1; m < nModels; m++) {
    const first = models.getInt32(m * RECORD.MODELS + 40, true), n = models.getInt32(m * RECORD.MODELS + 44, true)
    if (n < 0) throw new BspError(`model ${m} has a negative face count`)
    if (drawn.has(m)) {
      if (first < 0 || first + n > nFaces) throw new BspError(`model ${m} names faces that do not exist`)
      ranges.push([first, n, standing.get(m)!])
    } else otherModelFaces += n
  }
  const faceList = function* () { for (const [from, n, fx] of ranges) for (let f = from; f < from + n; f++) yield [f, fx] as const }

  const floors: number[] = [], walls: number[] = [], water: number[] = [], movable: number[] = [], decoration: number[] = []
  const floorFaces: number[] = [], wallFaces: number[] = [], decorationFaces: number[] = []
  const faceRecords: FaceRecord[] = []
  // How each face is textured: one mapping for each texinfo and brush entity (a texinfo is shared by faces of a plane, an entity moves them)
  const mappings: FaceMapping[] = []
  const mappingOf = new Map<string, number>()
  const mappingFor = (texinfo: number, fixture: Fixture | null, turn: number[] | null): number => {
    const key = `${texinfo}|${fixture?.model ?? 0}`
    const known = mappingOf.get(key)
    if (known !== undefined) return known
    const at = texinfo * RECORD.TEXINFO
    const vec = (o: number) => [0, 1, 2, 3].map(k => { const n = tex.getFloat32(at + o + k * 4, true); return Number.isFinite(n) ? n : 0 })
    const di = tex.getInt32(at + 68, true)
    const width = di >= 0 && di < nTexData ? texData.getInt32(di * 32 + 16, true) : 0, height = di >= 0 && di < nTexData ? texData.getInt32(di * 32 + 20, true) : 0
    const m: FaceMapping = { material: materialOf(texinfo), s: vec(0), t: vec(16), width: width > 0 && width <= 16384 ? width : 0, height: height > 0 && height <= 16384 ? height : 0 }
    if (fixture) m.placed = { origin: [fixture.x, fixture.y, fixture.z], turn }
    mappings.push(m)
    mappingOf.set(key, mappings.length - 1)
    return mappings.length - 1
  }
  const parts = new Map<number, MovablePart>()
  const stats = {
    faces: numFaces, floorFaces: 0, wallFaces: 0, ceilingFaces: 0, skipped: 0, otherModelFaces, displacements: 0, displacementTriangles: 0,
    skippedByMaterial: 0, waterFaces: 0, fixtureModels: drawn.size - 1, movableFaces: 0,
  }
  const tally: FaceTally = { worldFaces: 0, byFlags: {}, byOutcome: { floor: 0, wall: 0, ceiling: 0, water: 0, displacement: 0, skippedByFlag: 0, skippedByMaterial: 0 }, byMaterial: { sky: 0, tools: 0 } }
  const flagNames = new Map<number, string>()
  for (const [f, fixture] of faceList()) {
    const at = f * RECORD.FACES
    const plane = faces.getUint16(at, true), side = faces.getUint8(at + 2)
    const firstEdge = faces.getInt32(at + 4, true), numEdges = faces.getInt16(at + 8, true)
    const texinfo = faces.getInt16(at + 10, true), dispinfo = faces.getInt16(at + 12, true)

    if (plane >= nPlanes) throw new BspError(`face ${f} names a plane that does not exist`)
    if (texinfo < 0 || texinfo >= nTex) throw new BspError(`face ${f} names a texinfo that does not exist`)
    if (numEdges < 3 || numEdges > MAX_FACE_EDGES) throw new BspError(`face ${f} has ${numEdges} edges`)
    if (firstEdge < 0 || firstEdge + numEdges > nSurf) throw new BspError(`face ${f} reaches past the surfedges`)

    const flags = tex.getInt32(texinfo * RECORD.TEXINFO + 64, true)
    const world = fixture === null
    if (world) {
      tally.worldFaces++
      let name = flagNames.get(flags)
      if (name === undefined) { name = flagSetName(flags); flagNames.set(flags, name) }
      tally.byFlags[name] = (tally.byFlags[name] ?? 0) + 1
    }
    if ((flags & SKIP_FLAGS) !== 0) { stats.skipped++; if (world) tally.byOutcome.skippedByFlag++; continue }
    if (isNotSurfaceMaterial(materialOf(texinfo))) {
      stats.skippedByMaterial++
      if (world) { tally.byOutcome.skippedByMaterial++; if (materialOf(texinfo).startsWith('tools/')) tally.byMaterial.tools++; else tally.byMaterial.sky++ }
      continue
    }

    let nx = planes.getFloat32(plane * RECORD.PLANES, true), ny = planes.getFloat32(plane * RECORD.PLANES + 4, true)
    let nz = planes.getFloat32(plane * RECORD.PLANES + 8, true)
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) throw new BspError(`plane ${plane} is not a finite number`)
    if (side) { nx = -nx; ny = -ny; nz = -nz } // the side of the plane the face is on
    // A brush entity's faces are stored around its own origin: turned by its angles, then moved to where it stands.
    const turn = fixture && (fixture.pitch !== 0 || fixture.yaw !== 0 || fixture.roll !== 0) ? angleMatrix(fixture.pitch, fixture.yaw, fixture.roll) : null
    if (turn) [nx, ny, nz] = [turn[0]! * nx + turn[1]! * ny + turn[2]! * nz, turn[3]! * nx + turn[4]! * ny + turn[5]! * nz, turn[6]! * nx + turn[7]! * ny + turn[8]! * nz]
    const place = (v: number): [number, number, number] => {
      let x = xyz[v * 3]!, y = xyz[v * 3 + 1]!, z = xyz[v * 3 + 2]!
      if (turn) [x, y, z] = [turn[0]! * x + turn[1]! * y + turn[2]! * z, turn[3]! * x + turn[4]! * y + turn[5]! * z, turn[6]! * x + turn[7]! * y + turn[8]! * z]
      if (fixture) { x += fixture.x; y += fixture.y; z += fixture.z }
      return [Math.round(x), Math.round(y), Math.round(z)]
    }

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

    if (fixture?.movable) {
      // A part that can move is drawn whole, whatever its slope, and takes no part in floors, storeys or parts.
      if (dispinfo >= 0 || (flags & SURF_WARP) !== 0) continue
      stats.movableFaces++
      let part = parts.get(fixture.model)
      if (!part) {
        part = { model: fixture.model, class: fixture.class ?? 'func_door', ...(fixture.name ? { name: fixture.name } : {}), x: fixture.x, y: fixture.y, z: fixture.z, pitch: fixture.pitch, yaw: fixture.yaw, roll: fixture.roll, triangles: [], faces: [] }
        parts.set(fixture.model, part)
      }
      faceRecords.push({ mapping: mappingFor(texinfo, null, null) })
      for (let k = 1; k + 1 < corner.length; k++) {
        part.faces!.push(faceRecords.length - 1)
        for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) {
          movable.push(...place(v))
          // local to the origin, in sixty-fourths of a unit (exact in a float32; whole units where the map has them)
          part.triangles.push(Math.round(xyz[v * 3]! * 64) / 64, Math.round(xyz[v * 3 + 1]! * 64) / 64, Math.round(xyz[v * 3 + 2]! * 64) / 64)
        }
      }
      continue
    }

    if (fixture?.water) {
      // A water brush (RFC 33, 4.2): the liquid faces that look up are the water; its underside and sides are dropped, so it is never a floor, a wall or a storey.
      if ((flags & SURF_WARP) === 0 || dispinfo >= 0) continue
      stats.waterFaces++
      if (nz >= 0.5) for (let k = 1; k + 1 < corner.length; k++) for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) water.push(...place(v))
      continue
    }
    if (fixture?.decoration) {
      // Decoration (RFC 33, 4.4): drawn whatever the slope, in a group of its own; no floor, wall, storey or part comes of it.
      if (dispinfo >= 0 || (flags & SURF_WARP) !== 0) continue
      faceRecords.push({ mapping: mappingFor(texinfo, fixture, turn) })
      for (let k = 1; k + 1 < corner.length; k++) {
        decorationFaces.push(faceRecords.length - 1)
        for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) decoration.push(...place(v))
      }
      continue
    }

    if (dispinfo >= 0) {
      stats.displacements++
      if (world) tally.byOutcome.displacement++
      faceRecords.push({ mapping: mappingFor(texinfo, fixture, turn) })
      displacement(f, dispinfo, corner, [nx, ny, nz], faceRecords.length - 1)
      continue
    }

    if ((flags & SURF_WARP) !== 0) {
      stats.waterFaces++
      if (world) tally.byOutcome.water++
      if (nz >= 0.5) for (let k = 1; k + 1 < corner.length; k++) for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) water.push(...place(v))
      continue
    }
    if (nz <= -FLOOR_NZ + 1e-6) { stats.ceilingFaces++; if (world) tally.byOutcome.ceiling++; continue }
    const isFloor = nz + 1e-6 >= FLOOR_NZ
    if (isFloor) stats.floorFaces++; else stats.wallFaces++
    if (world) tally.byOutcome[isFloor ? 'floor' : 'wall']++
    const out = isFloor ? floors : walls, outFaces = isFloor ? floorFaces : wallFaces
    faceRecords.push({ mapping: mappingFor(texinfo, fixture, turn) })
    const record = faceRecords.length - 1
    for (let k = 1; k + 1 < corner.length; k++) {
      for (const v of [corner[0]!, corner[k]!, corner[k + 1]!]) out.push(...place(v))
      outFaces.push(record)
    }
  }

  /**
   * One displacement: the face's four corners are the base quad; the grid starts at the corner
   * nearest `startPosition`; the position of vertex (i, j) is the bilinear interpolation across the
   * quad plus its direction times its distance. Each cell becomes two triangles, the diagonal
   * alternating like a chessboard. A triangle is a floor, a wall or a ceiling by its own slope, with
   * the face's plane deciding which way is "out" (so the order of the corners does not matter).
   */
  function displacement(f: number, index: number, corner: number[], out: [number, number, number], record: number) {
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
    const alphas = new Float64Array(size * size)
    const last = size - 1
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const left = [0, 1, 2].map(a => c[0]![a]! + (c[1]![a]! - c[0]![a]!) * (i / last))
        const right = [0, 1, 2].map(a => c[3]![a]! + (c[2]![a]! - c[3]![a]!) * (i / last))
        const v = (vertStart + i * size + j) * RECORD.DISPVERTS
        const dist = dispVerts.getFloat32(v + 12, true)
        const alpha = dispVerts.getFloat32(v + 16, true)
        alphas[i * size + j] = Number.isFinite(alpha) ? Math.min(255, Math.max(0, alpha)) : 0
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
    const emit = (ia: readonly [number, number], ib: readonly [number, number], id: readonly [number, number]) => {
      const a = g(...ia), b = g(...ib), d = g(...id)
      stats.displacementTriangles++
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!]
      let n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
      const len = Math.hypot(n[0]!, n[1]!, n[2]!)
      if (len < 1e-9) return // a flat-out degenerate triangle covers nothing
      if (n[0]! * out[0] + n[1]! * out[1] + n[2]! * out[2] < 0) n = n.map(x => -x) // point it out of the face
      const nz = n[2]! / len
      if (nz <= -FLOOR_NZ + 1e-6) return // a ceiling
      const isFloor = nz + 1e-6 >= FLOOR_NZ
      const target = isFloor ? floors : walls
      for (const p of [a, b, d]) target.push(Math.round(p[0]!), Math.round(p[1]!), Math.round(p[2]!))
      // this triangle's own record: the same mapping, and how far it is from the first texture to the second
      const blend = Math.round(((alphas[ia[0] * size + ia[1]]! + alphas[ib[0] * size + ib[1]]! + alphas[id[0] * size + id[1]]!) / 3 / 255) * 4)
      faceRecords.push({ mapping: faceRecords[record]!.mapping, blend })
      ;(isFloor ? floorFaces : wallFaces).push(faceRecords.length - 1)
    }
    for (let i = 0; i < last; i++) {
      for (let j = 0; j < last; j++) {
        const A = [i, j] as const, B = [i, j + 1] as const, C = [i + 1, j + 1] as const, D = [i + 1, j] as const
        if ((i + j) % 2 === 0) { emit(A, B, C); emit(A, C, D) } else { emit(A, B, D); emit(B, C, D) }
      }
    }
  }

  return { fingerprint: header.fingerprint, version: header.version, revision: header.revision, floors, walls, floorFaces, wallFaces, faces: faceRecords, mappings, water, movable, decoration, decorationFaces, movableParts: [...parts.values()].sort((a, b) => a.model - b.model), tally, stats }
}

// ---- the entities we need: spawn points and the 3D skybox camera ---------------------------------

/**
 * What the entity lump holds, for the coverage record (RFC 32): the brush entities (the class and the model `*N` it owns) and how many entities there are of each other class.
 * Names are as the file has them, cut to 64 characters, and not safe to show: `coverageRecord` cleans them. At most `MAX_CENSUS_CLASSES` different classes are kept, the rest are counted in `pointsOther`.
 */
export interface EntityCensus { brush: { class: string, model: number, /** It has a parent entity, which moves it: the extractor does not draw such an entity, whatever its class. */ parented: boolean }[], points: Map<string, number>, pointsOther: number }
const MAX_CENSUS_CLASSES = 5000

export interface Spawn { class: string, x: number, y: number, z: number }
/** A model placed in the map: its path, where it stands, and its angles (pitch, yaw, roll, in degrees). */
export interface Placement { model: string, x: number, y: number, z: number, pitch: number, yaw: number, roll: number }
const PROP_CLASS = /^prop_(dynamic|physics|physics_override|dynamic_override|physics_multiplayer)$/
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

/** An entity's `angles` (pitch, yaw, roll), zero for what is missing or not a number. */
function anglesOf(entity: Record<string, string>): [number, number, number] {
  const a = (entity['angles'] ?? '0 0 0').trim().split(/\s+/).map(Number)
  return [0, 1, 2].map(i => (Number.isFinite(a[i]) ? a[i]! : 0)) as [number, number, number]
}

/** A keyvalue as a finite number, or null for anything else (missing, empty, text). */
function finiteOf(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Is the brush entity hidden when the round starts (RFC 33, 3)? `startdisabled` 1, or `rendermode` 10 (kRenderNone), each read as a finite number. */
export const hiddenAtStart = (entity: Record<string, string>): boolean => finiteOf(entity['startdisabled']) === 1 || finiteOf(entity['rendermode']) === 10

const MAX_WATER_MOVE = 16_384

/**
 * Where a water brush stands at the start of the round (RFC 33, 4.2): its origin moved along `movedir` by `startposition` (0 to 1) times `movedistance` (0 to 16384),
 * anything malformed counting as 0 and anything out of range being limited to it. `movedir` is angles ("pitch yaw roll"), turned into a direction as Source does for a
 * movement direction: the forward vector (1, 0, 0) through the angle matrix. In Source pitch -90 points UP (+90 is down), so `movedir "-90 0 0"` moves the water up.
 */
export function waterOrigin(entity: Record<string, string>, origin: Point): Point {
  const start = Math.min(1, Math.max(0, finiteOf(entity['startposition']) ?? 0))
  const distance = Math.min(MAX_WATER_MOVE, Math.max(0, finiteOf(entity['movedistance']) ?? 0))
  const [pitch, yaw, roll] = (entity['movedir'] ?? '0 0 0').trim().split(/\s+/).map(Number).concat([0, 0, 0]).slice(0, 3).map(n => (Number.isFinite(n) ? n : 0)) as [number, number, number]
  const m = angleMatrix(pitch, yaw, roll)
  const by = start * distance
  return { x: origin.x + m[0]! * by, y: origin.y + m[3]! * by, z: origin.z + m[6]! * by }
}

/**
 * Where players start (the `info_player_*` entities) and where the 3D skybox camera is (`sky_camera`,
 * which sits inside the skybox section, far from the map), from the entity lump: a few tens of KB
 * of text, blocks of "key" "value" lines in braces. Only the header and that one lump are read.
 */
export async function extractMapEntities(src: ByteSource, limits: SpawnLimits = {}): Promise<{ spawns: Spawn[], skyCameras: Point[], fixtureModels: Fixture[], entityProps: Placement[], census: EntityCensus }> {
  const maxEntities = limits.maxEntities ?? 100_000
  const maxBytes = limits.maxEntityBytes ?? 4 * 1024 * 1024
  const header = await readHeader(src)
  const lump = header.lumps[0]!
  if (lump.compressed) throw new BspError('the entity lump is compressed, which is not supported')
  if (lump.length > maxBytes) throw new BspError(`the entity lump is ${lump.length} bytes, over the limit of ${maxBytes}`)
  const spawns: Spawn[] = [], skyCameras: Point[] = [], fixtureModels: Fixture[] = [], entityProps: Placement[] = []
  const census: EntityCensus = { brush: [], points: new Map(), pointsOther: 0 }
  if (lump.length === 0) return { spawns, skyCameras, fixtureModels, entityProps, census }
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
      // Only counted, for the coverage record (RFC 32): a class that owns a model `*N` is a brush entity, any other is a point entity.
      if (entity && cls && cls !== 'worldspawn') {
        const owned = /^\*(\d{1,5})$/.exec(entity['model'] ?? '')
        const name = cls.slice(0, 64)
        if (owned && Number(owned[1]) > 0) census.brush.push({ class: name, model: Number(owned[1]), parented: !!entity['parentname'] })
        else if (census.points.has(name) || census.points.size < MAX_CENSUS_CLASSES) census.points.set(name, (census.points.get(name) ?? 0) + 1)
        else census.pointsOther++
      }
      // A brush entity that stands still names its model `*N` and has no parent that could move it, and is not hidden at the start (RFC 33, 3).
      const water = !!cls && WATER_CLASSES.test(cls), decoration = !!cls && DECORATION_CLASSES.test(cls)
      if (entity && cls && (FIXTURE_CLASSES.test(cls) || MOVABLE_CLASSES.test(cls) || water || decoration) && /^\*\d{1,5}$/.test(entity['model'] ?? '') && !entity['parentname'] && !hiddenAtStart(entity)) {
        const o = originOf(entity!) ?? { x: 0, y: 0, z: 0 }
        const a = anglesOf(entity!)
        const at = water ? waterOrigin(entity!, o) : o
        fixtureModels.push({ model: Number(entity['model']!.slice(1)), ...at, pitch: a[0], yaw: a[1], roll: a[2], ...(MOVABLE_CLASSES.test(cls) ? { movable: true, class: cls, ...(entity['targetname'] ? { name: entity['targetname'].slice(0, 80) } : {}) } : {}), ...(water ? { water: true } : {}), ...(decoration ? { decoration: true } : {}) })
      }
      const at = entity && cls ? originOf(entity) : null
      if (cls && at) {
        if (SPAWN_CLASS.test(cls)) spawns.push({ class: cls, ...at })
        else if (PROP_CLASS.test(cls) && /^models\/[^\0]{1,200}\.mdl$/i.test(entity?.['model'] ?? '')) {
          const [pitch, yaw, roll] = anglesOf(entity!)
          if (entityProps.length < 20_000) entityProps.push({ model: entity!['model']!.toLowerCase(), ...at, pitch, yaw, roll })
        }
        else if (cls === 'sky_camera') skyCameras.push(at)
      }
      entity = null; key = null
    } else if (entity) {
      // Keys are read in lower case: Hammer writes `StartDisabled` and `WaveHeight` with capitals and `origin` without, and the lookups above are all lower case (RFC 33: the hidden-at-start rule never fired on real maps while keys kept their case).
      if (key === null) key = m[1]!.toLowerCase()
      else { entity[key] = m[1]!; key = null }
    }
  }
  return { spawns, skyCameras, fixtureModels, entityProps, census }
}

/** The player spawns of a map (see extractMapEntities). */
export async function extractSpawns(src: ByteSource, limits: SpawnLimits = {}): Promise<Spawn[]> {
  return (await extractMapEntities(src, limits)).spawns
}
