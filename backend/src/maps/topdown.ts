import { NodeIO } from '@gltf-transform/core'

// RFC 21, 4.4: the stored mesh of a map (RFC 11, 18) flattened into a picture from above, once, as a grid of cells: a floor,
// a wall, or nothing, for each storey. The killzone picture draws the grid as rectangles under the deaths. It is the
// same geometry the 3D view shows, with no height or depth to it, and it is made on the server so the in-game browser
// needs no script and no WebGL.

export const EMPTY = 0, FLOOR = 1, WALL = 2

export interface Layer {
  /** The storey (1 is the lowest) and the heights its floors have. */
  index: number, lo: number, hi: number
  /** `nx` by `ny` cells, row `j` is the row from `miny + j * cell` north; EMPTY, FLOOR or WALL. */
  cells: Uint8Array
  /** For each cell with a floor, the height of its highest floor in this storey; NO_FLOOR where there is none. */
  zs: Int16Array
}
export const NO_FLOOR = -32768
export interface TopDown { cell: number, minx: number, miny: number, nx: number, ny: number, layers: Layer[], /** The map's player spawns, as the mesh carries them (empty for an older mesh). */ spawns?: { x: number, y: number, z: number }[] }

const MAX_CELLS_ACROSS = 360 // the longer side of the map is cut into at most this many cells
const MIN_CELL = 16

/** Keeps the highest floor height seen in a cell. */
const up = (zs: Int16Array, k: number, z: number) => { const v = Math.max(-32767, Math.min(32767, Math.round(z))); if (v > zs[k]!) zs[k] = v }

/** Marks the cells whose middle is inside the triangle, and the one around its centre (a triangle smaller than a cell). */
function fill(cells: Uint8Array, zs: Int16Array | null, nx: number, ny: number, minx: number, miny: number, cell: number, a: number[], mark: number) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = a as [number, number, number, number, number, number, number, number, number]
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minx) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - minx) / cell))
  const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - miny) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - miny) / cell))
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
  if (area !== 0) {
    for (let j = j0; j <= j1; j++) {
      const py = miny + (j + 0.5) * cell
      for (let i = i0; i <= i1; i++) {
        const px = minx + (i + 0.5) * cell
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) { const k = j * nx + i; if (cells[k]! < mark) cells[k] = mark; if (zs) up(zs, k, w0 * az + w1 * bz + (1 - w0 - w1) * cz) }
      }
    }
  }
  const mi = Math.floor(((ax + bx + cx) / 3 - minx) / cell), mj = Math.floor(((ay + by + cy) / 3 - miny) / cell)
  if (mi >= 0 && mi < nx && mj >= 0 && mj < ny) { const k = mj * nx + mi; if (cells[k]! < mark) cells[k] = mark; if (zs) up(zs, k, (az + bz + cz) / 3) }
}

/** The cells a wall's edges cross: a wall is a vertical face, so from above it is a line. */
function line(cells: Uint8Array, nx: number, ny: number, minx: number, miny: number, cell: number, x0: number, y0: number, x1: number, y1: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cell / 2)))
  for (let s = 0; s <= steps; s++) {
    const i = Math.floor((x0 + ((x1 - x0) * s) / steps - minx) / cell), j = Math.floor((y0 + ((y1 - y0) * s) / steps - miny) / cell)
    if (i >= 0 && i < nx && j >= 0 && j < ny) cells[j * nx + i] = WALL
  }
}

/** The storeys of a mesh as grids; null when the mesh has no storeys or cannot be read. */
export async function flatten(glb: Uint8Array): Promise<TopDown | null> {
  let doc
  try { doc = await new NodeIO().readBinary(glb) } catch { return null }
  type Soup = { index: number, lo: number, hi: number, floors: Float32Array[], walls: Float32Array[] }
  const levels: Soup[] = []
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const node of doc.getRoot().listNodes()) {
    const e = node.getExtras() as { level?: number, lo?: number, hi?: number }
    const mesh = node.getMesh()
    if (!mesh || !Number.isInteger(e.level)) continue
    const lv: Soup = { index: e.level!, lo: Number(e.lo), hi: Number(e.hi), floors: [], walls: [] }
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')?.getArray() as Float32Array | null | undefined
      const idx = prim.getIndices()?.getArray()
      if (!pos || !idx) continue
      const tri = new Float32Array(idx.length * 3) // x, y and z of every corner of every triangle
      for (let n = 0; n < idx.length; n++) { tri[n * 3] = pos[idx[n]! * 3]!; tri[n * 3 + 1] = pos[idx[n]! * 3 + 1]!; tri[n * 3 + 2] = pos[idx[n]! * 3 + 2]! }
      for (let n = 0; n < tri.length; n += 3) {
        minx = Math.min(minx, tri[n]!); maxx = Math.max(maxx, tri[n]!); miny = Math.min(miny, tri[n + 1]!); maxy = Math.max(maxy, tri[n + 1]!)
      }
      ;(prim.getMaterial()?.getName() === 'wall' ? lv.walls : lv.floors).push(tri)
    }
    levels.push(lv)
  }
  if (levels.length === 0 || !Number.isFinite(minx)) return null
  levels.sort((a, b) => a.index - b.index)

  const span = Math.max(maxx - minx, maxy - miny, 1)
  const cell = Math.max(MIN_CELL, Math.ceil(span / MAX_CELLS_ACROSS / 8) * 8)
  minx = Math.floor(minx / cell) * cell; miny = Math.floor(miny / cell) * cell
  const nx = Math.ceil((maxx - minx) / cell) + 1, ny = Math.ceil((maxy - miny) / cell) + 1
  const layers: Layer[] = levels.map(lv => {
    const cells = new Uint8Array(nx * ny)
    const zs = new Int16Array(nx * ny).fill(NO_FLOOR)
    for (const tri of lv.floors) for (let n = 0; n + 8 < tri.length; n += 9) fill(cells, zs, nx, ny, minx, miny, cell, Array.from(tri.subarray(n, n + 9)), FLOOR)
    for (const tri of lv.walls) {
      for (let n = 0; n + 8 < tri.length; n += 9) {
        line(cells, nx, ny, minx, miny, cell, tri[n]!, tri[n + 1]!, tri[n + 3]!, tri[n + 4]!)
        line(cells, nx, ny, minx, miny, cell, tri[n + 3]!, tri[n + 4]!, tri[n + 6]!, tri[n + 7]!)
        line(cells, nx, ny, minx, miny, cell, tri[n + 6]!, tri[n + 7]!, tri[n]!, tri[n + 1]!)
      }
    }
    return { index: lv.index, lo: lv.lo, hi: lv.hi, cells, zs }
  })
  const spawns = (doc.getRoot().getExtras() as { spawns?: { x?: unknown, y?: unknown, z?: unknown }[] }).spawns
  return {
    cell, minx, miny, nx, ny, layers,
    spawns: Array.isArray(spawns) ? spawns.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).map(p => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) })) : [],
  }
}

// ---- where a player can get to (RFC 21, 12). A storey is cut from the mesh by the heights of its floors, and nothing in the mesh says
// that anyone can stand on it: a flat plate under a map (the ground plane, the bottom of a lake, the underside of a model) is a storey too.

/** The most a player climbs to the next floor (a jump onto a ledge): about the height of a jump; a cell's width is added to it (a slope). */
export const CLIMB = 56
/** The most a player drops to a floor below without it being the end of them (a fall of more than this hurts or kills). */
export const DROP = 260
/** How far above a floor a place may be and still stand on it (a spawn or a death a little in the air). */
const ABOVE = 32
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const
/** A seed higher than this over the floor that would catch it is in the air over a pit, not on a floor. */
const FALL = 600

/**
 * The floor cells a player can reach, for each storey: from the places players are known to stand (the spawn points of the map and the places
 * deaths were recorded, which are given as `seeds`), walking to a neighbouring cell on a floor at most `CLIMB` higher or `DROP` lower,
 * in the storey or in another one (stairs and ramps between storeys are neighbouring floors at nearly the same height). Walls are
 * not looked at, so this is generous: a place behind a wall can count as reachable, but a storey that is a plate by itself, or
 * lies a long way under or over the rest, does not. Ladders, lifts and teleports are not in the mesh; a place a player has died is a seed,
 * so a storey only they lead to shows as soon as someone dies there.
 */
export function reachableCells(top: TopDown, seeds: { x: number, y: number, z: number }[]): Uint8Array[] {
  const { nx, ny, cell, minx, miny, layers } = top
  const seen = layers.map(() => new Uint8Array(nx * ny))
  const queue: number[] = [] // layer * nx * ny + cell
  const visit = (li: number, k: number) => { if (!seen[li]![k]) { seen[li]![k] = 1; queue.push(li * nx * ny + k) } }

  for (const s of seeds) {
    const i = Math.floor((s.x - minx) / cell), j = Math.floor((s.y - miny) / cell)
    if (i < 0 || i >= nx || j < 0 || j >= ny) continue
    // the floor that catches the seed: the highest at or under it in its own cell, else in a neighbouring one
    const catching = (ii: number, jj: number): number => {
      let best = -1, bz = -Infinity
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) return best
      for (let li = 0; li < layers.length; li++) {
        const z = layers[li]!.zs[jj * nx + ii]!
        if (z !== NO_FLOOR && z <= s.z + ABOVE && s.z - z <= FALL && z > bz) { bz = z; best = li * nx * ny + jj * nx + ii }
      }
      return best
    }
    let best = catching(i, j)
    for (const [di, dj] of NEIGHBOURS) { if (best >= 0) break; best = catching(i + di, j + dj) }
    if (best >= 0) visit(Math.floor(best / (nx * ny)), best % (nx * ny))
  }

  for (let head = 0; head < queue.length; head++) {
    const li = Math.floor(queue[head]! / (nx * ny)), k = queue[head]! % (nx * ny)
    const z = layers[li]!.zs[k]!, i = k % nx, j = Math.floor(k / nx)
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue
      const kk = jj * nx + ii
      for (let mi = 0; mi < layers.length; mi++) {
        if (seen[mi]![kk]) continue
        const h = layers[mi]!.zs[kk]!
        if (h === NO_FLOOR) continue
        if (h - z <= CLIMB + cell && z - h <= DROP + cell) visit(mi, kk) // a cell's floor is its highest point: a slope of 45 degrees climbs a cell's width in a cell
      }
    }
  }
  return seen
}

/** The storeys (their `index`) that have a floor a player can reach (see `reachableCells`). */
export function reachableStoreys(top: TopDown, seeds: { x: number, y: number, z: number }[]): number[] {
  const cells = reachableCells(top, seeds)
  return top.layers.filter((_, li) => cells[li]!.some(v => v === 1)).map(l => l.index)
}

/**
 * The storey a death at (x, y, z) belongs to: the one with a floor under that spot closest to the height. Storeys overlap in
 * height (a hillside and the street at its foot are one storey each), so the heights a storey spans say little; the floor at
 * the place does. `half` is the half width of the square around the spot that is looked at (a killzone square). Where no
 * storey has a floor there, the highest storey that starts at or below the height (a little slack for feet on a floor).
 */
export function storeyAt(top: Pick<TopDown, 'cell' | 'minx' | 'miny' | 'nx' | 'ny' | 'layers'>, x: number, y: number, z: number, half = 64): number {
  const { cell, minx, miny, nx, ny, layers } = top
  const i0 = Math.max(0, Math.floor((x - half - minx) / cell)), i1 = Math.min(nx - 1, Math.floor((x + half - 1 - minx) / cell))
  const j0 = Math.max(0, Math.floor((y - half - miny) / cell)), j1 = Math.min(ny - 1, Math.floor((y + half - 1 - miny) / cell))
  let best = -1, gap = Infinity
  for (const l of layers) {
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const h = l.zs[j * nx + i]!
      if (h === NO_FLOOR) continue
      const d = Math.abs(h - z)
      if (d < gap) { gap = d; best = l.index }
    }
  }
  if (best >= 0) return best
  let pick = layers[0]?.index ?? 1
  for (const l of layers) if (l.lo - 96 <= z) pick = l.index
  return pick
}

// Maps are flattened once: the result is kept for the few maps a server is looking at.
const kept = new Map<string, Promise<TopDown | null>>()
export function flattened(glb: Uint8Array): Promise<TopDown | null> {
  const key = `${glb.length}:${Bun.hash(glb)}`
  let p = kept.get(key)
  if (!p) {
    p = flatten(glb)
    kept.set(key, p)
    if (kept.size > 8) kept.delete(kept.keys().next().value!)
  } else { kept.delete(key); kept.set(key, p) }
  return p
}
