// RFC 22, stage 3: a player model that moves. The mesh stays in its rest pose and carries its bone weights; the animations are
// short loops taken from the shared animation set (standing, walking, running, crouching, crouch-walking), one frame for each
// frame of the original (every fourth for the two idles, which are long and slow), as the position and rotation of every bone
// at every key. The viewer plays them (glTF skin and animation, drawn by the graphics card) and picks and times them from how a
// player moves.

import type { ModelFiles } from './model'
import { AnimationSet, normalsOf, readRig, skinMatrices, skinVertices, type AnimationFiles, type Bone, type Local } from './rig'

export interface ClipSpec {
  name: string
  /** The sequence of the shared set. */
  sequence: string
  /** Every how many frames a key is kept (the last frame is always kept). */
  every: number
  /** For a sequence that has an animation for each direction of travel: which one, as a number from 0 (straight ahead) counter-clockwise in steps of 45 degrees (see `DIRECTIONS`). */
  direction?: number
}

/** The eight directions of travel relative to where the player looks, counter-clockwise from straight ahead (the viewer's list in `replaylogic.ts` is the same; a test compares them). */
export const DIRECTIONS = ['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'] as const
/** The sequences that walk, each with an animation for every direction (a 3 by 3 grid with the standing one in the middle). */
export const GAIT_SEQUENCES = { walk: 'walk_all', run: 'run_all_01', cwalk: 'cwalk_all' } as const

export const CLIPS: ClipSpec[] = [
  { name: 'idle', sequence: 'idle_all_01', every: 4 },
  { name: 'cidle', sequence: 'cidle_all', every: 4 },
  ...Object.entries(GAIT_SEQUENCES).flatMap(([gait, sequence]) => DIRECTIONS.map((d, direction) => ({ name: `${gait}_${d}`, sequence, every: 1, direction }))),
]

export interface ClipTrack {
  /** The number of the bone in the model. */
  bone: number
  /** x y z for each key, or for the one key of a bone that does not move in this clip. */
  pos: Float32Array<ArrayBuffer>
  /** x y z w for each key, or for the one key of a bone that does not turn. */
  quat: Float32Array<ArrayBuffer>
}

export interface Clip {
  name: string
  /** Seconds from the first frame to the last (the last is the first again: the clip loops). */
  duration: number
  /** How far the clip walks in one cycle, in units, along +x; 0 for a clip that stays on the spot. */
  stride: number
  times: Float32Array<ArrayBuffer>
  tracks: ClipTrack[]
}

export interface AnimatedMesh {
  /** The vertices in the rest pose, Source's coordinates, and their normals and triangles. */
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  /** Four bones and four weights for each vertex (the unused ones are 0). */
  joints: Uint16Array<ArrayBuffer>
  weights: Float32Array<ArrayBuffer>
  bones: Bone[]
  clips: Clip[]
  /** How far to lift the model so that its feet in the standing pose are on the floor. */
  floor: number
  /** The height of the standing pose above its floor. */
  height: number
}

const EPS_POS = 1e-3, EPS_QUAT = 1e-5

/** The animation of a sequence that walks straight ahead (its movement points along +x), or its first. */
function forward(set: AnimationSet, blends: number[]): number {
  let best = blends[0]!, score = -Infinity
  for (const ao of blends) {
    const { move } = set.describe(ao)
    if (!move) continue
    const len = Math.hypot(move[0], move[1])
    const s = len > 0 ? move[0] / len : -Infinity
    if (s > score) { score = s; best = ao }
  }
  return best
}

/** The animation of a sequence that moves the player in the given direction (0 to 7, in steps of 45 degrees counter-clockwise from +x; Source's +y is to the left). */
function heading(set: AnimationSet, blends: number[], direction: number): number {
  let best = -1, off = Infinity
  for (const ao of blends) {
    const { move } = set.describe(ao)
    if (!move || Math.hypot(move[0], move[1]) < 1e-3) continue
    const d = Math.abs(((Math.atan2(move[1], move[0]) - direction * Math.PI / 4) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
    if (d < off) { off = d; best = ao }
  }
  if (best < 0 || off > Math.PI / 8) throw new RangeError('a sequence has no animation for a direction')
  return best
}

const constant = (a: number[], width: number, eps: number) => {
  for (let k = 1; k < a.length / width; k++) for (let j = 0; j < width; j++) if (Math.abs(a[k * width + j]! - a[j]!) > eps) return false
  return true
}

function clipOf(set: AnimationSet, bones: Bone[], spec: ClipSpec): Clip {
  const blends = set.blends(set.sequence(spec.sequence))
  const ao = spec.direction === undefined ? forward(set, blends) : heading(set, blends, spec.direction)
  const { numFrames, fps, move } = set.describe(ao)
  if (numFrames < 1 || !(fps > 0)) throw new RangeError('an animation has no frames')
  const frames: number[] = []
  for (let f = 0; f < numFrames - 1; f += spec.every) frames.push(f)
  frames.push(numFrames - 1)
  const keys: Map<number, Local>[] = frames.map(f => set.frameFor(bones, ao, f))
  const tracks: ClipTrack[] = bones.map((b, i) => {
    const pos: number[] = [], quat: number[] = []
    keys.forEach((k, n) => {
      const l = k.get(i)
      pos.push(...(l ? l.pos : b.pos))
      let q = l ? l.quat : b.quat
      // the sign of a rotation is free: keep it with the one before, so that two keys are not taken the long way round
      if (n > 0 && q[0]! * quat[(n - 1) * 4]! + q[1]! * quat[(n - 1) * 4 + 1]! + q[2]! * quat[(n - 1) * 4 + 2]! + q[3]! * quat[(n - 1) * 4 + 3]! < 0) q = q.map(x => -x)
      quat.push(...q)
    })
    return {
      bone: i,
      pos: new Float32Array(constant(pos, 3, EPS_POS) ? pos.slice(0, 3) : pos),
      quat: new Float32Array(constant(quat, 4, EPS_QUAT) ? quat.slice(0, 4) : quat),
    }
  })
  return {
    name: spec.name,
    duration: (numFrames - 1) / fps,
    stride: move ? Math.hypot(move[0], move[1]) : 0,
    times: new Float32Array(frames.map(f => f / fps)),
    tracks,
  }
}

/** The model with its animations, or null when the files are not what was expected, are cut off, or have more than `maxTriangles`. */
export function readAnimatedModel(files: ModelFiles, anm: AnimationFiles, maxTriangles = 20_000, specs: ClipSpec[] = CLIPS): AnimatedMesh | null {
  try {
    const rig = readRig(files, maxTriangles)
    if (!rig) return null
    const set = new AnimationSet(anm)
    const clips = specs.map(s => clipOf(set, rig.bones, s))

    // the floor: the lowest point of the standing pose
    const idle = specs.findIndex(s => s.name === 'idle')
    const [stand] = set.blends(set.sequence(specs[Math.max(idle, 0)]!.sequence))
    const posed = skinVertices(rig, skinMatrices(rig.bones, set.frameFor(rig.bones, stand!, 0)))
    let low = Infinity, high = -Infinity
    for (let i = 2; i < posed.length; i += 3) { low = Math.min(low, posed[i]!); high = Math.max(high, posed[i]!) }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null

    const n = rig.counts.length
    const positions = new Float32Array(rig.rest)
    const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) for (let k = 0; k < rig.counts[i]!; k++) { joints[i * 4 + k] = rig.boneIds[i * 3 + k]!; weights[i * 4 + k] = rig.weights[i * 3 + k]! }
    return { positions, normals: normalsOf(positions, rig.indices), indices: Uint32Array.from(rig.indices), joints, weights, bones: rig.bones, clips, floor: -low, height: high - low }
  } catch (e) { if (e instanceof RangeError) return null; throw e }
}
