// RFC 22: a player model in a pose, from the model's own files (`.mdl` the skeleton, `.vvd` the vertices with their bone
// weights, `.dx90.vtx` the triangles) and the shared animation set that player models include (`models/m_anm.mdl` the
// sequences, `models/m_anm.ani` the frames they point to). One frame, the first, of the standing or the crouching idle
// sequence is turned into bone positions and the mesh is skinned with them. No texture; the moving version is in
// `animatedmodel.ts`. Reading is in `rig.ts`.

import type { ModelFiles } from './model'
import { AnimationSet, normalsOf, readRig, skinMatrices, skinVertices, type AnimationFiles } from './rig'

export type { AnimationFiles } from './rig'
export type Pose = 'stand' | 'crouch'
export const POSES: Pose[] = ['stand', 'crouch']
/** The sequence of the shared set whose first frame is each pose. */
export const POSE_SEQUENCE: Record<Pose, string> = { stand: 'idle_all_01', crouch: 'cidle_all' }

export interface PosedMesh {
  /** x y z per vertex, in Source's coordinates (Z up, facing +x), with the feet on the floor. */
  positions: Float32Array<ArrayBuffer>
  /** One unit normal per vertex. */
  normals: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  /** The height of the highest point above the floor. */
  height: number
}

/**
 * The model in a pose, or null when the files are not what was expected, are cut off, or have more than `maxTriangles`.
 * The feet are put on the floor (the lowest vertex decides).
 */
export function readPosedModel(files: ModelFiles, anm: AnimationFiles, pose: Pose, maxTriangles = 20_000): PosedMesh | null {
  try {
    const rig = readRig(files, maxTriangles)
    if (!rig) return null
    const set = new AnimationSet(anm)
    const [ao] = set.blends(set.sequence(POSE_SEQUENCE[pose]))
    if (ao === undefined) return null
    const positions = skinVertices(rig, skinMatrices(rig.bones, set.frameFor(rig.bones, ao, 0)))
    let low = Infinity, high = -Infinity
    for (let i = 2; i < positions.length; i += 3) { low = Math.min(low, positions[i]!); high = Math.max(high, positions[i]!) }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null
    for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! - low
    return { positions, normals: normalsOf(positions, rig.indices), indices: Uint32Array.from(rig.indices), height: high - low }
  } catch (e) { if (e instanceof RangeError) return null; throw e }
}
