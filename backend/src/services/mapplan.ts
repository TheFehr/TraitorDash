// RFC 10, section 4.5: validating a floor-plan upload. The bridge's scan is trusted for nothing:
// the shape of the grid, every height and the counts are checked or recomputed here.

export const MAP_NAME = /^[A-Za-z0-9_.-]{1,64}$/
export const FINGERPRINT = /^[0-9a-f]{64}$/

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
  if (typeof body.map !== 'string' || !MAP_NAME.test(body.map)) return { error: 'invalid map name' }
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
