import { KILLZONE_BAND, KILLZONE_CELL, type Killzones } from './stats'
import { parseRows, storeyModel, type MapPlan } from './mapplan'

// RFC 21, 4.4: where the deaths on a map are, as a picture from above. Built from numbers and a count, with no script,
// no reference to anything else and no <image>, so it can sit in a page the in-game browser shows.

const TARGET = 640 // the width a picture is made to have, when the map allows; squares are whole pixels, 4 to 24 wide
const MAX_SQUARES = 10_000
const LEGEND = 28

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface Square { bx: number, by: number, n: number }

/** The deaths of `cells` summed into squares; with `storeyOf` and `level` only those of one storey (1 is the lowest). */
export function squaresOf(cells: Killzones['cells'], pick?: (z: number) => boolean): Square[] {
  const by = new Map<string, Square>()
  for (const c of cells) {
    if (pick && !pick(c.bz * KILLZONE_BAND + KILLZONE_BAND / 2)) continue
    const key = `${c.bx},${c.by}`
    const s = by.get(key)
    if (s) s.n += c.n
    else by.set(key, { bx: c.bx, by: c.by, n: c.n })
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.bx - b.bx || a.by - b.by)
}

/** The busiest squares as the centre of each in world units, for the list beside the picture. */
export const hottest = (squares: Square[], k = 5) =>
  squares.slice(0, k).map(s => ({ x: s.bx * KILLZONE_CELL + KILLZONE_CELL / 2, y: s.by * KILLZONE_CELL + KILLZONE_CELL / 2, n: s.n }))

/** A square's colour at t (0 = one death, 1 = the most): yellow to red, stronger as it gets hotter. */
const heat = (t: number) => `hsl(${Math.round(55 - 55 * t)} 95% ${Math.round(58 - 12 * t)}%)`

/** The storeys of a plan, and which storey a height belongs to; for an admin who has the plan. */
export function storeysOf(plan: MapPlan['grid']) {
  const m = storeyModel(parseRows(plan).flat(2).map(f => f.z))
  return { levels: m.levels, storeyOf: m.storeyOf }
}

/**
 * The picture. `floor` (an admin's plan; omit for a guest) is drawn in dark grey under the squares, only the storey
 * `level` of it when that is given. Returns null when there is nothing to draw.
 */
export function renderKillzonesSvg(squares: Square[], map: string, floor?: { grid: MapPlan['grid'], level?: number }): string | null {
  if (squares.length === 0) return null
  const shown = squares.slice(0, MAX_SQUARES)
  const max = shown[0]!.n

  // The frame, in squares: the deaths, and the floor when there is one.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const s of shown) { minX = Math.min(minX, s.bx); maxX = Math.max(maxX, s.bx); minY = Math.min(minY, s.by); maxY = Math.max(maxY, s.by) }

  const floorRects: { x: number, y: number, w: number, h: number }[] = []
  if (floor) {
    const { grid } = floor
    const rows = parseRows(grid)
    const { storeyOf } = storeyModel(rows.flat(2).map(f => f.z))
    const keep = (z: number) => floor.level === undefined || storeyOf(z) === floor.level - 1
    const k = grid.cell / KILLZONE_CELL // plan cells in squares
    for (let j = 0; j < rows.length; j++) {
      let run: { i: number, n: number } | null = null
      const flush = () => {
        if (run) {
          const x = (grid.minx + run.i * grid.cell) / KILLZONE_CELL, y = (grid.miny + j * grid.cell) / KILLZONE_CELL
          floorRects.push({ x, y, w: run.n * k, h: k })
          minX = Math.min(minX, Math.floor(x)); maxX = Math.max(maxX, Math.ceil(x + run.n * k) - 1)
          minY = Math.min(minY, Math.floor(y)); maxY = Math.max(maxY, Math.ceil(y + k) - 1)
        }
        run = null
      }
      for (let i = 0; i < grid.nx; i++) {
        if (rows[j]![i]!.some(f => keep(f.z))) { if (run && run.i + run.n === i) run.n++; else { flush(); run = { i, n: 1 } } } else flush()
      }
      flush()
      if (floorRects.length > 50_000) break
    }
  }

  const columns = maxX - minX + 3
  const PX = Math.max(4, Math.min(24, Math.floor(TARGET / columns)))
  const x0 = minX - 1
  const w = columns * PX, h = (maxY - minY + 3) * PX
  const X = (x: number) => (x - x0) * PX
  const Y = (y: number) => (maxY + 2 - y) * PX // north is up
  const floorSvg = floorRects.map(r => `<rect x="${(X(r.x)).toFixed(1)}" y="${(Y(r.y + r.h)).toFixed(1)}" width="${(r.w * PX).toFixed(1)}" height="${(r.h * PX).toFixed(1)}" fill="#2b2b2b"/>`).join('')
  const dead = shown.map(s => {
    const t = max <= 1 ? 1 : (s.n - 1) / (max - 1)
    return `<rect x="${X(s.bx)}" y="${Y(s.by + 1)}" width="${PX}" height="${PX}" fill="${heat(t)}" fill-opacity="${(0.6 + 0.4 * t).toFixed(2)}"><title>${s.n} ${s.n === 1 ? 'death' : 'deaths'}</title></rect>`
  }).join('')

  const wide = Math.max(w, 180)
  const bar = 120
  const legend =
    `<defs><linearGradient id="kz" x1="0" x2="1" y1="0" y2="0">${[0, 1, 2, 3, 4].map(i => `<stop offset="${i / 4}" stop-color="${heat(i / 4)}"/>`).join('')}</linearGradient></defs>` +
    `<path d="M4 ${h + 6}h${bar}v6h-${bar}z" fill="url(#kz)"/>` +
    `<text x="4" y="${h + 24}" fill="#ccc" font-family="sans-serif" font-size="9">1</text>` +
    `<text x="${4 + bar}" y="${h + 24}" fill="#ccc" font-family="sans-serif" font-size="9" text-anchor="end">${max}</text>` +
    `<text x="${bar + 12}" y="${h + 12}" fill="#ccc" font-family="sans-serif" font-size="9">deaths in a square of ${KILLZONE_CELL} units</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(`Where players died on ${map}`)}" width="${wide}" height="${h + LEGEND}" viewBox="0 0 ${wide} ${h + LEGEND}" style="background:#111;max-width:100%;height:auto"><title>${esc(map)}</title>${floorSvg}${dead}${legend}</svg>`
}
