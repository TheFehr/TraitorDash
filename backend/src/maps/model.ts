// RFC 18, 4.3: the mesh of one Source model, from the three files that make it (`.mdl` the structure, `.vvd` the
// vertices, `.dx90.vtx` the triangles). Only the first body part's first model at the first level of detail is read:
// what a player sees. Materials are not read, except for one question: is this mesh foliage (a material with a cut-out
// or a translucent texture, `$alphatest` or `$translucent`), which is drawn apart. The files are untrusted: reading
// past the end of one is a `RangeError` of the `DataView`, which gives `null`, and every count is capped.

export interface ModelMesh {
  /** Triangles of the solid meshes, x y z per corner, in the model's own space. */
  solid: number[]
  /** Triangles of the meshes whose material is foliage (a cut-out or translucent material) and that have a shape of their own. */
  foliage: number[]
  /** Foliage meshes left out because they are cards: see `CARD_TRIANGLE_AREA`. */
  cards: number
}

/**
 * A foliage mesh whose triangles are on average bigger than this (units squared, about 220 by 220) is a card: a few huge
 * flat sheets that take their shape from a texture, which is not read, so without it they are only a sheet (the leaf cards
 * of `ttt_alps` are 230 triangles over 2 400 units; the cloud and mountain backdrops of other maps are the same). It is
 * left out. A crown made of many small leaves is far below this (the largest in the 27 maps measured: about 20 000).
 */
export const CARD_TRIANGLE_AREA = 50_000

export interface ModelFiles { mdl: Uint8Array, vvd: Uint8Array, vtx: Uint8Array }

const MAX_MESHES = 1024
const MAX_STRIP_GROUPS = 4096
const MAX_STRIPS = 8192
const MAX_TEXTURES = 1024
const MAX_FIXUPS = 65_536
const MAX_VERTICES = 1_000_000

const VERTEX = 48 // one vertex in the .vvd
const STUDIO_MODEL = 148 // sizeof studiomodel_t
const STUDIO_MESH = 116 // sizeof studiomesh_t
const STUDIO_TEXTURE = 64
const STRIP_IS_TRILIST = 0x01

const cap = (n: number, max: number) => { if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError('a count is out of range'); return n }

/** A NUL-ended string at `at` in `b`, at most `max` bytes. */
const cstr = (b: Uint8Array, at: number, max = 260): string => {
  if (at < 0 || at >= b.length) throw new RangeError('a string starts outside the file')
  let end = at
  while (end < b.length && b[end] !== 0 && end - at < max) end++
  return Buffer.from(b.subarray(at, end)).toString('latin1')
}

/**
 * The mesh of a model, or null when the files are not what was expected, are cut off, or have more than `maxTriangles`.
 * `isFoliage` is asked, for each mesh, with the paths its material could be at (`materials/<dir><name>.vmt`, lower case).
 */
export function readModel(files: ModelFiles, isFoliage: (vmtPaths: string[]) => boolean, maxTriangles = 50_000): ModelMesh | null {
  try { return read(files, isFoliage, maxTriangles) } catch (e) { if (e instanceof RangeError) return null; throw e }
}

function read({ mdl, vvd, vtx }: ModelFiles, isFoliage: (vmtPaths: string[]) => boolean, maxTriangles: number): ModelMesh | null {
  const m = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength)
  const v = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength)
  const t = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength)
  const id = (b: Uint8Array) => String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!)
  if (mdl.length < 240 || vvd.length < 64 || vtx.length < 36 || id(mdl) !== 'IDST' || id(vvd) !== 'IDSV') return null

  // The vertices of the first level of detail, with its fix-ups (the vertices a level of detail takes from the others).
  const numFix = cap(v.getInt32(48, true), MAX_FIXUPS), fixStart = v.getInt32(52, true), vertStart = v.getInt32(56, true)
  const lod0 = cap(v.getInt32(16, true), MAX_VERTICES)
  const positions: number[] = []
  const take = (i: number) => { const o = vertStart + i * VERTEX; positions.push(v.getFloat32(o + 16, true), v.getFloat32(o + 20, true), v.getFloat32(o + 24, true)) }
  if (numFix > 0) {
    for (let f = 0; f < numFix; f++) {
      const o = fixStart + f * 12
      const lod = v.getInt32(o, true), from = v.getInt32(o + 4, true), n = cap(v.getInt32(o + 8, true), MAX_VERTICES)
      if (lod >= 0) for (let k = 0; k < n; k++) { take(from + k); if (positions.length / 3 > MAX_VERTICES) return null }
    }
  } else for (let i = 0; i < lod0; i++) take(i)
  const vertexCount = positions.length / 3

  // Where the materials are, for the foliage question.
  const numTex = cap(m.getInt32(204, true), MAX_TEXTURES), texAt = m.getInt32(208, true)
  const numCd = cap(m.getInt32(212, true), MAX_TEXTURES), cdAt = m.getInt32(216, true)
  const numSkinRef = cap(m.getInt32(220, true), MAX_TEXTURES), skinAt = m.getInt32(228, true)
  const dirs: string[] = []
  for (let i = 0; i < numCd; i++) {
    const d = cstr(mdl, m.getInt32(cdAt + i * 4, true)).toLowerCase().replace(/\\/g, '/')
    dirs.push(d === '' || d.endsWith('/') ? d : d + '/')
  }
  const foliageOfMaterial = new Map<number, boolean>()
  const foliageMaterial = (material: number): boolean => {
    const known = foliageOfMaterial.get(material)
    if (known !== undefined) return known
    let foliage = false
    if (material >= 0 && material < numSkinRef) {
      const tex = m.getInt16(skinAt + material * 2, true) // the first skin family
      if (tex >= 0 && tex < numTex) {
        const at = texAt + tex * STUDIO_TEXTURE
        const name = cstr(mdl, at + m.getInt32(at, true)).toLowerCase().replace(/\\/g, '/')
        foliage = isFoliage(dirs.map(d => `materials/${d}${name}.vmt`))
      }
    }
    foliageOfMaterial.set(material, foliage)
    return foliage
  }

  // The structure: first body part, first model, first level of detail.
  const nParts = cap(m.getInt32(232, true), 1024), partAt = m.getInt32(236, true)
  if (nParts < 1 || t.getInt32(28, true) < 1) return null
  const nModels = m.getInt32(partAt + 4, true), modelAt = partAt + m.getInt32(partAt + 12, true)
  if (nModels < 1) return null
  const nMeshes = cap(m.getInt32(modelAt + 72, true), MAX_MESHES), meshAt = modelAt + m.getInt32(modelAt + 76, true)
  const vertexIndex = m.getInt32(modelAt + 84, true) / VERTEX
  if (!Number.isInteger(vertexIndex)) return null
  const vtxPart = t.getInt32(32, true), vtxModel = vtxPart + t.getInt32(vtxPart + 4, true), vtxLod = vtxModel + t.getInt32(vtxModel + 4, true)
  const vtxMeshes = cap(t.getInt32(vtxLod, true), MAX_MESHES), vtxMeshAt = vtxLod + t.getInt32(vtxLod + 4, true)

  const solid: number[] = [], foliage: number[] = []
  let triangles = 0, cards = 0
  for (let k = 0; k < Math.min(nMeshes, vtxMeshes); k++) {
    const mesh = meshAt + k * STUDIO_MESH
    const vertexOffset = m.getInt32(mesh + 12, true)
    const isFoliage_ = foliageMaterial(m.getInt32(mesh, true))
    const target = isFoliage_ ? [] as number[] : solid
    const vm = vtxMeshAt + k * 9
    const groups = cap(t.getInt32(vm, true), MAX_STRIP_GROUPS), groupAt = vm + t.getInt32(vm + 4, true)
    for (let g = 0; g < groups; g++) {
      const sg = groupAt + g * 25
      const nVerts = cap(t.getInt32(sg, true), MAX_VERTICES), vertAt = sg + t.getInt32(sg + 4, true)
      const indexAt = sg + t.getInt32(sg + 12, true)
      const nStrips = cap(t.getInt32(sg + 16, true), MAX_STRIPS), stripAt = sg + t.getInt32(sg + 20, true)
      const original: number[] = []
      for (let i = 0; i < nVerts; i++) original.push(t.getUint16(vertAt + i * 9 + 4, true))
      for (let s = 0; s < nStrips; s++) {
        const st = stripAt + s * 27
        const n = t.getInt32(st, true), first = t.getInt32(st + 4, true), flags = t.getUint8(st + 18)
        if (!(flags & STRIP_IS_TRILIST) || n < 3 || n > 3 * maxTriangles) continue
        for (let i = 0; i + 2 < n; i += 3) {
          for (let c = 0; c < 3; c++) {
            const local = t.getUint16(indexAt + (first + i + c) * 2, true)
            if (local >= original.length) return null
            const gv = vertexIndex + vertexOffset + original[local]!
            if (!(gv >= 0 && gv < vertexCount)) return null
            target.push(positions[gv * 3]!, positions[gv * 3 + 1]!, positions[gv * 3 + 2]!)
          }
          if (++triangles > maxTriangles) return null
        }
      }
    }
    if (isFoliage_) {
      if (meanArea(target) > CARD_TRIANGLE_AREA) cards++
      else for (const x of target) foliage.push(x)
    }
  }
  return triangles === 0 ? null : { solid, foliage, cards }
}

/** The mean area of the triangles of a soup (x y z per corner). */
function meanArea(soup: number[]): number {
  let total = 0
  for (let i = 0; i < soup.length; i += 9) {
    const ux = soup[i + 3]! - soup[i]!, uy = soup[i + 4]! - soup[i + 1]!, uz = soup[i + 5]! - soup[i + 2]!
    const vx = soup[i + 6]! - soup[i]!, vy = soup[i + 7]! - soup[i + 1]!, vz = soup[i + 8]! - soup[i + 2]!
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return soup.length === 0 ? 0 : total / (soup.length / 9)
}
