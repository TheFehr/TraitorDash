import { Matrix4, Vector3, type Object3D, type SkinnedMesh } from 'three'

/**
 * How far a posed figure reaches along its own x (the way it faces), in the space of `root`: the least and the most. A figure's
 * file holds its shape at rest, which is not the pose that is drawn, so the depth of a body lying on its back is measured on the
 * skinned vertices as they stand. Null when there is nothing skinned in it.
 */
export function depthOf(root: Object3D): { min: number, max: number } | null {
  root.updateMatrixWorld(true)
  const inverse = new Matrix4().copy(root.matrixWorld).invert()
  const v = new Vector3()
  let min = Infinity, max = -Infinity
  root.traverse(o => {
    const m = o as SkinnedMesh
    if (!m.isSkinnedMesh) return
    m.skeleton.update()
    const to = new Matrix4().multiplyMatrices(inverse, m.matrixWorld)
    const n = m.geometry.attributes.position!.count
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); v.applyMatrix4(to); if (v.x < min) min = v.x; if (v.x > max) max = v.x }
  })
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null
}
