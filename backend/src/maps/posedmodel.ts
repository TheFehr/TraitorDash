// RFC 22: a player model in a pose, from the model's own files (`.mdl` the skeleton, `.vvd` the vertices with their bone
// weights, `.dx90.vtx` the triangles) and the shared animation set that player models include (`models/m_anm.mdl` the
// sequences, `models/m_anm.ani` the frames they point to). One frame, the first, of the standing or the crouching idle
// sequence is turned into bone positions and the mesh is skinned with them. No texture, no moving animation.
//
// The files are untrusted (they come from Valve's servers and nothing else is known about them): reading past the end of
// one is a `RangeError` of the `DataView`, which gives `null`, and every count is capped.

import type { ModelFiles } from './model'

export interface AnimationFiles { mdl: Uint8Array, ani: Uint8Array }
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

const MAX_BONES = 256
const MAX_VERTICES = 100_000
const MAX_FIXUPS = 65_536
const MAX_MESHES = 1024
const MAX_STRIP_GROUPS = 4096
const MAX_STRIPS = 8192
const MAX_SEQUENCES = 4096
const MAX_ENTRIES = 1024 // bones with data in one frame
const VERTEX = 48
const STUDIO_MESH = 116
const STUDIO_BONE = 216
const STUDIO_SEQ = 212
const STUDIO_ANIMDESC = 100

const cap = (n: number, max: number) => { if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError('a count is out of range'); return n }
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const cstr = (b: Uint8Array, at: number, max = 128): string => {
  if (at < 0 || at >= b.length) throw new RangeError('a string starts outside the file')
  let end = at
  while (end < b.length && b[end] !== 0 && end - at < max) end++
  return Buffer.from(b.subarray(at, end)).toString('latin1')
}
const id = (b: Uint8Array) => String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!)

interface Bone { name: string, parent: number, pos: number[], quat: number[], rot: number[], posScale: number[], rotScale: number[], poseToBone: number[] }

function readBones(buf: Uint8Array): Bone[] {
  const d = view(buf), n = cap(d.getInt32(156, true), MAX_BONES), at = d.getInt32(160, true)
  const bones: Bone[] = []
  for (let b = 0; b < n; b++) {
    const o = at + b * STUDIO_BONE
    const f = (k: number, c: number) => Array.from({ length: c }, (_, j) => d.getFloat32(o + k + j * 4, true))
    const parent = d.getInt32(o + 4, true)
    if (parent >= b || parent < -1) throw new RangeError('a bone comes before its parent') // so one pass in order is enough
    bones.push({ name: cstr(buf, o + d.getInt32(o, true)), parent, pos: f(32, 3), quat: f(44, 4), rot: f(60, 3), posScale: f(72, 3), rotScale: f(84, 3), poseToBone: f(96, 12) })
  }
  return bones
}

/** The name of a bone without the prefix some tools write, so the skeleton of a model and of the animation set can be matched. */
const boneKey = (name: string) => name.replace(/^ValveBiped\./, '')

const half = (h: number) => {
  const sign = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023
  return e === 0 ? sign * 5.960464477539063e-8 * f : e === 31 ? 0 : sign * Math.pow(2, e - 15) * (1 + f / 1024)
}
const angleQuaternion = (x: number, y: number, z: number) => {
  const sy = Math.sin(z * 0.5), cy = Math.cos(z * 0.5), sp = Math.sin(y * 0.5), cp = Math.cos(y * 0.5), sr = Math.sin(x * 0.5), cr = Math.cos(x * 0.5)
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy]
}

interface Local { pos: number[], quat: number[] }

/**
 * Frame 0 of a sequence of the animation set: the local position and rotation of each bone that the sequence moves (of the
 * animation set's skeleton; the others are left out, and stay as in the model).
 */
function firstFrame(anm: AnimationFiles, bones: Bone[], name: string): Map<number, Local> {
  const a = view(anm.mdl), A = view(anm.ani)
  const set = readBones(anm.mdl) // the frame's bone numbers are those of the animation set's skeleton, with its own rest values
  const nSeq = cap(a.getInt32(188, true), MAX_SEQUENCES), seqAt = a.getInt32(192, true), animAt = a.getInt32(184, true)
  const nAnim = cap(a.getInt32(180, true), 65_536), nBlocks = cap(a.getInt32(352, true), 65_536), blockAt = a.getInt32(356, true)
  let found = -1
  for (let k = 0; k < nSeq && found < 0; k++) { const o = seqAt + k * STUDIO_SEQ; if (cstr(anm.mdl, o + a.getInt32(o + 4, true)) === name) found = o }
  if (found < 0) throw new RangeError('no such sequence')
  const animIndex = a.getInt16(found + a.getInt32(found + 60, true), true) // the first blend of the sequence
  if (animIndex < 0 || animIndex >= nAnim) throw new RangeError('an animation is out of range')
  const ao = animAt + animIndex * STUDIO_ANIMDESC

  // Where the data of the first frame is: in the sequence's first section if it is cut into sections, else in the animation itself;
  // in the frames file (by block) or, for block 0, in the model file.
  const sectionFrames = a.getInt32(ao + 84, true)
  const block = sectionFrames !== 0 ? a.getInt32(ao + a.getInt32(ao + 80, true), true) : a.getInt32(ao + 52, true)
  const index = sectionFrames !== 0 ? a.getInt32(ao + a.getInt32(ao + 80, true) + 4, true) : a.getInt32(ao + 56, true)
  if (block < 0 || (block > 0 && block >= nBlocks)) throw new RangeError('a block is out of range')
  const D = block === 0 ? a : A
  const data = block === 0 ? ao + index : a.getInt32(blockAt + block * 8, true) + index // the table of blocks is in the model file

  const byName = new Map(bones.map((b, i) => [boneKey(b.name), i]))
  const out = new Map<number, Local>()
  // the first value of the run-length list that the j-th offset of the pointer at `base` points to (the offsets count from the pointer)
  const value = (base: number, j: number) => {
    const off = D.getInt16(base + j * 2, true)
    return off > 0 && D.getUint8(base + off) > 0 ? D.getInt16(base + off + 2, true) : 0 // the first byte of a run says how many values it holds
  }

  let p = data
  for (let guard = 0; guard < MAX_ENTRIES; guard++) {
    const bone = D.getUint8(p), flags = D.getUint8(p + 1), next = D.getInt16(p + 2, true)
    const b = set[bone]
    if (!b) throw new RangeError('a bone is out of range')
    let quat = b.quat.slice(), pos = b.pos.slice()
    let c = p + 4 // after the four bytes of the header: the rotation, then the position, as they are written
    if (flags & 0x02) { // 48-bit quaternion
      const x = (D.getUint16(c, true) - 32768) / 32768, y = (D.getUint16(c + 2, true) - 32768) / 32768, zz = D.getUint16(c + 4, true)
      const z = ((zz & 0x7fff) - 16384) / 16384
      let w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)); if (zz & 0x8000) w = -w
      quat = [x, y, z, w]; c += 6
    } else if (flags & 0x20) { // 64-bit quaternion, 21 bits each
      const bits = BigInt(D.getUint32(c, true)) | (BigInt(D.getUint32(c + 4, true)) << 32n)
      const x = (Number(bits & 0x1fffffn) - 1048576) / 1048576.5, y = (Number((bits >> 21n) & 0x1fffffn) - 1048576) / 1048576.5, z = (Number((bits >> 42n) & 0x1fffffn) - 1048576) / 1048576.5
      let w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)); if ((bits >> 63n) & 1n) w = -w
      quat = [x, y, z, w]; c += 8
    } else if (flags & 0x08) { // run-length Euler angles, in radians, added to the bone's own
      const ang = [0, 1, 2].map(j => value(c, j) * b.rotScale[j]! + b.rot[j]!)
      quat = angleQuaternion(ang[0]!, ang[1]!, ang[2]!); c += 6
    }
    if (flags & 0x01) pos = [half(D.getUint16(c, true)), half(D.getUint16(c + 2, true)), half(D.getUint16(c + 4, true))]
    else if (flags & 0x04) pos = [0, 1, 2].map(j => value(c, j) * b.posScale[j]! + b.pos[j]!)
    if (!(flags & 0x10)) out.set(bone, { pos, quat }) // a delta is for blending, not a pose
    if (next === 0) break
    p += next
  }
  // by the name of the bone, so a model with another order of bones (or more of them) can use the set
  const mapped = new Map<number, Local>()
  for (const [i, l] of out) { const j = byName.get(boneKey(set[i]!.name)); if (j !== undefined) mapped.set(j, l) }
  return mapped
}

type M = number[] // a 3x4 matrix, row by row
const mul = (A: M, B: M): M => {
  const r: M = []
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) r.push(A[i * 4]! * B[j]! + A[i * 4 + 1]! * B[4 + j]! + A[i * 4 + 2]! * B[8 + j]! + (j === 3 ? A[i * 4 + 3]! : 0))
  return r
}
const matrix = (q: number[], pos: number[]): M => {
  const [x, y, z, w] = q as [number, number, number, number]
  return [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y, pos[0]!,
    2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x, pos[1]!,
    2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y, pos[2]!]
}

/**
 * The model in a pose, or null when the files are not what was expected, are cut off, or have more than `maxTriangles`.
 * The feet are put on the floor (the lowest vertex decides).
 */
export function readPosedModel(files: ModelFiles, anm: AnimationFiles, pose: Pose, maxTriangles = 20_000): PosedMesh | null {
  try { return read(files, anm, pose, maxTriangles) } catch (e) { if (e instanceof RangeError) return null; throw e }
}

function read({ mdl, vvd, vtx }: ModelFiles, anm: AnimationFiles, pose: Pose, maxTriangles: number): PosedMesh | null {
  const m = view(mdl), v = view(vvd), t = view(vtx)
  if (mdl.length < 240 || vvd.length < 64 || vtx.length < 36 || id(mdl) !== 'IDST' || id(vvd) !== 'IDSV' || anm.mdl.length < 240 || id(anm.mdl) !== 'IDST') return null
  const bones = readBones(mdl)
  if (bones.length === 0) return null

  // The vertices of the first level of detail (with its fix-ups), each with up to three bone weights.
  const numFix = cap(v.getInt32(48, true), MAX_FIXUPS), fixStart = v.getInt32(52, true), vertStart = v.getInt32(56, true)
  const lod0 = cap(v.getInt32(16, true), MAX_VERTICES)
  const rest: number[] = [], weights: number[] = [], boneIds: number[] = [], counts: number[] = []
  const take = (i: number) => {
    const o = vertStart + i * VERTEX
    const n = v.getUint8(o + 15)
    if (n > 3) throw new RangeError('too many weights')
    for (let k = 0; k < 3; k++) {
      weights.push(k < n ? v.getFloat32(o + k * 4, true) : 0)
      const bone = v.getUint8(o + 12 + k)
      if (k < n && bone >= bones.length) throw new RangeError('a vertex has a bone that does not exist')
      boneIds.push(k < n ? bone : 0)
    }
    counts.push(n)
    rest.push(v.getFloat32(o + 16, true), v.getFloat32(o + 20, true), v.getFloat32(o + 24, true))
  }
  if (numFix > 0) {
    for (let f = 0; f < numFix; f++) {
      const o = fixStart + f * 12
      const lod = v.getInt32(o, true), from = v.getInt32(o + 4, true), n = cap(v.getInt32(o + 8, true), MAX_VERTICES)
      if (lod >= 0) for (let k = 0; k < n; k++) { take(from + k); if (counts.length > MAX_VERTICES) return null }
    }
  } else for (let i = 0; i < lod0; i++) take(i)
  const vertexCount = counts.length

  // The structure: first body part, first model, first level of detail (as in `readModel`).
  const nParts = cap(m.getInt32(232, true), 1024), partAt = m.getInt32(236, true)
  if (nParts < 1 || t.getInt32(28, true) < 1) return null
  if (m.getInt32(partAt + 4, true) < 1) return null
  const modelAt = partAt + m.getInt32(partAt + 12, true)
  const nMeshes = cap(m.getInt32(modelAt + 72, true), MAX_MESHES), meshAt = modelAt + m.getInt32(modelAt + 76, true)
  const vertexIndex = m.getInt32(modelAt + 84, true) / VERTEX
  if (!Number.isInteger(vertexIndex)) return null
  const vtxPart = t.getInt32(32, true), vtxModel = vtxPart + t.getInt32(vtxPart + 4, true), vtxLod = vtxModel + t.getInt32(vtxModel + 4, true)
  const vtxMeshes = cap(t.getInt32(vtxLod, true), MAX_MESHES), vtxMeshAt = vtxLod + t.getInt32(vtxLod + 4, true)

  const indices: number[] = []
  for (let k = 0; k < Math.min(nMeshes, vtxMeshes); k++) {
    const vertexOffset = m.getInt32(meshAt + k * STUDIO_MESH + 12, true)
    const vm = vtxMeshAt + k * 9
    const groups = cap(t.getInt32(vm, true), MAX_STRIP_GROUPS), groupAt = vm + t.getInt32(vm + 4, true)
    for (let g = 0; g < groups; g++) {
      const sg = groupAt + g * 25
      const nVerts = cap(t.getInt32(sg, true), MAX_VERTICES), vertAt = sg + t.getInt32(sg + 4, true), indexAt = sg + t.getInt32(sg + 12, true)
      const nStrips = cap(t.getInt32(sg + 16, true), MAX_STRIPS), stripAt = sg + t.getInt32(sg + 20, true)
      const original: number[] = []
      for (let i = 0; i < nVerts; i++) original.push(t.getUint16(vertAt + i * 9 + 4, true))
      for (let s = 0; s < nStrips; s++) {
        const st = stripAt + s * 27
        const n = t.getInt32(st, true), first = t.getInt32(st + 4, true), flags = t.getUint8(st + 18)
        if (!(flags & 1) || n < 3 || n > 3 * maxTriangles) continue
        for (let i = 0; i + 2 < n; i += 3) {
          const corner: number[] = []
          for (let c = 0; c < 3; c++) {
            const local = t.getUint16(indexAt + (first + i + c) * 2, true)
            if (local >= original.length) return null
            const gv = vertexIndex + vertexOffset + original[local]!
            if (!(gv >= 0 && gv < vertexCount)) return null
            corner.push(gv)
          }
          indices.push(corner[0]!, corner[2]!, corner[1]!) // Source winds its triangles clockwise; glTF counter-clockwise
          if (indices.length / 3 > maxTriangles) return null
        }
      }
    }
  }
  if (indices.length === 0) return null

  // The pose: each bone's transform from the frame, else from the model's own rest position; then every vertex follows its bones.
  const frame = firstFrame(anm, bones, POSE_SEQUENCE[pose])
  const world: M[] = []
  bones.forEach((b, i) => {
    const l = frame.get(i)
    const local = matrix(l ? l.quat : b.quat, l ? l.pos : b.pos)
    world[i] = b.parent < 0 ? local : mul(world[b.parent]!, local)
  })
  const skin = bones.map((b, i) => mul(world[i]!, b.poseToBone))
  const positions = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i++) {
    let x = 0, y = 0, z = 0
    const px = rest[i * 3]!, py = rest[i * 3 + 1]!, pz = rest[i * 3 + 2]!
    for (let k = 0; k < counts[i]!; k++) {
      const S = skin[boneIds[i * 3 + k]!]!, w = weights[i * 3 + k]!
      x += w * (S[0]! * px + S[1]! * py + S[2]! * pz + S[3]!)
      y += w * (S[4]! * px + S[5]! * py + S[6]! * pz + S[7]!)
      z += w * (S[8]! * px + S[9]! * py + S[10]! * pz + S[11]!)
    }
    if (counts[i] === 0) { x = px; y = py; z = pz }
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z
  }
  let low = Infinity, high = -Infinity
  for (let i = 2; i < positions.length; i += 3) { low = Math.min(low, positions[i]!); high = Math.max(high, positions[i]!) }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! - low

  // Smooth normals: the faces' normals added at each corner.
  const normals = new Float32Array(vertexCount * 3)
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!
    const wx = positions[c]! - positions[a]!, wy = positions[c + 1]! - positions[a + 1]!, wz = positions[c + 2]! - positions[a + 2]!
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    for (const k of [a, b, c]) { normals[k] = normals[k]! + nx; normals[k + 1] = normals[k + 1]! + ny; normals[k + 2] = normals[k + 2]! + nz }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1
    normals[i] = normals[i]! / l; normals[i + 1] = normals[i + 1]! / l; normals[i + 2] = normals[i + 2]! / l
  }
  return { positions, normals, indices: Uint32Array.from(indices), height: high - low }
}
