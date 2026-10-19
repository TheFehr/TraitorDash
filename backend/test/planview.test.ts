import { expect, test, describe } from 'bun:test'
import { renderPlanSvg } from '../src/services/mapplan'

// RFC 10, 4.5: the admin preview of a stored floor plan, as an SVG drawn from the grid.

const grid = (rows: string[], over: Record<string, unknown> = {}) => ({
  cell: 64, minx: 0, miny: 0, nx: rows[0]!.split('|').length, ny: rows.length, zmin: -100, zmax: 1000, rows, ...over,
})
const svg = (rows: string[], map = 'ttt_a', over: Record<string, unknown> = {}) => renderPlanSvg(grid(rows, over), map)!
const rects = (s: string) => s.match(/<rect [^>]*>/g) ?? []
const attr = (tag: string, name: string) => (tag.match(new RegExp(` ${name}="([^"]*)"`)) ?? [])[1]

describe('renderPlanSvg', () => {
  test('is an SVG with the map name as its title and no scripts', () => {
    const s = svg(['48|48'])
    expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(s).toContain('<title>ttt_a</title>')
    expect(s).not.toContain('<script')
  })

  test('escapes the map name', () => {
    expect(renderPlanSvg(grid(['48']), 'a<b>&"')!).toContain('<title>a&lt;b&gt;&amp;&quot;</title>')
  })

  test('draws nothing for cells without a floor', () => {
    expect(rects(svg(['48||', '||'])).length).toBe(1)
  })

  test('merges neighbouring cells of one colour in a row into one rectangle', () => {
    const r = rects(svg(['48|48|48|48']))
    expect(r.length).toBe(1)
    expect(attr(r[0]!, 'width')).toBe(String(4 * 8))
  })

  test('a different height, or a gap, starts a new rectangle', () => {
    expect(rects(svg(['48|48|272'])).length).toBe(2)
    expect(rects(svg(['48||48'])).length).toBe(2)
  })

  test('colours run from blue (lowest floor) to red (highest)', () => {
    const r = rects(svg(['-160|48|272']))
    expect(attr(r[0]!, 'fill')).toMatch(/^hsl\(240 /)
    expect(attr(r[2]!, 'fill')).toMatch(/^hsl\(0 /)
    const mid = Number(/^hsl\((\d+) /.exec(attr(r[1]!, 'fill')!)![1])
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(240)
  })

  test('a plan with one height does not produce NaN', () => {
    const s = svg(['48|48'])
    expect(s).not.toContain('NaN')
    expect(attr(rects(s)[0]!, 'fill')).toMatch(/^hsl\(240 /)
  })

  test('north is up: the first row (lowest y) is at the bottom', () => {
    const r = rects(svg(['48', '272']))
    const south = r.find(t => attr(t, 'fill')!.startsWith('hsl(240'))!
    const north = r.find(t => attr(t, 'fill')!.startsWith('hsl(0'))!
    expect(Number(attr(south, 'y'))).toBeGreaterThan(Number(attr(north, 'y')))
  })

  test('the highest floor of a cell is drawn, with a dark dot when there are floors below it', () => {
    const r = rects(svg(['-160,272|48']))
    expect(attr(r[0]!, 'fill')).toMatch(/^hsl\(0 /) // 272, the highest of the cell and of the plan
    expect(r.some(t => attr(t, 'fill') === '#000')).toBe(true)
  })

  test('a cell whose floors are all crouch-only is faint, with a white dot', () => {
    const r = rects(svg(['48|48c|48c,272']))
    expect(r.filter(t => attr(t, 'fill') === '#fff').length).toBe(1)
    expect(r.filter(t => attr(t, 'fill-opacity') === '.4').length).toBe(1)
  })

  test('a cell with a normal floor and a crouch-only one is not faint', () => {
    const r = rects(svg(['48,272c']))
    expect(r.some(t => attr(t, 'fill-opacity') === '.4')).toBe(false)
  })

  test('crops to the cells that are drawn, with a two-cell margin', () => {
    const rows = Array.from({ length: 10 }, (_, j) => Array.from({ length: 10 }, (_, i) => (i === 5 && j === 5 ? '48' : '')).join('|'))
    const s = svg(rows)
    expect(/viewBox="([^"]*)"/.exec(s)![1]).toBe('24 16 40 40')
  })

  test('states the height range and the cell size', () => {
    const s = svg(['-160|48|272'])
    expect(s).toContain('lowest -160')
    expect(s).toContain('highest 272')
    expect(s).toContain('64 units')
  })

  test('an empty plan is still a valid, small picture', () => {
    const s = svg(['||', '||'])
    expect(s.startsWith('<svg')).toBe(true)
    expect(rects(s).length).toBe(0)
  })

  test('a plan that would need more than 50 000 rectangles is refused (null)', () => {
    const row = Array.from({ length: 300 }, (_, i) => (i % 2 ? '48' : '272')).join('|')
    expect(renderPlanSvg(grid(Array(300).fill(row)), 'big')).toBeNull()
  })

  test('a plan the size of a real one (233 x 207 cells, about 1 500 isolated floor cells with a floor below) stays small', () => {
    // The worst case for the file size: no neighbouring cells to merge, and every cell has a dot.
    const rows = Array.from({ length: 207 }, (_, j) =>
      Array.from({ length: 233 }, (_, i) => (j % 2 === 0 && i % 16 === 0 ? '-160,48' : '')).join('|'))
    const s = svg(rows)
    expect(rects(s).length).toBe(104 * 15 * 2)
    expect(s.length).toBeLessThan(400_000)
  })
})
