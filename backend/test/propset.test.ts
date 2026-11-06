import { expect, test, describe } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import validator from 'gltf-validator'
import { readHeader, memorySource } from '../src/maps/bsp'
import { buildPropSet, PROP_LIMITS } from '../src/maps/propset'
import { surfacesToGlb, angleQuaternion } from '../src/maps/meshGlb'
import { buildBsp, flatQuad } from './helpers/bsp_builder'
import { buildModel, buildZip } from './helpers/model_builder'
import { parseVmt, LEAF_LIMITS } from '../src/maps/propset'
import { encodePng } from '../src/maps/png'

// RFC 18, 4.3 and 7: the props of a map as the mesh gets them: from the map's own pack, near the map, within the limits.

const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [10, 0, 0], C: [number, number, number] = [0, 10, 0]
const house = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }] })
const glassy = buildModel({ textures: ['wall', 'glass'], meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2] }, { material: 1, vertices: [A, B, C], tris: [0, 1, 2] }] })
const big = (n: number) => buildModel({ meshes: [{ vertices: [A, B, C], tris: Array.from({ length: n * 3 }, (_, i) => i % 3) }] })
const files = (name: string, m: { mdl: Buffer, vvd: Buffer, vtx: Buffer }) => ({ [`models/test/${name}.mdl`]: m.mdl, [`models/test/${name}.vvd`]: m.vvd, [`models/test/${name}.dx90.vtx`]: m.vtx })
const around = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
const floor = (z: number) => [0, 0, z, 64, 0, z, 64, 64, z, 0, 0, z, 64, 64, z, 0, 64, z]

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

describe('the leaves have their textures (RFC 18, 4.6)', () => {
  // a texture of 8 by 8 in DXT5: 4 blocks, the first half of the leaf cut out
  const block = (a0: number, a1: number, idx: number[]) => {
    let bits = 0n
    idx.forEach((v, i) => { bits |= BigInt(v) << BigInt(3 * i) })
    return [a0, a1, ...Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(8 * i)) & 255n)), 0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0]
  }
  const texture = (name: string, wide = 8) => {
    const out = Buffer.alloc(80 + wide * wide) // header 7.2, 1 mip of DXT5
    out.write('VTF\0', 0, 'latin1'); out.writeUInt32LE(7, 4); out.writeUInt32LE(2, 8); out.writeUInt32LE(80, 12)
    out.writeUInt16LE(wide, 16); out.writeUInt16LE(wide, 18); out.writeUInt16LE(1, 24); out.writeInt32LE(15, 52); out.writeUInt8(1, 56); out.writeInt32LE(-1, 57); out.writeUInt16LE(1, 63)
    const blocks = (wide / 4) ** 2
    for (let b = 0; b < blocks; b++) Buffer.from(block(b % 2 ? 255 : 0, 255, Array(16).fill(0))).copy(out, 80 + b * 16) // alternate blocks cut out and solid
    return out.subarray(0, 80 + blocks * 16)
  }
  const leaf = buildModel({ textures: ['leaves'], cdTextures: ['models\\test\\'], meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2], uvs: [[0, 0], [1, 0], [0, 1]] }] })
  const place = (vmt: string, extra: Record<string, Buffer | string> = {}) => open({ ...files('leaf', leaf), 'materials/models/test/leaves.vmt': vmt, ...extra }, [{ model: 'models/test/leaf.mdl', x: 100, y: 100 }, { model: 'models/test/leaf.mdl', x: 300, y: 100 }])

  test('the texture is read from the pack, once for the map, as a PNG; the material says how it is used', async () => {
    const { src, header } = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
    const { set, report } = await buildPropSet(src, header, [], around)
    expect(set.leafTextures).toHaveLength(1)
    expect(set.leafTextures![0]).toMatchObject({ name: 'models/test/leaftex', width: 8, height: 8 })
    expect(Array.from(set.leafTextures![0]!.png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]) // PNG
    expect(set.leafMaterials).toEqual([{ name: 'materials/models/test/leaves.vmt', texture: 0, mode: 'mask', alpha: 1 }])
    expect(set.models[0]!.foliageRuns).toEqual([{ material: 0, triangles: 1 }])
    expect(set.models[0]!.foliageUv).toEqual([0, 0, 1, 0, 0, 1])
    expect(report).toMatchObject({ leafTextures: 1, leafMaterials: 1, leavesWithoutTexture: 0, foliageModels: 1 })
  })

  test('$translucent is blended, with the $alpha of the material; $alphatest wins when both are there', async () => {
    const glass = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$translucent" 1 "$alpha" 0.4 }', { 'materials/models/test/leaftex.vtf': texture('x') })
    expect((await buildPropSet(glass.src, glass.header, [], around)).set.leafMaterials![0]).toMatchObject({ mode: 'blend', alpha: 0.4 })
    const both = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$translucent" 1 "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
    expect((await buildPropSet(both.src, both.header, [], around)).set.leafMaterials![0]).toMatchObject({ mode: 'mask', alpha: 1 })
  })

  test('a texture that is not in the pack (the game\'s own), cannot be read or is a kind that is not read leaves the leaves without one, counted', async () => {
    const extras: Record<string, Buffer | string>[] = [{}, { 'materials/models/test/leaftex.vtf': Buffer.from('not a texture') }, { 'materials/models/test/leaftex.vtf': (() => { const t = Buffer.from(texture('x')); t.writeUInt16LE(0x4000, 20); return t })() }]
    for (const extra of extras) {
      const { src, header } = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', extra)
      const { set, report } = await buildPropSet(src, header, [], around)
      expect(set.leafTextures).toEqual([]); expect(set.leafMaterials).toEqual([])
      expect(set.models[0]!.foliageRuns).toEqual([{ material: -1, triangles: 1 }])
      expect(report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1, foliageModels: 1 })
    }
    const none = await place('"VertexLitGeneric" { "$alphatest" 1 }') // no $basetexture at all
    expect((await buildPropSet(none.src, none.header, [], around)).report.leavesWithoutTexture).toBe(1)
  })

  test('the limits: at most so many textures and so many bytes of PNG for a map, and the texture is cut down to the size allowed', async () => {
    const was = { ...LEAF_LIMITS }
    try {
      LEAF_LIMITS.textures = 0
      let r = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
      expect((await buildPropSet(r.src, r.header, [], around)).report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1 })
      LEAF_LIMITS.textures = was.textures; LEAF_LIMITS.pngBytes = 10
      r = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
      expect((await buildPropSet(r.src, r.header, [], around)).report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1 })
      LEAF_LIMITS.pngBytes = was.pngBytes; LEAF_LIMITS.memberBytes = 100
      r = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
      expect((await buildPropSet(r.src, r.header, [], around)).report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1 })
      LEAF_LIMITS.memberBytes = was.memberBytes; LEAF_LIMITS.side = 4
      r = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
      expect((await buildPropSet(r.src, r.header, [], around)).set.leafTextures![0]).toMatchObject({ width: 8, height: 8 }) // a file with one mip has only that one
    } finally { Object.assign(LEAF_LIMITS, was) }
  })

  test('two materials with one texture share it; two models with one material share it', async () => {
    const two = buildModel({ textures: ['leaves', 'leaves2'], cdTextures: ['models\\test\\'], meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2], uvs: [[0, 0], [1, 0], [0, 1]] }, { material: 1, vertices: [A, B, C], tris: [0, 1, 2], uvs: [[0, 0], [1, 0], [0, 1]] }] })
    const vmt = '"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }'
    const { src, header } = await open({ ...files('leaf', two), ...files('leaf2', leaf), 'materials/models/test/leaves.vmt': vmt, 'materials/models/test/leaves2.vmt': vmt, 'materials/models/test/leaftex.vtf': texture('x') },
      [{ model: 'models/test/leaf.mdl', x: 100, y: 100 }, { model: 'models/test/leaf2.mdl', x: 300, y: 100 }])
    const { set } = await buildPropSet(src, header, [], around)
    expect(set.leafTextures).toHaveLength(1)
    expect(set.leafMaterials).toHaveLength(2) // two materials
    expect(set.leafMaterials!.every(m => m.texture === 0)).toBe(true)
  })

  test('a texture that is not in the pack is asked of the game\'s own files, once for the whole map, and drawn; one the game does not have, or a failed answer, leaves the leaves bare and says why', async () => {
    const vmt = '"VertexLitGeneric" { "$basetexture" "models/props/de_inferno/bush" "$alphatest" 1 }'
    const asked: string[][] = []
    const stock = (answer: Map<string, Uint8Array>, error?: string) => async (paths: string[]) => { asked.push(paths); return { files: answer, error } }
    const { src, header } = await place(vmt)
    const got = await buildPropSet(src, header, [], around, undefined, undefined, stock(new Map([['materials/models/props/de_inferno/bush.vtf', texture('x')]])))
    expect(asked).toEqual([['materials/models/props/de_inferno/bush.vtf']]) // one request, with the path of the texture (two places, one model)
    expect(got.set.leafTextures).toHaveLength(1)
    expect(got.set.models[0]!.foliageRuns).toEqual([{ material: 0, triangles: 1 }])
    expect(got.report).toMatchObject({ leafTextures: 1, leafTexturesFromGame: 1, leavesWithoutTexture: 0 })

    const none = await buildPropSet(src, header, [], around, undefined, undefined, stock(new Map()))
    expect(none.report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1 })
    const failed = await buildPropSet(src, header, [], around, undefined, undefined, stock(new Map(), 'a download failed'))
    expect(failed.report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1, stockError: 'a download failed' })

    // a texture that is in the pack is not asked for, and one that is not a readable texture is no texture
    asked.length = 0
    const pk = await place(vmt, { 'materials/models/props/de_inferno/bush.vtf': texture('x') })
    const inPack = await buildPropSet(pk.src, pk.header, [], around, undefined, undefined, stock(new Map()))
    expect(asked).toEqual([]); expect(inPack.report).toMatchObject({ leafTextures: 1, leafTexturesFromGame: 0 })
    const junk = await buildPropSet(src, header, [], around, undefined, undefined, stock(new Map([['materials/models/props/de_inferno/bush.vtf', Buffer.from('not a texture')]])))
    expect(junk.report).toMatchObject({ leafTextures: 0, leavesWithoutTexture: 1 })
  })

  test('the mesh: a foliage mesh with a primitive for each texture, the coordinates, the texture as a PNG in the file and a cut-out material shared by every place; it is a valid file', async () => {
    const { src, header } = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$alphatest" 1 }', { 'materials/models/test/leaftex.vtf': texture('x') })
    const { set } = await buildPropSet(src, header, [], around)
    const r = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: [0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 0, 0, 64, 64, 0, 0, 64, 0], walls: [], props: set }, { map: 'x' }))!
    expect(r.info.props).toMatchObject({ placements: 2, models: 1, textures: 1 })
    const doc = await new NodeIO().readBinary(r.glb)
    const mesh = doc.getRoot().listMeshes().find(m => m.getName() === 'foliage:models/test/leaf.mdl')!
    const prim = mesh.listPrimitives()[0]!
    expect(mesh.listPrimitives()).toHaveLength(1)
    expect(Array.from(prim.getAttribute('TEXCOORD_0')!.getArray()!)).toEqual([0, 0, 1, 0, 0, 1])
    const mat = prim.getMaterial()!
    expect(mat.getName()).toBe('foliage'); expect(mat.getAlphaMode()).toBe('MASK'); expect(mat.getAlphaCutoff()).toBe(0.5); expect(mat.getDoubleSided()).toBe(true)
    const tex = mat.getBaseColorTexture()!
    expect(tex.getMimeType()).toBe('image/png'); expect(Array.from(tex.getImage()!.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47])
    expect(doc.getRoot().listTextures()).toHaveLength(1) // one texture for both places and one model
    const report = await validator.validateBytes(r.glb)
    expect(report.issues.numErrors).toBe(0)
    expect(report.issues.numWarnings).toBe(0)
  })

  test('the mesh: a translucent material is blended with its alpha, and leaves with no texture are not in the file at all', async () => {
    const glass = await place('"VertexLitGeneric" { "$basetexture" "models/test/leaftex" "$translucent" 1 "$alpha" 0.4 }', { 'materials/models/test/leaftex.vtf': texture('x') })
    const g = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [], props: (await buildPropSet(glass.src, glass.header, [], around)).set }, { map: 'x' }))!
    const gm = (await new NodeIO().readBinary(g.glb)).getRoot().listMeshes().find(m => m.getName().startsWith('foliage:'))!.listPrimitives()[0]!.getMaterial()!
    expect(gm.getAlphaMode()).toBe('BLEND'); expect(gm.getBaseColorFactor()[3]).toBeCloseTo(0.4, 6)
    const bare = await place('"VertexLitGeneric" { "$alphatest" 1 }')
    const b = (await surfacesToGlb({ fingerprint: 'ab'.repeat(32), version: 20, revision: 1, floors: floor(0), walls: [], props: (await buildPropSet(bare.src, bare.header, [], around)).set }, { map: 'x' }))!
    const doc = await new NodeIO().readBinary(b.glb)
    expect(doc.getRoot().listMeshes().filter(m => m.getName().startsWith('foliage:'))).toHaveLength(0) // nothing grey in its place
    expect(doc.getRoot().listTextures()).toHaveLength(0)
    expect((await validator.validateBytes(b.glb)).issues.numErrors).toBe(0)
  })

  test('a stock model whose material is the game\'s own is read with it: a light shaft is a glow of its texture\'s brightness, not a solid column', async () => {
    const shaft = buildModel({ textures: ['vol_light001'], cdTextures: ['models\\effects\\'], meshes: [{ material: 0, vertices: [A, B, C], tris: [0, 1, 2], uvs: [[0, 0], [1, 0], [0, 1]] }] })
    const { src, header } = await open({}, [{ model: 'models/effects/vol_light.mdl', x: 100, y: 100 }])
    const stock = async () => ({ models: new Map([['models/effects/vol_light.mdl', { mdl: shaft.mdl, vvd: shaft.vvd, vtx: shaft.vtx }]]) })
    // a 4 by 4 DXT5 texture with an opaque, bright and dark half: the shaft is dark at the edge and bright in the middle
    const tex = texture('x', 4)
    const asked: string[][] = []
    const files = new Map<string, Uint8Array>([
      ['materials/models/effects/vol_light001.vmt', Buffer.from('"UnlitGeneric"\n{\n\t"$baseTexture" "Models/Effects/vol_light001"\n\t"$additive" "1"\n}')],
      ['materials/models/effects/vol_light001.vtf', tex],
    ])
    const textures = async (paths: string[]) => { asked.push(paths); return { files: new Map(paths.filter(p => files.has(p)).map(p => [p, files.get(p)!])) } }
    const got = await buildPropSet(src, header, [], around, undefined, stock, textures)
    expect(asked[0]).toContain('materials/models/effects/vol_light001.vmt') // the material was asked of the game
    const m = got.set.models[0]!
    expect(m.solid).toEqual([]); expect(m.foliage).toHaveLength(9) // not a solid prop
    expect(m.foliageRuns).toEqual([{ material: 0, triangles: 1 }])
    expect(got.set.leafMaterials![0]).toMatchObject({ mode: 'blend', alpha: 1 })
    expect(got.report).toMatchObject({ fromGame: 1, foliageModels: 1, leafTextures: 1, leafTexturesFromGame: 1 })
  })

  test('glass: a translucent material with no alpha in its texture and none of its own is see-through by default; one with an $alpha, or with alpha in its texture, keeps its own', async () => {
    const opaque = Buffer.from(texture('x', 4)); // blocks with a0 = 255 and a1 = 255: every alpha 255
    for (let b = 0; b < 1; b++) Buffer.from(block(255, 255, Array(16).fill(0))).copy(opaque, 80 + b * 16)
    const glass = async (vmt: string, tex: Buffer) => {
      const { src, header } = await place(vmt, { 'materials/models/test/glasstex.vtf': tex })
      return (await buildPropSet(src, header, [], around)).set.leafMaterials![0]!
    }
    const plain = '"VertexLitGeneric" { "$basetexture" "models/test/glasstex" "$translucent" 1 }'
    expect((await glass(plain, opaque)).alpha).toBe(0.4)
    expect((await glass('"VertexLitGeneric" { "$basetexture" "models/test/glasstex" "$translucent" 1 "$alpha" 0.7 }', opaque)).alpha).toBe(0.7)
    const holes = Buffer.from(opaque); Buffer.from(block(0, 255, Array(16).fill(0))).copy(holes, 80)
    expect((await glass(plain, holes)).alpha).toBe(1) // the texture has its own alpha: that is the shape
  })

  test('the .vmt is read for the texture and the mode; a texture name with anything but a path in it is no texture', () => {
    expect(parseVmt('"VertexLitGeneric" { "$basetexture" "Models\\Test\\Leaf.vtf" "$alphatest" "1" }')).toEqual({ texture: 'models/test/leaf', texture2: null, kind: 'mask', alpha: 1, explicitAlpha: false, additive: false })
    expect(parseVmt('"VertexLitGeneric" { $translucent 1\n $basetexture models/test/glass\n $alpha 2 }')).toEqual({ texture: 'models/test/glass', texture2: null, kind: 'blend', alpha: 1, explicitAlpha: false, additive: false }) // $alpha over 1 is not a number to use
    expect(parseVmt('"VertexLitGeneric" { "$basetexture" "../../etc/passwd" "$alphatest" 1 }')!.texture).toBeNull()
    expect(parseVmt('"VertexLitGeneric" { "$basetexture" "a;b" "$alphatest" 1 }')!.texture).toBeNull()
    expect(parseVmt('"VertexLitGeneric" { "$basetexture" "x" }')).toBeNull() // not foliage
    expect(parseVmt('"VertexLitGeneric" { "$basetexture" "x" "$translucent" 1 "$alpha" 0.25 }')).toMatchObject({ kind: 'blend', alpha: 0.25, explicitAlpha: true })
    // a light shaft or a glow adds its colour: it is foliage-like (not solid), blended, and marked
    expect(parseVmt('"UnlitGeneric"\n{\n\t"$baseTexture" "Models/Effects/vol_light001"\n\t"$nocull" "1"\n\t"$additive" "1"\n//\t"$translucent" "1"\n}')).toEqual({ texture: 'models/effects/vol_light001', texture2: null, kind: 'blend', alpha: 1, explicitAlpha: false, additive: true })
  })
})

describe('cards: foliage that is only a few huge flat sheets (RFC 18, 4.3)', () => {
  const huge: [number, number, number][] = [[0, 0, 0], [2400, 0, 0], [0, 1000, 0]] // one triangle of 1 200 000 units squared
  const crown = buildModel({ textures: ['leaves'], meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }] })
  const card = buildModel({ textures: ['leaves'], meshes: [{ vertices: huge, tris: [0, 1, 2] }] })
  const trunkAndCard = buildModel({ textures: ['bark', 'leaves'], meshes: [{ material: 0, vertices: huge, tris: [0, 1, 2] }, { material: 1, vertices: huge, tris: [0, 1, 2] }] })
  const pack = { ...files('crown', crown), ...files('card', card), ...files('mixed', trunkAndCard), 'materials/models/test/leaves.vmt': '"VertexLitGeneric" { $alphatest 1 }' }
  const at = (n: string, i: number) => ({ model: `models/test/${n}.mdl`, x: 100 + i * 50, y: 100 })

  test('a crown of small leaves is kept as foliage; a model of nothing but cards is not drawn, and is counted', async () => {
    const { src, header } = await open(pack, [at('crown', 0), at('card', 1)])
    const { set, report } = await buildPropSet(src, header, [], around)
    expect(set.models.map(m => m.name)).toEqual(['models/test/crown.mdl'])
    expect(set.models[0]!.foliage).toHaveLength(9)
    expect(report).toMatchObject({ drawnModels: 1, drawnPlacements: 1, foliageModels: 1, cards: 1 })
  })

  test('a model with solid parts and a card keeps the solid parts (a big flat solid is a wall, not a card)', async () => {
    const { src, header } = await open(pack, [at('mixed', 0)])
    const { set, report } = await buildPropSet(src, header, [], around)
    expect(set.models[0]!.solid).toHaveLength(9) // the bark mesh is huge too, but it is solid: kept
    expect(set.models[0]!.foliage).toEqual([])
    expect(report.cards).toBe(1)
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

  test('the limits are far above the largest real map (955 000 triangles, 2 037 places, 377 models; the water park lost its slide at 600 000), so a map is drawn whole', () => {
    expect(PROP_LIMITS.maxTriangles).toBeGreaterThanOrEqual(3_000_000)
    expect(PROP_LIMITS.maxPlacements).toBeGreaterThanOrEqual(10_000)
    expect(PROP_LIMITS.maxModels).toBeGreaterThanOrEqual(2000)
    expect(PROP_LIMITS.maxModelTriangles).toBeGreaterThanOrEqual(200_000)
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
    expect(mats[1]!.getAlphaMode()).toBe('OPAQUE') // foliage is drawn solid: translucent it looked like fog
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
