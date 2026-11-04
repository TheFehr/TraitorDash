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

/**
 * The Euler-angle form of a rotation: a pointer of three offsets (from the start of the pointer) and the runs they point to.
 * An axis is null (no run), the values of one run, or several runs one after another.
 */
export function eulerPointer(axes: (number[] | Buffer[] | null)[]): Buffer {
  const runs: Buffer[] = []
  let at = 6
  const offsets = axes.map(a => {
    if (!a) return 0
    const list = a.length > 0 && typeof a[0] === 'number' ? [run(a as number[])] : (a as Buffer[])
    const o = at
    for (const r of list) { runs.push(r); at += r.length }
    return o
  })
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

/** One animation of a sequence: its frames and how they are stored. */
export interface AnimSpec {
  numFrames?: number
  fps?: number
  /** The straight line it moves its root along in one cycle. */
  move?: [number, number, number]
  /** The data of every frame in one block, or in sections of `sectionFrames` frames (one block each, and the extra last section of the format). */
  entries?: FrameEntry[]
  sections?: { sectionFrames: number, entries: FrameEntry[][] }
}
export interface SequenceSpec {
  name: string
  /** The shorthand: one animation of one frame. */
  entries?: FrameEntry[]
  /** Else the animations (one for each blend). */
  animations?: AnimSpec[]
}

/**
 * The animation set: a .mdl with the skeleton and the sequences, and the .ani with the frames, each block's data in its own
 * place. Block 0 is the placeholder the format keeps.
 */
export function buildAnimationSet(bones: BoneSpec[], sequences: SequenceSpec[]): { mdl: Buffer, ani: Buffer } {
  const animations: AnimSpec[][] = sequences.map(s => s.animations ?? [{ entries: s.entries ?? [] }])
  const flat = animations.flat()
  const nAnim = flat.length, nSeq = sequences.length
  const header = 400
  const animAt = header, seqAt = animAt + nAnim * 100
  const indexAt = seqAt + nSeq * 212
  const indexLen = nAnim * 2 + (nAnim % 2) * 2
  const labelStart = indexAt + indexLen
  const labels = sequences.map(s => Buffer.from(s.name + '\0', 'latin1'))
  const labelAt: number[] = []
  let cursor = labelStart
  for (const l of labels) { labelAt.push(cursor); cursor += l.length }
  cursor += (4 - cursor % 4) % 4
  // the movement structs and the section tables, then the table of blocks
  const moveAt = flat.map(a => { if (!a.move) return 0; const at = cursor; cursor += 44; return at })
  const sectionAt = flat.map(a => { if (!a.sections) return 0; const at = cursor; cursor += (Math.floor((a.numFrames ?? 1) / a.sections.sectionFrames) + 2) * 8; return at })
  const blocks: Buffer[] = []
  const blockOf = (entries: FrameEntry[]) => { blocks.push(frameBytes(entries)); return blocks.length } // block numbers start at 1
  const where: { block?: number, sections?: number[] }[] = flat.map(a => (a.sections ? { sections: a.sections.entries.map(e => blockOf(e)) } : { block: blockOf(a.entries ?? []) }))
  const blockAt = cursor
  const blockTable = Buffer.alloc((blocks.length + 1) * 8)
  let pos = 0
  blocks.forEach((b, i) => { blockTable.writeInt32LE(pos, (i + 1) * 8); blockTable.writeInt32LE(pos + b.length, (i + 1) * 8 + 4); pos += b.length })

  const base = Buffer.alloc(header)
  base.write('IDST', 0, 'latin1'); base.writeInt32LE(48, 4)
  base.writeInt32LE(nAnim, 180); base.writeInt32LE(animAt, 184)
  base.writeInt32LE(nSeq, 188); base.writeInt32LE(seqAt, 192)
  base.writeInt32LE(blocks.length + 1, 352); base.writeInt32LE(blockAt, 356)
  const body = Buffer.alloc(blockAt + blockTable.length - header)
  const put = (at: number, f: (b: Buffer, o: number) => void) => f(body, at - header)
  flat.forEach((a, k) => {
    const ao = animAt + k * 100
    put(ao, (b, o) => {
      b.writeFloatLE(a.fps ?? 30, o + 8); b.writeInt32LE(a.numFrames ?? 1, o + 16)
      if (a.move) { b.writeInt32LE(1, o + 20); b.writeInt32LE(moveAt[k]! - ao, o + 24) }
      const w = where[k]!
      if (w.block !== undefined) { b.writeInt32LE(w.block, o + 52); b.writeInt32LE(0, o + 56) }
      else { b.writeInt32LE(sectionAt[k]! - ao, o + 80); b.writeInt32LE(a.sections!.sectionFrames, o + 84) }
    })
    if (a.move) put(moveAt[k]!, (b, o) => { b.writeInt32LE((a.numFrames ?? 1) - 1, o); a.move!.forEach((v, j) => b.writeFloatLE(v, o + 32 + j * 4)) })
    const w = where[k]!
    if (w.sections) {
      // the sections one after another, and for a last frame past the last whole section the extra one that holds it
      const n = Math.floor((a.numFrames ?? 1) / a.sections!.sectionFrames) + 2
      for (let sIdx = 0; sIdx < n; sIdx++) put(sectionAt[k]! + sIdx * 8, (b, o) => { b.writeInt32LE(w.sections![Math.min(sIdx, w.sections!.length - 1)]!, o); b.writeInt32LE(0, o + 4) })
    }
  })
  let anim = 0
  sequences.forEach((s, i) => {
    const so = seqAt + i * 212
    put(so, (b, o) => {
      b.writeInt32LE(labelAt[i]! - so, o + 4)
      b.writeInt32LE(animations[i]!.length, o + 56); b.writeInt32LE(indexAt + anim * 2 - so, o + 60)
    })
    animations[i]!.forEach((_, j) => put(indexAt + (anim + j) * 2, (b, o) => b.writeInt16LE(anim + j, o)))
    anim += animations[i]!.length
    labels[i]!.copy(body, labelAt[i]! - header)
  })
  blockTable.copy(body, blockAt - header)
  return { mdl: withBones(Buffer.concat([base, body]), bones), ani: Buffer.concat(blocks) }
}
