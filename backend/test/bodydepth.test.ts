import { expect, test } from 'bun:test'
import { Bone, BufferAttribute, BufferGeometry, Group, Matrix4, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three'
import { depthOf } from '../src/bodyDepth'

// A figure's file holds its resting shape; the body is drawn in the standing pose. The back of a body lying on the floor must be
// the back of the pose that is drawn ("still floating", 2026-11-04: lifted 20 units by the resting shape's arms).
function figure(boneX: number) {
  const g = new BufferGeometry()
  // a "back" at x = -27 on a bone that, in the pose, is moved by boneX; a "chest" at x = 5 on the root
  g.setAttribute('position', new BufferAttribute(new Float32Array([-27, 0, 0, 5, 0, 0, 0, 0, 10]), 3))
  g.setAttribute('skinIndex', new Uint16BufferAttribute([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4))
  g.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4))
  const root = new Bone(), arm = new Bone()
  root.add(arm)
  arm.position.x = boneX // the pose: the bone is where the pose puts it
  const mesh = new SkinnedMesh(g, new MeshBasicMaterial())
  mesh.add(root)
  mesh.bind(new Skeleton([root, arm]), new Matrix4()) // the rest: both bones at the origin
  const group = new Group()
  group.add(mesh)
  return group
}

test('the depth is that of the vertices as posed, not as they rest', () => {
  expect(depthOf(figure(0))).toEqual({ min: -27, max: 5 })
  const posed = depthOf(figure(20))!
  expect(posed.min).toBeCloseTo(-7, 5) // the back moved 20 units forward with its bone
  expect(posed.max).toBeCloseTo(5, 5)
})

test('is in the space of the figure it is asked about, wherever that is', () => {
  const g = figure(20)
  g.rotation.y = -Math.PI / 2
  g.position.set(100, 200, 300)
  const d = depthOf(g)!
  expect(d.min).toBeCloseTo(-7, 5)
  expect(d.max).toBeCloseTo(5, 5)
})

test('is null when nothing in it is skinned', () => {
  expect(depthOf(new Group())).toBeNull()
})
