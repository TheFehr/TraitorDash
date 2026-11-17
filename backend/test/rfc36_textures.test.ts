import { expect, test, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { memorySource, bspFingerprint, type FaceMapping, type FaceRecord } from '../src/maps/bsp'
import { readPak } from '../src/maps/pak'
import { readVtf } from '../src/maps/vtf'
import { encodePng } from '../src/maps/png'
import { buildSurfaceTextures, SURFACE_LIMITS, type SurfaceInput } from '../src/maps/surfacetex'
import { buildGeometry } from '../src/services/mapgeometry'
import { buildBsp, flatQuads } from './helpers/bsp_builder'
import { buildZip } from './helpers/model_builder'

// RFC 36, 6: every material the map names gets its texture, whatever its ground; translucent and cut-out ones with their alpha; only safety ceilings, and they are counted.

/** A Source texture (RGBA8888, one mip, version 7.2) of the given size; `pixel(x, y)` gives its colour. */
function vtf(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const out = Buffer.alloc(80 + w * h * 4)
  out.write('VTF\0', 0, 'latin1'); out.writeUInt32LE(7, 4); out.writeUInt32LE(2, 8); out.writeUInt32LE(80, 12)
  out.writeUInt16LE(w, 16); out.writeUInt16LE(h, 18); out.writeUInt16LE(1, 24); out.writeInt32LE(0, 52); out.writeUInt8(1, 56)
  out.writeInt32LE(-1, 57); out.writeUInt16LE(1, 63)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = pixel(x, y); out.set(p, 80 + (y * w + x) * 4) }
  return out
}
/** A texture whose colour depends on `k` (so that every one is a different file) and on the position (noise, so the PNG has some size). */
const solid = (k: number, size = 8) => vtf(size, size, (x, y) => [(k * 37) & 255, (k * 91 + x * 7) & 255, (k * 13 + y * 11) & 255, 255])
/** A texture with its mip chain down to 1 by 1 (so that a size can be chosen), the largest `w` by `w`. */
function vtfMips(w: number, k: number): Buffer {
  const levels: Buffer[] = []
  for (let s = w; s >= 1; s = s >> 1) levels.push(Buffer.alloc(s * s * 4, (k * 37) & 255))
  const out = Buffer.alloc(80 + levels.reduce((n, l) => n + l.length, 0))
  out.write('VTF\0', 0, 'latin1'); out.writeUInt32LE(7, 4); out.writeUInt32LE(2, 8); out.writeUInt32LE(80, 12)
  out.writeUInt16LE(w, 16); out.writeUInt16LE(w, 18); out.writeUInt16LE(1, 24); out.writeInt32LE(0, 52); out.writeUInt8(levels.length, 56)
  out.writeInt32LE(-1, 57); out.writeUInt16LE(1, 63)
  Buffer.concat([...levels].reverse()).copy(out, 80)
  return out
}
const withAlpha = (k: number) => vtf(8, 8, (x, y) => [(k * 37) & 255, 40, 200, (x + y) % 2 === 0 ? 0 : 255])

interface Mat { name: string, vmt?: string, vtf?: Uint8Array | null }
const vmtOf = (tex: string, extra = '') => `"LightmappedGeneric"\n{\n  "$basetexture" "${tex}"\n  ${extra}\n}\n`

/** The input of a map whose floor has one triangle for each material, of the area given (the index of the material by default). */
async function run(mats: Mat[], areas?: number[], limits = SURFACE_LIMITS) {
  const files: Record<string, Buffer | string> = { 'materials/readme.txt': 'x' }
  for (const m of mats) {
    files[`materials/${m.name}.vmt`] = m.vmt ?? vmtOf(m.name)
    if (m.vtf !== null) files[`materials/${m.name}.vtf`] = Buffer.from(m.vtf ?? solid(1))
  }
  for (const m of mats) if (m.vmt === 'none') delete files[`materials/${m.name}.vmt`]
  const zip = buildZip(files)
  const src = memorySource(zip)
  const pak = await readPak(src, { index: 40, offset: 0, length: zip.length, version: 0, compressed: false })
  const mappings: FaceMapping[] = mats.map(m => ({ material: m.name, s: [1, 0, 0, 0], t: [0, 1, 0, 0], width: 8, height: 8 }))
  const faces: FaceRecord[] = mats.map((_, i) => ({ mapping: i }))
  const floors: number[] = []
  mats.forEach((_, i) => { const a = areas?.[i] ?? i + 1; floors.push(0, 0, 0, a, 0, 0, 0, 2, 0) }) // area = a
  const input: SurfaceInput = { mappings, faces, floors, floorFaces: mats.map((_, i) => i), walls: [], wallFaces: [] }
  return { ...(await buildSurfaceTextures(input, src, pak, undefined, limits)), mats }
}
const matOf = (r: Awaited<ReturnType<typeof run>>, name: string) => { const i = r.mats.findIndex(m => m.name === name); const at = r.surface.materialOf[i]!; return at < 0 ? null : r.surface.materials[at]! }

describe('every material is textured, whatever its ground', () => {
  const many = Array.from({ length: 120 }, (_, i): Mat => ({ name: `tex/m${String(i).padStart(3, '0')}`, vtf: solid(i + 1) }))

  test('120 materials, every one with a texture of its own, the smallest ground included (the old cap was 40)', async () => {
    const r = await run(many)
    expect(r.report).toMatchObject({ materials: 120, resolved: 120, textured: 120, coloured: 0, notFound: 0, notDecodable: 0, ceiling: 0 })
    expect(r.surface.textures).toHaveLength(120)
    for (const m of many) { const got = matOf(r, m.name); expect(got?.texture, m.name).not.toBeNull(); expect(got?.colour).toBeNull() }
    // material 0 has the smallest ground (rank 120 of 120), material 119 the largest
    expect(matOf(r, 'tex/m000')!.texture).not.toBeNull()
  })

  test('the textures are the pictures of the files, at the size of at most 128, as before', async () => {
    const r = await run([{ name: 'tex/a', vtf: solid(3) }, { name: 'tex/b', vtf: vtfMips(256, 5) }])
    const a = r.surface.textures[matOf(r, 'tex/a')!.texture!]!, b = r.surface.textures[matOf(r, 'tex/b')!.texture!]!
    expect(SURFACE_LIMITS.side).toBe(128)
    expect(Math.max(b.width, b.height)).toBe(128) // a 256 picture comes down to 128
    expect([a.width, a.height]).toEqual([8, 8])
    // a texture of a material that was textured before is the same bytes as before: the picture of the file, as a PNG
    const px = readVtf(solid(3), 128)!
    expect(Buffer.from(a.png).equals(Buffer.from(encodePng(px.width, px.height, px.rgba)))).toBe(true)
  })

  test('a map with at most 40 materials has the textures it had: the same files, in the order of the ground, largest first', async () => {
    const mats = Array.from({ length: 40 }, (_, i): Mat => ({ name: `tex/n${i}`, vtf: solid(i + 7) }))
    const r = await run(mats)
    // index 0 of the textures is the material with the largest ground: the last one
    expect(r.surface.textures[0]!.name).toBe('tex/n39')
    expect(r.surface.textures).toHaveLength(40)
    const all = createHash('sha256').update(Buffer.concat(r.surface.textures.map(t => Buffer.from(t.png)))).digest('hex')
    expect(all).toBe('46e6b9b8961dc2844fcd51c6916c0405466409320d5788757984f09498d2a538') // taken from the code before RFC 36 (a map of 40 materials: nothing changes)
    expect(r.report.pngBytes).toBe(r.surface.textures.reduce((n, t) => n + t.png.length, 0))
  })

  test('the area ranks the work, not the result: a map with the ceiling at 5 gets the five LARGEST textured and the rest flat, counted', async () => {
    const mats = Array.from({ length: 12 }, (_, i): Mat => ({ name: `tex/c${String(i).padStart(2, '0')}`, vtf: solid(i + 1) }))
    // areas: the material with the index i has the ground i + 1, so c11 is the largest
    const r = await run(mats, undefined, { ...SURFACE_LIMITS, materials: 5 })
    expect(r.report).toMatchObject({ materials: 12, textured: 5, ceiling: 7, notFound: 0, notDecodable: 0 })
    for (const i of [11, 10, 9, 8, 7]) expect(matOf(r, mats[i]!.name)?.texture, mats[i]!.name).not.toBeNull()
    for (const i of [6, 5, 0]) expect(matOf(r, mats[i]!.name), mats[i]!.name).toBeNull()
    expect(r.surface.textures.map(t => t.name).length).toBe(5)
  })

  test('the ground decides the order only: with shuffled areas the largest are the ones kept', async () => {
    const mats = Array.from({ length: 6 }, (_, i): Mat => ({ name: `tex/s${i}`, vtf: solid(i + 1) }))
    const r = await run(mats, [5, 1, 9, 2, 7, 3], { ...SURFACE_LIMITS, materials: 3 })
    expect(['tex/s2', 'tex/s4', 'tex/s0'].map(n => matOf(r, n)?.texture != null)).toEqual([true, true, true])
    expect(['tex/s1', 'tex/s3', 'tex/s5'].map(n => matOf(r, n))).toEqual([null, null, null])
    expect(r.report.ceiling).toBe(3)
  })
})

describe('translucent and cut-out materials are textured with their alpha', () => {
  test('a translucent material with a picture that has alpha: mode blend, alpha 1 (nothing said), its own texture', async () => {
    const r = await run([{ name: 'glass/g', vmt: vmtOf('glass/g', '"$translucent" "1"'), vtf: withAlpha(1) }])
    expect(matOf(r, 'glass/g')).toMatchObject({ mode: 'blend', alpha: 1 })
    expect(matOf(r, 'glass/g')!.texture).not.toBeNull()
    expect(r.report).toMatchObject({ textured: 1, coloured: 0 })
  })
  test('a translucent material whose picture has no alpha channel gets the default 0.4, one that says $alpha keeps its own', async () => {
    const r = await run([
      { name: 'glass/plain', vmt: vmtOf('glass/plain', '"$translucent" "1"'), vtf: solid(2) },
      { name: 'glass/said', vmt: vmtOf('glass/said', '"$translucent" "1" "$alpha" "0.25"'), vtf: solid(3) },
    ])
    expect(matOf(r, 'glass/plain')).toMatchObject({ mode: 'blend', alpha: 0.4 })
    expect(matOf(r, 'glass/said')).toMatchObject({ mode: 'blend', alpha: 0.25 })
  })
  test('a cut-out material: mode mask with its texture (the sign, the leaf)', async () => {
    const r = await run([{ name: 'plant/leaf', vmt: vmtOf('plant/leaf', '"$alphatest" "1"'), vtf: withAlpha(4) }])
    expect(matOf(r, 'plant/leaf')).toMatchObject({ mode: 'mask', alpha: 1 })
    expect(matOf(r, 'plant/leaf')!.texture).not.toBeNull()
  })
  test('an additive material (a light shaft) is a blend material with the glow as its alpha', async () => {
    const r = await run([{ name: 'light/shaft', vmt: vmtOf('light/shaft', '"$additive" "1"'), vtf: solid(6) }])
    expect(matOf(r, 'light/shaft')).toMatchObject({ mode: 'blend' })
    expect(r.surface.textures[matOf(r, 'light/shaft')!.texture!]!.name).toContain('additive')
  })
  test('they are textured even when they are among the smallest of more than 40 materials', async () => {
    const mats: Mat[] = Array.from({ length: 60 }, (_, i) => ({ name: `tex/w${i}`, vtf: solid(i + 1) }))
    mats[0] = { name: 'tex/w0', vmt: vmtOf('tex/w0', '"$translucent" "1"'), vtf: withAlpha(9) } // the smallest ground of all
    mats[1] = { name: 'tex/w1', vmt: vmtOf('tex/w1', '"$alphatest" "1"'), vtf: withAlpha(8) }
    const r = await run(mats)
    expect(matOf(r, 'tex/w0')).toMatchObject({ mode: 'blend' }); expect(matOf(r, 'tex/w0')!.texture).not.toBeNull()
    expect(matOf(r, 'tex/w1')).toMatchObject({ mode: 'mask' }); expect(matOf(r, 'tex/w1')!.texture).not.toBeNull()
    expect(r.report.textured).toBe(60)
  })
})

describe('the fallback, and why', () => {
  test('a texture that is not in the map is "not found": the material stays plain, the others are textured', async () => {
    const r = await run([{ name: 'tex/ok', vtf: solid(1) }, { name: 'tex/gone', vtf: null }])
    expect(r.report).toMatchObject({ materials: 2, textured: 1, notFound: 1, notDecodable: 0, ceiling: 0 })
    expect(matOf(r, 'tex/gone')).toBeNull()
    expect(matOf(r, 'tex/ok')!.texture).not.toBeNull()
  })
  test('a material with no material file is "not found" too', async () => {
    const r = await run([{ name: 'tex/nofile', vmt: 'none', vtf: solid(1) }, { name: 'tex/ok', vtf: solid(2) }])
    expect(r.report).toMatchObject({ textured: 1, notFound: 1, resolved: 1 })
  })
  test('a texture that cannot be decoded is "not decodable", not "not found"', async () => {
    const r = await run([{ name: 'tex/junk', vtf: Buffer.from('this is not a texture at all, only text that is long enough to be read') }, { name: 'tex/ok', vtf: solid(2) }])
    expect(r.report).toMatchObject({ textured: 1, notFound: 0, notDecodable: 1, ceiling: 0 })
    expect(matOf(r, 'tex/junk')).toBeNull()
  })
  test('a cut-out material whose texture is missing stays plain (a flat colour would hide its shape) and is counted', async () => {
    const r = await run([{ name: 'plant/gone', vmt: vmtOf('plant/gone', '"$alphatest" "1"'), vtf: null }])
    expect(matOf(r, 'plant/gone')).toBeNull()
    expect(r.report).toMatchObject({ textured: 0, notFound: 1 })
  })
  test('each material is in one place: textured + not found + not decodable + ceiling = materials', async () => {
    const mats: Mat[] = [{ name: 'a/1', vtf: solid(1) }, { name: 'a/2', vtf: null }, { name: 'a/3', vtf: Buffer.from('junk junk junk junk junk junk junk junk junk junk junk junk junk junk junk junk junk') }, { name: 'a/4', vtf: solid(4) }, { name: 'a/5', vtf: solid(5) }]
    const r = await run(mats, undefined, { ...SURFACE_LIMITS, materials: 4 })
    const t = r.report
    expect(t.textured + t.notFound + t.notDecodable + t.ceiling).toBe(t.materials)
    expect(t.ceiling).toBe(1)
  })
})

describe('the safety ceilings', () => {
  test('the real ceilings are the ones of RFC 36: 24 MB of PNG, 2 000 materials, the pack member as before, and no cap on the textured ones', () => {
    expect(SURFACE_LIMITS.pngBytes).toBe(24 * 1024 * 1024)
    expect(SURFACE_LIMITS.materials).toBe(2000)
    expect(SURFACE_LIMITS.memberBytes).toBe(24 * 1024 * 1024)
    expect(SURFACE_LIMITS.side).toBe(128)
    expect('textured' in SURFACE_LIMITS).toBe(false)
  })
  test('the PNG ceiling: the largest are textured, the next ones that no longer fit are plain colours and counted as "ceiling" (not hidden)', async () => {
    const mats = Array.from({ length: 6 }, (_, i): Mat => ({ name: `tex/p${i}`, vtf: solid(i + 1, 16) }))
    const probe = await run(mats)
    const one = probe.surface.textures[0]!.png.length
    const r = await run(mats, undefined, { ...SURFACE_LIMITS, pngBytes: one * 2 + 10 })
    expect(r.report.textured).toBeLessThan(6); expect(r.report.textured).toBeGreaterThanOrEqual(1)
    expect(r.report.ceiling).toBe(6 - r.report.textured)
    expect(r.report.notFound + r.report.notDecodable).toBe(0)
    expect(r.report.pngBytes).toBeLessThanOrEqual(one * 2 + 10)
    // the largest ground is textured; those that fell back are solid materials, so they keep an average colour
    expect(matOf(r, 'tex/p5')!.texture).not.toBeNull()
    expect(r.report.coloured).toBe(r.report.ceiling)
  })
  test('a pack member over the size of one file is skipped, as before, and counted as not decodable', async () => {
    const r = await run([{ name: 'tex/big', vtf: solid(1, 16) }, { name: 'tex/ok', vtf: solid(2) }], undefined, { ...SURFACE_LIMITS, memberBytes: 600 })
    expect(r.report.textured).toBe(1)
    expect(r.report.notFound + r.report.notDecodable).toBe(1)
  })
})

describe('the record of a built map', () => {
  const names = Array.from({ length: 5 }, (_, i) => `rfc36/t${i}`)
  const files: Record<string, Buffer | string> = {}
  names.slice(0, 4).forEach((n, i) => { files[`materials/${n}.vmt`] = vmtOf(n); files[`materials/${n}.vtf`] = solid(i + 1) })
  files[`materials/${names[4]}.vmt`] = vmtOf(names[4]!) // no texture file: not found
  const file = buildBsp({ ...flatQuads([0, 0, 0, 0, 0]), materials: names, mappings: names.map(() => ({ s: [1, 0, 0, 0], t: [0, 1, 0, 0], width: 8, height: 8 })), pak: buildZip(files) })
  const fingerprint = bspFingerprint(file.subarray(0, 1036), file.length)

  test('it counts the materials, the textured, the fallbacks by reason, the PNG bytes and the size of the GLB', async () => {
    const r = await buildGeometry(memorySource(file), 'ttt_rfc36', fingerprint)
    if (!r.ok) throw new Error(r.error)
    const t = r.info.coverage?.textures
    expect(t).toMatchObject({ materials: 5, textured: 4, notFound: 1, notDecodable: 0, ceiling: 0 })
    expect(t!.glbBytes).toBe(r.glb.length)
    expect(t!.pngBytes).toBe(r.info.surface!.pngBytes)
    expect(t!.pngBytes).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(r.info)).coverage.textures.glbBytes).toBe(r.glb.length) // it survives storage
  })
})
