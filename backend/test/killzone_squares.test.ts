import { expect, test, describe } from 'bun:test'
import { footprintOfMap, footprintOfPlan, hottest, renderKillzonesSvg, rootSizeOf, squaresOf, SPLIT_AT, SQUARE_MIN } from '../src/services/killzones'
import { FLOOR, NO_FLOOR } from '../src/maps/topdown'

// RFC 21, 11: the squares of the killzone picture follow the data. A quadtree of aligned squares, 32 to 1,024 units, that starts at a root
// size taken from the map's area and splits a square with more than 3 deaths; the colour follows the deaths in an area.

/** Deaths at world positions as the finest squares (32 units) the query returns, one row for each. */
const at = (pts: [number, number, number?][]) => {
  const m = new Map<string, { bx: number, by: number, bz: number, n: number }>()
  for (const [x, y, z = 0] of pts) {
    const bx = Math.floor(x / 32), by = Math.floor(y / 32), bz = Math.floor(z / 32), k = `${bx},${by},${bz}`
    const c = m.get(k)
    if (c) c.n++; else m.set(k, { bx, by, bz, n: 1 })
  }
  return [...m.values()]
}
const total = (sq: { n: number }[]) => sq.reduce((a, s) => a + s.n, 0)

describe('the squares', () => {
  test('a death alone stays in a root square, aligned to the root grid', () => {
    const sq = squaresOf(at([[700, 1300]]), 512)
    expect(sq).toEqual([{ x: 512, y: 1024, size: 512, n: 1 }])
    expect(squaresOf(at([[-10, -10]]), 256)).toEqual([{ x: -256, y: -256, size: 256, n: 1 }])
  })

  test('a square splits at more than 3 deaths, not at 3', () => {
    expect(SPLIT_AT).toBe(3)
    const three = squaresOf(at([[10, 10], [200, 10], [10, 200]]), 512)
    expect(three).toHaveLength(1); expect(three[0]).toMatchObject({ size: 512, n: 3 })
    const four = squaresOf(at([[10, 10], [300, 10], [10, 300], [300, 300]]), 512)
    expect(four.map(s => s.size)).toEqual([256, 256, 256, 256]); expect(total(four)).toBe(4)
    // the halves are the aligned quarters of the parent
    expect(four.map(s => [s.x, s.y]).sort()).toEqual([[0, 0], [0, 256], [256, 0], [256, 256]])
  })

  test('many deaths in one place go down to the finest square and no further', () => {
    const sq = squaresOf(at(Array.from({ length: 40 }, () => [100, 100] as [number, number])), 512)
    expect(sq).toEqual([{ x: 96, y: 96, size: SQUARE_MIN, n: 40 }])
  })

  test('a busy corner is fine and a quiet one is coarse, on the same picture', () => {
    const busy = Array.from({ length: 12 }, (_, i) => [40 + (i % 4) * 40, 40 + Math.floor(i / 4) * 40] as [number, number])
    const sq = squaresOf(at([...busy, [5000, 5000]]), 512)
    expect(Math.max(...sq.map(s => s.size))).toBe(512) // the lone death
    expect(Math.min(...sq.map(s => s.size))).toBeLessThanOrEqual(64) // the busy corner
    expect(total(sq)).toBe(13)
  })

  test('the squares always hold exactly the deaths, do not overlap and are aligned (random sets, negative positions, edges)', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (const root of [128, 256, 512, 1024]) {
      for (let round = 0; round < 6; round++) {
        const n = 1 + Math.floor(rnd() * 400), spread = [200, 2000, 20_000][round % 3]!
        const pts = Array.from({ length: n }, () => [Math.round((rnd() - 0.5) * spread), Math.round((rnd() - 0.5) * spread), Math.round(rnd() * 300)] as [number, number, number])
        const sq = squaresOf(at(pts), root)
        expect(total(sq)).toBe(n)
        for (const s of sq) {
          expect(s.size).toBeGreaterThanOrEqual(SQUARE_MIN); expect(s.size).toBeLessThanOrEqual(root)
          expect(Math.log2(s.size) % 1).toBe(0)
          expect(Math.abs(s.x % s.size)).toBe(0); expect(Math.abs(s.y % s.size)).toBe(0)
        }
        // a point is in exactly one square
        for (const [x, y] of pts) expect(sq.filter(s => x >= s.x && x < s.x + s.size && y >= s.y && y < s.y + s.size)).toHaveLength(1)
      }
    }
  })

  test('the densest square is first, and a small square beats a large one with the same deaths', () => {
    const sq = squaresOf(at([[10, 10], [10, 10], [5000, 5000], [5000, 5000], ...Array.from({ length: 10 }, () => [9000, 9000] as [number, number])]), 512)
    expect(sq[0]).toMatchObject({ size: 32, n: 10 })
    const two = squaresOf(at([[10, 10], [10, 10], [5000, 5000], [5000, 5000], [5000, 5000], [5040, 5040], [5040, 5040]]), 512)
    expect(two[0]!.n / two[0]!.size ** 2).toBeGreaterThanOrEqual(two[1]!.n / two[1]!.size ** 2)
    expect(hottest(two, 1)[0]).toEqual({ x: two[0]!.x + two[0]!.size / 2, y: two[0]!.y + two[0]!.size / 2, n: two[0]!.n, size: two[0]!.size })
  })

  test('the picker takes out the cells it refuses', () => {
    const sq = squaresOf(at([[10, 10, 5], [10, 10, 305]]), 512, z => z < 100)
    expect(total(sq)).toBe(1)
  })
})

describe('the coarsest size follows the map', () => {
  const m2 = (area: number) => area / (0.01905 * 0.01905) // square metres to square units
  test('a small map starts fine, a large one coarse, and no area is the middle', () => {
    expect(rootSizeOf(m2(500))).toBe(128)    // the plane, the train
    expect(rootSizeOf(m2(6000))).toBe(512)   // the median map
    expect(rootSizeOf(m2(30_000))).toBe(1024) // the outdoor maps
    expect(rootSizeOf(null)).toBe(512)
    expect(rootSizeOf(0)).toBe(128)
    expect(rootSizeOf(m2(1))).toBe(128)         // never finer than 128
    expect(rootSizeOf(m2(5_000_000))).toBe(1024) // never coarser than 1,024
  })
  test('the area of a flattened map counts a cell once however many storeys have a floor there; a plan counts its cells with a floor', () => {
    const layer = (index: number, cells: number[]) => ({ index, lo: 0, hi: 0, cells: Uint8Array.from(cells), zs: new Int16Array(cells.length).fill(NO_FLOOR) })
    const top = { cell: 16, minx: 0, miny: 0, nx: 2, ny: 2, layers: [layer(1, [FLOOR, FLOOR, 0, 2]), layer(2, [FLOOR, 0, FLOOR, 0])] }
    expect(footprintOfMap(top)).toBe(3 * 16 * 16)
    const grid = { cell: 64, minx: 0, miny: 0, nx: 3, ny: 1, zmin: 0, zmax: 100, rows: ['0|0|'] }
    expect(footprintOfPlan(grid)).toBe(2 * 64 * 64)
  })
})

describe('the picture of squares of different sizes', () => {
  test('a circle for each square as large as the square, the legend and tooltips say the size, nothing runs or loads', () => {
    const svg = renderKillzonesSvg([{ x: 0, y: 0, size: 32, n: 3 }, { x: 512, y: 0, size: 512, n: 1 }], 'm')!
    expect((svg.match(/<circle /g) ?? []).length).toBe(2)
    expect(svg).toContain('3 deaths in a square of 32 units'); expect(svg).toContain('1 death in a square of 512 units')
    expect(svg).toContain('squares of 32 to 512 units, finer where more died')
    expect(svg).toContain('>fewer<'); expect(svg).toContain('>more<')
    expect(svg).not.toMatch(/<script|<image|href=|xlink|onload|<foreignObject/i)
    const r = (x: string) => Number(new RegExp(`r="([0-9.]+)"[^>]*><title>${x}`).exec(svg)![1])
    expect(r('1 death in a square of 512')).toBeGreaterThan(r('3 deaths in a square of 32') * 4)
  })
  test('the colour follows the density, not the count: the same count in a large square is cooler than in a small one', () => {
    const svg = renderKillzonesSvg([{ x: 0, y: 0, size: 32, n: 2 }, { x: 512, y: 0, size: 512, n: 2 }], 'm')!
    const fill = (size: number) => new RegExp(`fill="url\\(#kz(\\d)\\)"><title>2 deaths in a square of ${size} `).exec(svg)![1]
    expect(Number(fill(32))).toBeGreaterThan(Number(fill(512)))
  })
  test('squares of one size say so, and with equal density they all get the hottest colour', () => {
    const svg = renderKillzonesSvg([{ x: 0, y: 0, size: 128, n: 2 }, { x: 256, y: 0, size: 128, n: 2 }], 'm')!
    expect(svg).toContain('squares of 128 units<'); expect(svg).not.toContain('finer where')
    expect(svg.match(/fill="url\(#kz4\)"/g)).toHaveLength(2)
  })
})
