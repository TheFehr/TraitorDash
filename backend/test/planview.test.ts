import { expect, test, describe } from 'bun:test'
import { renderPlanSvg, planLevels, heightColour } from '../src/services/mapplan'

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

  test('the highest floor of a cell is drawn in the overview, and there is no marker for floors below it', () => {
    const r = rects(svg(['-160,272|48']))
    expect(attr(r[0]!, 'fill')).toMatch(/^hsl\(0 /) // 272, the highest of the cell and of the plan
    expect(r.some(t => attr(t, 'fill') === '#000')).toBe(false)
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

  test('crops to the cells that are drawn, with a two-cell margin, and makes room for the legend', () => {
    const rows = Array.from({ length: 10 }, (_, j) => Array.from({ length: 10 }, (_, i) => (i === 5 && j === 5 ? '48' : '')).join('|'))
    const s = svg(rows)
    // 5 x 5 cells drawn area (with margin) is 40 x 40 pixels: widened to fit the legend (180) and taller by its strip (36)
    expect(/viewBox="([^"]*)"/.exec(s)![1]).toBe('24 16 180 76')
  })

  test('states that it shows all floors and their height range', () => {
    expect(svg(['-160|48|272'])).toContain('all floors · -160 to 272')
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

  test('a plan the size of a real one (233 x 207 cells, about 1 500 isolated crouch-only cells) stays small', () => {
    // The worst case for the file size: no neighbouring cells to merge, every cell faint with a dot.
    const rows = Array.from({ length: 207 }, (_, j) =>
      Array.from({ length: 233 }, (_, i) => (j % 2 === 0 && i % 16 === 0 ? '-160c,48c' : '')).join('|'))
    const s = svg(rows)
    expect(rects(s).length).toBe(104 * 15 * 2)
    expect(s.length).toBeLessThan(400_000)
  })
})

// A plan with clear storeys: `n` cells at each given height, spread over rows of 20 cells.
const storeys = (heights: Record<number, number>, extra: string[] = []) => {
  const cells: string[] = []
  for (const [z, n] of Object.entries(heights)) for (let i = 0; i < n; i++) cells.push(z)
  cells.push(...extra)
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += 20) rows.push(cells.slice(i, i + 20).concat(Array(20).fill('')).slice(0, 20).join('|'))
  return grid(rows)
}

describe('planLevels: finding the storeys', () => {
  test('two heights with many cells are two storeys, lowest first, counted and ranged', () => {
    const l = planLevels(storeys({ 48: 60, 272: 60 }))
    expect(l.map(x => [x.index, x.lo, x.hi, x.cells])).toEqual([[1, 48, 48, 60], [2, 272, 272, 60]])
  })

  test('stairs between two storeys join the storey they are nearest to', () => {
    const l = planLevels(storeys({ 48: 60, 272: 60 }, ['100', '150', '200', '230']))
    expect(l).toHaveLength(2)
    expect(l[0]).toMatchObject({ lo: 48, hi: 150, cells: 62 })
    expect(l[1]).toMatchObject({ lo: 200, hi: 272, cells: 62 })
  })

  test('a handful of cells at an odd height (a vent) is not a storey of its own', () => {
    const l = planLevels(storeys({ 48: 80, 272: 80 }, ['296c', '296c', '296c']))
    expect(l).toHaveLength(2)
    expect(l[1]!.hi).toBe(296)
  })

  test('five storeys come out in order', () => {
    const l = planLevels(storeys({ '-160': 90, 48: 90, 272: 90, 480: 90, 700: 90 }))
    expect(l.map(x => x.lo)).toEqual([-160, 48, 272, 480, 700])
    expect(l.map(x => x.index)).toEqual([1, 2, 3, 4, 5])
  })

  test('the test map\'s 416 and 480 levels, 64 units apart, are one storey (416 looked like a void under 480)', () => {
    const l = planLevels(storeys({ '-160': 90, 48: 90, 272: 90, 416: 40, 480: 90 }))
    expect(l.map(x => x.lo)).toEqual([-160, 48, 272, 416])
    expect(l[3]).toMatchObject({ lo: 416, hi: 480, cells: 130 })
  })

  test('a height with few cells next to a big plan is not a storey (under 3% of all floors)', () => {
    // 1000 floors: 900 + 60 are storeys (6%); 20 cells (2%) high up are not and join the nearest one.
    const l = planLevels(storeys({ 48: 900, 272: 60, 700: 20 }))
    expect(l.map(x => x.lo)).toEqual([48, 272])
    expect(l[1]).toMatchObject({ lo: 272, hi: 700, cells: 80 })
  })

  test('a long ramp, with a few cells at every height, does not turn into storeys of its own', () => {
    const ramp: Record<number, number> = {}
    for (let z = 80; z <= 240; z += 16) ramp[z] = 8
    const l = planLevels(storeys({ 48: 60, 272: 60, ...ramp }))
    expect(l).toHaveLength(2)
  })

  test('when two close heights merge, the one with more floors sets the storey', () => {
    // 48 (30 floors) and 112 (60 floors) merge into a storey around 112; a few floors at 190 are nearest to it,
    // not to the storey at 300.
    const l = planLevels(storeys({ 48: 30, 112: 60, 300: 50 }, ['190', '190']))
    expect(l).toHaveLength(2)
    expect(l[0]).toMatchObject({ lo: 48, hi: 190 })
    expect(l[1]).toMatchObject({ lo: 300, hi: 300 })
  })

  test('two heights closer than 96 units are one storey', () => {
    expect(planLevels(storeys({ 48: 60, 100: 60 }))).toHaveLength(1)
  })

  test('one height is one storey', () => {
    expect(planLevels(storeys({ 48: 30 }))).toHaveLength(1)
  })

  test('a plan too small to have a clear storey is one storey with everything in it', () => {
    const l = planLevels(grid(['-160|48|272']))
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ lo: -160, hi: 272, cells: 3 })
  })

  test('an empty plan has no storeys', () => {
    expect(planLevels(grid(['||', '||']))).toEqual([])
  })

  test('negative heights and the zero boundary are handled', () => {
    const l = planLevels(storeys({ '-200': 50, '-8': 50 }))
    expect(l.map(x => x.lo)).toEqual([-200, -8])
  })
})

describe('renderPlanSvg: one storey', () => {
  const two = () => storeys({ 48: 40, 272: 40 }, ['100', '230'])
  const level = (n: number, g = two()) => renderPlanSvg(g, 'ttt_a', n)!

  const cellsDrawn = (s: string) => rects(s).filter(t => attr(t, 'fill') !== '#fff').reduce((n, t) => n + Number(attr(t, 'width')) / 8, 0)

  test('draws only the floors of that storey', () => {
    // 40 cells at 48 plus a stair cell at 100 belong to storey 1; 40 at 272 plus one at 230 to storey 2
    expect(cellsDrawn(level(1))).toBe(41)
    expect(cellsDrawn(level(2))).toBe(41)
    expect(cellsDrawn(renderPlanSvg(two(), 'ttt_a')!)).toBe(82)
  })

  test('a storey that does not exist is null, never the whole plan', () => {
    expect(renderPlanSvg(two(), 'ttt_a', 3)).toBeNull()
    expect(renderPlanSvg(two(), 'ttt_a', 0)).toBeNull()
  })

  test('colours within the storey: its own lowest floor is blue, its own highest is red', () => {
    const r = rects(level(1))
    const fills = r.map(t => attr(t, 'fill')!)
    expect(fills.some(f => f.startsWith('hsl(240 '))).toBe(true) // 48, the lowest of storey 1
    expect(fills.some(f => f.startsWith('hsl(0 '))).toBe(true) // 100, the highest of storey 1
  })

  test('every storey of a plan has the same frame, so they line up', () => {
    const g = two()
    const view = (n: number) => /viewBox="([^"]*)"/.exec(renderPlanSvg(g, 'ttt_a', n)!)![1]
    expect(view(1)).toBe(view(2))
    expect(view(1)).toBe(/viewBox="([^"]*)"/.exec(renderPlanSvg(g, 'ttt_a')!)![1])
  })

  test('says which storey it is and its height range', () => {
    expect(level(2)).toContain('level 2 of 2 · 230 to 272')
    expect(level(1)).toContain('level 1 of 2 · 48 to 100')
  })

  test('the legend is short enough to fit a small picture', () => {
    const text = /<text[^>]*>([^<]*)<\/text>/.exec(level(2))![1]!
    expect(text.length).toBeLessThan(40)
  })

  test('the overview does not claim to be a storey', () => {
    expect(renderPlanSvg(two(), 'ttt_a')!).not.toContain('level ')
  })

  test('a crouch-only cell in a storey is faint with a white dot', () => {
    const g = storeys({ 48: 40, 272: 40 }, ['296c'])
    const r = rects(renderPlanSvg(g, 'ttt_a', 2)!)
    expect(r.filter(t => attr(t, 'fill') === '#fff').length).toBe(1)
  })

  test('a storey that does not exist is null-safe: the caller checks planLevels first', () => {
    expect(planLevels(two()).length).toBe(2)
  })
})

describe('the legend inside every picture', () => {
  const many = () => storeys({ 48: 40, 272: 40 })
  const texts = (s: string) => (s.match(/<text[^>]*>[^<]*<\/text>/g) ?? []).map(t => t.replace(/<[^>]+>/g, ''))

  test('a gradient bar in the same colours as the squares', () => {
    const s = renderPlanSvg(many(), 'ttt_a')!
    expect(s).toContain('<linearGradient')
    for (let i = 0; i <= 6; i++) expect(s).toContain(`stop-color="${heightColour(i / 6)}"`)
    expect(s.indexOf(`stop-color="${heightColour(0)}"`)).toBeLessThan(s.indexOf(`stop-color="${heightColour(1)}"`)) // blue first, red last
    expect(s).toMatch(/<path [^>]*data-legend="scale"[^>]*fill="url\(#scale\)"|<path [^>]*fill="url\(#scale\)"[^>]*data-legend="scale"/)
  })

  test('the bar is labelled with the lowest and highest height drawn in this picture', () => {
    expect(texts(renderPlanSvg(many(), 'ttt_a')!)).toEqual(expect.arrayContaining(['48', '272']))
    const l2 = texts(renderPlanSvg(storeys({ 48: 40, 272: 40, 500: 40 }), 'ttt_a', 2)!)
    expect(l2).toEqual(expect.arrayContaining(['272']))
    expect(l2).not.toContain('500')
  })

  test('explains the faint square with a dot as crouch-only', () => {
    const s = renderPlanSvg(many(), 'ttt_a')!
    expect(texts(s)).toContain('crouch-only')
    // a sample square drawn like a crouch-only cell: faint, with the white dot
    const sample = (s.match(/<path [^>]*data-legend="crouch"[^>]*>/g) ?? [])
    expect(sample).toHaveLength(1)
    expect(sample[0]).toContain('fill-opacity=".4"')
    const dot = (s.match(/<path [^>]*data-legend="crouch-dot"[^>]*>/g) ?? [])
    expect(dot).toHaveLength(1)
    expect(dot[0]).toContain('fill="#fff"')
  })

  test('the legend sits below the plan, inside the picture, and never over a square', () => {
    const s = renderPlanSvg(grid(Array(10).fill('48|48')), 'ttt_a')! // tall enough that the plan is deeper than the legend's labels
    const [x, y, w, h] = /viewBox="([^"]*)"/.exec(s)![1]!.split(' ').map(Number) as [number, number, number, number]
    const strip = h - 36
    const legendTops = (s.match(/<text[^>]*font-size="9"[^>]*>/g) ?? []).map(t => Number(attr(t, 'y')))
    expect(legendTops.length).toBeGreaterThan(0)
    for (const ty of legendTops) expect(ty).toBeGreaterThan(y + strip) // every legend label is below the plan area
    for (const t of s.match(/<rect [^>]*>/g) ?? []) expect(Number(attr(t, 'y')) + Number(attr(t, 'height'))).toBeLessThanOrEqual(y + strip) // no square reaches into the strip
    expect(w).toBeGreaterThanOrEqual(180)
    expect(x).toBe(0)
  })

  test('an empty plan has no legend to draw', () => {
    expect(renderPlanSvg(grid(['||']), 'ttt_a')!).not.toContain('linearGradient')
  })

  test('the legend is not made of <rect>, so it never counts as squares of the plan', () => {
    expect(rects(renderPlanSvg(storeys({ 48: 40 }), 'ttt_a')!).every(t => !/data-legend/.test(t))).toBe(true)
  })
})

describe('heightColour: the one colour scale of pictures and legend', () => {
  test('runs from blue at 0 to red at 1, through the hues in between', () => {
    expect(heightColour(0)).toBe('hsl(240 70% 50%)')
    expect(heightColour(1)).toBe('hsl(0 70% 50%)')
    expect(heightColour(0.5)).toBe('hsl(120 70% 50%)')
  })

  test('the pictures use it', () => {
    const r = rects(svg(['-160|48|272']))
    expect(attr(r[0]!, 'fill')).toBe(heightColour(0))
    expect(attr(r[2]!, 'fill')).toBe(heightColour(1))
  })
})
