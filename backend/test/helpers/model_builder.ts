import { deflateRawSync } from 'node:zlib'

// Builders for the tests of RFC 18, 4.3: a ZIP pack (what a map carries), and a Source model in its three files, small
// enough to read by eye. Only what the readers look at is filled in.

/** A ZIP with the given members. Members named in `deflate` are compressed, the others stored. */
export function buildZip(files: Record<string, Buffer | string>, deflate: string[] = []): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'latin1') : content
    const method = deflate.includes(name) ? 8 : 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const n = Buffer.from(name, 'latin1')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26)
    locals.push(local, n, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export interface ModelMeshSpec {
  /** Index into the model's materials (the first skin family). */
  material?: number
  vertices: [number, number, number][]
  /** Indices into `vertices`, three to a triangle. */
  tris: number[]
}
export interface ModelSpec {
  meshes: ModelMeshSpec[]
  /** Texture names of the model, and the directories to look them up in (as in the .mdl: backslashes, a trailing one). */
  textures?: string[]
  cdTextures?: string[]
  /** `skinref[material]` is the texture index (default: the identity). */
  skinref?: number[]
  /** Write the .vtx vertices of each strip group in reverse order, so the reader must map them back. */
  reverseVertices?: boolean
  /** The .vvd vertex table with level-of-detail fix-ups: the vertices as listed, and the fix-ups that pick from them. */
  vvd?: { vertices: [number, number, number][], fixups: { lod: number, from: number, count: number }[] }
}

const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b }

export function buildModel(spec: ModelSpec): { mdl: Buffer, vvd: Buffer, vtx: Buffer } {
  const textures = spec.textures ?? ['wall']
  const cds = spec.cdTextures ?? ['models\\test\\']
  const skinref = spec.skinref ?? textures.map((_, i) => i)

  // ---- .mdl: header, textures, strings, cd table, skin table, body part, model, meshes
  const header = 240
  const texAt = header
  const strAt = texAt + textures.length * 64
  const strings: Buffer[] = []
  let strLen = 0
  const addStr = (s: string) => { const at = strAt + strLen; const b = Buffer.from(s + '\0', 'latin1'); strings.push(b); strLen += b.length; return at }
  const texNameAt = textures.map(t => addStr(t))
  const cdNameAt = cds.map(c => addStr(c))
  const cdAt = strAt + strLen
  const skinAt = cdAt + cds.length * 4
  const partAt = skinAt + skinref.length * 2 + (skinref.length % 2) * 2
  const modelAt = partAt + 16
  const meshAt = modelAt + 148
  const mdl = Buffer.alloc(meshAt + spec.meshes.length * 116 + 16)
  mdl.write('IDST', 0, 'latin1'); mdl.writeInt32LE(48, 4)
  mdl.writeInt32LE(textures.length, 204); mdl.writeInt32LE(texAt, 208)
  mdl.writeInt32LE(cds.length, 212); mdl.writeInt32LE(cdAt, 216)
  mdl.writeInt32LE(skinref.length, 220); mdl.writeInt32LE(1, 224); mdl.writeInt32LE(skinAt, 228)
  mdl.writeInt32LE(1, 232); mdl.writeInt32LE(partAt, 236)
  texNameAt.forEach((at, i) => mdl.writeInt32LE(at - (texAt + i * 64), texAt + i * 64))
  Buffer.concat(strings).copy(mdl, strAt)
  cdNameAt.forEach((at, i) => mdl.writeInt32LE(at, cdAt + i * 4))
  skinref.forEach((t, i) => mdl.writeInt16LE(t, skinAt + i * 2))
  mdl.writeInt32LE(1, partAt + 4); mdl.writeInt32LE(modelAt - partAt, partAt + 12) // one model
  mdl.writeInt32LE(spec.meshes.length, modelAt + 72); mdl.writeInt32LE(meshAt - modelAt, modelAt + 76)
  let vertexOffset = 0
  spec.meshes.forEach((m, k) => {
    const at = meshAt + k * 116
    mdl.writeInt32LE(m.material ?? 0, at); mdl.writeInt32LE(m.vertices.length, at + 8); mdl.writeInt32LE(vertexOffset, at + 12)
    vertexOffset += m.vertices.length
  })
  mdl.writeInt32LE(vertexOffset, modelAt + 80); mdl.writeInt32LE(0, modelAt + 84) // numvertices, vertexindex

  // ---- .vvd
  const verts = spec.vvd?.vertices ?? spec.meshes.flatMap(m => m.vertices)
  const fixups = spec.vvd?.fixups ?? []
  const fixAt = 64, vertAt = fixAt + fixups.length * 12
  const vvd = Buffer.alloc(vertAt + verts.length * 48)
  vvd.write('IDSV', 0, 'latin1'); vvd.writeInt32LE(4, 4)
  vvd.writeInt32LE(1, 12); vvd.writeInt32LE(spec.vvd ? fixups.reduce((n, f) => n + (f.lod >= 0 ? f.count : 0), 0) : verts.length, 16)
  vvd.writeInt32LE(fixups.length, 48); vvd.writeInt32LE(fixAt, 52); vvd.writeInt32LE(vertAt, 56)
  fixups.forEach((f, i) => { vvd.writeInt32LE(f.lod, fixAt + i * 12); vvd.writeInt32LE(f.from, fixAt + i * 12 + 4); vvd.writeInt32LE(f.count, fixAt + i * 12 + 8) })
  verts.forEach((v, i) => v.forEach((n, a) => vvd.writeFloatLE(n, vertAt + i * 48 + 16 + a * 4)))

  // ---- .vtx: header (36), body part (8), model (8), lod (12), then per mesh: mesh (9), strip group (25), vertices (9 each), indices, strip (27)
  const parts: Buffer[] = []
  const vtxHead = Buffer.alloc(36); vtxHead.writeInt32LE(7, 0); vtxHead.writeInt32LE(1, 20); vtxHead.writeInt32LE(1, 28); vtxHead.writeInt32LE(36, 32)
  const bodyPart = Buffer.alloc(8); bodyPart.writeInt32LE(1, 0); bodyPart.writeInt32LE(8, 4)
  const model = Buffer.alloc(8); model.writeInt32LE(1, 0); model.writeInt32LE(8, 4)
  const lod = Buffer.alloc(12); lod.writeInt32LE(spec.meshes.length, 0); lod.writeInt32LE(12, 4)
  const meshBlocks: Buffer[] = spec.meshes.map(m => {
    const n = m.vertices.length
    const original = Array.from({ length: n }, (_, i) => (spec.reverseVertices ? n - 1 - i : i))
    const local = (v: number) => (spec.reverseVertices ? n - 1 - v : v) // where vertex v sits in the strip group's list
    const sgVerts = Buffer.alloc(n * 9); original.forEach((o, i) => sgVerts.writeUInt16LE(o, i * 9 + 4))
    const idx = Buffer.alloc(m.tris.length * 2); m.tris.forEach((v, i) => idx.writeUInt16LE(local(v), i * 2))
    const strip = Buffer.alloc(27); strip.writeInt32LE(m.tris.length, 0); strip.writeInt32LE(0, 4); strip.writeUInt8(1, 18)
    const sg = Buffer.alloc(25)
    sg.writeInt32LE(n, 0); sg.writeInt32LE(25, 4); sg.writeInt32LE(m.tris.length, 8); sg.writeInt32LE(25 + n * 9, 12)
    sg.writeInt32LE(1, 16); sg.writeInt32LE(25 + n * 9 + idx.length, 20)
    const mesh = Buffer.alloc(9); mesh.writeInt32LE(1, 0); mesh.writeInt32LE(9, 4)
    return Buffer.concat([mesh, sg, sgVerts, idx, strip])
  })
  // the meshes sit one after another, each mesh record pointing at its own strip group (right after it)
  const records = meshBlocks.map(b => b.subarray(0, 9)), rest = meshBlocks.map(b => b.subarray(9))
  // lod.meshOffset 12 = the mesh records start right after the lod; each record's stripGroupOffset is from the record to its group
  let after = spec.meshes.length * 9
  records.forEach((r, k) => { r.writeInt32LE(after - k * 9, 4); after += rest[k]!.length })
  // the strip group of mesh k starts at after-offset; sg offsets inside are relative to the group, which they already are
  parts.push(vtxHead, bodyPart, model, lod, ...records, ...rest)
  const vtx = Buffer.concat(parts)
  return { mdl, vvd, vtx }
}
