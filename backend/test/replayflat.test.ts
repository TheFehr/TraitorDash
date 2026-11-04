import { expect, test, describe } from 'bun:test'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { flatten } from '../src/replayflat'

// RFC 19: the flat replay takes the map's meshes (three's Y-up) to Source's x and y, floors as triangles and walls as lines.

/** A model like the map's GLB: a root turned a quarter turn (Source is Z-up), a level node with a floor and a wall mesh. */
function model() {
  const root = new Group()
  root.rotation.x = -Math.PI / 2 // Source (x, y, z) sits in the file as (x, z, -y), so the group turns it back
  const level = new Group(); level.name = 'level-1'
  const mesh = (name: string, pts: number[]) => {
    const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3))
    const m = new MeshStandardMaterial(); m.name = name
    return new Mesh(g, m)
  }
  // in the group's own space (Source's): a floor triangle on the ground, a wall standing on the edge from (0,0) to (100,0)
  level.add(mesh('floor', [0, 0, 0, 100, 0, 0, 0, 50, 0]))
  level.add(mesh('wall', [0, 0, 0, 100, 0, 0, 100, 0, 64]))
  root.add(level)
  return root
}

describe('flatten', () => {
  test('floors become triangles and walls lines, in Source\'s x and y, for their level', () => {
    const flat = flatten(model(), 'plain', 1)
    expect(flat.layers.map(l => l.index)).toEqual([1])
    const floors = [...flat.layers[0]!.floors.values()].flat()
    expect(floors.map(v => Math.round(v) + 0)).toEqual([0, 0, 100, 0, 0, 50])
    const walls = [...flat.layers[0]!.walls.values()].flat().map(v => Math.round(v) + 0)
    expect(walls).toEqual([0, 0, 100, 0]) // the longest edge of the wall's triangle, along the ground
    expect(flat.min.map(v => Math.round(v) + 0)).toEqual([0, 0])
    expect(flat.max.map(v => Math.round(v) + 0)).toEqual([100, 50])
  })

  test('a map with no level nodes has nothing to draw', () => {
    const flat = flatten(new Group(), 'plain', 1)
    expect(flat.layers).toEqual([])
    expect(Number.isFinite(flat.min[0])).toBe(false)
  })
})
