import { expect, test, describe } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import validator from 'gltf-validator'
import { readHeader, memorySource } from '../src/maps/bsp'
import { buildPropSet, PROP_LIMITS } from '../src/maps/propset'
import { surfacesToGlb, angleQuaternion } from '../src/maps/meshGlb'
import { buildBsp, flatQuad } from './helpers/bsp_builder'
import { buildModel, buildZip } from './helpers/model_builder'

// RFC 18, 4.3 and 7: the props of a map as the mesh gets them: from the map's own pack, near the map, within the limits.

const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [10, 0, 0], C: [number, number, number] = [0, 10, 0]
const house = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }] })
const glassy = buildModel({ textures: ['wall', 'glass'], meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2] }, { material: 1, vertices: [A, B, C], tris: [0, 1, 2] }] })
const big = (n: number) => buildModel({ meshes: [{ vertices: [A, B, C], tris: Array.from({ length: n * 3 }, (_, i) => i % 3) }] })
const files = (name: string, m: { mdl: Buffer, vvd: Buffer, vtx: Buffer }) => ({ [`models/test/${name}.mdl`]: m.mdl, [`models/test/${name}.vvd`]: m.vvd, [`models/test/${name}.dx90.vtx`]: m.vtx })
const around = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }

const open = async (pack: Record<string, Buffer | string>, props: { model: string, x: number, y: number, z?: number }[], extra: Parameters<typeof buildBsp>[0] = {}) => {
  const models = [...new Set(props.map(p => p.model))]
  const src = memorySource(buildBsp({
    ...flatQuad(0), pak: buildZip(pack),
    staticProps: { models, props: props.map(p => ({ model: models.indexOf(p.model), x: p.x, y: p.y, z: p.z ?? 0, yaw: 90 })) }, ...extra,
  }))
  return { src, header: await readHeader(src) }
}

describe('what is drawn', () => {
  test('the places of a model that the pack has, each model read once', async () => {
    const { src, header } = await open(files('house', house), [{ model: 'models/test/house.mdl', x: 100, y: 100 }, { model: 'models/test/house.mdl', x: 300, y: 100 }])
    const { set, report } = await buildPropSet(src, header, [], around)
    expect(set.models.map(m => m.name)).toEqual(['models/test/house.mdl'])
    expect(set.placements).toHaveLength(2)
    expect(set.placements[1]).toMatchObject({ model: 0, x: 300, y: 100, yaw: 90 })
    expect(report).toMatchObject({ found: 2, near: 2, drawnPlacements: 2, drawnModels: 1, triangles: 2, unavailable: 0, dropped: 0 })
  })

  test('a model the pack does not have (the game\'s own) is counted, not drawn, and costs the map nothing else', async () => {
    const { src, header } = await open(files('house', house), [{ model: 'models/test/house.mdl', x: 100, y: 100 }, { model: 'models/props_c17/crate.mdl', x: 200, y: 200 }, { model: 'models/props_c17/crate.mdl', x: 300, y: 200 }])
    const { report } = await buildPropSet(src, header, [], around)
    expect(report).toMatchObject({ found: 3, drawnPlacements: 1, unavailable: 1 }) // distinct models: two places of one missing model are one
  })

  test('a model with a file missing, or one that cannot be read, or one over the triangle limit', async () => {
    const pack = { ...files('house', house), ...files('nomesh', house), ...files('big', big(40)), 'models/test/broken.mdl': Buffer.alloc(400), 'models/test/broken.vvd': Buffer.alloc(100), 'models/test/broken.dx90.vtx': Buffer.alloc(100) }
    delete (pack as any)['models/test/nomesh.vvd']
    const props = ['house', 'nomesh', 'big', 'broken'].map((n, i) => ({ model: `models/test/${n}.mdl`, x: 100 + i * 50, y: 100 }))
    const { src, header } = await open(pack, props)
    const { report } = await buildPropSet(src, header, [], around, { ...PROP_LIMITS, maxModelTriangles: 10 })
    expect(report).toMatchObject({ drawnModels: 1, unavailable: 1, tooBig: 1, unreadable: 1 })
  })

  test('props far from the map (a 3D skybox has its own) are not drawn', async () => {
    const { src, header } = await open(files('house', house), [{ model: 'models/test/house.mdl', x: 100, y: 100 }, { model: 'models/test/house.mdl', x: 90_000, y: 100 }])
    const { report } = await buildPropSet(src, header, [], around)
    expect(report).toMatchObject({ found: 2, near: 1, drawnPlacements: 1 })
  })

  test('entity props are drawn with the static ones', async () => {
    const { src, header } = await open(files('house', house), [])
    const { set } = await buildPropSet(src, header, [{ model: 'models/test/house.mdl', x: 5, y: 6, z: 7, pitch: 0, yaw: 45, roll: 0 }], around)
    expect(set.placements).toEqual([{ model: 0, x: 5, y: 6, z: 7, pitch: 0, yaw: 45, roll: 0 }])
  })

  test('no geometry to be near, no props', async () => {
    const { src, header } = await open(files('house', house), [{ model: 'models/test/house.mdl', x: 100, y: 100 }])
    expect((await buildPropSet(src, header, [], null)).set.placements).toEqual([])
  })
})

describe('foliage, from the material files in the pack', () => {
  const pack = (vmt: string) => ({ ...files('glassy', glassy), 'materials/models/test/glass.vmt': vmt, 'materials/models/test/wall.vmt': '"VertexLitGeneric" { "$basetexture" "x" }' })
  const run = async (vmt: string) => {
    const { src, header } = await open(pack(vmt), [{ model: 'models/test/glassy.mdl', x: 100, y: 100 }])
    return (await buildPropSet(src, header, [], around)).set.models[0]!
  }

  test('a material with $alphatest or $translucent is foliage, in either way of writing it; the others stay solid', async () => {
    for (const vmt of ['"VertexLitGeneric" { $alphatest 1 }', '"VertexLitGeneric" { "$alphatest" "1" }', '"VertexLitGeneric" { "$translucent" 1 }', '"VertexLitGeneric" { "$TRANSLUCENT" "1" }']) {
      const m = await run(vmt)
      expect([m.solid.length / 9, m.foliage.length / 9]).toEqual([1, 1])
    }
  })

  test('a material that has them switched off, or no material file, is solid', async () => {
    expect((await run('"VertexLitGeneric" { "$alphatest" 0 }')).foliage).toEqual([])
    const { src, header } = await open(files('glassy', glassy), [{ model: 'models/test/glassy.mdl', x: 100, y: 100 }])
    expect((await buildPropSet(src, header, [], around)).set.models[0]!.foliage).toEqual([])
  })

  test('the report says how many drawn models have foliage', async () => {
    const { src, header } = await open(pack('"VertexLitGeneric" { $alphatest 1 }'), [{ model: 'models/test/glassy.mdl', x: 100, y: 100 }])
    expect((await buildPropSet(src, header, [], around)).report.foliageModels).toBe(1)
  })
})

describe('the limits (RFC 18, 7): over one, the biggest models go first, and the report says how many went', () => {
  const pack = { ...files('small', big(2)), ...files('mid', big(10)), ...files('large', big(40)) }
  const props = ['small', 'mid', 'large'].flatMap((n, i) => [0, 1].map(k => ({ model: `models/test/${n}.mdl`, x: 100 + i * 100 + k * 10, y: 100 })))

  test('places', async () => {
    const { src, header } = await open(pack, props)
    const { set, report } = await buildPropSet(src, header, [], around, { ...PROP_LIMITS, maxPlacements: 4 })
    expect(set.models.map(m => m.name)).toEqual(['models/test/small.mdl', 'models/test/mid.mdl'])
    expect(report).toMatchObject({ drawnPlacements: 4, dropped: 2 })
  })

  test('triangles, counting every place of a model', async () => {
    const { src, header } = await open(pack, props)
    const { report } = await buildPropSet(src, header, [], around, { ...PROP_LIMITS, maxTriangles: 30 })
    expect(report).toMatchObject({ drawnPlacements: 4, dropped: 2, triangles: 24 }) // 2+2+10+10 fit; the two places of the 40-triangle model do not
  })

  test('distinct models', async () => {
    const { src, header } = await open(pack, props)
    const { set, report } = await buildPropSet(src, header, [], around, { ...PROP_LIMITS, maxModels: 1 })
    expect(set.models).toHaveLength(1)
    expect(report.dropped).toBe(4)
  })
})

describe('the mesh', () => {
  const build = async () => {
    const { src, header } = await open(files('glassy', glassy), [{ model: 'models/test/glassy.mdl', x: 100, y: 100, z: 50 }, { model: 'models/test/glassy.mdl', x: 300, y: 100 }])
    const { set } = await buildPropSet(src, header, [], around)
    return set
  }
  const floor = (z: number) => [0, 0, z, 64, 0, z, 64, 64, z, 0, 0, z, 64, 64, z, 0, 64, z]

  test('a node of props holds a transform per place, each with its solid and its foliage mesh; a model\'s meshes are written once', async () => {
    const set = await build()
    set.models[0]!.foliage = [0, 0, 0, 5, 0, 0, 0, 5, 0] // a model with foliage, so both children exist
    const r = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [], props: set }, { map: 'x' }))!
    expect(r.info.props).toEqual({ placements: 2, models: 1, triangles: 2 * ((set.models[0]!.solid.length + set.models[0]!.foliage.length) / 9) })
    const doc = await new NodeIO().readBinary(r.glb)
    const group = doc.getRoot().listScenes()[0]!.listChildren()[0]!.listChildren().find(n => n.getName() === 'props')!
    expect(group.listChildren()).toHaveLength(2)
    const place = group.listChildren()[0]!
    expect(place.getTranslation()).toEqual([100, 100, 50])
    expect(place.listChildren().map(c => c.getName())).toEqual(['solid', 'foliage'])
    expect(doc.getRoot().listMeshes().map(m => m.getName()).filter(n => n.startsWith('prop:') || n.startsWith('foliage:'))).toEqual(['prop:models/test/glassy.mdl', 'foliage:models/test/glassy.mdl'])
    const mats = place.listChildren().map(c => c.getMesh()!.listPrimitives()[0]!.getMaterial()!)
    expect(mats.map(m => m.getName())).toEqual(['prop', 'foliage'])
    expect(mats[1]!.getAlphaMode()).toBe('BLEND')
    const report = await validator.validateBytes(r.glb)
    expect(report.issues.numErrors).toBe(0)
    expect(report.issues.numWarnings).toBe(0)
  })

  test('props are not part of the level model, and a map without props has no props node', async () => {
    const plain = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [] }, { map: 'x' }))!
    const withProps = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [], props: await build() }, { map: 'x' }))!
    expect(withProps.info.levels).toEqual(plain.info.levels)
    expect(plain.info.props).toEqual({ placements: 0, models: 0, triangles: 0 })
    const doc = await new NodeIO().readBinary(plain.glb)
    expect(doc.getRoot().listNodes().some(n => n.getName() === 'props')).toBe(false)
  })

  test('a place that names a model that is not there is an error, not a silent gap', async () => {
    await expect(surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [], props: { models: [], placements: [{ model: 0, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 }] } }, { map: 'x' })).rejects.toThrow('model that is not there')
  })
})

describe('Source angles as a quaternion', () => {
  // Source: a turn by roll about X, then pitch about Y, then yaw about Z; a positive pitch tips the nose down.
  const rotate = (q: number[], v: number[]) => {
    const [x, y, z, w] = q as [number, number, number, number]
    const [vx, vy, vz] = v as [number, number, number]
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx)
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)]
  }
  const matrix = (pitch: number, yaw: number, roll: number, v: number[]) => {
    const d = Math.PI / 180, [sp, cp, sy, cy, sr, cr] = [Math.sin(pitch * d), Math.cos(pitch * d), Math.sin(yaw * d), Math.cos(yaw * d), Math.sin(roll * d), Math.cos(roll * d)]
    const r = [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy], [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy], [-sp, sr * cp, cr * cp]]
    return r.map(row => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!)
  }

  test('turns a point like the game\'s own angle matrix does, for many angles', () => {
    for (const [p, y, r] of [[0, 0, 0], [0, 90, 0], [30, 0, 0], [0, 0, 45], [10, 20, 30], [-45, 200, 120], [89, 359, -90]] as const) {
      for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [3, -2, 5]]) {
        const a = rotate(angleQuaternion(p, y, r), v), b = matrix(p, y, r, v)
        for (let i = 0; i < 3; i++) expect(a[i]!).toBeCloseTo(b[i]!, 6)
      }
    }
  })

  test('is a unit quaternion, and no angles is no turn', () => {
    expect(angleQuaternion(0, 0, 0)).toEqual([0, 0, 0, 1])
    const q = angleQuaternion(33, 77, -12)
    expect(Math.hypot(...q)).toBeCloseTo(1, 12)
  })
})
