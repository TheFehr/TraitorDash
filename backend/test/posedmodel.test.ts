import { expect, test, describe } from 'bun:test'
import { readPosedModel, POSE_SEQUENCE } from '../src/maps/posedmodel'
import { playerModelGlb } from '../src/maps/modelGlb'
import validator from 'gltf-validator'
import { buildAnimationSet, buildRigged, eulerPointer, quat48, type BoneSpec } from './helpers/rig_builder'

// RFC 22: a player model in a pose, read from the model's files and the shared animation set, on a model made to be read by eye:
// three bones in a column (root, mid at height 10, tip at height 20) and three vertices, each held by one of them.

const T = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -z] // the inverse of a bone that sits z up in the rest pose
const bones: BoneSpec[] = [
  { name: 'ValveBiped.Bip01_Pelvis', parent: -1, poseToBone: T(0) },
  { name: 'ValveBiped.Bip01_Spine', parent: 0, pos: [0, 0, 10], poseToBone: T(10) },
  { name: 'ValveBiped.Bip01_Head1', parent: 1, pos: [0, 0, 10], poseToBone: T(20) },
]
const model = () => buildRigged({
  bones,
  vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]],
  tris: [0, 1, 2],
  weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 1 }], [{ bone: 2, weight: 1 }]],
})
// The animation set has a bone of its own in front (so the numbers of the two skeletons differ) and no "ValveBiped." in its names.
const setBones: BoneSpec[] = [
  { name: 'Bip01_Extra', parent: -1 },
  { name: 'Bip01_Pelvis', parent: 0 },
  { name: 'Bip01_Spine', parent: 1, pos: [0, 0, 10] },
  { name: 'Bip01_Head1', parent: 2, pos: [0, 0, 10] },
]
const SPINE = 2 // the spine's number in the animation set
const S = Math.SQRT1_2
const anim = (spineEntry: { flags: number, data: Buffer }) => buildAnimationSet(setBones, [
  { name: POSE_SEQUENCE.stand, entries: [{ bone: SPINE, ...spineEntry }] },
  { name: POSE_SEQUENCE.crouch, entries: [{ bone: SPINE, flags: 0x08, data: eulerPointer([null, null, [1571]]) }] },
])
// a quarter turn about the vertical axis, as a 48-bit quaternion and as run-length Euler angles (the third axis, 1.571 radians)
const quarterTurn = { flags: 0x02, data: quat48(0, 0, S) }
const euler = { flags: 0x08, data: eulerPointer([null, null, [1571]]) }
const setBones1000 = setBones.map(b => b.name === 'Bip01_Spine' ? { ...b, rotScale: [0.001, 0.001, 0.001] } : b)

const near = (got: ArrayLike<number>, want: number[], eps = 0.02) => want.forEach((w, i) => expect(Math.abs(got[i]! - w)).toBeLessThan(eps))

describe('the pose', () => {
  test('a bone turned with a quaternion carries the vertices it holds, the others stay', () => {
    const m = readPosedModel(model(), anim(quarterTurn), 'stand')!
    expect(m).not.toBeNull()
    near(m.positions.subarray(0, 3), [0, 0, 0]) // the root does not move
    near(m.positions.subarray(3, 6), [0, 5, 10]) // (5, 0, 0) in the spine's space, turned a quarter about the vertical axis
    near(m.positions.subarray(6, 9), [-5, 0, 20]) // the head follows the spine
  })

  test('run-length angles are read from the start of the pointer, for every axis (the third axis was once read from the wrong place)', () => {
    const set = buildAnimationSet(setBones1000, [
      { name: POSE_SEQUENCE.stand, entries: [{ bone: SPINE, ...euler }] },
      { name: POSE_SEQUENCE.crouch, entries: [{ bone: SPINE, ...euler }] },
    ])
    const m = readPosedModel(model(), set, 'crouch')!
    near(m.positions.subarray(3, 6), [0, 5, 10])
    near(m.positions.subarray(6, 9), [-5, 0, 20])
  })

  test('the two poses read their own sequences', () => {
    const set = buildAnimationSet(setBones1000, [
      { name: POSE_SEQUENCE.stand, entries: [{ bone: SPINE, ...quarterTurn }] },
      { name: POSE_SEQUENCE.crouch, entries: [{ bone: 0, flags: 0, data: Buffer.alloc(0) }] }, // moves nothing the model has
    ])
    expect(readPosedModel(model(), set, 'stand')!.positions[4]).toBeGreaterThan(4) // turned
    expect(readPosedModel(model(), set, 'crouch')!.positions[4]).toBeCloseTo(0, 1) // the bones stay as the model has them
    // and a sequence with no frame data at all is a broken file
    const empty = buildAnimationSet(setBones1000, [{ name: POSE_SEQUENCE.stand, entries: [{ bone: SPINE, ...quarterTurn }] }, { name: POSE_SEQUENCE.crouch, entries: [] }])
    expect(readPosedModel(model(), empty, 'crouch')).toBeNull()
  })

  test('the feet are put on the floor and the height is measured from there', () => {
    const lowered = buildRigged({ bones, vertices: [[0, 0, -3], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2], weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 1 }], [{ bone: 2, weight: 1 }]] })
    const m = readPosedModel(lowered, anim({ flags: 0, data: Buffer.alloc(0) }), 'stand')!
    expect(m.positions[2]).toBeCloseTo(0, 3)
    expect(m.height).toBeCloseTo(23, 2)
  })

  test('two weights blend, and the weights add up to the position between the two', () => {
    const blend = buildRigged({ bones, vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2], weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 0.5 }, { bone: 0, weight: 0.5 }], [{ bone: 2, weight: 1 }]] })
    // bone 0 holds it still at (5, 0, 10) in model space; bone 1 turns it to (0, 5, 10) in model space
    // (the second weight is for the root, whose skin matrix is the identity: the vertex keeps its own place)
    const m = readPosedModel(blend, anim(quarterTurn), 'stand')!
    near(m.positions.subarray(3, 6), [2.5, 2.5, 10])
  })

  test('the faces point outward and the normals are unit length', () => {
    const m = readPosedModel(model(), anim(quarterTurn), 'stand')!
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 3)
    expect(m.indices.length).toBe(3)
  })
})

describe('files that are not what was expected', () => {
  const set = anim(quarterTurn)
  test('a missing sequence, a cut-off file, the wrong kind of file and a vertex on a bone that does not exist give null', () => {
    expect(readPosedModel(model(), buildAnimationSet(setBones, [{ name: 'something_else', entries: [] }]), 'stand')).toBeNull()
    const m = model()
    expect(readPosedModel({ ...m, vtx: m.vtx.subarray(0, 40) }, set, 'stand')).toBeNull()
    expect(readPosedModel({ ...m, mdl: m.mdl.subarray(0, 300) }, set, 'stand')).toBeNull()
    expect(readPosedModel({ ...m, vvd: Buffer.alloc(200) }, set, 'stand')).toBeNull()
    expect(readPosedModel(m, { ...set, ani: set.ani.subarray(0, 2) }, 'stand')).toBeNull()
    expect(readPosedModel(m, { mdl: Buffer.alloc(400), ani: set.ani }, 'stand')).toBeNull()
    const lost = buildRigged({ bones, vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2], weights: [[{ bone: 0, weight: 1 }], [{ bone: 9, weight: 1 }], [{ bone: 2, weight: 1 }]] })
    expect(readPosedModel(lost, set, 'stand')).toBeNull()
  })
  test('a model with more triangles than the limit is refused', () => {
    expect(readPosedModel(model(), set, 'stand', 0)).toBeNull()
  })
  test('a bone that comes before its parent is refused', () => {
    const odd = buildRigged({ bones: [{ name: 'a', parent: 1 }, { name: 'b', parent: -1 }, bones[2]!], vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2], weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 1 }], [{ bone: 2, weight: 1 }]] })
    expect(readPosedModel(odd, set, 'stand')).toBeNull()
  })
})

describe('the glTF file', () => {
  test('is a binary glTF with the mesh, the normals and a root that turns Z-up into Y-up, and it passes the reference validator', async () => {
    const m = readPosedModel(model(), anim(quarterTurn), 'stand')!
    const glb = await playerModelGlb(m, 'test (stand)')
    expect(Buffer.from(glb.subarray(0, 4)).toString()).toBe('glTF')
    const report = await validator.validateBytes(glb)
    expect(report.issues.numErrors).toBe(0)
    expect(report.issues.numWarnings).toBe(0)
    const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))).toString())
    expect(json.nodes.some((n: any) => n.name === 'z-up' && n.rotation)).toBe(true)
    expect(json.meshes[0].primitives[0].attributes).toHaveProperty('NORMAL')
    expect(json.nodes.find((n: any) => n.name === 'player').extras.height).toBeCloseTo(20, 2)
  })
})
