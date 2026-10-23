// The storey model (RFC 10, 4.5): which floors belong to which level of a map. Used by the trace plan
// and by the mesh (RFC 11). Nothing here knows about the rest of the backend.

export interface Level {
  /** 1 is the lowest storey. */
  index: number
  /** The lowest and highest floor that belong to it. */
  lo: number
  hi: number
  /** How many floors. */
  cells: number
}

const BIN = 16 // units per height bin
const PEAK_WINDOW = 3 // a storey height has no bigger bin within 3 bins (48 units)
const MERGE_UNITS = 96 // two storey heights closer than this are one storey
const MIN_SHARE = 0.03 // a storey height holds at least this share of all floors...
const MIN_CELLS = 6 // ...and at least this many

/**
 * The storeys of a set of floor heights, and which storey (0-based) a height belongs to. Every
 * sample counts one, or `weights[i]` (for samples of different size, such as the triangles of a
 * mesh weighted by the ground they cover, in units of one grid cell).
 */
export const storeyModel = (zs: number[], weights?: number[]): { levels: Level[], storeyOf: (z: number) => number, bounds: number[] } => {
  if (weights && weights.length !== zs.length) throw new RangeError('there must be one weight per height')
  if (weights && weights.some(w => !Number.isFinite(w) || w < 0)) throw new RangeError('weights must be finite and not negative')
  if (zs.length === 0) return { levels: [], storeyOf: () => 0, bounds: [] }
  const weight = (i: number) => (weights ? weights[i]! : 1)
  const counts = new Map<number, number>()
  let total = 0
  zs.forEach((z, i) => { counts.set(Math.floor(z / BIN), (counts.get(Math.floor(z / BIN)) ?? 0) + weight(i)); total += weight(i) })
  const need = Math.max(MIN_CELLS, MIN_SHARE * total)

  let peaks: { z: number, n: number }[] = []
  for (const [bin, n] of counts) {
    if (n < need) continue
    let biggest = true
    for (let d = -PEAK_WINDOW; d <= PEAK_WINDOW; d++) {
      const other = counts.get(bin + d) ?? 0
      if (other > n || (other === n && d < 0)) biggest = false // a tie goes to the lower bin
    }
    if (biggest) peaks.push({ z: bin * BIN + BIN / 2, n })
  }
  peaks.sort((a, b) => a.z - b.z)
  // Merge heights that are too close: the one with more floors wins.
  const merged: typeof peaks = []
  for (const p of peaks) {
    const last = merged[merged.length - 1]
    if (last && p.z - last.z < MERGE_UNITS) { if (p.n > last.n) merged[merged.length - 1] = p } else merged.push(p)
  }
  peaks = merged
  if (peaks.length === 0) peaks = [{ z: 0, n: 0 }] // no clear storey: everything is one

  // The nearest storey height wins, so stairs join the storey they lead to.
  const nearest = (z: number) => {
    let best = 0
    for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i]!.z - z) < Math.abs(peaks[best]!.z - z)) best = i
    return best
  }
  const levels: Level[] = peaks.map((_, i) => ({ index: i + 1, lo: Infinity, hi: -Infinity, cells: 0 }))
  zs.forEach((z, i) => {
    const l = levels[nearest(z)]!
    l.lo = Math.min(l.lo, z); l.hi = Math.max(l.hi, z); l.cells += weight(i)
  })
  for (const l of levels) l.cells = Math.round(l.cells * 1000) / 1000
  // Where one storey ends and the next begins: halfway between their heights (what `nearest` decides by).
  const bounds = peaks.slice(1).map((p, i) => (peaks[i]!.z + p.z) / 2)
  return { levels, storeyOf: nearest, bounds }
}
