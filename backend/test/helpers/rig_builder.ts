import { buildModel } from './model_builder'

// Builders for the tests of RFC 22: a Source player model with a skeleton and bone weights, and the shared animation set
// (a model file with sequences and a frames file) it would be posed from. Only what the reader looks at is filled in.

export interface BoneSpec { name: string, parent: number, pos?: number[], quat?: number[], rot?: number[], rotScale?: number[], posScale?: number[], poseToBone?: number[] }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]

/** Appends the bone table to a .mdl built by `buildModel`, and returns the new file. */
function withBones(mdl: Buffer, bones: BoneSpec[]): Buffer {
  const names = Buffer.concat(bones.map(b => Buffer.from(b.name + '\0', 'latin1')))
  const at = mdl.length
  const table = Buffer.alloc(bones.length * 216)
  let nameAt = at + table.length
  bones.forEach((b, i) => {
    const o = i * 216
    table.writeInt32LE(nameAt - (at + o), o); nameAt += Buffer.byteLength(b.name + '\0', 'latin1')
    table.writeInt32LE(b.parent, o + 4)
    const f = (k: number, v: number[]) => v.forEach((n, j) => table.writeFloatLE(n, o + k + j * 4))
    f(32, b.pos ?? [0, 0, 0]); f(44, b.quat ?? [0, 0, 0, 1]); f(60, b.rot ?? [0, 0, 0])
    f(72, b.posScale ?? [1, 1, 1]); f(84, b.rotScale ?? [1, 1, 1]); f(96, b.poseToBone ?? IDENTITY)
  })
  const out = Buffer.concat([mdl, table, names])
  out.writeInt32LE(bones.length, 156); out.writeInt32LE(at, 160)
  return out
}

export interface RiggedSpec {
  bones: BoneSpec[]
  vertices: [number, number, number][]
  tris: number[]
  /** For each vertex, the bones that hold it and their weights. */
  weights: { bone: number, weight: number }[][]
}

export function buildRigged(spec: RiggedSpec): { mdl: Buffer, vvd: Buffer, vtx: Buffer } {
  const base = buildModel({ meshes: [{ vertices: spec.vertices, tris: spec.tris }] })
  const vvd = Buffer.from(base.vvd)
  const vertAt = vvd.readInt32LE(56)
  spec.weights.forEach((w, i) => {
    const o = vertAt + i * 48
    w.forEach((x, k) => { vvd.writeFloatLE(x.weight, o + k * 4); vvd.writeUInt8(x.bone, o + 12 + k) })
    vvd.writeUInt8(w.length, o + 15)
  })
  return { mdl: withBones(base.mdl, spec.bones), vvd, vtx: base.vtx }
}

/** One bone's entry in a frame: its flags and the bytes that follow the four bytes of the header. */
export interface FrameEntry { bone: number, flags: number, data: Buffer }

/** A run of values for the run-length lists: `valid` values that cover `total` frames. */
export const run = (valid: number[], total = valid.length): Buffer => {
  const b = Buffer.alloc(2 + valid.length * 2)
  b.writeUInt8(valid.length, 0); b.writeUInt8(total, 1)
  valid.forEach((v, i) => b.writeInt16LE(v, 2 + i * 2))
  return b
}

/** The Euler-angle form of a rotation: a pointer of three offsets (from the start of the pointer) and the runs they point to. A null axis has no run. */
export function eulerPointer(axes: (number[] | null)[]): Buffer {
  const runs: Buffer[] = []
  let at = 6
  const offsets = axes.map(a => { if (!a) return 0; const r = run(a); const o = at; runs.push(r); at += r.length; return o })
  const head = Buffer.alloc(6)
  offsets.forEach((o, i) => head.writeInt16LE(o, i * 2))
  return Buffer.concat([head, ...runs])
}

/** A 48-bit quaternion (x, y, z, w with w >= 0). */
export function quat48(x: number, y: number, z: number): Buffer {
  const b = Buffer.alloc(6)
  b.writeUInt16LE(Math.round(x * 32768 + 32768), 0); b.writeUInt16LE(Math.round(y * 32768 + 32768), 2); b.writeUInt16LE(Math.round(z * 16384 + 16384) & 0x7fff, 4)
  return b
}

const frameBytes = (entries: FrameEntry[]): Buffer => {
  const parts = entries.map((e, i) => {
    const head = Buffer.alloc(4)
    head.writeUInt8(e.bone, 0); head.writeUInt8(e.flags, 1)
    const size = 4 + e.data.length
    head.writeInt16LE(i === entries.length - 1 ? 0 : size, 2)
    return Buffer.concat([head, e.data])
  })
  return Buffer.concat(parts)
}

export interface SequenceSpec { name: string, entries: FrameEntry[] }

/**
 * The animation set: a .mdl with the skeleton and one sequence for each spec (each with one animation of one frame, its data
 * in its own block of the .ani), and the .ani. Block 0 is the placeholder the format keeps.
 */
export function buildAnimationSet(bones: BoneSpec[], sequences: SequenceSpec[]): { mdl: Buffer, ani: Buffer } {
  const n = sequences.length
  const header = 400
  const animAt = header, seqAt = animAt + n * 100
  const extra = Buffer.alloc(n * 2 + (n % 2) * 2) // the table of animation indexes (shorts)
  const indexAt = seqAt + n * 212
  const labelStart = indexAt + extra.length
  const labels = sequences.map(s => Buffer.from(s.name + '\0', 'latin1'))
  const labelAt: number[] = []
  let cursor = labelStart
  for (const l of labels) { labelAt.push(cursor); cursor += l.length }
  const blockAt = cursor + (4 - cursor % 4) % 4
  const blockTable = Buffer.alloc((n + 1) * 8)
  const blocks = sequences.map(s => frameBytes(s.entries))
  let pos = 0
  blocks.forEach((b, i) => { blockTable.writeInt32LE(pos, (i + 1) * 8); blockTable.writeInt32LE(pos + b.length, (i + 1) * 8 + 4); pos += b.length })
  const body = Buffer.alloc(blockAt + blockTable.length - header)
  const base = Buffer.alloc(header)
  base.write('IDST', 0, 'latin1'); base.writeInt32LE(48, 4)
  base.writeInt32LE(n, 180); base.writeInt32LE(animAt, 184)
  base.writeInt32LE(n, 188); base.writeInt32LE(seqAt, 192)
  base.writeInt32LE(n + 1, 352); base.writeInt32LE(blockAt, 356)
  sequences.forEach((s, i) => {
    const ao = animAt + i * 100 - header
    body.writeInt32LE(0, ao + 4); body.writeInt32LE(1, ao + 16) // one frame
    body.writeInt32LE(i + 1, ao + 52); body.writeInt32LE(0, ao + 56) // block i + 1, from its start
    const so = seqAt + i * 212 - header
    body.writeInt32LE(labelAt[i]! - (seqAt + i * 212), so + 4)
    body.writeInt32LE(1, so + 56); body.writeInt32LE(indexAt + i * 2 - (seqAt + i * 212), so + 60) // one blend; its slot in the table of animation indexes
    body.writeInt16LE(i, indexAt - header + i * 2)
    labels[i]!.copy(body, labelAt[i]! - header)
  })
  blockTable.copy(body, blockAt - header)
  const mdl = Buffer.concat([base, body])
  // the bones follow the file, as in the model builder
  return { mdl: withBonesAt(mdl, bones), ani: Buffer.concat(blocks) }
}

const withBonesAt = (mdl: Buffer, bones: BoneSpec[]) => withBones(mdl, bones)
