import { expect, test, describe } from 'bun:test'
import { readModel } from '../src/maps/model'
import { buildModel } from './helpers/model_builder'

// RFC 18, 4.3: the mesh of one model from its .mdl, .vvd and .vtx; and the one question asked of its materials.

const tri = (m: { solid: number[], foliage: number[] }) => ({ solid: m.solid.length / 9, foliage: m.foliage.length / 9 })
const never = () => false
const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [10, 0, 0], C: [number, number, number] = [0, 10, 0], D: [number, number, number] = [10, 10, 5]

describe('the triangles', () => {
  test('come out in the model\'s own space, three corners to a triangle', () => {
    const files = buildModel({ meshes: [{ vertices: [A, B, C, D], tris: [0, 1, 2, 1, 3, 2] }] })
    const m = readModel(files, never)!
    expect(m.foliage).toEqual([])
    expect(m.solid).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 5, 0, 10, 0])
  })

  test('the vertices of a strip group may be in any order: they are mapped back through their original numbers', () => {
    const spec = { meshes: [{ vertices: [A, B, C, D], tris: [0, 1, 2, 1, 3, 2] }] }
    expect(readModel(buildModel({ ...spec, reverseVertices: true }), never)!.solid).toEqual(readModel(buildModel(spec), never)!.solid)
  })

  test('each mesh has its own vertices, after those of the one before', () => {
    const files = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }, { vertices: [B, C, D], tris: [0, 1, 2] }] })
    const m = readModel(files, never)!
    expect(tri(m)).toEqual({ solid: 2, foliage: 0 })
    expect(m.solid.slice(9, 18)).toEqual([10, 0, 0, 0, 10, 0, 10, 10, 5])
  })

  test('the fix-ups of the first level of detail say which of the file\'s vertices make up the table', () => {
    // the file lists D, A, B, C; the fix-ups take C, A, B in that order (and skip D, and one fix-up for no level, -1)
    const files = buildModel({
      meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }],
      vvd: { vertices: [D, A, B, C], fixups: [{ lod: 0, from: 3, count: 1 }, { lod: 0, from: 1, count: 2 }, { lod: -1, from: 0, count: 1 }] },
    })
    // the mesh's vertices 0, 1, 2 are the table's: C, A, B
    expect(readModel(files, never)!.solid).toEqual([0, 10, 0, 0, 0, 0, 10, 0, 0])
  })
})

describe('foliage (a material with a cut-out or a translucent texture)', () => {
  const spec = {
    textures: ['trunk', 'LEAVES'], cdTextures: ['models\\Props\\Tree\\', 'models\\props\\'],
    meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2] }, { material: 1, vertices: [B, C, D], tris: [0, 1, 2] }],
  }

  test('is asked about each material with the paths it could be at, in lower case, a path for each directory the model names', () => {
    const asked: string[][] = []
    readModel(buildModel(spec), p => { asked.push(p); return false })
    expect(asked).toEqual([
      ['materials/models/props/tree/trunk.vmt', 'materials/models/props/trunk.vmt'],
      ['materials/models/props/tree/leaves.vmt', 'materials/models/props/leaves.vmt'],
    ])
  })

  test('the meshes the answer says are foliage go apart from the solid ones', () => {
    const m = readModel(buildModel(spec), p => p.includes('materials/models/props/tree/leaves.vmt'))!
    expect(tri(m)).toEqual({ solid: 1, foliage: 1 })
    expect(m.foliage).toEqual([10, 0, 0, 0, 10, 0, 10, 10, 5])
  })

  test('a material that is not named by the model counts as solid', () => {
    const m = readModel(buildModel({ ...spec, skinref: [0] }), () => true)! // mesh 1 has material 1, which the skin table does not have
    expect(tri(m)).toEqual({ solid: 1, foliage: 1 })
  })
})

describe('what is refused (null, never a crash)', () => {
  const good = () => buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }] })

  test('more triangles than the limit', () => {
    const files = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2, 0, 1, 2, 0, 1, 2] }] })
    expect(readModel(files, never, 2)).toBeNull()
    expect(readModel(files, never, 3)).not.toBeNull()
  })

  test('files that are not a model, empty, or cut off anywhere', () => {
    const g = good()
    expect(readModel({ ...g, mdl: Buffer.alloc(300) }, never)).toBeNull()
    expect(readModel({ ...g, vvd: Buffer.alloc(100) }, never)).toBeNull()
    expect(readModel({ mdl: Buffer.alloc(0), vvd: Buffer.alloc(0), vtx: Buffer.alloc(0) }, never)).toBeNull()
    for (const cut of [250, 300, 500, 700]) expect(() => readModel({ ...g, mdl: g.mdl.subarray(0, cut) }, never)).not.toThrow()
    for (const cut of [10, 40, 60, 100]) expect(() => readModel({ ...g, vtx: g.vtx.subarray(0, cut) }, never)).not.toThrow()
    for (const cut of [30, 70, 90]) expect(() => readModel({ ...g, vvd: g.vvd.subarray(0, cut) }, never)).not.toThrow()
  })

  test('an index that names a vertex that is not there', () => {
    const g = good()
    const vtx = Buffer.from(g.vtx)
    vtx.writeUInt16LE(60000, vtx.length - 27 - 6) // the first index
    expect(readModel({ ...g, vtx }, never)).toBeNull()
  })

  test('absurd counts in the header (a million meshes, a negative count) are refused before they are looped over', () => {
    const g = good()
    const many = Buffer.from(g.mdl); many.writeInt32LE(2_000_000_000, 204)
    expect(readModel({ ...g, mdl: many }, never)).toBeNull()
    const neg = Buffer.from(g.vvd); neg.writeInt32LE(-5, 48)
    expect(readModel({ ...g, vvd: neg }, never)).toBeNull()
  })

  test('random bytes behind a valid-looking header never throw', () => {
    const g = good()
    let seed = 1
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let i = 0; i < 200; i++) {
      const mdl = Buffer.from(g.mdl), vtx = Buffer.from(g.vtx), vvd = Buffer.from(g.vvd)
      for (const b of [mdl, vtx, vvd]) for (let k = 0; k < 6; k++) b[rand() % b.length] = rand() & 0xff
      expect(() => readModel({ mdl, vvd, vtx }, never)).not.toThrow()
    }
  })
})
