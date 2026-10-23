import { FINGERPRINT, NAME } from './validators'
import { storeyModel, type Level } from '../maps/levels'
export { storeyModel, type Level }
// RFC 10, section 4.5: validating a floor-plan upload. The bridge's scan is trusted for nothing:
// the shape of the grid, every height and the counts are checked or recomputed here.


export const MAX_PLAN_BYTES = 2_000_000
const MAX_CELLS = 250_000 // the scan's own cap
const MAX_HEIGHT = 32_768 // Source maps are at most +-16384 units; this leaves room
const FLOOR = /^(-?\d{1,5})(c?)$/

export interface MapPlan {
  map: string
  fingerprint: string | null
  cell: number
  nx: number
  ny: number
  seeds: number
  traces: number | null
  seconds: number | null
  floorCells: number
  crouchFloors: number
  /** What is stored and served: the grid only. */
  grid: { cell: number, minx: number, miny: number, nx: number, ny: number, zmin: number, zmax: number, rows: string[] }
}

const whole = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e7 ? v : null)
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

/** Returns the plan to store, or a short reason it was refused. */
export function validatePlan(body: any): { plan: MapPlan } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'a JSON object is expected' }
  if (typeof body.map !== 'string' || !NAME.test(body.map)) return { error: 'invalid map name' }
  if (body.fingerprint !== undefined && body.fingerprint !== null && (typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint))) {
    return { error: 'invalid fingerprint' }
  }

  const cell = whole(body.cell, 16, 512)
  const nx = whole(body.nx, 1, MAX_CELLS)
  const ny = whole(body.ny, 1, MAX_CELLS)
  if (cell === null) return { error: 'cell must be a whole number from 16 to 512' }
  if (nx === null || ny === null || nx * ny > MAX_CELLS) return { error: `the grid must have 1 to ${MAX_CELLS} cells` }

  const minx = finite(body.minx), miny = finite(body.miny), zmin = finite(body.zmin), zmax = finite(body.zmax)
  if (minx === null || miny === null || zmin === null || zmax === null) return { error: 'the grid origin and height range must be numbers' }

  const seeds = count(body.seeds)
  if (seeds === null) return { error: 'seeds must be a non-negative number' }
  const given = (v: unknown) => v !== undefined && v !== null
  const traces = given(body.traces) ? count(body.traces) : null
  if (given(body.traces) && traces === null) return { error: 'traces must be a non-negative number' }
  const secs = given(body.seconds) ? count(Number(body.seconds) * 1000) : null // whole milliseconds
  if (given(body.seconds) && secs === null) return { error: 'seconds must be a non-negative number' }
  const seconds = secs === null ? null : secs / 1000

  if (!Array.isArray(body.rows) || body.rows.length !== ny) return { error: `rows must have exactly ${ny} entries` }
  let floorCells = 0
  let crouchFloors = 0
  for (const row of body.rows) {
    if (typeof row !== 'string') return { error: 'every row must be a string' }
    const cells = row.split('|')
    if (cells.length !== nx) return { error: `every row must have exactly ${nx} cells` }
    for (const c of cells) {
      if (c === '') continue
      for (const f of c.split(',')) {
        const m = FLOOR.exec(f)
        if (!m || Math.abs(Number(m[1])) > MAX_HEIGHT) return { error: 'a floor is not a whole height (with an optional c)' }
        floorCells++
        if (m[2] === 'c') crouchFloors++
      }
    }
  }

  return {
    plan: {
      map: body.map, fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : null,
      cell, nx, ny, seeds, traces, seconds, floorCells, crouchFloors,
      grid: { cell, minx, miny, nx, ny, zmin, zmax, rows: body.rows },
    },
  }
}

// ---- the admin preview (RFC 10, 4.5) ---------------------------------------------------------
// A picture per storey (and an overview): a square per cell with a floor, blue (lowest) to red
// (highest), north up. Only numbers and the (escaped) map name go into it.

/** The colour of a floor at `t` (0 = lowest, 1 = highest of what is drawn): blue through green to red. Pictures and legend share it. */
export const heightColour = (t: number) => `hsl(${Math.round(240 - 240 * t)} 70% 50%)`

const PX = 8 // picture pixels per grid cell
const LEGEND_WIDTH = 180 // the narrowest picture that holds its legend
const LEGEND_STRIP = 36 // the height of the legend strip below the plan
export const MAX_PREVIEW_RECTS = 50_000

type Grid = MapPlan['grid']
interface Floor { z: number, crouch: boolean }
type Cells = Floor[][][]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const parseRows = (grid: Grid): Cells =>
  grid.rows.map(r => r.split('|').map(c => (c === '' ? [] : c.split(',').map(f => ({ z: parseInt(f, 10), crouch: f.endsWith('c') })))))

/**
 * The storeys of a plan, lowest first. Heights are counted in bins; a bin with many floors and no
 * bigger bin nearby is a storey height; every floor belongs to the nearest storey height, so stairs
 * join the storey they lead to and a few cells at an odd height (a vent) do not form a storey.
 */
export function planLevels(grid: Grid): Level[] {
  return storeyModel(parseRows(grid).flat(2).map(f => f.z)).levels
}


/**
 * The plan as an SVG: storey `level` (1-based) on its own, or every floor (highest on top) when
 * `level` is omitted. null when it would need more than MAX_PREVIEW_RECTS rectangles. Every
 * picture of a plan has the same frame, so the storeys line up. The caller checks that `level`
 * is one of planLevels().
 */
export function renderPlanSvg(grid: Grid, map: string, level?: number): string | null {
  const rows = parseRows(grid)
  const zs = rows.flat(2).map(f => f.z)
  const { levels, storeyOf } = storeyModel(zs)

  // Which floors are drawn: all of them, or those that belong to the chosen storey.
  let keep = (_: Floor) => true
  let lo = Math.min(...zs)
  let hi = Math.max(...zs)
  let caption = ''
  if (level !== undefined) {
    const chosen = levels[level - 1]
    if (!chosen) return null
    keep = f => storeyOf(f.z) === level - 1
    lo = chosen.lo
    hi = chosen.hi
    caption = `level ${level} of ${levels.length} · `
  }
  const colour = (z: number) => heightColour((z - lo) / Math.max(1, hi - lo))

  const rects: string[] = []
  const dots: string[] = []
  let minI = Infinity, maxI = -1, minJ = Infinity, maxJ = -1 // the frame: cells drawn in ANY storey
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < grid.nx; i++) {
    if (rows[j]![i]!.length === 0) continue
    minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j)
  }

  for (let j = 0; j < rows.length; j++) {
    const y = (grid.ny - 1 - j) * PX // y grows north in the world and down in a picture
    // Horizontal runs of cells that look the same become one rectangle.
    let run: { i: number, n: number, fill: string, faint: boolean } | null = null
    const flush = () => {
      if (run) rects.push(`<rect x="${run.i * PX}" y="${y}" width="${run.n * PX}" height="${PX}" fill="${run.fill}"${run.faint ? ' fill-opacity=".4"' : ''}/>`)
      run = null
    }
    for (let i = 0; i < grid.nx; i++) {
      const cell = rows[j]![i]!.filter(keep)
      if (cell.length === 0) { flush(); continue }
      const top = cell.reduce((a, b) => (b.z > a.z ? b : a))
      const faint = cell.every(f => f.crouch)
      const fill = colour(top.z)
      if (faint) dots.push(`<rect x="${i * PX + 1}" y="${y + 1}" width="2" height="2" fill="#fff"/>`)
      if (run && run.fill === fill && run.faint === faint && run.i + run.n === i) run.n++
      else { flush(); run = { i, n: 1, fill, faint } }
      if (rects.length + dots.length > MAX_PREVIEW_RECTS) return null
    }
    flush()
    if (rects.length + dots.length > MAX_PREVIEW_RECTS) return null
  }

  // Crop to the frame, with a margin of two cells, so a small map in a huge world fills the picture.
  const drawn = maxI >= 0
  const x0 = drawn ? Math.max(0, minI - 2) * PX : 0
  const x1 = drawn ? Math.min(grid.nx, maxI + 3) * PX : Math.max(1, grid.nx) * PX
  const y0 = drawn ? Math.max(0, grid.ny - 1 - maxJ - 2) * PX : 0
  const y1 = drawn ? Math.min(grid.ny, grid.ny - minJ + 2) * PX : Math.max(1, grid.ny) * PX
  // The legend: a title line over the plan, and a strip below it (so it never covers a square) with
  // the colour scale and the meaning of the faint square. Drawn with <path>, never <rect>, so it is
  // not counted as squares of the plan. The picture is widened to fit it.
  const title = drawn
    ? `<text x="${x0 + 4}" y="${y0 + 12}" fill="#ddd" font-family="sans-serif" font-size="10">${caption || 'all floors · '}${lo} to ${hi}</text>`
    : ''
  const wide = drawn ? Math.max(x1 - x0, LEGEND_WIDTH) : x1 - x0
  const strip = drawn ? LEGEND_STRIP : 0
  const sy = y1 // the strip starts where the plan ends
  const bar = 140
  const legend = drawn
    ? `<defs><linearGradient id="scale" x1="0" x2="1" y1="0" y2="0">${[0, 1, 2, 3, 4, 5, 6].map(i => `<stop offset="${i / 6}" stop-color="${heightColour(i / 6)}"/>`).join('')}</linearGradient></defs>` +
      `<path data-legend="scale" d="M${x0 + 4} ${sy + 6}h${bar}v6h-${bar}z" fill="url(#scale)"/>` +
      `<text x="${x0 + 4}" y="${sy + 22}" fill="#ccc" font-family="sans-serif" font-size="9">${lo}</text>` +
      `<text x="${x0 + 4 + bar}" y="${sy + 22}" fill="#ccc" font-family="sans-serif" font-size="9" text-anchor="end">${hi}</text>` +
      `<path data-legend="crouch" d="M${x0 + 4} ${sy + 26}h8v8h-8z" fill="${heightColour(0.5)}" fill-opacity=".4"/>` +
      `<path data-legend="crouch-dot" d="M${x0 + 5} ${sy + 27}h2v2h-2z" fill="#fff"/>` +
      `<text x="${x0 + 16}" y="${sy + 33}" fill="#ccc" font-family="sans-serif" font-size="9">crouch-only</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wide}" height="${y1 - y0 + strip}" viewBox="${x0} ${y0} ${wide} ${y1 - y0 + strip}" style="background:#111"><title>${esc(map)}</title>${rects.join('')}${dots.join('')}${title}${legend}</svg>`
}
