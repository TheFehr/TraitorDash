import { Document, NodeIO } from '@gltf-transform/core'
import type { PosedMesh } from './posedmodel'
import type { AnimatedMesh } from './animatedmodel'
import { boneKey } from './rig'

// RFC 22: a posed player model as glTF 2.0 (GLB), the same way the map is (RFC 11, 3.6): a root node turns Source's Z-up
// into glTF's Y-up and the vertices stay in whole Source units, so a viewer that works in Source's space reads them as
// they are. One mesh, one primitive, no texture: the viewer colours it.

export async function playerModelGlb(mesh: PosedMesh, name: string): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const wide = mesh.positions.length / 3 > 65_535
  const position = doc.createAccessor('POSITION').setType('VEC3').setArray(mesh.positions).setBuffer(buffer)
  const normal = doc.createAccessor('NORMAL').setType('VEC3').setArray(mesh.normals).setBuffer(buffer)
  const index = doc.createAccessor('indices').setType('SCALAR').setArray(wide ? mesh.indices : Uint16Array.from(mesh.indices)).setBuffer(buffer)
  const material = doc.createMaterial('player').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
  const primitive = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setIndices(index).setMaterial(material)
  const gltfMesh = doc.createMesh(name).addPrimitive(primitive)
  const scene = doc.createScene(name)
  const root = doc.createNode('z-up').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]) // Source is Z-up, glTF is Y-up
  root.addChild(doc.createNode('player').setMesh(gltfMesh).setExtras({ height: mesh.height, triangles: mesh.indices.length / 3 }))
  scene.addChild(root)
  doc.getRoot().setExtras({ generator: 'TraitorDash (RFC 22)', model: name })
  return await new NodeIO().writeBinary(doc)
}

/**
 * A model that moves, as glTF 2.0 (GLB): the mesh at rest with its bone weights, the skeleton as nodes, a skin, and one glTF
 * animation for each clip. The clips carry their length and how far they walk in one cycle in their extras. The root node turns
 * Source's Z-up into Y-up like the others; the model stands on a node that lifts its feet to the floor.
 */
export async function animatedModelGlb(m: AnimatedMesh, name: string): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const acc = (label: string, type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) => doc.createAccessor(label).setType(type).setArray(array).setBuffer(buffer)

  const scene = doc.createScene(name)
  const root = doc.createNode('z-up').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]) // Source is Z-up, glTF is Y-up
  const stand = doc.createNode('player').setTranslation([0, 0, m.floor])
  root.addChild(stand)
  scene.addChild(root)

  // the skeleton, at rest, and the matrices that take a vertex to the bone it holds
  const nodes = m.bones.map(b => doc.createNode(boneKey(b.name)).setTranslation(b.pos as [number, number, number]).setRotation(b.quat as [number, number, number, number]))
  m.bones.forEach((b, i) => (b.parent < 0 ? stand : nodes[b.parent]!).addChild(nodes[i]!))
  const ibm = new Float32Array(m.bones.length * 16)
  m.bones.forEach((b, i) => {
    const r = b.poseToBone // 3 x 4, row by row; glTF wants 4 x 4, column by column
    const o = i * 16
    ibm.set([r[0]!, r[4]!, r[8]!, 0, r[1]!, r[5]!, r[9]!, 0, r[2]!, r[6]!, r[10]!, 0, r[3]!, r[7]!, r[11]!, 1], o)
  })
  const skin = doc.createSkin('player').setInverseBindMatrices(acc('inverse bind', 'MAT4', ibm))
  const rootBone = nodes[m.bones.findIndex(b => b.parent < 0)]
  if (rootBone) skin.setSkeleton(rootBone)
  for (const n of nodes) skin.addJoint(n)

  const material = doc.createMaterial('player').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', acc('POSITION', 'VEC3', m.positions))
    .setAttribute('NORMAL', acc('NORMAL', 'VEC3', m.normals))
    .setAttribute('JOINTS_0', acc('JOINTS_0', 'VEC4', m.joints))
    .setAttribute('WEIGHTS_0', acc('WEIGHTS_0', 'VEC4', m.weights))
    .setIndices(acc('indices', 'SCALAR', m.positions.length / 3 > 65_535 ? m.indices : Uint16Array.from(m.indices)))
    .setMaterial(material)
  // the node of a skinned mesh is at the top of the scene: its parents' transforms do not count for it, the bones' do
  scene.addChild(doc.createNode('player-mesh').setMesh(doc.createMesh(name).addPrimitive(primitive)).setSkin(skin).setExtras({ height: m.height, triangles: m.indices.length / 3 }))

  const once = acc('time 0', 'SCALAR', new Float32Array([0]))
  for (const clip of m.clips) {
    const times = acc(`${clip.name} times`, 'SCALAR', clip.times)
    const animation = doc.createAnimation(clip.name).setExtras({ duration: clip.duration, stride: clip.stride })
    for (const t of clip.tracks) {
      for (const [path, type, array] of [['translation', 'VEC3', t.pos], ['rotation', 'VEC4', t.quat]] as const) {
        const width = type === 'VEC3' ? 3 : 4
        const input = array.length === width ? once : times // a bone that does not move in the clip has one key
        const sampler = doc.createAnimationSampler().setInput(input).setOutput(acc(`${clip.name} ${path}`, type, array)).setInterpolation('LINEAR')
        animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes[t.bone]!).setTargetPath(path).setSampler(sampler))
      }
    }
  }
  doc.getRoot().setExtras({ generator: 'TraitorDash (RFC 22)', model: name, height: m.height, floor: m.floor, clips: m.clips.map(c => ({ name: c.name, duration: c.duration, stride: c.stride })) })
  return await new NodeIO().writeBinary(doc)
}

/** One run of triangles of a static model that share a material: corners (x y z each), their texture coordinates (u v each, or none), and the material. */
export interface StaticPart {
  positions: number[]
  uvs: number[] | null
  /** The texture as a PNG, or null for a plain colour. `mask` cuts the texture's alpha out, `blend` is see-through (RFC 18, 4.6). */
  material: { png: Uint8Array | null, colour: [number, number, number], mode: 'opaque' | 'mask' | 'blend', alpha: number, key: string }
}

/**
 * A static model (a weapon, a prop of an addon, RFC 40) as glTF 2.0 (GLB): one primitive for each run of triangles that share a material, the
 * textures embedded as PNG, the root node turning Source's Z-up into Y-up and the vertices in whole Source units, as the other models are.
 * Triangles are not indexed, with no normals: a viewer makes flat ones, which is what the maps' props get too.
 */
export async function staticModelGlb(parts: StaticPart[], name: string): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const materials = new Map<string, ReturnType<Document['createMaterial']>>()
  const textures = new Map<string, ReturnType<Document['createTexture']>>()
  const scene = doc.createScene(name)
  const root = doc.createNode('z-up').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2])
  let triangles = 0
  const gltfMesh = doc.createMesh(name)
  for (const part of parts) {
    const corners = part.positions.length / 3
    if (corners === 0 || corners % 3 !== 0) continue
    let material = materials.get(part.material.key)
    if (!material) {
      material = doc.createMaterial(part.material.key).setMetallicFactor(0).setRoughnessFactor(1).setDoubleSided(true)
      const m = part.material
      material.setBaseColorFactor([m.colour[0], m.colour[1], m.colour[2], m.mode === 'blend' ? m.alpha : 1])
      if (m.png) {
        let tex = textures.get(m.key)
        if (!tex) { tex = doc.createTexture(m.key).setImage(m.png).setMimeType('image/png'); textures.set(m.key, tex) }
        material.setBaseColorTexture(tex)
        material.setBaseColorFactor([1, 1, 1, m.mode === 'blend' ? m.alpha : 1])
      }
      if (m.mode === 'mask') material.setAlphaMode('MASK').setAlphaCutoff(0.5)
      else if (m.mode === 'blend') material.setAlphaMode('BLEND')
      materials.set(part.material.key, material)
    }
    const prim = doc.createPrimitive().setMaterial(material)
      .setAttribute('POSITION', doc.createAccessor('POSITION').setType('VEC3').setArray(new Float32Array(part.positions)).setBuffer(buffer))
    if (part.uvs && part.uvs.length === corners * 2) prim.setAttribute('TEXCOORD_0', doc.createAccessor('TEXCOORD_0').setType('VEC2').setArray(new Float32Array(part.uvs)).setBuffer(buffer))
    const index = new Uint32Array(corners)
    for (let i = 0; i < corners; i++) index[i] = i
    prim.setIndices(doc.createAccessor('indices').setType('SCALAR').setArray(corners > 65_535 ? index : Uint16Array.from(index)).setBuffer(buffer))
    gltfMesh.addPrimitive(prim)
    triangles += corners / 3
  }
  root.addChild(doc.createNode('model').setMesh(gltfMesh).setExtras({ triangles }))
  scene.addChild(root)
  doc.getRoot().setExtras({ generator: 'TraitorDash (RFC 40)', model: name, triangles })
  return await new NodeIO().writeBinary(doc)
}
