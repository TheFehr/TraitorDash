// RFC 18, 4.4: the parts of a map. The triangles are grouped by **shared corners**: two triangles are in one part when
// a corner of one is within about 4 units of a corner of the other. A part is *main* when a spawn point is on it or it
// holds a fair share of the triangles; a part that is neither main nor close to a main part is *detached*: a floating
// slab, a stray piece beyond the map. The 3D skybox is a part too (the one a `sky_camera` is next to, with no spawn).
// Nothing here knows about the rest of the backend; the soups are `x, y, z` per corner, three corners to a triangle.

export interface Point3 { x: number, y: number, z: number }

export interface Part {
  id: number
  triangles: number
  /** The box around its corners. */
  min: [number, number, number]
  max: [number, number, number]
  kind: 'main' | 'detached' | 'sky'
  /** Spawn points that stand on it. */
  spawns: number
}

export interface PartOptions {
  /** A part with this share of all triangles is main. Default 5%. */
  mainShare?: number
  /** Parts beyond this many units (and not resting on a main floor) from every main part are detached. Default 256. */
  near?: number
  /** A sky camera is in a part when it is within this many units of its box. Default 256. */
  skyPad?: number
  /** The skybox is not removed when it would be more than this share of all triangles (a map is not that much sky). Default 0.5. */
  maxSkyShare?: number
}

export interface Parted {
  /** Every triangle by part, in the order of the soups given. */
  of: Int32Array[]
  parts: Part[]
  /** Triangles of the sky parts, to be removed. */
  skyTriangles: number
}

const SNAP = 8 // corners within about SNAP / 2 units are one corner
const GRID = 256 // cell of the lookup grids
const BASE = 131072 // cells per axis in a numeric key (±524 k units)

const key3 = (cx: number, cy: number, cz: number) => ((cx + BASE / 2) * BASE + (cy + BASE / 2)) * BASE + (cz + BASE / 2)

class Union {
  private p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i }
  find(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]!]!; a = this.p[a]! } return a }
  join(a: number, b: number) { const x = this.find(a), y = this.find(b); if (x !== y) this.p[Math.max(x, y)] = Math.min(x, y) }
}

/**
 * Groups the triangles of the soups into parts by shared corners and sorts out which are main, detached or sky.
 * `floors` are the first soup's triangles (spawns stand on those); the others are walls and the like.
 */
export function findParts(soups: number[][], where: { spawns: Point3[], skyCameras: Point3[] }, opts: PartOptions = {}): Parted {
  const mainShare = opts.mainShare ?? 0.05, near = opts.near ?? 256, skyPad = opts.skyPad ?? 256, maxSky = opts.maxSkyShare ?? 0.5
  const floors = soups[0] ?? []
  const starts: number[] = []
  let total = 0
  for (const s of soups) { if (s.length % 9 !== 0) throw new RangeError('a soup must be whole triangles'); starts.push(total); total += s.length / 9 }
  if (total === 0) return { of: soups.map(() => new Int32Array(0)), parts: [], skyTriangles: 0 }

  // ---- shared corners
  const uf = new Union(total)
  const seen = new Map<number, number>() // snapped corner -> a triangle that has it
  soups.forEach((soup, si) => {
    for (let i = 0, t = starts[si]!; i < soup.length; i += 9, t++) {
      for (let c = 0; c < 9; c += 3) {
        const q = [soup[i + c]! / SNAP, soup[i + c + 1]! / SNAP, soup[i + c + 2]! / SNAP]
        const cell = q.map(Math.floor) as [number, number, number]
        // The neighbours on the side the corner is nearer to: every corner within half a cell is found, in either order.
        const side = q.map((v, k) => (v - cell[k]! < 0.5 ? -1 : 1))
        for (let m = 1; m < 8; m++) {
          const o = seen.get(key3(cell[0] + (m & 1 ? side[0]! : 0), cell[1] + (m & 2 ? side[1]! : 0), cell[2] + (m & 4 ? side[2]! : 0)))
          if (o !== undefined) uf.join(t, o)
        }
        const k0 = key3(cell[0], cell[1], cell[2])
        const o = seen.get(k0)
        if (o === undefined) seen.set(k0, t); else uf.join(t, o)
      }
    }
  })

  // ---- the parts
  const index = new Map<number, number>() // union root -> part id
  const of = soups.map(s => new Int32Array(s.length / 9))
  const parts: Part[] = []
  soups.forEach((soup, si) => {
    for (let i = 0, t = starts[si]!; i < soup.length; i += 9, t++) {
      const root = uf.find(t)
      let id = index.get(root)
      if (id === undefined) { id = parts.length; index.set(root, id); parts.push({ id, triangles: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], kind: 'main', spawns: 0 }) }
      const p = parts[id]!
      p.triangles++
      for (let c = 0; c < 9; c++) { const a = c % 3; p.min[a] = Math.min(p.min[a]!, soup[i + c]!); p.max[a] = Math.max(p.max[a]!, soup[i + c]!) }
      of[si]![(i / 9) | 0] = id
    }
  })

  // ---- lookups: which parts have a corner in a grid cell
  const cells = new Map<number, Set<number>>()
  const cellOf = (v: number) => Math.floor(v / GRID)
  soups.forEach((soup, si) => {
    for (let i = 0; i < soup.length; i += 9) {
      const id = of[si]![(i / 9) | 0]!
      for (let c = 0; c < 9; c += 3) {
        const k = key3(cellOf(soup[i + c]!), cellOf(soup[i + c + 1]!), cellOf(soup[i + c + 2]!))
        const s = cells.get(k) ?? cells.set(k, new Set()).get(k)!
        s.add(id)
      }
    }
  })
  const partsNear = (p: Point3, reach: number) => {
    const out = new Set<number>()
    const r = Math.ceil(reach / GRID)
    const cx = cellOf(p.x), cy = cellOf(p.y), cz = cellOf(p.z)
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const s = cells.get(key3(cx + dx, cy + dy, cz + dz))
      if (s) for (const id of s) out.add(id)
    }
    return out
  }

  // ---- floors by ground cell, to find the one under a spawn
  const grid = new Map<number, number[]>()
  const huge: number[] = []
  for (let i = 0, n = 0; i < floors.length; i += 9, n++) {
    const x0 = cellOf(Math.min(floors[i]!, floors[i + 3]!, floors[i + 6]!)), x1 = cellOf(Math.max(floors[i]!, floors[i + 3]!, floors[i + 6]!))
    const y0 = cellOf(Math.min(floors[i + 1]!, floors[i + 4]!, floors[i + 7]!)), y1 = cellOf(Math.max(floors[i + 1]!, floors[i + 4]!, floors[i + 7]!))
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { huge.push(n); continue }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = key3(x, y, 0); (grid.get(k) ?? grid.set(k, []).get(k)!).push(n) }
  }
  /** Height of the floor triangle `n` at (x, y), or null when the point is not inside it. */
  const heightAt = (n: number, x: number, y: number): number | null => {
    const i = n * 9
    const ax = floors[i]!, ay = floors[i + 1]!, bx = floors[i + 3]!, by = floors[i + 4]!, cx = floors[i + 6]!, cy = floors[i + 7]!
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-9) return null
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
    const w = 1 - u - v
    const e = -1e-6
    if (u < e || v < e || w < e) return null
    return u * floors[i + 2]! + v * floors[i + 5]! + w * floors[i + 8]!
  }
  /** The part of the floor under a point (at most `below` units under it, or `above` over it), the nearest in height; null when there is none. */
  const floorUnder = (p: Point3, below: number, above: number): number | null => {
    let best: { z: number, id: number } | null = null
    for (const n of [...(grid.get(key3(cellOf(p.x), cellOf(p.y), 0)) ?? []), ...huge]) {
      const z = heightAt(n, p.x, p.y)
      if (z === null || z > p.z + above || z < p.z - below) continue
      if (!best || z > best.z) best = { z, id: of[0]![n]! }
    }
    return best ? best.id : null
  }

  // ---- spawns and the sky
  for (const sp of where.spawns) {
    const id = floorUnder(sp, 512, 64) ?? [...partsNear(sp, 512)][0]
    if (id !== undefined) parts[id]!.spawns++
  }
  // The skybox: a sky camera stands inside the small copy of the surroundings, so the parts whose box holds the camera
  // (and have no spawn on them) are the skybox, and so is every other part that lies inside the box around those.
  const sky = new Set<number>()
  const inside = (p: Part, pad: number, c: Point3) => c.x >= p.min[0] - pad && c.x <= p.max[0] + pad && c.y >= p.min[1] - pad && c.y <= p.max[1] + pad && c.z >= p.min[2] - pad && c.z <= p.max[2] + pad
  for (const c of where.skyCameras) for (const p of parts) if (p.spawns === 0 && inside(p, skyPad, c)) sky.add(p.id)
  if (sky.size) {
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (const id of sky) for (let a = 0; a < 3; a++) { box.min[a] = Math.min(box.min[a]!, parts[id]!.min[a]!); box.max[a] = Math.max(box.max[a]!, parts[id]!.max[a]!) }
    for (const p of parts) if (p.spawns === 0 && [0, 1, 2].every(a => p.min[a]! >= box.min[a]! - skyPad && p.max[a]! <= box.max[a]! + skyPad)) sky.add(p.id)
  }
  let skyTriangles = [...sky].reduce((a, id) => a + parts[id]!.triangles, 0)
  if (skyTriangles > maxSky * total) { sky.clear(); skyTriangles = 0 }
  for (const id of sky) parts[id]!.kind = 'sky'

  // ---- main and detached
  const rest = parts.filter(p => p.kind !== 'sky')
  const main = new Set(rest.filter(p => p.spawns > 0 || p.triangles >= mainShare * total).map(p => p.id))
  if (main.size === 0 && rest.length) main.add(rest.reduce((a, b) => (b.triangles > a.triangles ? b : a)).id)
  const mainCells = new Set<number>()
  soups.forEach((soup, si) => {
    for (let i = 0; i < soup.length; i += 9) if (main.has(of[si]![(i / 9) | 0]!)) for (let c = 0; c < 9; c += 3) mainCells.add(key3(cellOf(soup[i + c]!), cellOf(soup[i + c + 1]!), cellOf(soup[i + c + 2]!)))
  })
  // A part is near the main ones when a corner of it is close to a corner of theirs, or rests on a main floor.
  const mainFloor = (p: Point3) => {
    for (const n of [...(grid.get(key3(cellOf(p.x), cellOf(p.y), 0)) ?? []), ...huge]) {
      if (!main.has(of[0]![n]!)) continue
      const z = heightAt(n, p.x, p.y)
      if (z !== null && Math.abs(z - p.z) <= 48) return true
    }
    return false
  }
  const touches = (id: number) => {
    const r = Math.ceil(near / GRID)
    for (let si = 0; si < soups.length; si++) {
      const soup = soups[si]!
      for (let i = 0; i < soup.length; i += 9) {
        if (of[si]![(i / 9) | 0] !== id) continue
        for (let c = 0; c < 9; c += 3) {
          const p = { x: soup[i + c]!, y: soup[i + c + 1]!, z: soup[i + c + 2]! }
          for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
            if (mainCells.has(key3(cellOf(p.x) + dx, cellOf(p.y) + dy, cellOf(p.z) + dz))) return true
          }
          if (mainFloor(p)) return true
        }
      }
    }
    return false
  }
  for (const p of rest) p.kind = main.has(p.id) || touches(p.id) ? 'main' : 'detached'

  return { of, parts, skyTriangles }
}

/** The triangles of a soup whose part has one of the kinds (`of` is that soup's entry in `Parted.of`). */
export function soupOfKinds(soup: number[], of: Int32Array, parts: Part[], kinds: Part['kind'][]): number[] {
  const out: number[] = []
  for (let i = 0; i < soup.length; i += 9) if (kinds.includes(parts[of[(i / 9) | 0]!]!.kind)) for (let k = 0; k < 9; k++) out.push(soup[i + k]!)
  return out
}
