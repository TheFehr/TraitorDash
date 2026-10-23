import { expect, test, describe } from 'bun:test'
import { findParts, soupOfKinds } from '../src/maps/parts'

// RFC 18, 4.4: the triangles grouped by shared corners; main, detached and sky parts.

/** Two triangles covering a square at height z. */
const floor = (z: number, x0 = 0, y0 = 0, size = 64) => [
  x0, y0, z, x0 + size, y0, z, x0 + size, y0 + size, z,
  x0, y0, z, x0 + size, y0 + size, z, x0, y0 + size, z,
]
/** Two triangles covering an upright square from z0 to z1 along x. */
const wall = (z0: number, z1: number, x0 = 0, y = 0, width = 64) => [
  x0, y, z0, x0 + width, y, z0, x0 + width, y, z1,
  x0, y, z0, x0 + width, y, z1, x0, y, z1,
]
const spawn = (x: number, y: number, z = 40) => ({ x, y, z })
const kinds = (r: ReturnType<typeof findParts>) => r.parts.map(p => p.kind)
/** A strip of 120 triangles far away: the rest of a map, so that the small parts of a test are well under 5% of it. */
const ballast = () => Array.from({ length: 60 }, (_, i) => floor(0, -50_000 + i * 100, -50_000, 100)).flat()

describe('parts by shared corners', () => {
  test('squares that share an edge are one part; squares that do not touch are two', () => {
    const r = findParts([[...floor(0, 0, 0, 100), ...floor(0, 100, 0, 100)]], { spawns: [], skyCameras: [] })
    expect(r.parts).toHaveLength(1)
    expect(r.parts[0]!.triangles).toBe(4)
    const apart = findParts([[...floor(0, 0, 0, 100), ...floor(0, 120, 0, 100)]], { spawns: [], skyCameras: [] })
    expect(apart.parts).toHaveLength(2)
  })

  test('corners a few units apart still join, ten units apart do not', () => {
    const close = findParts([[...floor(0, 0, 0, 100), ...floor(3, 100, 0, 100)]], { spawns: [], skyCameras: [] })
    expect(close.parts).toHaveLength(1)
    const far = findParts([[...floor(0, 0, 0, 100), ...floor(0, 110, 0, 100)]], { spawns: [], skyCameras: [] })
    expect(far.parts).toHaveLength(2)
  })

  test('corners either side of a grid line are found whichever comes first', () => {
    // 7.9 and 8.1 are in different cells of 8 and 0.2 apart; so are 15.9 and 16.1
    for (const gap of [0.2, 0.3]) for (const x of [7.9, 15.9, -0.1, 23.9]) {
      const a = [x, 0, 0, x - 50, 0, 0, x - 50, 50, 0], b = [x + gap, 0, 0, x + 50, 0, 0, x + 50, 50, 0]
      expect(findParts([[...a, ...b]], { spawns: [], skyCameras: [] }).parts).toHaveLength(1)
      expect(findParts([[...b, ...a]], { spawns: [], skyCameras: [] }).parts).toHaveLength(1)
    }
  })

  test('floors and walls join into one part when they share corners; every triangle knows its part', () => {
    const r = findParts([floor(0, 0, 0, 100), wall(0, 100, 0, 0, 100)], { spawns: [], skyCameras: [] })
    expect(r.parts).toHaveLength(1)
    expect([...r.of[0]!, ...r.of[1]!]).toEqual([0, 0, 0, 0])
  })

  test('nothing in, nothing out; soups must be whole triangles', () => {
    expect(findParts([[], []], { spawns: [], skyCameras: [] }).parts).toEqual([])
    expect(() => findParts([[1, 2, 3]], { spawns: [], skyCameras: [] })).toThrow(/triangles/)
  })

  test('the result does not depend on the order of the soups\' triangles for what is in which part', () => {
    const a = [...floor(0, 0, 0, 100), ...floor(0, 100, 0, 100), ...floor(0, 5000, 0, 100)]
    const b = [...floor(0, 5000, 0, 100), ...floor(0, 100, 0, 100), ...floor(0, 0, 0, 100)]
    const sizes = (s: number[]) => findParts([s], { spawns: [], skyCameras: [] }).parts.map(p => p.triangles).sort()
    expect(sizes(a)).toEqual(sizes(b))
  })
})

describe('main and detached', () => {
  test('a part with a spawn on it is main; a small far part is detached; the big one is main without a spawn', () => {
    const big = Array.from({ length: 30 }, (_, i) => floor(0, i * 100, 0, 100)).flat() // 60 triangles, one part
    const lone = floor(-6000, 9000, 0, 200)
    const r = findParts([[...big, ...lone]], { spawns: [spawn(50, 50)], skyCameras: [] })
    expect(kinds(r)).toEqual(['main', 'detached'])
    expect(r.parts[0]!.spawns).toBe(1)
    const noSpawn = findParts([[...big, ...lone]], { spawns: [], skyCameras: [] })
    expect(kinds(noSpawn)).toEqual(['main', 'detached']) // 60 of 62 triangles: main by share
  })

  test('a small part that stands near a main part, or on its floor, is not detached', () => {
    const room = [...floor(0, 0, 0, 4000)] // two huge triangles: their corners are far from everything on the floor
    const crate = [...floor(48, 1500, 1500, 48), ...wall(0, 48, 1500, 1500, 48)] // rests on the floor, no shared corner
    const hanging = floor(2000, 1500, 1500, 48) // floats 2000 units above it
    const nearby = floor(0, 4100, 0, 48) // 100 units beyond the corner of the room
    const r = findParts([[...room, ...crate, ...hanging, ...nearby, ...ballast()]], { spawns: [spawn(500, 500), spawn(-49_950, -49_950)], skyCameras: [] })
    const small = r.parts.filter(p => p.triangles < 10 && p.spawns === 0)
    expect(small).toHaveLength(3) // crate, hanging, nearby
    expect(small.filter(p => p.kind === 'main')).toHaveLength(2)
    expect(small.find(p => p.kind === 'detached')!.min[2]).toBe(2000)
  })

  test('without a spawn and without a big part, the largest part is main (there is always one)', () => {
    const r = findParts([[...floor(0, 0, 0, 100), ...floor(0, 5000, 0, 100), ...floor(0, 9000, 0, 100), ...floor(0, 9000, 5000, 100), ...floor(0, 20000, 0, 100), ...floor(0, 30000, 0, 100), ...floor(0, 40000, 0, 100), ...floor(0, 50000, 0, 100), ...floor(0, 60000, 0, 100), ...floor(0, 70000, 0, 100), ...wall(0, 50, 0, 0, 100)]], { spawns: [], skyCameras: [] })
    expect(r.parts.filter(p => p.kind === 'main').length).toBeGreaterThanOrEqual(1)
  })

  test('a spawn is found on a floor made of one huge triangle, and above a lower floor', () => {
    const r = findParts([[...floor(0, 0, 0, 8000), ...floor(500, 20000, 0, 100)]], { spawns: [spawn(4000, 3000, 30)], skyCameras: [] })
    expect(r.parts[0]!.spawns).toBe(1)
    expect(r.parts[1]!.spawns).toBe(0)
  })

  test('soupOfKinds gives the triangles of the parts of the given kinds, in order', () => {
    const f = [...floor(0, 0, 0, 100), ...floor(-6000, 9000, 0, 100), ...ballast()]
    const r = findParts([f], { spawns: [spawn(50, 50), spawn(-49_950, -49_950)], skyCameras: [] })
    expect(soupOfKinds(f, r.of[0]!, r.parts, ['main'])).toEqual([...floor(0, 0, 0, 100), ...ballast()])
    expect(soupOfKinds(f, r.of[0]!, r.parts, ['detached'])).toEqual(floor(-6000, 9000, 0, 100))
    expect(soupOfKinds(f, r.of[0]!, r.parts, ['main', 'detached']).length).toBe(f.length)
  })
})

describe('the 3D skybox', () => {
  // The skybox is a small copy of the surroundings, built far from the map; a sky camera stands inside it.
  const map = () => [...floor(0, 0, 0, 800), ...floor(0, 800, 0, 800), ...wall(0, 100, 0, 0, 800)]
  const sky = () => [...floor(0, 50_000, 50_000, 600), ...floor(0, 50_600, 50_000, 600)]
  const camera = { x: 50_300, y: 50_300, z: 100 }

  test('the part the camera stands in is the sky, and the map is not', () => {
    const r = findParts([[...map(), ...sky()]], { spawns: [spawn(400, 400)], skyCameras: [camera] })
    expect(kinds(r)).toEqual(['main', 'sky'])
    expect(r.skyTriangles).toBe(4)
  })

  test('the other parts inside the box around the sky are sky too; parts outside it are not', () => {
    const extra = floor(0, 50_200, 50_100, 100) // a separate piece within the skybox
    const outside = floor(0, 70_000, 70_000, 100)
    const r = findParts([[...map(), ...sky(), ...extra, ...outside, ...ballast()]], { spawns: [spawn(400, 400)], skyCameras: [camera] })
    expect(kinds(r)).toEqual(['main', 'sky', 'sky', 'detached', 'main'])
  })

  test('a camera that is not inside any geometry takes nothing', () => {
    const r = findParts([[...map(), ...sky(), ...ballast()]], { spawns: [spawn(400, 400)], skyCameras: [{ x: -99_999, y: -99_999, z: 0 }] })
    expect(r.skyTriangles).toBe(0)
    expect(kinds(r)).toEqual(['main', 'detached', 'main'])
  })

  test('a part with a spawn on it is never the sky, even with the camera inside', () => {
    const r = findParts([[...map(), ...sky()]], { spawns: [spawn(400, 400), spawn(50_300, 50_300, 40)], skyCameras: [camera] })
    expect(r.skyTriangles).toBe(0)
  })

  test('a "skybox" that is more than half of the map is not removed: it is probably the map', () => {
    const big = Array.from({ length: 40 }, (_, i) => floor(0, 50_000 + i * 100, 50_000, 100)).flat()
    const r = findParts([[...floor(0, 0, 0, 100), ...big]], { spawns: [spawn(50, 50)], skyCameras: [camera] })
    expect(r.skyTriangles).toBe(0)
    expect(r.parts.some(p => p.kind === 'sky')).toBe(false)
  })

  test('a skybox joined to the map by shared corners cannot be told apart and stays; a spawn keeps its own part', () => {
    const joined = [...floor(0, 0, 0, 800), ...floor(0, 800, 0, 800), ...floor(0, 1600, 0, 800)]
    const r = findParts([joined], { spawns: [spawn(400, 400)], skyCameras: [{ x: 2000, y: 400, z: 0 }] })
    expect(r.skyTriangles).toBe(0)
  })

  test('two skyboxes, each with a camera, are both sky', () => {
    const second = floor(0, -60_000, 50_000, 600)
    const r = findParts([[...map(), ...sky(), ...second]], { spawns: [spawn(400, 400)], skyCameras: [camera, { x: -59_700, y: 50_300, z: 0 }] })
    expect(r.skyTriangles).toBe(6)
  })
})
