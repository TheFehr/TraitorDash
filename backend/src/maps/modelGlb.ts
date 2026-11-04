import { Document, NodeIO } from '@gltf-transform/core'
import type { PosedMesh } from './posedmodel'

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
