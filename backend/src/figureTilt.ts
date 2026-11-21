import { Quaternion, Vector3, type Object3D } from 'three'
import { boneKey } from './maps/rig'
import { tiltShares } from './replaylogic'

// RFC 39, 4a: a figure of the replay looks up or down. The head and the spine bones are turned about the figure's side axis: the figure faces +x in Source's axes, so the
// side is y, and a positive pitch (looking down) turns +x towards -z. The turn is worked out in the figure's space and brought into each bone's own frame, so it does not
// depend on how the model's bones are oriented. It is done after the animation has set the pose (the animation would overwrite it).

export interface TiltBones { head: Object3D | null, spine: Object3D[] }

const SIDE = new Vector3(0, 1, 0)
const qa = new Quaternion(), qb = new Quaternion(), qr = new Quaternion()
const depthOf = (o: Object3D) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d }

/** The head and the spine bones of a figure (the standard biped's names, with or without the `ValveBiped.` prefix), the spine from the pelvis up. */
export function findTiltBones(g: Object3D): TiltBones {
  let head: Object3D | null = null
  const spine: Object3D[] = []
  g.traverse(o => {
    const k = boneKey(o.name)
    if (k === 'Bip01_Head1') head = o
    else if (/^Bip01_Spine\d?$/.test(k)) spine.push(o)
  })
  spine.sort((a, b) => depthOf(a) - depthOf(b)) // so each turn is made in the frame the ones below it left
  return { head, spine }
}

/** Turns one bone by `deg` about the figure's side axis. */
export function turnBone(g: Object3D, bone: Object3D, deg: number) {
  if (deg === 0 || !bone.parent) return
  g.updateMatrixWorld(true)
  qa.copy(g.getWorldQuaternion(qa).invert())
  const P = qa.multiply(bone.parent.getWorldQuaternion(qb)) // the parent's frame in the figure's space
  qr.setFromAxisAngle(SIDE, (deg * Math.PI) / 180)
  bone.quaternion.premultiply(P.clone().invert().multiply(qr).multiply(P))
}

/** The head by `shares.head`, and the spine bones `shares.spine` between them. */
export function applyTilt(g: Object3D, bones: TiltBones, shares: { head: number, spine: number }) {
  for (const b of bones.spine) turnBone(g, b, shares.spine / bones.spine.length)
  if (bones.head) turnBone(g, bones.head, shares.head)
}

/** Looks up or down by a view pitch in degrees (positive looking down). */
export const tiltFigure = (g: Object3D, bones: TiltBones, pitch: number) => applyTilt(g, bones, tiltShares(pitch))

/** The right hand of a figure (the standard biped's `Bip01_R_Hand`, with or without the `ValveBiped.` prefix), or null: where a weapon is held (RFC 39, 4a). */
export function findHand(g: Object3D): Object3D | null {
  let hand: Object3D | null = null
  g.traverse(o => { if (boneKey(o.name) === 'Bip01_R_Hand') hand = o })
  return hand
}
