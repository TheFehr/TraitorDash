import { Document, NodeIO } from '@gltf-transform/core'
import { storeyModel, storeyCoverage } from './levels'
import { MESH_VERSION } from './meshVersion'
import { mappedUv, type FaceMapping, type FaceRecord } from './bsp'
import { angleMatrix, type MovablePart } from './bsp'

// RFC 11, 3.6: the map's exact geometry as glTF 2.0 (GLB), an existing standard, not a format of our
// own. One scene; a root node that turns Source's Z-up into glTF's Y-up; one node per level (the
// storeys of RFC 10), each with a `floors` and a `walls` primitive in two materials. Coordinates stay
// whole Source units. The tests check every file with the Khronos reference validator.

export { MESH_VERSION }

export interface Bounds { minX: number, maxX: number, minY: number, maxY: number }

export const expandBounds = (b: Bounds, margin: number): Bounds =>
  ({ minX: b.minX - margin, maxX: b.maxX + margin, minY: b.minY - margin, maxY: b.maxY + margin })

/** The cells of a trace plan (RFC 10) that have a floor, as the box around them. null for a plan without floors. */
export function planBounds(grid: { cell: number, minx: number, miny: number, nx: number, ny: number, rows: string[] }): Bounds | null {
  let minI = Infinity, maxI = -1, minJ = Infinity, maxJ = -1
  grid.rows.forEach((row, j) => row.split('|').forEach((cell, i) => {
    if (cell === '') return
    minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j)
  }))
  if (maxI < 0) return null
  return {
    minX: grid.minx + minI * grid.cell, maxX: grid.minx + (maxI + 1) * grid.cell,
    minY: grid.miny + minJ * grid.cell, maxY: grid.miny + (maxJ + 1) * grid.cell,
  }
}

/** The box around the spawn points. null without any. */
export function spawnBounds(spawns: { x: number, y: number }[]): Bounds | null {
  if (spawns.length === 0) return null
  return {
    minX: Math.min(...spawns.map(s => s.x)), maxX: Math.max(...spawns.map(s => s.x)),
    minY: Math.min(...spawns.map(s => s.y)), maxY: Math.max(...spawns.map(s => s.y)),
  }
}

/** Keeps the triangles whose centre lies inside `b` (the edge counts as inside). `soup` is x, y, z per corner, three corners per triangle. */
export function cropTriangles(soup: number[], b: Bounds): number[] {
  const out: number[] = []
  for (let i = 0; i < soup.length; i += 9) {
    const cx = (soup[i]! + soup[i + 3]! + soup[i + 6]!) / 3
    const cy = (soup[i + 1]! + soup[i + 4]! + soup[i + 7]!) / 3
    if (cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY) for (let k = 0; k < 9; k++) out.push(soup[i + k]!)
  }
  return out
}

/**
 * Keeps the triangles of a group (water) whose centre lies within `margin` units of the box around `around`
 * (the floors and walls that were kept). A 3D skybox has water of its own, far from the map.
 */
export function nearTriangles(soup: number[], around: number[][], margin: number): number[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of around) for (let i = 0; i < a.length; i += 3) {
    minX = Math.min(minX, a[i]!); maxX = Math.max(maxX, a[i]!); minY = Math.min(minY, a[i + 1]!); maxY = Math.max(maxY, a[i + 1]!)
  }
  if (!Number.isFinite(minX)) return []
  return cropTriangles(soup, { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin })
}

/** The models placed in a map (RFC 18, 4.3): each distinct model once, and every place it stands. */
export interface PropSet {
  models: {
    name: string, solid: number[], foliage: number[]
    /** The texture coordinates of `foliage` (u, v for each corner) and the runs of triangles, each with a material of `leafMaterials` (-1: none, drawn grey). */
    foliageUv?: number[]
    foliageRuns?: { material: number, triangles: number }[]
  }[]
  /** The materials of the leaves (RFC 18, 4.6): the texture that cuts them out (an index into `leafTextures`), and how it is used. */
  leafMaterials?: { name: string, texture: number, mode: 'mask' | 'blend', alpha: number }[]
  leafTextures?: { name: string, width: number, height: number, png: Uint8Array }[]
  /** `model` is an index into `models`; the angles are Source's pitch, yaw, roll in degrees. */
  placements: { model: number, x: number, y: number, z: number, pitch: number, yaw: number, roll: number }[]
}

/** Source's angles (pitch, yaw, roll, degrees) as a quaternion x, y, z, w: a turn by roll about X, then pitch about Y, then yaw about Z. */
export function angleQuaternion(pitch: number, yaw: number, roll: number): [number, number, number, number] {
  const h = Math.PI / 360
  const [sp, cp, sy, cy, sr, cr] = [Math.sin(pitch * h), Math.cos(pitch * h), Math.sin(yaw * h), Math.cos(yaw * h), Math.sin(roll * h), Math.cos(roll * h)]
  // q = qz(yaw) * qy(pitch) * qx(roll)
  return [
    cy * cp * sr - sy * sp * cr,
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * cr + sy * sp * sr,
  ]
}

export interface MeshLevel { index: number, lo: number, hi: number, floorTriangles: number, wallTriangles: number }
export interface GlbInfo {
  vertices: number
  triangles: number
  /** Triangles that collapsed to a line or a point when the coordinates were rounded to whole units. */
  droppedDegenerate: number
  levels: MeshLevel[]
  /** Triangles of the water group (not counted in `triangles`' levels, and not part of the level model). */
  waterTriangles: number
  /** False when the floor is spread over all heights (a hill, a terrain) rather than at a few storeys: the levels are then only a list (RFC 18, 4.4). */
  storeys: boolean
  /** The triangles and the number of parts that are detached (drawn in a group of their own, hidden by default). */
  detached: { triangles: number, parts: number }
  /** Triangles of the parts that can move (doors, lifts, a collapsing building): a group of their own, in a colour of their own. */
  movable: number
  /** Spawn points written into the file. */
  spawns: number
  /** Textures and materials of the floors and walls (RFC 18, 5), when they have them. */
  surface?: { textures: number, materials: number, texturedTriangles: number, colouredTriangles: number }
  /** What was placed: places, distinct models, and the triangles drawn (every place counts its model's triangles). */
  props: { placements: number, models: number, triangles: number, /** Textures written for the leaves. */ textures?: number }
  /** Triangles removed by the crop. */
  cropped: { floors: number, walls: number }
}

/** Parts of the map that are not near the rest (RFC 18, 4.4): outside the level model, in a group of their own. */
export interface DetachedParts { floors: number[], walls: number[], parts: { triangles: number, min: number[], max: number[] }[] }
export interface MeshSpawn { class: string, x: number, y: number, z: number }
/** A material of the surfaces of the map (RFC 18, 5): a texture to cut and tile, or a plain colour when its texture is not worth a file. */
export interface SurfaceMaterial {
  name: string
  /** An index into `SurfaceTextures.textures`, or null for a plain colour. */
  texture: number | null
  /** The average colour of the texture (sRGB, 0 to 1), for a material with no texture of its own. */
  colour: [number, number, number] | null
  mode: 'opaque' | 'mask' | 'blend'
  alpha: number
}
/** How the floors and the walls are textured: for each triangle how it is mapped, and what each mapping is drawn with. */
export interface SurfaceTextures {
  /** One entry for each triangle of `floors` and of `walls`: the number of the face it came from. */
  floorFaces: number[]
  wallFaces: number[]
  faces: FaceRecord[]
  mappings: FaceMapping[]
  /** For each mapping, an index into `materials`, or -1 (drawn as the plain floor or wall). */
  materialOf: number[]
  materials: SurfaceMaterial[]
  textures: { name: string, width: number, height: number, png: Uint8Array }[]
}
export interface MeshInput { surface?: SurfaceTextures, floors: number[], walls: number[], water?: number[], movable?: number[], movableParts?: MovablePart[], detached?: DetachedParts, spawns?: MeshSpawn[], props?: PropSet, fingerprint: string, version: number, revision: number }
/** A map has storeys when at least this share of its floor lies within 48 units of the height of one (see `storeyCoverage`). */
export const STOREY_COVERAGE = 0.6
const MAX_SPAWNS = 512
export interface MeshOptions {
  map: string
  /** The playable area (already including any margin). Triangles whose centre is outside are left out. */
  crop?: Bounds
  /** The grid cell, in units, that the level model counts ground in (RFC 10 uses 64). */
  cell?: number
}

const check = (soup: number[], what: string) => {
  if (soup.length % 9 !== 0) throw new RangeError(`${what} must be triangles of three corners of three numbers each`)
  for (const n of soup) if (!Number.isFinite(n)) throw new RangeError(`${what} contains a number that is not finite`)
}

/** The triangles of a soup with the numbers given, in that order. */
export const pickTriangles = (soup: number[], which: number[]): number[] => {
  const out: number[] = []
  for (const t of which) for (let k = 0; k < 9; k++) out.push(soup[t * 9 + k]!)
  return out
}
/** What goes with each triangle (one number for each), for the same numbers. */
export const pickTags = (tags: number[], which: number[]): number[] => which.map(t => tags[t]!)

/** The numbers of the triangles `cropTriangles` keeps. */
export function croppedTriangles(soup: number[], b: Bounds): number[] {
  const out: number[] = []
  for (let i = 0, t = 0; i < soup.length; i += 9, t++) {
    const cx = (soup[i]! + soup[i + 3]! + soup[i + 6]!) / 3
    const cy = (soup[i + 1]! + soup[i + 4]! + soup[i + 7]!) / 3
    if (cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY) out.push(t)
  }
  return out
}

/** The numbers of the triangles `withoutDegenerate` keeps. */
function areaTriangles(soup: number[]): number[] {
  const out: number[] = []
  for (let i = 0, t = 0; i < soup.length; i += 9, t++) {
    const ux = soup[i + 3]! - soup[i]!, uy = soup[i + 4]! - soup[i + 1]!, uz = soup[i + 5]! - soup[i + 2]!
    const vx = soup[i + 6]! - soup[i]!, vy = soup[i + 7]! - soup[i + 1]!, vz = soup[i + 8]! - soup[i + 2]!
    if (!(uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0)) out.push(t)
  }
  return out
}

/** Drops triangles that have no area (two equal corners, or all three on a line). */
function withoutDegenerate(soup: number[]): { kept: number[], dropped: number } {
  const kept: number[] = []
  let dropped = 0
  for (let i = 0; i < soup.length; i += 9) {
    const ux = soup[i + 3]! - soup[i]!, uy = soup[i + 4]! - soup[i + 1]!, uz = soup[i + 5]! - soup[i + 2]!
    const vx = soup[i + 6]! - soup[i]!, vy = soup[i + 7]! - soup[i + 1]!, vz = soup[i + 8]! - soup[i + 2]!
    if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) { dropped++; continue }
    for (let k = 0; k < 9; k++) kept.push(soup[i + k]!)
  }
  return { kept, dropped }
}

/**
 * The triangles cut at the given heights, so that every piece lies between two of them. Wall
 * triangles are big and slanted (a fan of one tall face spans many storeys); sorting whole
 * triangles into a storey by their centre made a face half there and half missing when a storey is
 * hidden. Cut pieces share their cut corners exactly, as each edge is cut the same way from either side.
 */
export function splitAtHeights(soup: number[], heights: number[]): number[] {
  return splitAtHeightsFrom(soup, heights).soup
}

/** The same, and for each triangle of the result the number of the triangle it is a piece of (for what goes with a triangle: its texture). */
export function splitAtHeightsFrom(soup: number[], heights: number[]): { soup: number[], from: number[] } {
  if (heights.length === 0) return { soup, from: Array.from({ length: soup.length / 9 }, (_, t) => t) }
  const out: number[] = [], from: number[] = []
  type P = [number, number, number]
  const cut = (a: P, b: P, h: number): P => {
    const [lo, hi] = a[2] < b[2] || (a[2] === b[2] && (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]))) ? [a, b] : [b, a]
    const t = (h - lo[2]) / (hi[2] - lo[2])
    return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, h]
  }
  // Keep the part of a convex polygon above (keepAbove) or below the height h.
  const clip = (poly: P[], h: number, keepAbove: boolean): P[] => {
    const res: P[] = []
    const inside = (p: P) => (keepAbove ? p[2] >= h : p[2] <= h)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!
      const ia = inside(a), ib = inside(b)
      if (ia) res.push(a)
      if (ia !== ib && a[2] !== h && b[2] !== h) res.push(cut(a, b, h))
    }
    return res
  }
  for (let i = 0; i < soup.length; i += 9) {
    const tri: P[] = [[soup[i]!, soup[i + 1]!, soup[i + 2]!], [soup[i + 3]!, soup[i + 4]!, soup[i + 5]!], [soup[i + 6]!, soup[i + 7]!, soup[i + 8]!]]
    const zmin = Math.min(tri[0]![2], tri[1]![2], tri[2]![2]), zmax = Math.max(tri[0]![2], tri[1]![2], tri[2]![2])
    const inner = heights.filter(h => h > zmin && h < zmax)
    if (inner.length === 0) { out.push(...soup.slice(i, i + 9)); from.push(i / 9); continue }
    const edges = [-Infinity, ...inner, Infinity]
    for (let s = 0; s + 1 < edges.length; s++) {
      let poly = tri
      if (edges[s]! > -Infinity) poly = clip(poly, edges[s]!, true)
      if (edges[s + 1]! < Infinity) poly = clip(poly, edges[s + 1]!, false)
      for (let k = 1; k + 1 < poly.length; k++) { for (const p of [poly[0]!, poly[k]!, poly[k + 1]!]) out.push(p[0], p[1], p[2]); from.push(i / 9) }
    }
  }
  return { soup: out, from }
}

/** Indexed vertices from a triangle soup: identical corners are one vertex. */
function indexed(soup: number[]) {
  const ids = new Map<string, number>()
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`
    let id = ids.get(key)
    if (id === undefined) { id = positions.length / 3; ids.set(key, id); positions.push(soup[i]!, soup[i + 1]!, soup[i + 2]!) }
    indices.push(id)
  }
  return { positions: new Float32Array(positions), indices: positions.length / 3 > 65_535 ? new Uint32Array(indices) : new Uint16Array(indices) }
}

/** The same with a texture coordinate for each corner: corners with the same place and the same coordinate are one vertex. */
function indexedUv(soup: number[], uvs: number[]) {
  const ids = new Map<string, number>()
  const positions: number[] = [], coords: number[] = [], indices: number[] = []
  for (let i = 0; i < soup.length / 3; i++) {
    const key = `${soup[i * 3]},${soup[i * 3 + 1]},${soup[i * 3 + 2]},${uvs[i * 2]},${uvs[i * 2 + 1]}`
    let id = ids.get(key)
    if (id === undefined) { id = positions.length / 3; ids.set(key, id); positions.push(soup[i * 3]!, soup[i * 3 + 1]!, soup[i * 3 + 2]!); coords.push(uvs[i * 2]!, uvs[i * 2 + 1]!) }
    indices.push(id)
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(coords), indices: positions.length / 3 > 65_535 ? new Uint32Array(indices) : new Uint16Array(indices) }
}

/**
 * The surfaces as a GLB, with a summary of what is in it. null when there is nothing to draw (no
 * triangles at all, or the crop took them all). Throws for input that is not triangles.
 */
export async function surfacesToGlb(s: MeshInput, opts: MeshOptions): Promise<{ glb: Uint8Array, info: GlbInfo } | null> {
  check(s.floors, 'floors'); check(s.walls, 'walls'); if (s.movable) check(s.movable, 'movable')
  for (const p of s.movableParts ?? []) check(p.triangles, `movable part ${p.model}`)
  const cell = opts.cell ?? 64

  let floors = s.floors, walls = s.walls
  let floorTags = s.surface?.floorFaces, wallTags = s.surface?.wallFaces
  if (s.surface && (floorTags!.length !== floors.length / 9 || wallTags!.length !== walls.length / 9)) throw new RangeError('the textures must have one mapping for each triangle of the floors and of the walls')
  const cropped = { floors: 0, walls: 0 }
  // What each step keeps, as the numbers of the triangles, so that what goes with a triangle (its mapping) goes with it
  const keep = (which: number[], soup: number[], tags: number[] | undefined) => ({ soup: pickTriangles(soup, which), tags: tags && pickTags(tags, which) })
  if (opts.crop) {
    const f = keep(croppedTriangles(floors, opts.crop), floors, floorTags), w = keep(croppedTriangles(walls, opts.crop), walls, wallTags)
    cropped.floors = (floors.length - f.soup.length) / 9; cropped.walls = (walls.length - w.soup.length) / 9
    floors = f.soup; floorTags = f.tags; walls = w.soup; wallTags = w.tags
  }
  const fArea = keep(areaTriangles(floors), floors, floorTags), wArea = keep(areaTriangles(walls), walls, wallTags)
  const dropped = (floors.length - fArea.soup.length + walls.length - wArea.soup.length) / 9
  floors = fArea.soup; floorTags = fArea.tags; walls = wArea.soup; wallTags = wArea.tags
  if (floors.length === 0 && walls.length === 0) return null
  const water = withoutDegenerate(s.water ?? []).kept

  // The levels: floors weighted by the ground they cover, in grid cells (RFC 10 4.5).
  const centre = (soup: number[], i: number) => (soup[i + 2]! + soup[i + 5]! + soup[i + 8]!) / 3
  const area2d = (soup: number[], i: number) => Math.abs((soup[i + 3]! - soup[i]!) * (soup[i + 7]! - soup[i + 1]!) - (soup[i + 6]! - soup[i]!) * (soup[i + 4]! - soup[i + 1]!)) / 2
  const heights: number[] = [], weights: number[] = []
  for (let i = 0; i < floors.length; i += 9) { heights.push(centre(floors, i)); weights.push(area2d(floors, i) / (cell * cell)) }
  const model = storeyModel(heights, weights)
  const storeys = heights.length === 0 || storeyCoverage(heights, weights, model.peaks) >= STOREY_COVERAGE
  const count = Math.max(1, model.levels.length)
  const byLevel = Array.from({ length: count }, () => ({ floors: [] as number[], walls: [] as number[], floorTags: [] as number[], wallTags: [] as number[] }))
  for (let i = 0, n = 0; i < floors.length; i += 9, n++) { const lv = byLevel[model.storeyOf(heights[n]!)]!; lv.floors.push(...floors.slice(i, i + 9)); if (floorTags) lv.floorTags.push(floorTags[n]!) }
  const split = splitAtHeightsFrom(walls, model.bounds)
  const splitTags = wallTags && split.from.map(t => wallTags![t]!)
  const wSplit = keep(areaTriangles(split.soup), split.soup, splitTags)
  walls = wSplit.soup; wallTags = wSplit.tags
  for (let i = 0, n = 0; i < walls.length; i += 9, n++) { const lv = byLevel[model.levels.length ? model.storeyOf(centre(walls, i)) : 0]!; lv.walls.push(...walls.slice(i, i + 9)); if (wallTags) lv.wallTags.push(wallTags[n]!) }

  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene(opts.map)
  const root = doc.createNode('z-up').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]) // Source is Z-up, glTF is Y-up
  scene.addChild(root)
  const material = (name: string, rgb: [number, number, number]) => doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
  const mats = { floor: material('floor', [0.2, 0.7, 0.3]), wall: material('wall', [0.6, 0.6, 0.65]) }
  // Parts that can move are orange in every colouring, so they cannot be taken for the fixed map.
  const movableMat = material('movable', [0.93, 0.5, 0.12])
  const waterMat = doc.createMaterial('water').setBaseColorFactor([0.23, 0.49, 0.65, 0.55]).setAlphaMode('BLEND').setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)

  // The materials of the surfaces (RFC 18, 5): a texture cut as the file says, or a plain colour; the same material is one for the floors and one for the walls
  const surface = s.surface
  const textures = (surface?.textures ?? []).map(t => doc.createTexture(t.name).setImage(t.png).setMimeType('image/png'))
  const surfaceMaterials = new Map<string, ReturnType<typeof doc.createMaterial>>()
  let texturedTriangles = 0, colouredTriangles = 0
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const surfaceMaterial = (kind: 'floor' | 'wall', index: number) => {
    const key = `${kind}|${index}`
    let mat = surfaceMaterials.get(key)
    if (!mat) {
      const def = surface!.materials[index]!
      mat = doc.createMaterial(kind).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true).setExtras({ surface: def.texture !== null ? 'texture' : 'colour', material: def.name })
      if (def.texture !== null) {
        mat.setBaseColorFactor([1, 1, 1, def.mode === 'blend' ? def.alpha : 1]).setBaseColorTexture(textures[def.texture]!)
        if (def.mode === 'mask') mat.setAlphaMode('MASK').setAlphaCutoff(0.5)
        else if (def.mode === 'blend') mat.setAlphaMode('BLEND')
      } else {
        const c = def.colour ?? [0.6, 0.6, 0.6]
        mat.setBaseColorFactor([linear(c[0]), linear(c[1]), linear(c[2]), 1])
      }
      surfaceMaterials.set(key, mat)
    }
    return mat
  }

  const info: GlbInfo = { vertices: 0, triangles: 0, droppedDegenerate: dropped, levels: [], storeys, detached: { triangles: 0, parts: 0 }, movable: 0, spawns: 0, waterTriangles: 0, props: { placements: 0, models: 0, triangles: 0 }, cropped }
  byLevel.forEach((lv) => {
    if (lv.floors.length === 0 && lv.walls.length === 0) return
    const index = info.levels.length + 1
    const name = `level-${index}`
    const mesh = doc.createMesh(name)
    for (const [kind, soup, tags] of [['floor', lv.floors, lv.floorTags], ['wall', lv.walls, lv.wallTags]] as const) {
      if (soup.length === 0) continue
      // A surface with textures is cut into a primitive for each material (none: the plain floor or wall as before)
      const groups = new Map<number, number[]>()
      for (let t = 0; t < soup.length / 9; t++) {
        const material = surface ? surface.materialOf[surface.faces[tags[t]!]!.mapping] ?? -1 : -1
        const list = groups.get(material)
        if (list) list.push(t); else groups.set(material, [t])
      }
      let k = 0
      for (const [material, triangles] of groups) {
        const part = pickTriangles(soup, triangles)
        const prim = doc.createPrimitive()
        const def = material >= 0 ? surface!.materials[material] : undefined
        if (def && def.texture !== null) {
          // the coordinates of each corner from where it is, as the file of the map projects them; a whole number of tiles is taken off a
          // triangle (the picture repeats) so that the numbers stay small
          const uvs: number[] = []
          triangles.forEach((t, n) => {
            const mp = surface!.mappings[surface!.faces[tags[t]!]!.mapping]!
            const c = [0, 1, 2].map(i => mappedUv(mp, part[n * 9 + i * 3]!, part[n * 9 + i * 3 + 1]!, part[n * 9 + i * 3 + 2]!))
            const du = Math.floor(Math.min(c[0]![0], c[1]![0], c[2]![0])), dv = Math.floor(Math.min(c[0]![1], c[1]![1], c[2]![1]))
            for (const [u, v] of c) uvs.push(u - du, v - dv)
          })
          const { positions, uvs: coords, indices } = indexedUv(part, uvs)
          info.vertices += positions.length / 3; info.triangles += indices.length / 3; texturedTriangles += indices.length / 3
          prim.setMaterial(surfaceMaterial(kind, material))
            .setAttribute('POSITION', doc.createAccessor(`${name}-${kind}-positions-${k}`).setType('VEC3').setArray(positions).setBuffer(buffer))
            .setAttribute('TEXCOORD_0', doc.createAccessor(`${name}-${kind}-uv-${k}`).setType('VEC2').setArray(coords).setBuffer(buffer))
            .setIndices(doc.createAccessor(`${name}-${kind}-indices-${k}`).setType('SCALAR').setArray(indices).setBuffer(buffer))
        } else {
          const { positions, indices } = indexed(part)
          info.vertices += positions.length / 3; info.triangles += indices.length / 3
          if (def) colouredTriangles += indices.length / 3
          prim.setMaterial(def ? surfaceMaterial(kind, material) : mats[kind])
            .setAttribute('POSITION', doc.createAccessor(`${name}-${kind}-positions-${k}`).setType('VEC3').setArray(positions).setBuffer(buffer))
            .setIndices(doc.createAccessor(`${name}-${kind}-indices-${k}`).setType('SCALAR').setArray(indices).setBuffer(buffer))
        }
        mesh.addPrimitive(prim)
        k++
      }
    }
    // The heights of the level: those of the corners of its floors, or of its walls when there are no floors at all.
    const zs = lv.floors.length ? lv.floors.filter((_, i) => i % 3 === 2) : lv.walls.filter((_, i) => i % 3 === 2)
    const level: MeshLevel = {
      index, lo: Math.min(...zs), hi: Math.max(...zs),
      floorTriangles: lv.floors.length / 9, wallTriangles: lv.walls.length / 9,
    }
    info.levels.push(level)
    root.addChild(doc.createNode(name).setMesh(mesh).setExtras({ level: level.index, lo: level.lo, hi: level.hi, floorTriangles: level.floorTriangles, wallTriangles: level.wallTriangles }))
  })

  // The water: one mesh of its own, outside the levels (it is not a floor and a level cutaway does not cut it).
  if (water.length > 0) {
    const { positions, indices } = indexed(water)
    info.vertices += positions.length / 3; info.waterTriangles = indices.length / 3
    const mesh = doc.createMesh('water').addPrimitive(doc.createPrimitive().setMaterial(waterMat)
      .setAttribute('POSITION', doc.createAccessor('water-positions').setType('VEC3').setArray(positions).setBuffer(buffer))
      .setIndices(doc.createAccessor('water-indices').setType('SCALAR').setArray(indices).setBuffer(buffer)))
    root.addChild(doc.createNode('water').setMesh(mesh).setExtras({ group: 'water', triangles: info.waterTriangles }))
  }

  // The parts that can move: a group outside the levels (they are not floors and make no storeys), cut like them. With the
  // parts given, one child node for each, its triangles local to the part's origin and the node placed by the part's origin and
  // angles (RFC 20, 4.2), so a viewer can move it; without them, one mesh of the world-space triangles.
  const movableGroup = (triangles: number) => ({ group: 'movable', triangles })
  if (s.movableParts && s.movableParts.length > 0) {
    const group = doc.createNode('movable')
    let triangles = 0, count = 0
    for (const p of s.movableParts) {
      // The crop keeps a triangle whose centre, once placed, is inside it.
      let soup = p.triangles
      if (opts.crop) {
        const m = angleMatrix(p.pitch, p.yaw, p.roll)
        const kept: number[] = []
        for (let i = 0; i < soup.length; i += 9) {
          const cx = (soup[i]! + soup[i + 3]! + soup[i + 6]!) / 3, cy = (soup[i + 1]! + soup[i + 4]! + soup[i + 7]!) / 3, cz = (soup[i + 2]! + soup[i + 5]! + soup[i + 8]!) / 3
          const wx = m[0]! * cx + m[1]! * cy + m[2]! * cz + p.x, wy = m[3]! * cx + m[4]! * cy + m[5]! * cz + p.y
          if (wx >= opts.crop.minX && wx <= opts.crop.maxX && wy >= opts.crop.minY && wy <= opts.crop.maxY) for (let k = 0; k < 9; k++) kept.push(soup[i + k]!)
        }
        soup = kept
      }
      soup = withoutDegenerate(soup).kept
      if (soup.length === 0) continue
      const { positions, indices } = indexed(soup)
      info.vertices += positions.length / 3
      const name = `movable-${p.model}`
      const mesh = doc.createMesh(name).addPrimitive(doc.createPrimitive().setMaterial(movableMat)
        .setAttribute('POSITION', doc.createAccessor(`${name}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor(`${name}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer)))
      const n = soup.length / 9
      triangles += n; count++
      group.addChild(doc.createNode(name).setMesh(mesh).setTranslation([p.x, p.y, p.z]).setRotation(angleQuaternion(p.pitch, p.yaw, p.roll))
        .setExtras({ model: p.model, class: p.class, ...(p.name ? { name: p.name } : {}), origin: [p.x, p.y, p.z], angles: [p.pitch, p.yaw, p.roll], triangles: n }))
    }
    if (count > 0) {
      info.movable = triangles
      root.addChild(group.setExtras({ ...movableGroup(triangles), parts: count }))
    }
  } else {
    const movableSoup = withoutDegenerate(opts.crop ? cropTriangles(s.movable ?? [], opts.crop) : s.movable ?? []).kept
    if (movableSoup.length > 0) {
      const { positions, indices } = indexed(movableSoup)
      info.vertices += positions.length / 3
      const mesh = doc.createMesh('movable')
      mesh.addPrimitive(doc.createPrimitive().setMaterial(movableMat)
        .setAttribute('POSITION', doc.createAccessor('movable-positions').setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor('movable-indices').setType('SCALAR').setArray(indices).setBuffer(buffer)))
      info.movable = movableSoup.length / 9
      root.addChild(doc.createNode('movable').setMesh(mesh).setExtras(movableGroup(info.movable)))
    }
  }

  // The detached parts: a group of their own, outside the levels, so they neither make storeys nor take part in the cutaway.
  const detached = s.detached ? { floors: withoutDegenerate(s.detached.floors).kept, walls: withoutDegenerate(s.detached.walls).kept } : null
  if (s.detached && detached && detached.floors.length + detached.walls.length > 0) {
    const mesh = doc.createMesh('detached')
    for (const [kind, soup] of [['floor', detached.floors], ['wall', detached.walls]] as const) {
      if (soup.length === 0) continue
      const { positions, indices } = indexed(soup)
      info.vertices += positions.length / 3
      mesh.addPrimitive(doc.createPrimitive().setMaterial(mats[kind])
        .setAttribute('POSITION', doc.createAccessor(`detached-${kind}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor(`detached-${kind}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer)))
    }
    info.detached = { triangles: (detached.floors.length + detached.walls.length) / 9, parts: s.detached.parts.length }
    root.addChild(doc.createNode('detached').setMesh(mesh).setExtras({ group: 'detached', triangles: info.detached.triangles, parts: s.detached.parts.slice(0, 64) }))
  }

  // The props: one node `props` holding a node per place; a place is a transform with two children, the solid mesh of its
  // model and its foliage mesh (a little darker, so a crown can be told from its trunk), so a viewer can hide either. A model's meshes are written once and shared by all its places.
  if (s.props && s.props.placements.length > 0) {
    const propMat = doc.createMaterial('prop').setBaseColorFactor([0.72, 0.7, 0.63, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
    const foliageMat = doc.createMaterial('foliage').setBaseColorFactor([0.62, 0.62, 0.55, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
    const meshes = new Map<number, { solid: ReturnType<typeof doc.createMesh> | null, foliage: ReturnType<typeof doc.createMesh> | null, triangles: number }>()
    const meshOf = (name: string, soup: number[], material: typeof propMat) => {
      if (soup.length === 0) return null
      const { positions, indices } = indexed(soup)
      return doc.createMesh(name).addPrimitive(doc.createPrimitive().setMaterial(material)
        .setAttribute('POSITION', doc.createAccessor(`${name}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor(`${name}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer)))
    }
    // The leaves (RFC 18, 4.6): a material for each cut-out texture, shared by all the models that use it. A run of triangles with no texture is grey, as it was.
    const textures = (s.props.leafTextures ?? []).map(t => doc.createTexture(t.name).setImage(t.png).setMimeType('image/png'))
    const leafMats = new Map<number, ReturnType<typeof doc.createMaterial>>()
    const leafMaterial = (index: number) => {
      let mat = leafMats.get(index)
      if (!mat) {
        const def = s.props!.leafMaterials![index]!
        mat = doc.createMaterial('foliage').setBaseColorFactor([1, 1, 1, def.mode === 'blend' ? def.alpha : 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
          .setBaseColorTexture(textures[def.texture]!)
        if (def.mode === 'mask') mat.setAlphaMode('MASK').setAlphaCutoff(0.5)
        else mat.setAlphaMode('BLEND')
        leafMats.set(index, mat)
      }
      return mat
    }
    const leavesOf = (name: string, model: PropSet['models'][number]) => {
      if (model.foliage.length === 0) return null
      const runs = model.foliageRuns, uvs = model.foliageUv
      const whole = runs && uvs && s.props!.leafMaterials !== undefined && uvs.length === (model.foliage.length / 3) * 2 && runs.reduce((n, r) => n + r.triangles, 0) * 9 === model.foliage.length
      if (!whole) return meshOf(name, model.foliage, foliageMat)
      const groups = new Map<number, { pos: number[], uv: number[] }>()
      let at = 0
      for (const r of runs!) {
        const g = groups.get(r.material) ?? { pos: [], uv: [] }
        groups.set(r.material, g)
        for (let i = at * 9; i < (at + r.triangles) * 9; i++) g.pos.push(model.foliage[i]!)
        for (let i = at * 6; i < (at + r.triangles) * 6; i++) g.uv.push(uvs![i]!)
        at += r.triangles
      }
      const prims: ReturnType<typeof doc.createPrimitive>[] = []
      let k = 0
      for (const [material, g] of groups) {
        const prim = doc.createPrimitive()
        if (material >= 0 && material < s.props!.leafMaterials!.length) {
          const { positions, uvs: coords, indices } = indexedUv(g.pos, g.uv)
          prim.setMaterial(leafMaterial(material))
            .setAttribute('POSITION', doc.createAccessor(`${name}-positions-${k}`).setType('VEC3').setArray(positions).setBuffer(buffer))
            .setAttribute('TEXCOORD_0', doc.createAccessor(`${name}-uv-${k}`).setType('VEC2').setArray(coords).setBuffer(buffer))
            .setIndices(doc.createAccessor(`${name}-indices-${k}`).setType('SCALAR').setArray(indices).setBuffer(buffer))
        } else continue // leaves with no texture to cut them out are not drawn: opaque sheets are not leaves (RFC 18, 4.6)
        prims.push(prim)
        k++
      }
      if (prims.length === 0) return null // (a mesh made and not used would be written empty)
      const mesh = doc.createMesh(name)
      for (const prim of prims) mesh.addPrimitive(prim)
      return mesh
    }
    const group = doc.createNode('props')
    root.addChild(group)
    for (const pl of s.props.placements) {
      const model = s.props.models[pl.model]
      if (!model) throw new RangeError('a placement names a model that is not there')
      let m = meshes.get(pl.model)
      if (!m) {
        m = { solid: meshOf(`prop:${model.name}`, model.solid, propMat), foliage: leavesOf(`foliage:${model.name}`, model), triangles: (model.solid.length + model.foliage.length) / 9 }
        meshes.set(pl.model, m)
        info.props.models++
      }
      const node = doc.createNode('prop').setTranslation([pl.x, pl.y, pl.z]).setRotation(angleQuaternion(pl.pitch, pl.yaw, pl.roll))
      if (m.solid) node.addChild(doc.createNode('solid').setMesh(m.solid))
      if (m.foliage) node.addChild(doc.createNode('foliage').setMesh(m.foliage))
      group.addChild(node)
      info.props.placements++
      info.props.triangles += m.triangles
    }
  }

  doc.getRoot().setExtras({
    generator: 'TraitorDash (RFC 18)', meshVersion: MESH_VERSION, map: opts.map, fingerprint: s.fingerprint, mapVersion: s.version, mapRevision: s.revision,
    units: 'Source units (about 1.9 cm); Z is up before the root node turns it into glTF\'s Y-up',
    cropped: opts.crop !== undefined, levels: info.levels.length, storeys,
    spawns: (s.spawns ?? []).slice(0, MAX_SPAWNS).map(p => ({ class: p.class, x: p.x, y: p.y, z: p.z })),
  })
  info.spawns = Math.min((s.spawns ?? []).length, MAX_SPAWNS)
  if (surface) info.surface = { textures: surface.textures.length, materials: surfaceMaterials.size, texturedTriangles, colouredTriangles }
  if (s.props?.leafTextures?.length) info.props.textures = s.props.leafTextures.length
  return { glb: await new NodeIO().writeBinary(doc), info }
}
