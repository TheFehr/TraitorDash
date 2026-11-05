import { KILLZONE_BAND, KILLZONE_CELL, type Killzones } from './stats'
import { parseRows, storeyModel, type MapPlan } from './mapplan'
import { EMPTY, FLOOR, WALL, type TopDown } from '../maps/topdown'

// RFC 21, 4.4: where the deaths on a map are, as a picture from above. Built from numbers and a count, with no script,
// no reference to anything else and no <image>, so it can sit in a page the in-game browser shows. Under the deaths goes
// the map itself when the viewer may see it (a signed-in visitor, which includes a player in the game), or the floor plan
// for an admin, or nothing.

const TARGET = 640 // the width a picture is made to have
const LEGEND = 28
const MAX_BLOBS = 10_000
const MAX_RECTS = 40_000

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A square of the picture: its lower corner and side in world units, and the deaths in it. */
export interface Square { x: number, y: number, size: number, n: number }

// RFC 21, 11: the squares follow the data. They are aligned powers of two, 32 to 1,024 units; a square with more than SPLIT_AT
// deaths is split into its four halves down to 32 units, and the map starts in root squares whose size follows its area.
export const SQUARE_MIN = KILLZONE_CELL
export const SQUARE_MAX = 1024
export const SPLIT_AT = 3
/** The map starts as about this many squares, whatever its size. */
export const ROOT_SQUARES = 64
export const ROOT_DEFAULT = 512
const ROOT_MIN = 128

/** The coarsest square for a map whose walkable area seen from above is `area` square units (null when unknown). */
export function rootSizeOf(area: number | null): number {
  if (area === null) return ROOT_DEFAULT
  if (!(area > 0)) return ROOT_MIN
  const side = Math.sqrt(area / ROOT_SQUARES)
  const size = 2 ** Math.round(Math.log2(side))
  return Math.min(SQUARE_MAX, Math.max(ROOT_MIN, size))
}

/** The walkable area of a flattened map seen from above, in square units: the cells with a floor in any storey. */
export function footprintOfMap(m: TopDown): number {
  const seen = new Uint8Array(m.nx * m.ny)
  for (const l of m.layers) for (let i = 0; i < seen.length; i++) if (l.cells[i] === FLOOR) seen[i] = 1
  return seen.reduce((a, b) => a + b, 0) * m.cell * m.cell
}

/** The same for a floor plan: the cells that have a floor. */
export function footprintOfPlan(grid: MapPlan['grid']): number {
  return parseRows(grid).flat().filter(floors => floors.length > 0).length * grid.cell * grid.cell
}

/**
 * The deaths of `cells` (in the finest squares) as the squares of the picture, the densest first. `root` is the coarsest size;
 * with `pick` only the cells it accepts count, given the height and the middle of the finest square. Every death is in exactly one square.
 */
export function squaresOf(cells: Killzones['cells'], root = ROOT_DEFAULT, pick?: (z: number, x: number, y: number) => boolean): Square[] {
  const per = new Map<string, { bx: number, by: number, n: number }>()
  for (const c of cells) {
    if (pick && !pick(c.bz * KILLZONE_BAND + KILLZONE_BAND / 2, (c.bx + 0.5) * KILLZONE_CELL, (c.by + 0.5) * KILLZONE_CELL)) continue
    const key = `${c.bx},${c.by}`
    const s = per.get(key)
    if (s) s.n += c.n
    else per.set(key, { bx: c.bx, by: c.by, n: c.n })
  }
  const side = Math.max(1, Math.round(root / KILLZONE_CELL)) // the root square in finest squares
  const groups = new Map<string, { bx: number, by: number, n: number }[]>()
  for (const p of per.values()) {
    const key = `${Math.floor(p.bx / side)},${Math.floor(p.by / side)}`
    const g = groups.get(key)
    if (g) g.push(p); else groups.set(key, [p])
  }
  const out: Square[] = []
  const split = (x: number, y: number, size: number, pts: { bx: number, by: number, n: number }[]) => {
    const n = pts.reduce((a, p) => a + p.n, 0)
    if (n > SPLIT_AT && size > 1) {
      const h = size / 2
      const quarters: { bx: number, by: number, n: number }[][] = [[], [], [], []]
      for (const p of pts) quarters[(p.bx >= x + h ? 1 : 0) + (p.by >= y + h ? 2 : 0)]!.push(p)
      quarters.forEach((q, i) => { if (q.length > 0) split(x + (i & 1 ? h : 0), y + (i & 2 ? h : 0), h, q) })
    } else out.push({ x: x * KILLZONE_CELL, y: y * KILLZONE_CELL, size: size * KILLZONE_CELL, n })
  }
  for (const [key, pts] of groups) {
    const [gx, gy] = key.split(',').map(Number)
    split(gx! * side, gy! * side, side, pts)
  }
  return out.sort((a, b) => b.n / (b.size * b.size) - a.n / (a.size * a.size) || b.n - a.n || a.x - b.x || a.y - b.y)
}

/** The densest squares as the centre of each in world units, for the list beside the picture. */
export const hottest = (squares: Square[], k = 5) =>
  squares.slice(0, k).map(s => ({ x: s.x + s.size / 2, y: s.y + s.size / 2, n: s.n, size: s.size }))

/** Yellow to red as t goes from 0 (one death) to 1 (the most). */
const heat = (t: number) => `hsl(${Math.round(55 - 55 * t)} 95% ${Math.round(58 - 12 * t)}%)`

/** What is drawn under the deaths: a grid of cells in world units, each a floor, a wall or nothing. */
export interface Base { cell: number, minx: number, miny: number, nx: number, ny: number, cells: Uint8Array }

/** One storey of the flattened map, or all of them put together when `level` is not given. */
export function baseOfMap(m: TopDown, level?: number): Base {
  const layers = level === undefined ? m.layers : m.layers.filter(l => l.index === level)
  const cells = new Uint8Array(m.nx * m.ny)
  for (const l of layers) for (let i = 0; i < cells.length; i++) if (l.cells[i]! > cells[i]!) cells[i] = l.cells[i]!
  return { cell: m.cell, minx: m.minx, miny: m.miny, nx: m.nx, ny: m.ny, cells }
}

/** The floor plan of an admin as the same kind of grid; `level` (1 is the lowest) picks a storey of it. */
export function baseOfPlan(grid: MapPlan['grid'], level?: number): Base {
  const rows = parseRows(grid)
  const { storeyOf } = storeyModel(rows.flat(2).map(f => f.z))
  const cells = new Uint8Array(grid.nx * grid.ny)
  rows.forEach((row, j) => row.forEach((floors, i) => { if (floors.some(f => level === undefined || storeyOf(f.z) === level - 1)) cells[j * grid.nx + i] = 1 }))
  return { cell: grid.cell, minx: grid.minx, miny: grid.miny, nx: grid.nx, ny: grid.ny, cells }
}

/** The storeys of a plan, and which storey a height belongs to; for an admin who has the plan. */
export function storeysOf(plan: MapPlan['grid']) {
  const m = storeyModel(parseRows(plan).flat(2).map(f => f.z))
  return { levels: m.levels, storeyOf: m.storeyOf }
}

/**
 * The picture. `base` is drawn under the deaths. Each death square is a soft blob, redder and larger where more players
 * died, so a corridor reads as a hot stripe and a spawn as a spot. Returns null when there is nothing to draw.
 */
export function renderKillzonesSvg(squares: Square[], map: string, base?: Base): string | null {
  if (squares.length === 0 && !base) return null
  const shown = squares.slice(0, MAX_BLOBS)
  const density = (s: Square) => s.n / (s.size * s.size)
  const dmax = shown.length > 0 ? density(shown[0]!) : 0
  const dmin = shown.reduce((m, s) => Math.min(m, density(s)), Infinity)
  const sizes = shown.map(s => s.size)
  const smallest = Math.min(...sizes), largest = Math.max(...sizes)

  // The frame, in world units: what is drawn of the base, and the deaths, with a margin.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of shown) {
    x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x + s.size)
    y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y + s.size)
  }
  if (base) {
    for (let j = 0; j < base.ny; j++) for (let i = 0; i < base.nx; i++) {
      if (base.cells[j * base.nx + i] === EMPTY) continue
      x0 = Math.min(x0, base.minx + i * base.cell); x1 = Math.max(x1, base.minx + (i + 1) * base.cell)
      y0 = Math.min(y0, base.miny + j * base.cell); y1 = Math.max(y1, base.miny + (j + 1) * base.cell)
    }
  }
  if (!Number.isFinite(x0)) return null // no deaths and a base with nothing in it
  const margin = 128
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin
  const k = TARGET / (x1 - x0) // pixels in a world unit
  const w = Math.round((x1 - x0) * k), h = Math.round((y1 - y0) * k)
  const X = (x: number) => ((x - x0) * k).toFixed(1)
  const Y = (y: number) => ((y1 - y) * k).toFixed(1) // north is up

  // The base: runs of equal cells along a row become one rectangle.
  const rects: string[] = []
  if (base) {
    outer: for (let j = 0; j < base.ny; j++) {
      let from = -1, kind = EMPTY
      const flush = (to: number) => {
        if (from < 0) return
        rects.push(`<rect x="${X(base.minx + from * base.cell)}" y="${Y(base.miny + (j + 1) * base.cell)}" width="${((to - from) * base.cell * k).toFixed(1)}" height="${(base.cell * k + 0.3).toFixed(1)}" fill="${kind === WALL ? '#6a6a72' : '#34343a'}"/>`)
        from = -1
      }
      for (let i = 0; i <= base.nx; i++) {
        const v = i < base.nx ? base.cells[j * base.nx + i]! : EMPTY
        if (v !== kind || i === base.nx) { flush(i); if (v !== EMPTY) { from = i; kind = v } else kind = EMPTY }
      }
      if (rects.length > MAX_RECTS) break outer
    }
  }

  // The deaths: one soft blob for each square, the busiest last so they are on top. Five colours, one gradient for each.
  const steps = 5
  const grads = Array.from({ length: steps }, (_, i) => {
    const c = heat(i / (steps - 1))
    return `<radialGradient id="kz${i}"><stop offset="0" stop-color="${c}" stop-opacity=".95"/><stop offset=".55" stop-color="${c}" stop-opacity=".55"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`
  }).join('')
  // the colour follows the deaths in an area (not the count: a large square holds more by size alone), on a log scale between the thinnest and the densest
  const span = Math.log(dmax / dmin)
  const blobs = [...shown].reverse().map(s => {
    const t = span > 0 ? Math.log(density(s) / dmin) / span : 1
    const r = Math.max(s.size * 0.75 * k * (0.9 + 0.3 * t), 7)
    return `<circle cx="${X(s.x + s.size / 2)}" cy="${Y(s.y + s.size / 2)}" r="${r.toFixed(1)}" fill="url(#kz${Math.round(t * (steps - 1))})"><title>${s.n} ${s.n === 1 ? 'death' : 'deaths'} in a square of ${s.size} units</title></circle>`
  }).join('')

  const wide = Math.max(w, 200)
  const bar = 120
  const legend = shown.length === 0 ? '' :
    `<defs><linearGradient id="kzl" x1="0" x2="1" y1="0" y2="0">${[0, 1, 2, 3, 4].map(i => `<stop offset="${i / 4}" stop-color="${heat(i / 4)}"/>`).join('')}</linearGradient></defs>` +
    `<path d="M4 ${h + 6}h${bar}v6h-${bar}z" fill="url(#kzl)"/>` +
    `<text x="4" y="${h + 24}" fill="#ccc" font-family="sans-serif" font-size="9">fewer</text>` +
    `<text x="${4 + bar}" y="${h + 24}" fill="#ccc" font-family="sans-serif" font-size="9" text-anchor="end">more</text>` +
    `<text x="${bar + 12}" y="${h + 12}" fill="#ccc" font-family="sans-serif" font-size="9">deaths in an area; ${smallest === largest ? `squares of ${smallest} units` : `squares of ${smallest} to ${largest} units, finer where more died`}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(`Where players died on ${map}`)}" width="${wide}" height="${h + LEGEND}" viewBox="0 0 ${wide} ${h + LEGEND}" style="background:#111;max-width:100%;height:auto"><title>${esc(map)}</title><defs>${grads}</defs>${rects.join('')}${blobs}${legend}</svg>`
}
