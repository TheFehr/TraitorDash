// RFC 18, 5 and RFC 36: the materials of the surfaces of a map. EVERY material the map names gets its own texture (at a small size), translucent and
// cut-out ones with their alpha: there is no budget of textures. The materials are taken by the ground they cover only as the ORDER of the work, so
// that a safety ceiling (against hostile files, far above any real map) cuts the least important first, and says so (the report counts it). A material
// whose texture truly cannot be had falls back to the plain colour (the average of its texture, taken to a few shades) or to the plain floor or
// wall, and the report says why. Nothing here is fatal: whatever cannot be read is left out.

import type { ByteSource, FaceMapping, FaceRecord } from './bsp'
import type { SurfaceMaterial, SurfaceTextures } from './meshGlb'
import { readPakMember, type Pak } from './pak'
import type { StockTextures } from './propset'
import { TextureBook } from './texturebook'
import { applyPatch, parseMaterial, patchOf, type Vmt } from './vmt'

/** Safety ceilings against hostile map files, not quality budgets (RFC 36): no real map comes near them, and when one is reached the report says so. */
export const SURFACE_LIMITS = {
  /** The materials looked at, largest ground first; the rest are left to the plain colour and counted as `ceiling`. */
  materials: 2000,
  /** The longer side of a texture (the resolution of a texture, not a count of textures). */
  side: 128,
  /** All the PNG of the surface textures; a texture that does not fit is left to a colour and counted as `ceiling`. */
  pngBytes: 24 * 1024 * 1024,
  memberBytes: 24 * 1024 * 1024,
  /** What is asked of the game's own files: material files and textures (a request size, above what `materials` allows). */
  stockMaterials: 4000,
  stockTextures: 4000,
  /** Shades for each channel of a plain colour (the colours are taken to this many), so that materials of nearly one colour are one. */
  shades: 8,
}

export interface SurfaceInput {
  mappings: FaceMapping[]
  faces: FaceRecord[]
  floors: number[]
  floorFaces: number[]
  walls: number[]
  wallFaces: number[]
  /** The parts that can move: their triangles (local to the part) and the face of each. */
  parts?: { triangles: number[], faces?: number[] }[]
  /** The decoration (RFC 33, 4.4): world-space triangles and the face of each, so its materials are counted too. */
  decoration?: { triangles: number[], faces: number[] }
}

const area = (soup: number[], i: number) => {
  const ux = soup[i + 3]! - soup[i]!, uy = soup[i + 4]! - soup[i + 1]!, uz = soup[i + 5]! - soup[i + 2]!
  const vx = soup[i + 6]! - soup[i]!, vy = soup[i + 7]! - soup[i + 1]!, vz = soup[i + 8]! - soup[i + 2]!
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
}

/**
 * The textures and materials of the floors and walls given. `stock` fetches the game's own files (material files and textures) in one request
 * each; without it only what the pack has is used.
 */
export async function buildSurfaceTextures(input: SurfaceInput, src: ByteSource, pak: Pak, stock?: StockTextures, limits = SURFACE_LIMITS): Promise<{ surface: SurfaceTextures, report: SurfaceReport }> {
  const report: SurfaceReport = { materials: 0, resolved: 0, textured: 0, coloured: 0, fromGame: 0, pngBytes: 0, notFound: 0, notDecodable: 0, ceiling: 0 }
  // ---- the ground each material covers
  const byMaterial = new Map<string, number>()
  const areaOfMapping = new Float64Array(input.mappings.length)
  for (const [soup, faces] of [[input.floors, input.floorFaces], [input.walls, input.wallFaces]] as const) {
    for (let i = 0, t = 0; i < soup.length; i += 9, t++) areaOfMapping[input.faces[faces[t]!]!.mapping]! += area(soup, i)
  }
  for (const p of input.parts ?? []) if (p.faces) for (let i = 0, t = 0; i < p.triangles.length; i += 9, t++) areaOfMapping[input.faces[p.faces[t]!]!.mapping]! += area(p.triangles, i)
  if (input.decoration) for (let i = 0, t = 0; i < input.decoration.triangles.length; i += 9, t++) areaOfMapping[input.faces[input.decoration.faces[t]!]!.mapping]! += area(input.decoration.triangles, i)
  input.mappings.forEach((m, k) => { if (m.material) byMaterial.set(m.material, (byMaterial.get(m.material) ?? 0) + areaOfMapping[k]!) })
  // the ground only orders the work (the largest first, so that a ceiling cuts the least important)
  const all = [...byMaterial].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  const ranked = all.slice(0, limits.materials)
  report.materials = byMaterial.size
  report.ceiling += all.length - ranked.length

  // ---- the material files: the pack's, then the game's own (a patch names the file it includes: read in one more round)
  const text = new Map<string, string>()
  const askedStock = new Set<string>()
  const readText = async (paths: string[]) => {
    const missing: string[] = []
    for (const p of paths) {
      if (text.has(p)) continue
      if (pak.entries.has(p)) { const b = await readPakMember(src, pak, p, { maxMemberBytes: 64 * 1024 }); if (b) text.set(p, Buffer.from(b).toString('latin1')); continue }
      if (!askedStock.has(p)) { askedStock.add(p); missing.push(p) }
    }
    if (stock && missing.length > 0) {
      const got = await stock(missing.slice(0, Math.max(0, limits.stockMaterials - (askedStock.size - missing.length))))
      for (const [p, b] of got.files) text.set(p, Buffer.from(b).toString('latin1'))
    }
  }
  const pathOf = (name: string) => `materials/${name}.vmt`
  await readText(ranked.map(pathOf))
  for (let round = 0; round < 2; round++) {
    const includes = [...text.values()].map(patchOf).filter((p): p is string => p !== null)
    if (includes.length === 0) break
    await readText(includes)
  }
  const merged = (path: string, depth = 0): string | null => {
    const t = text.get(path)
    if (t === undefined) return null
    const inc = patchOf(t)
    if (inc === null) return t
    const base = depth < 3 ? merged(inc, depth + 1) : null
    return base === null ? null : applyPatch(base, t)
  }
  const vmts = new Map<string, Vmt>()
  for (const name of ranked) { const t = merged(pathOf(name)); if (t !== null) { const v = parseMaterial(t); if (v.texture) vmts.set(name, v) } }
  report.resolved = vmts.size
  report.notFound += ranked.length - vmts.size // no material file, or it names no texture

  // ---- the textures: the game's own that the pack does not have, in one request
  const book = new TextureBook(src, pak, { side: limits.side, pngBytes: limits.pngBytes, memberBytes: limits.memberBytes })
  if (stock) {
    const wanted = new Set<string>()
    for (const v of vmts.values()) for (const tex of [v.texture, v.texture2]) if (tex && !book.has(tex)) wanted.add(`materials/${tex}.vtf`)
    if (wanted.size > 0) book.stock = (await stock([...wanted].slice(0, limits.stockTextures))).files
  }

  // ---- a texture for every material (the largest first); a plain colour only for one whose texture cannot be had
  const materials: SurfaceMaterial[] = []
  const indexOf = new Map<string, number>() // material name (or the plain colour) -> index in `materials`
  const shade = (c: number) => Math.round(c * (limits.shades - 1)) / (limits.shades - 1)
  for (const name of ranked) {
    const v = vmts.get(name)
    if (!v) continue
    // two textures blended by the alpha of a displacement (grass on dirt): five materials, from the first texture to the second
    if (v.texture2 && v.kind === 'solid') {
      const steps = []
      for (let k = 0; k < 5; k++) steps.push(await book.mixed(v.texture!, v.texture2, k))
      if (steps.every(x => x !== null)) {
        const base = materials.length
        steps.forEach((got, k) => materials.push({ name: `${name}@${k}`, texture: got!.index, colour: null, mode: 'opaque', alpha: 1, ...(k === 0 ? { blendSteps: 5 } : {}) }))
        indexOf.set(name, base)
        report.textured++
        continue
      }
    }
    // a cut-out or see-through material is a textured material like any other, with its alpha mode and alpha (RFC 36)
    const got = await book.texture(v.texture!, v.additive)
    if (got) {
      // materials that name one texture the same way are one material: a draw for each would be far more than the picture needs
      const alpha = v.kind === 'blend' && !v.explicitAlpha && !got.hasAlpha ? 0.4 : v.alpha
      const mode = v.kind === 'solid' ? 'opaque' : v.kind
      const key = `texture ${got.index} ${mode} ${alpha}`
      let at = indexOf.get(key)
      if (at === undefined) { at = materials.length; indexOf.set(key, at); materials.push({ name, texture: got.index, colour: null, mode, alpha }) }
      indexOf.set(name, at)
      report.textured++
      continue
    }
    // the texture truly cannot be had: say why; a solid material keeps the average colour of its texture if that decodes, a cut-out or see-through one cannot be a flat colour (its shape is its alpha) and stays plain
    const why = book.whyNot(v.texture!)
    if (why === 'not found') report.notFound++; else if (why === 'not decodable') report.notDecodable++; else report.ceiling++
    if (v.kind !== 'solid') continue
    const avg = await book.average(v.texture!)
    if (!avg) continue
    const c: [number, number, number] = [shade(avg[0]), shade(avg[1]), shade(avg[2])]
    const key = `colour ${c.map(x => Math.round(x * (limits.shades - 1))).join('')}`
    let at = indexOf.get(key)
    if (at === undefined) { at = materials.length; indexOf.set(key, at); materials.push({ name: key, texture: null, colour: c, mode: 'opaque', alpha: 1 }) }
    indexOf.set(name, at)
    report.coloured++
  }
  report.fromGame = book.fromGame
  report.pngBytes = book.pngBytes
  const materialOf = input.mappings.map(m => indexOf.get(m.material) ?? -1)
  return { surface: { floorFaces: input.floorFaces, wallFaces: input.wallFaces, faces: input.faces, mappings: input.mappings, materialOf, materials, textures: book.textures }, report }
}

export interface SurfaceReport {
  /** Materials the faces name, how many of the largest were looked at and had a material file with a texture, and what became of them. */
  materials: number
  resolved: number
  textured: number
  coloured: number
  /** Textures that came from the game's own files. */
  fromGame: number
  /** The PNG bytes of the surface textures (RFC 36, 4). */
  pngBytes: number
  /**
   * Materials left to a fallback, by why (RFC 36, 4): `notFound` (no material file, no texture named, or its file is not there), `notDecodable` (the file is
   * there and cannot be read), `ceiling` (a safety ceiling was reached: more materials than the ceiling looked at, or the PNG bytes full). Each material is in one.
   */
  notFound: number
  notDecodable: number
  ceiling: number
}
