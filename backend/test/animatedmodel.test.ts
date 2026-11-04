import { expect, test, describe } from 'bun:test'
import validator from 'gltf-validator'
import { CLIPS, readAnimatedModel, type ClipSpec } from '../src/maps/animatedmodel'
import { animatedModelGlb } from '../src/maps/modelGlb'
import { buildAnimationSet, buildRigged, eulerPointer, run, type BoneSpec } from './helpers/rig_builder'

// RFC 22, stage 3: a model with clips, read from the model's files and the animation set: every frame of a sequence, in sections or
// not, run-length coded or not, the animation that walks straight ahead, the clip's length and stride, and the glTF it is written as.

const T = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -z]
const bones: BoneSpec[] = [
  { name: 'ValveBiped.Bip01_Pelvis', parent: -1, poseToBone: T(0) },
  { name: 'ValveBiped.Bip01_Spine', parent: 0, pos: [0, 0, 10], poseToBone: T(10) },
  { name: 'ValveBiped.Bip01_Head1', parent: 1, pos: [0, 0, 10], poseToBone: T(20) },
]
const model = () => buildRigged({
  bones, vertices: [[0, 0, 0], [5, 0, 10], [0, 5, 20]], tris: [0, 1, 2],
  weights: [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 0.5 }, { bone: 0, weight: 0.5 }], [{ bone: 2, weight: 1 }]],
})
// the animation set has a bone of its own in front, and the spine turns about the vertical axis by 0.001 radians for each value
const setBones: BoneSpec[] = [
  { name: 'Bip01_Extra', parent: -1 },
  { name: 'Bip01_Pelvis', parent: 0 },
  { name: 'Bip01_Spine', parent: 1, pos: [0, 0, 10], rotScale: [0.001, 0.001, 0.001] },
  { name: 'Bip01_Head1', parent: 2, pos: [0, 0, 10] },
]
const SPINE = 2
const turn = (axisZ: number[] | Buffer[]) => ({ bone: SPINE, flags: 0x08, data: eulerPointer([null, null, axisZ]) })
/** The z of the rotation of the spine's track at each key, as an angle in radians. */
const angles = (clip: { tracks: { bone: number, quat: Float32Array }[] }) => {
  const q = clip.tracks.find(t => t.bone === 1)!.quat
  return Array.from({ length: q.length / 4 }, (_, k) => 2 * Math.atan2(q[k * 4 + 2]!, q[k * 4 + 3]!))
}
const only = (name: string, every = 1): ClipSpec[] => [{ name, sequence: name, every }]
const near = (got: number[], want: number[], eps = 0.002) => { expect(got.length).toBe(want.length); want.forEach((w, i) => expect(Math.abs(got[i]! - w)).toBeLessThan(eps)) }

describe('the frames of a clip', () => {
  test('run-length values give the right angle at every frame, and the last value goes on to the end of its run', () => {
    // two runs: frames 0 to 3 (values 0 and 500, the last held), frames 4 and 5 (1000)
    const set = buildAnimationSet(setBones, [{ name: 'walk_all', animations: [{ numFrames: 6, entries: [turn([run([0, 500], 4), run([1000], 2)])] }] }])
    const m = readAnimatedModel(model(), set, 20_000, only('walk_all'))!
    expect(m).not.toBeNull()
    near(angles(m.clips[0]!), [0, 0.5, 0.5, 0.5, 1, 1])
  })

  test('a sequence in sections reads each frame from its own section, and the last frame from the extra section after them', () => {
    // sections of 2 frames, 5 frames: frames 0 and 1, 2 and 3, and frame 4 is in the extra last section as its third value
    const sections = [[turn([run([100, 110])])], [turn([run([200, 210])])], [turn([run([999])])], [turn([run([0, 0, 300])])]]
    const set = buildAnimationSet(setBones, [{ name: 'idle_all_01', animations: [{ numFrames: 5, sections: { sectionFrames: 2, entries: sections } }] }])
    const m = readAnimatedModel(model(), set, 20_000, only('idle_all_01'))!
    near(angles(m.clips[0]!), [0.1, 0.11, 0.2, 0.21, 0.3])
  })

  test('only every few frames are kept, and the last one always is; the times are the frames\' times', () => {
    const set = buildAnimationSet(setBones, [{ name: 'idle_all_01', animations: [{ numFrames: 10, fps: 20, entries: [turn([run([0, 100, 200, 300, 400, 500, 600, 700, 800, 900])])] }] }])
    const clip = readAnimatedModel(model(), set, 20_000, only('idle_all_01', 4))!.clips[0]!
    expect(Array.from(clip.times)).toEqual([0, 4 / 20, 8 / 20, 9 / 20].map(Math.fround))
    near(angles(clip), [0, 0.4, 0.8, 0.9])
    expect(clip.duration).toBeCloseTo(9 / 20, 5) // from the first frame to the last
  })

  test('a bone that does not move in the clip has one key; one that does has one for each', () => {
    const set = buildAnimationSet(setBones, [{ name: 'walk_all', animations: [{ numFrames: 4, entries: [turn([run([0, 100, 200, 300])])] }] }])
    const clip = readAnimatedModel(model(), set, 20_000, only('walk_all'))!.clips[0]!
    expect(clip.tracks.find(t => t.bone === 1)!.quat.length).toBe(4 * 4)
    expect(clip.tracks.find(t => t.bone === 0)!.quat.length).toBe(4) // the pelvis stays
    expect(clip.tracks.find(t => t.bone === 1)!.pos.length).toBe(3) // and nothing moves its place
    expect(clip.tracks).toHaveLength(3)
  })
})

describe('which animation, how long, how far', () => {
  // three blends of a walk: backwards, straight ahead, to the side; each turns the spine by a different amount
  const walk = (extra = {}) => buildAnimationSet(setBones, [{ name: 'walk_all', animations: [
    { numFrames: 31, fps: 30, move: [-60, 0, 0], entries: [turn([run([111], 31)])] },
    { numFrames: 31, fps: 30, move: [80, 0, 0], entries: [turn([run([222], 31)])], ...extra },
    { numFrames: 27, fps: 30, move: [0, 45, 0], entries: [turn([run([333], 27)])] },
  ] }])

  test('the one that walks straight ahead is used, and its stride and length are the clip\'s', () => {
    const clip = readAnimatedModel(model(), walk(), 20_000, only('walk_all'))!.clips[0]!
    near(angles(clip).slice(0, 1), [0.222])
    expect(clip.stride).toBeCloseTo(80, 3)
    expect(clip.duration).toBeCloseTo(1, 5) // 30 steps of 1/30 s
  })

  test('a sequence that does not move has stride 0', () => {
    const set = buildAnimationSet(setBones, [{ name: 'idle_all_01', animations: [{ numFrames: 3, entries: [turn([run([1, 2, 3])])] }] }])
    expect(readAnimatedModel(model(), set, 20_000, only('idle_all_01'))!.clips[0]!.stride).toBe(0)
  })

  test('the standard clips are idle, walk, run, crouch and crouch-walk, and a set without one of them gives null', () => {
    expect(CLIPS.map(c => c.name)).toEqual(['idle', 'walk', 'run', 'cidle', 'cwalk'])
    expect(readAnimatedModel(model(), walk())).toBeNull()
  })
})

describe('files that are not what was expected', () => {
  const set = buildAnimationSet(setBones, [{ name: 'idle_all_01', animations: [{ numFrames: 3, entries: [turn([run([1, 2, 3])])] }] }])
  test('a cut-off frames file, a model without a skeleton and a missing sequence give null', () => {
    const m = model()
    expect(readAnimatedModel(m, { ...set, ani: set.ani.subarray(0, 3) }, 20_000, only('idle_all_01'))).toBeNull()
    expect(readAnimatedModel({ ...m, mdl: m.mdl.subarray(0, 300) }, set, 20_000, only('idle_all_01'))).toBeNull()
    expect(readAnimatedModel(m, set, 20_000, only('nothing_here'))).toBeNull()
    expect(readAnimatedModel(m, set, 0, only('idle_all_01'))).toBeNull() // more triangles than allowed
  })
})

describe('the glTF file', () => {
  const set = buildAnimationSet(setBones, [
    { name: 'idle_all_01', animations: [{ numFrames: 4, entries: [turn([run([0, 100, 200, 300])])] }] },
    { name: 'walk_all', animations: [{ numFrames: 31, move: [80, 0, 0], entries: [turn([run([0, 500], 31)])] }] },
  ])
  const specs: ClipSpec[] = [{ name: 'idle', sequence: 'idle_all_01', every: 1 }, { name: 'walk', sequence: 'walk_all', every: 1 }]

  test('is valid glTF by the Khronos reference validator, with a skin, the skeleton and one animation for each clip', async () => {
    const m = readAnimatedModel(model(), set, 20_000, specs)!
    const glb = await animatedModelGlb(m, 'test')
    const report = await validator.validateBytes(glb)
    expect(report.issues.numErrors).toBe(0)
    expect(report.issues.numWarnings).toBe(0)
    const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))).toString())
    expect(json.skins).toHaveLength(1)
    expect(json.skins[0].joints).toHaveLength(3)
    expect(json.animations.map((a: any) => a.name)).toEqual(['idle', 'walk'])
    expect(json.animations[1].extras).toMatchObject({ stride: 80 })
    expect(json.animations[1].extras.duration).toBeCloseTo(1, 5)
    const skinned = json.nodes.find((n: any) => n.skin !== undefined)
    expect(json.scenes[0].nodes).toContain(json.nodes.indexOf(skinned)) // the skinned mesh is at the top of the scene
    expect(json.meshes[0].primitives[0].attributes).toHaveProperty('JOINTS_0')
    expect(json.meshes[0].primitives[0].attributes).toHaveProperty('WEIGHTS_0')
  })

  test('the vertices are at rest and the skin matrices undo the bones\' rest positions', async () => {
    const m = readAnimatedModel(model(), set, 20_000, specs)!
    expect(Array.from(m.positions.slice(0, 9))).toEqual([0, 0, 0, 5, 0, 10, 0, 5, 20])
    expect(Array.from(m.joints.slice(4, 8))).toEqual([1, 0, 0, 0]) // the second vertex is held by the spine and the pelvis
    expect(Array.from(m.weights.slice(4, 8))).toEqual([0.5, 0.5, 0, 0])
    expect(m.floor).toBeCloseTo(0, 3)
    expect(m.height).toBeCloseTo(20, 3)
  })
})
