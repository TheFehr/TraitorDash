import { expect, test, describe } from 'bun:test'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { basis, soupOf } from '../src/mapflat'

// RFC 19, 3.2: the map as a list of triangles in Source's coordinates, and the camera that looks at them.

const mesh = (name: string, pts: number[]) => {
  const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3))
  const m = new MeshStandardMaterial(); m.name = name
  return new Mesh(g, m)
}
/** Like the map's file: a root turned a quarter turn, level 1 with a floor and a wall, a water node far away. */
function model() {
  const root = new Group(); root.rotation.x = -Math.PI / 2
  const level = new Group(); level.name = 'level-1'; level.userData.hi = 200
  level.add(mesh('floor', [0, 0, 0, 100, 0, 0, 0, 50, 0]))
  level.add(mesh('wall', [0, 0, 0, 100, 0, 0, 100, 0, 64]))
  const water = new Group(); water.name = 'water'
  water.add(mesh('water', [5000, 5000, -10, 5100, 5000, -10, 5000, 5100, -10]))
  root.add(level, water)
  return root
}

describe('soupOf', () => {
  const soup = soupOf(model(), 'textured')

  test('one entry for each triangle: floor, wall and water, with their kind and level', () => {
    expect(soup.n).toBe(3)
    expect([...soup.wall]).toEqual([0, 1, 0])
    expect([...soup.water]).toEqual([0, 0, 1])
    expect(soup.level[0]).toBe(1)
    expect(soup.hi.get(1)).toBe(200)
    expect(soup.levels).toEqual([1])
  })

  test('the points are in Source\'s coordinates and the normals point the way the faces do', () => {
    expect([...soup.pos.slice(0, 9)].map(v => Math.round(v) + 0)).toEqual([0, 0, 0, 100, 0, 0, 0, 50, 0])
    expect(Math.round(soup.normal[2]!)).toBe(1) // the floor faces up
    expect(Math.abs(Math.round(soup.normal[3 + 1]!))).toBe(1) // the wall on the x axis faces along y
  })

  test('the water does not decide the extent', () => {
    expect(soup.max.map(v => Math.round(v) + 0)).toEqual([100, 50, 64])
  })

  test('colours: plain by default and per colouring on demand', () => {
    expect(soup.base[0]).toBe(0xcfc6b0)
    expect(soup.base[1]).toBe(0xa59d8c)
    soup.recolour('levels')
    expect(soup.base[1]).toBe(0x9999a6) // a wall in the Levels colouring
    expect(soup.base[0]).not.toBe(0xcfc6b0)
    soup.recolour('textured')
    expect(soup.base[0]).toBe(0xcfc6b0)
  })

  test('the largest triangle comes first in the size order', () => {
    expect(soup.bySize.length).toBe(3)
    expect(soup.bySize[0]).toBe(2) // the water triangle is the biggest of the three
  })
})

describe('basis', () => {
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  test('right, up and the way to the camera are at right angles and of length one', () => {
    for (const [yaw, pitch] of [[0, 0.5], [2, 1], [-1.2, 0.2]] as const) {
      const { d, r, u } = basis(yaw, pitch)
      expect(dot(d, r)).toBeCloseTo(0); expect(dot(d, u)).toBeCloseTo(0); expect(dot(r, u)).toBeCloseTo(0)
      expect(dot(u, u)).toBeCloseTo(1); expect(dot(r, r)).toBeCloseTo(1)
      expect(u[2]).toBeGreaterThanOrEqual(0) // up is up
    }
  })
  test('from straight above with the camera turned south, north is up and east is right', () => {
    const { r, u } = basis(-Math.PI / 2, Math.PI / 2 - 0.0001)
    expect(r[0]).toBeCloseTo(1); expect(u[1]).toBeCloseTo(1, 3)
  })
})
