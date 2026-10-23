import { Document, NodeIO } from '@gltf-transform/core'
import { storeyModel } from './levels'
import { MESH_VERSION } from './meshVersion'

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
 * Takes the 3D skybox out of the surfaces. A map's world model also holds a small scaled copy of the
 * surroundings, built far from the map and marked by a `sky_camera` inside it; drawn with the map it
 * is a slab of ground and a few buildings in the distance. Geometry is grouped into pieces (cells of
 * `cell` units, neighbours joined); a piece that holds a sky camera and no spawn point is the skybox.
 * It is **never guessed**: if the skybox is joined to the map there is nothing to remove, and if the
 * pieces to remove are more than half of all triangles nothing is removed (a map is not that much sky).
 */
export function removeSkybox(
  s: { floors: number[], walls: number[] },
  where: { skyCameras: { x: number, y: number, z: number }[], spawns: { x: number, y: number, z: number }[] },
  opts: { cell?: number, maxShare?: number } = {},
): { floors: number[], walls: number[], removed: { floors: number, walls: number } } {
  check(s.floors, 'floors'); check(s.walls, 'walls')
  const none = { floors: s.floors, walls: s.walls, removed: { floors: 0, walls: 0 } }
  if (where.skyCameras.length === 0) return none
  const cell = opts.cell ?? 1024
  const maxShare = opts.maxShare ?? 0.5

  const at = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const centreCell = (soup: number[], i: number) =>
    at((soup[i]! + soup[i + 3]! + soup[i + 6]!) / 3, (soup[i + 1]! + soup[i + 4]! + soup[i + 7]!) / 3, (soup[i + 2]! + soup[i + 5]! + soup[i + 8]!) / 3)

  const cells = new Map<string, number>() // occupied cell -> triangles
  for (const soup of [s.floors, s.walls]) for (let i = 0; i < soup.length; i += 9) { const k = centreCell(soup, i); cells.set(k, (cells.get(k) ?? 0) + 1) }

  const piece = new Map<string, number>() // cell -> piece id
  const sizes: number[] = []
  for (const start of cells.keys()) {
    if (piece.has(start)) continue
    const id = sizes.length
    let size = 0
    const todo = [start]
    piece.set(start, id)
    while (todo.length) {
      const c = todo.pop()!
      size += cells.get(c)!
      const [x, y, z] = c.split(',').map(Number) as [number, number, number]
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const n = `${x + dx},${y + dy},${z + dz}`
        if (cells.has(n) && !piece.has(n)) { piece.set(n, id); todo.push(n) }
      }
    }
    sizes.push(size)
  }

  const piecesNear = (p: { x: number, y: number, z: number }) => {
    const ids = new Set<number>()
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const id = piece.get(at(p.x + dx * cell, p.y + dy * cell, p.z + dz * cell))
      if (id !== undefined) ids.add(id)
    }
    return ids
  }
  const sky = new Set<number>(), play = new Set<number>()
  for (const p of where.skyCameras) for (const id of piecesNear(p)) sky.add(id)
  for (const p of where.spawns) for (const id of piecesNear(p)) play.add(id)
  const drop = new Set([...sky].filter(id => !play.has(id)))
  const total = sizes.reduce((a, b) => a + b, 0)
  const dropped = [...drop].reduce((a, id) => a + sizes[id]!, 0)
  if (dropped === 0 || dropped > maxShare * total) return none

  const keep = (soup: number[]) => {
    const out: number[] = []
    for (let i = 0; i < soup.length; i += 9) if (!drop.has(piece.get(centreCell(soup, i))!)) for (let k = 0; k < 9; k++) out.push(soup[i + k]!)
    return out
  }
  const floors = keep(s.floors), walls = keep(s.walls)
  return { floors, walls, removed: { floors: (s.floors.length - floors.length) / 9, walls: (s.walls.length - walls.length) / 9 } }
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
  models: { name: string, solid: number[], foliage: number[] }[]
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
  /** What was placed: places, distinct models, and the triangles drawn (every place counts its model's triangles). */
  props: { placements: number, models: number, triangles: number }
  /** Triangles removed by the crop. */
  cropped: { floors: number, walls: number }
}

export interface MeshInput { floors: number[], walls: number[], water?: number[], props?: PropSet, fingerprint: string, version: number, revision: number }
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
  if (heights.length === 0) return soup
  const out: number[] = []
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
    if (inner.length === 0) { out.push(...soup.slice(i, i + 9)); continue }
    const edges = [-Infinity, ...inner, Infinity]
    for (let s = 0; s + 1 < edges.length; s++) {
      let poly = tri
      if (edges[s]! > -Infinity) poly = clip(poly, edges[s]!, true)
      if (edges[s + 1]! < Infinity) poly = clip(poly, edges[s + 1]!, false)
      for (let k = 1; k + 1 < poly.length; k++) for (const p of [poly[0]!, poly[k]!, poly[k + 1]!]) out.push(p[0], p[1], p[2])
    }
  }
  return out
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

/**
 * The surfaces as a GLB, with a summary of what is in it. null when there is nothing to draw (no
 * triangles at all, or the crop took them all). Throws for input that is not triangles.
 */
export async function surfacesToGlb(s: MeshInput, opts: MeshOptions): Promise<{ glb: Uint8Array, info: GlbInfo } | null> {
  check(s.floors, 'floors'); check(s.walls, 'walls')
  const cell = opts.cell ?? 64

  let floors = s.floors, walls = s.walls
  const cropped = { floors: 0, walls: 0 }
  if (opts.crop) {
    const f = cropTriangles(floors, opts.crop), w = cropTriangles(walls, opts.crop)
    cropped.floors = (floors.length - f.length) / 9; cropped.walls = (walls.length - w.length) / 9
    floors = f; walls = w
  }
  const f = withoutDegenerate(floors), w = withoutDegenerate(walls)
  floors = f.kept; walls = w.kept
  if (floors.length === 0 && walls.length === 0) return null
  const water = withoutDegenerate(s.water ?? []).kept

  // The levels: floors weighted by the ground they cover, in grid cells (RFC 10 4.5).
  const centre = (soup: number[], i: number) => (soup[i + 2]! + soup[i + 5]! + soup[i + 8]!) / 3
  const area2d = (soup: number[], i: number) => Math.abs((soup[i + 3]! - soup[i]!) * (soup[i + 7]! - soup[i + 1]!) - (soup[i + 6]! - soup[i]!) * (soup[i + 4]! - soup[i + 1]!)) / 2
  const heights: number[] = [], weights: number[] = []
  for (let i = 0; i < floors.length; i += 9) { heights.push(centre(floors, i)); weights.push(area2d(floors, i) / (cell * cell)) }
  const model = storeyModel(heights, weights)
  const count = Math.max(1, model.levels.length)
  const byLevel = Array.from({ length: count }, () => ({ floors: [] as number[], walls: [] as number[] }))
  for (let i = 0, n = 0; i < floors.length; i += 9, n++) byLevel[model.storeyOf(heights[n]!)]!.floors.push(...floors.slice(i, i + 9))
  walls = withoutDegenerate(splitAtHeights(walls, model.bounds)).kept
  for (let i = 0; i < walls.length; i += 9) byLevel[model.levels.length ? model.storeyOf(centre(walls, i)) : 0]!.walls.push(...walls.slice(i, i + 9))

  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene(opts.map)
  const root = doc.createNode('z-up').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]) // Source is Z-up, glTF is Y-up
  scene.addChild(root)
  const material = (name: string, rgb: [number, number, number]) => doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
  const mats = { floor: material('floor', [0.2, 0.7, 0.3]), wall: material('wall', [0.6, 0.6, 0.65]) }
  const waterMat = doc.createMaterial('water').setBaseColorFactor([0.23, 0.49, 0.65, 0.55]).setAlphaMode('BLEND').setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)

  const info: GlbInfo = { vertices: 0, triangles: 0, droppedDegenerate: f.dropped + w.dropped, levels: [], waterTriangles: 0, props: { placements: 0, models: 0, triangles: 0 }, cropped }
  byLevel.forEach((lv) => {
    if (lv.floors.length === 0 && lv.walls.length === 0) return
    const index = info.levels.length + 1
    const name = `level-${index}`
    const mesh = doc.createMesh(name)
    for (const [kind, soup] of [['floor', lv.floors], ['wall', lv.walls]] as const) {
      if (soup.length === 0) continue
      const { positions, indices } = indexed(soup)
      info.vertices += positions.length / 3; info.triangles += indices.length / 3
      mesh.addPrimitive(doc.createPrimitive().setMaterial(mats[kind])
        .setAttribute('POSITION', doc.createAccessor(`${name}-${kind}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor(`${name}-${kind}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer)))
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

  // The props: one node `props` holding a node per place; a place is a transform with two children, the solid mesh of its
  // model and its foliage mesh (drawn translucent), so a viewer can hide either. A model's meshes are written once and shared by all its places.
  if (s.props && s.props.placements.length > 0) {
    const propMat = doc.createMaterial('prop').setBaseColorFactor([0.72, 0.7, 0.63, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
    const foliageMat = doc.createMaterial('foliage').setBaseColorFactor([0.72, 0.7, 0.63, 0.33]).setAlphaMode('BLEND').setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
    const meshes = new Map<number, { solid: ReturnType<typeof doc.createMesh> | null, foliage: ReturnType<typeof doc.createMesh> | null, triangles: number }>()
    const meshOf = (name: string, soup: number[], material: typeof propMat) => {
      if (soup.length === 0) return null
      const { positions, indices } = indexed(soup)
      return doc.createMesh(name).addPrimitive(doc.createPrimitive().setMaterial(material)
        .setAttribute('POSITION', doc.createAccessor(`${name}-positions`).setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor(`${name}-indices`).setType('SCALAR').setArray(indices).setBuffer(buffer)))
    }
    const group = doc.createNode('props')
    root.addChild(group)
    for (const pl of s.props.placements) {
      const model = s.props.models[pl.model]
      if (!model) throw new RangeError('a placement names a model that is not there')
      let m = meshes.get(pl.model)
      if (!m) {
        m = { solid: meshOf(`prop:${model.name}`, model.solid, propMat), foliage: meshOf(`foliage:${model.name}`, model.foliage, foliageMat), triangles: (model.solid.length + model.foliage.length) / 9 }
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
    cropped: opts.crop !== undefined, levels: info.levels.length,
  })
  return { glb: await new NodeIO().writeBinary(doc), info }
}
