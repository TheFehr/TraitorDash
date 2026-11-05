// RFC 18, 5: the materials of the floors and walls of a map. A map has 30 to 720 materials and a mesh cannot carry them all, so they are taken by
// the ground they cover: the largest get their texture (at a small size), the next a plain colour (the average of the texture, taken to a few
// shades so that they share a material), the rest are drawn as the plain floor or wall. A material the map has no file for, whose texture cannot
// be had, or that names none, stays plain too. Nothing here is fatal: whatever cannot be read is left out.

import type { ByteSource, FaceMapping, FaceRecord } from './bsp'
import type { SurfaceMaterial, SurfaceTextures } from './meshGlb'
import { readPakMember, type Pak } from './pak'
import type { StockTextures } from './propset'
import { TextureBook } from './texturebook'
import { applyPatch, parseMaterial, patchOf, type Vmt } from './vmt'

export const SURFACE_LIMITS = {
  /** The materials looked at, by the ground they cover. */
  materials: 160,
  /** Of those, how many get a texture of their own. */
  textured: 24,
  /** The longer side of a texture. */
  side: 128,
  pngBytes: 3 * 1024 * 1024,
  memberBytes: 24 * 1024 * 1024,
  /** What is asked of the game's own files: material files and textures. */
  stockMaterials: 400,
  stockTextures: 200,
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
  const report: SurfaceReport = { materials: 0, resolved: 0, textured: 0, coloured: 0, fromGame: 0 }
  // ---- the ground each material covers
  const byMaterial = new Map<string, number>()
  const areaOfMapping = new Float64Array(input.mappings.length)
  for (const [soup, faces] of [[input.floors, input.floorFaces], [input.walls, input.wallFaces]] as const) {
    for (let i = 0, t = 0; i < soup.length; i += 9, t++) areaOfMapping[input.faces[faces[t]!]!.mapping]! += area(soup, i)
  }
  input.mappings.forEach((m, k) => { if (m.material) byMaterial.set(m.material, (byMaterial.get(m.material) ?? 0) + areaOfMapping[k]!) })
  const ranked = [...byMaterial].sort((a, b) => b[1] - a[1]).slice(0, limits.materials).map(([name]) => name)
  report.materials = byMaterial.size

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

  // ---- the textures: the game's own that the pack does not have, in one request
  const book = new TextureBook(src, pak, { textures: limits.textured, side: limits.side, pngBytes: limits.pngBytes, memberBytes: limits.memberBytes })
  if (stock) {
    const wanted = new Set<string>()
    for (const v of vmts.values()) if (!book.has(v.texture!)) wanted.add(`materials/${v.texture}.vtf`)
    if (wanted.size > 0) book.stock = (await stock([...wanted].slice(0, limits.stockTextures))).files
  }

  // ---- a texture for the largest, a plain colour for the next
  const materials: SurfaceMaterial[] = []
  const indexOf = new Map<string, number>() // material name (or the plain colour) -> index in `materials`
  const shade = (c: number) => Math.round(c * (limits.shades - 1)) / (limits.shades - 1)
  for (const name of ranked) {
    const v = vmts.get(name)
    if (!v) continue
    // a cut-out or see-through material needs its texture for its shape; a solid one can fall back to its colour
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
}
