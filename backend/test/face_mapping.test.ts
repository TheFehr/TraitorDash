import { expect, test, describe } from 'bun:test'
import { extractSurfaces, memorySource, mappedUv } from '../src/maps/bsp'
import { buildBsp, flatQuad, type BspSpec } from './helpers/bsp_builder'

// RFC 18, 5: every triangle of a floor or a wall says how it is textured (the texinfo it came from), so a texture can be put on it again
// after the triangles have been cut and sorted; the coordinates are worked out from the place of a corner.

const quad = (z: number, o: Partial<BspSpec> = {}) => ({ ...flatQuad(z), ...o })

describe('what the triangles carry', () => {
  test('a face of two triangles gives two entries of the floor channel, both naming the face\'s mapping', async () => {
    const b = buildBsp(quad(0, { materials: ['brick/floor01'], mappings: [{ s: [1, 0, 0, 0], t: [0, -1, 0, 32], width: 128, height: 64 }] }))
    const s = await extractSurfaces(memorySource(b))
    expect(s.floors.length / 9).toBe(2); expect(s.floorFaces).toEqual([0, 0]); expect(s.wallFaces).toEqual([]); expect(s.faces).toEqual([{ mapping: 0 }])
    expect(s.mappings).toEqual([{ material: 'brick/floor01', s: [1, 0, 0, 0], t: [0, -1, 0, 32], width: 128, height: 64 }])
  })

  test('walls have their own channel; faces of one texinfo share a mapping, another texinfo has another', async () => {
    // two quads at heights 0 and 10 are floors; a vertical wall quad is a wall
    const q = flatQuad(0)
    const wall = { planes: [{ nx: 1, ny: 0, nz: 0, dist: 0 }], vertices: [[0, 0, 0], [0, 64, 0], [0, 64, 64], [0, 0, 64]] as [number, number, number][], edges: [[0, 0], [0, 1], [1, 2], [2, 3], [3, 0]] as [number, number][], surfedges: [1, 2, 3, 4], faces: [{ plane: 0, firstEdge: 0, numEdges: 4, texinfo: 1 }] }
    const s = await extractSurfaces(memorySource(buildBsp({ ...wall, materials: ['a', 'wall/brick'], texinfoFlags: [0, 0], mappings: [{ s: [1, 0, 0, 0], t: [0, 1, 0, 0] }, { s: [0, 1, 0, 8], t: [0, 0, -1, 0], width: 256, height: 256 }] })))
    expect(q.faces).toHaveLength(1)
    expect(s.floors).toEqual([]); expect(s.walls.length / 9).toBe(2)
    expect(s.wallFaces).toEqual([0, 0]); expect(s.faces).toEqual([{ mapping: 0 }]); expect(s.mappings).toHaveLength(1); expect(s.mappings[0]!.material).toBe('wall/brick')
  })

  test('a displacement\'s triangles name the mapping of their face, one for each triangle', async () => {
    const quads = { ...flatQuad(0), materials: ['dev/grass'], mappings: [{ s: [1, 0, 0, 0], t: [0, 1, 0, 0], width: 64, height: 64 }], displacements: [{ startPosition: [0, 0, 0] as [number, number, number], vertStart: 0, power: 2 }], dispVerts: Array.from({ length: 25 }, () => ({ vec: [0, 0, 1] as [number, number, number], dist: 0 })) }
    quads.faces[0]!.dispinfo = 0
    const s = await extractSurfaces(memorySource(buildBsp(quads)))
    const n = (s.floors.length + s.walls.length) / 9
    expect(n).toBe(32) // 4 by 4 cells of two triangles
    expect(s.floorFaces.length + s.wallFaces.length).toBe(n)
    expect(new Set([...s.floorFaces, ...s.wallFaces])).toEqual(new Set([0])); expect(s.faces).toEqual([{ mapping: 0 }]) // one face, one record, all the triangles name it
  })

  test('the channels have a mapping for every triangle of the floors and of the walls', async () => {
    const s = await extractSurfaces(memorySource(buildBsp(flatQuad(0))))
    expect(s.floorFaces).toHaveLength(s.floors.length / 9); expect(s.wallFaces).toHaveLength(s.walls.length / 9)
  })
})

describe('the coordinates of a point', () => {
  const m = { material: 'x', s: [1, 0, 0, 16], t: [0, -1, 0, 0], width: 64, height: 32 }
  test('are the projection onto the two vectors over the size of the texture', () => {
    expect(mappedUv(m, 0, 0, 5)).toEqual([0.25, 0])
    expect(mappedUv(m, 48, 16, 99)).toEqual([1, -0.5])
    expect(mappedUv({ ...m, s: [0.5, 0.5, 0, 0], t: [0, 0, 1, 0] }, 64, 64, 32)).toEqual([1, 1])
  })
  test('a texture whose size is not known counts in units of one, never dividing by 0', () => {
    expect(mappedUv({ ...m, width: 0, height: 0 }, 4, 0, 0)).toEqual([20, 0])
  })
  test('a face of a brush entity is projected from its own space: the turn and the origin are undone', () => {
    // an entity put at (100, 0, 0) and turned by 90 degrees about z: its local x axis points along +y
    const turn = [0, -1, 0, 1, 0, 0, 0, 0, 1]
    const placed = { ...m, s: [1, 0, 0, 0], t: [0, 1, 0, 0], width: 1, height: 1, placed: { origin: [100, 0, 0] as [number, number, number], turn } }
    expect(mappedUv(placed, 100, 8, 0)).toEqual([8, 0]) // 8 along +y from the origin is 8 along local x
    expect(mappedUv({ ...placed, placed: { origin: [100, 0, 0], turn: null } }, 108, 4, 0)).toEqual([8, 4]) // moved only
  })
})
