import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileSource } from '../maps/fileSource'
import { readGmaIndex, type GmaEntry } from '../maps/gma'
import { staticModelGlb, type StaticPart } from '../maps/modelGlb'
import { readModel, type ModelFiles } from '../maps/model'
import type { Pak } from '../maps/pak'
import type { StockModels, StockTextures } from '../maps/propset'
import { TextureBook } from '../maps/texturebook'
import { applyPatch, parseMaterial, patchOf, type Vmt } from '../maps/vmt'
import type { ByteSource } from '../maps/bsp'
import { modelBase, texturePathName } from './gameContent'
import type { AddonFetcher } from './workshop'
import { workshopEnabled } from './workshopCollection'
import * as W from './workshopStore'

// RFC 40, 3.3: the Workshop content source. A model that something needs (an unavailable prop of a map, later a weapon of a track) is found in
// the index, its addon fetched again, and only the model's files and the materials and textures they name are copied into the content cache;
// the model is built from them as a GLB. Nothing here runs when WORKSHOP_COLLECTION is not set.

/** Where the cache is: WORKSHOP_CONTENT_DIR, else `.workshop-content` in the working directory (the server's own volume). */
export const workshopContentRoot = () => process.env.WORKSHOP_CONTENT_DIR || join(process.cwd(), '.workshop-content')

/** One file of an addon, unpacked, at most this many bytes (a safety ceiling: the biggest model files are a few MB). */
export const MAX_MEMBER_BYTES = 64 * 1024 * 1024
/** How many addons one model build may fetch (its own and the ones that hold its materials), a safety ceiling. */
export const MAX_ADDONS_PER_MODEL = 24
/** How many materials one model build looks for. */
export const MAX_MATERIALS_PER_MODEL = 400

const key = (s: string) => createHash('sha1').update(s).digest('hex')
const modelFile = (root: string, base: string, ext: string) => join(root, 'models', `${key(base)}.${ext}`)
const textureFile = (root: string, path: string) => join(root, 'textures', `${key(path)}.${path.slice(-3)}`)
export const glbFile = (root: string, base: string) => join(root, 'glb', `${key(base)}.glb`)

async function put(file: string, bytes: Uint8Array) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file + '.tmp', bytes)
  await rename(file + '.tmp', file)
}
const get = async (file: string): Promise<Uint8Array | null> => { try { return new Uint8Array(await readFile(file)) } catch { return null } }

// What the cache holds, as the sources of the pipeline

/** The files of the models the cache holds (nothing is fetched here: a model that is not built yet is "unavailable" until it is). */
async function cachedModel(root: string, base: string): Promise<ModelFiles | null> {
  const [mdl, vvd, vtx] = await Promise.all([get(modelFile(root, base, 'mdl')), get(modelFile(root, base, 'vvd')), get(modelFile(root, base, 'vtx'))])
  return mdl && vvd && vtx ? { mdl, vvd, vtx } : null
}

/** Queues what the pipeline could not find, when the index holds it (or may yet). */
function queueUnavailable(names: string[]) {
  if (!workshopEnabled()) return
  for (const name of names) {
    const base = modelBase(name)
    if (!base) continue
    if (W.holders(`${base}.mdl`).length > 0 || W.indexIncomplete()) queueModelBuild(name)
  }
}

/**
 * The Workshop source of the model pipeline (`StockModels` and `StockTextures`): the models and materials already built into the cache. A name it does not
 * have is queued for a build when the index knows an addon that holds it (the map-mesh trigger of RFC 40, 3.3), and the map draws without it until
 * the next time its mesh is built.
 */
export function workshopContent(root = workshopContentRoot()): { models: StockModels, textures: StockTextures, root: string } {
  const models: StockModels = async names => {
    const out = new Map<string, ModelFiles>()
    const missing: string[] = []
    for (const name of names) {
      const base = modelBase(name)
      const files = base ? await cachedModel(root, base) : null
      if (files) out.set(name, files); else missing.push(name)
    }
    queueUnavailable(missing)
    return { models: out }
  }
  const textures: StockTextures = async paths => {
    const files = new Map<string, Uint8Array>()
    for (const asked of paths) {
      const p = texturePathName(asked)
      const bytes = p ? await get(textureFile(root, p)) : null
      if (bytes) files.set(asked, bytes)
    }
    return { files }
  }
  return { models, textures, root }
}

/** The sources in order: the first that has a name answers for it; the next are asked only for the names the one before did not have. */
export function chainModels(...sources: (StockModels | null | undefined)[]): StockModels {
  const list = sources.filter((s): s is StockModels => !!s)
  return async names => {
    const out = new Map<string, ModelFiles>()
    let error: string | undefined
    let rest = names
    for (const s of list) {
      if (rest.length === 0) break
      const r = await s(rest)
      for (const [n, f] of r.models) out.set(n, f)
      error ??= r.error
      rest = rest.filter(n => !out.has(n))
    }
    return { models: out, error }
  }
}
export function chainTextures(...sources: (StockTextures | null | undefined)[]): StockTextures {
  const list = sources.filter((s): s is StockTextures => !!s)
  return async paths => {
    const files = new Map<string, Uint8Array>()
    let error: string | undefined
    let rest = paths
    for (const s of list) {
      if (rest.length === 0) break
      const r = await s(rest)
      for (const [n, f] of r.files) files.set(n, f)
      error ??= r.error
      rest = rest.filter(n => !files.has(n))
    }
    return { files, error }
  }
}

// The triggers

let kick: (() => void) | null = null
/** Installed at start: what starts the queue when a model has been queued. */
export const setWorkshopKick = (f: (() => void) | null) => { kick = f }

/**
 * Asks for the model of a path to be built in the background. False (nothing queued) when the feature is off, the path is not a model path, or the
 * model is already built, queued or being built. Safe to call with anything.
 */
export function queueModelBuild(path: string): boolean {
  if (!workshopEnabled()) return false
  const base = modelBase(path)
  if (!base) return false
  const queued = W.queueModel(`${base}.mdl`)
  if (queued) kick?.()
  return queued
}

/**
 * RFC 39 calls this with the weapon model paths a recorded track names (`wm`), to queue the builds it needs. Deduplicated, and nothing when the
 * feature is off. (RFC 39 is not built yet: nothing calls it.)
 */
export function queueTrackModels(paths: Iterable<string>): number {
  let n = 0
  for (const p of paths) if (queueModelBuild(p)) n++
  return n
}

/** The built GLB of a model path, or null when it is not built (the placeholder is drawn until it is). */
export async function workshopModelGlb(path: string, root = workshopContentRoot()): Promise<Uint8Array | null> {
  const base = modelBase(path)
  return base ? get(glbFile(root, base)) : null
}

// Reading an addon

interface OpenAddon { files: Map<string, { src: ByteSource, entry: GmaEntry }>, close: () => Promise<void> }
export class BuildError extends Error {}

/** The archives of an addon, opened; the table's names as the index knows them. `close` closes the files and deletes the download. */
async function openAddon(id: string, fetcher: AddonFetcher): Promise<OpenAddon> {
  const got = await fetcher(id)
  if ('error' in got) throw new BuildError(`Addon ${id}: ${got.error}`)
  const closers: (() => Promise<void>)[] = []
  const files = new Map<string, { src: ByteSource, entry: GmaEntry }>()
  const close = async () => { for (const c of closers) await c().catch(() => {}); await got.cleanup().catch(() => {}) }
  try {
    for (const path of got.paths) {
      const { src, close: c } = await fileSource(path)
      closers.push(c)
      for (const entry of await readGmaIndex(src, { maxTableBytes: 64 * 1024 * 1024, maxFiles: 1_000_000 })) {
        const name = W.cleanPath(entry.name) // a name that is not a safe path is not reachable at all
        if (name && !files.has(name)) files.set(name, { src, entry })
      }
    }
  } catch (e) {
    await close()
    throw e instanceof BuildError ? e : new BuildError(`Addon ${id} could not be read.`)
  }
  return { files, close }
}

/** The bytes of one file of an open addon, or null when it has none by that exact name. Refuses a member over `max`. */
async function extract(a: OpenAddon, path: string, max: number): Promise<Uint8Array | null> {
  const safe = W.cleanPath(path)
  const f = safe ? a.files.get(safe) : undefined
  if (!f) return null
  if (f.entry.size > max) throw new BuildError(`${path} is larger than the limit (${f.entry.size} bytes).`)
  const bytes = await f.src.read(f.entry.offset, f.entry.size)
  if (bytes.length !== f.entry.size) throw new BuildError(`${path} is cut off in the archive.`)
  return bytes
}

export interface ContentDeps {
  fetcher: AddonFetcher
  root?: string
  /** The game's own materials and textures, for what the addons do not hold (the pipeline's stock source). */
  stock?: StockTextures
  /** The game's own models: asked for a model that no indexed addon holds, so that a stock weapon (the Counter-Strike and Half-Life ones) is built the same way (RFC 39, 3.4). */
  stockModels?: StockModels
  /** Default `MAX_MEMBER_BYTES`. */
  maxMemberBytes?: number
}

const VTX = ['dx90.vtx', 'dx80.vtx'] as const

/** What a build learned, for the log and the tests. */
export interface BuildReport { addons: number, materials: number, textures: number, fromStock: number, missing: number, triangles: number, bytes: number, note: string | null }

/**
 * Builds the model of a path: finds it in the index, fetches the addon that holds it, copies its `.mdl`, `.vvd` and `.vtx` and the materials and textures
 * it names (from that addon, from other addons of the index, or the game's own through `stock`) into the cache, and writes the GLB. The outcome is
 * recorded on the model's row: `built`, `unknown` (no indexed addon holds it: the index may not be complete), or `failed` with the reason. Throws nothing.
 */
export async function buildModel(path: string, d: ContentDeps): Promise<BuildReport | null> {
  const base = modelBase(path)
  const row = base ? `${base}.mdl` : path
  if (!base) { W.setModel(row, 'failed', { error: 'Not a model path.' }); return null }
  W.setModel(row, 'building')
  try {
    const r = await buildInner(base, d)
    if (r === 'unknown') { W.setModel(row, 'unknown', { error: 'No indexed addon holds this model yet.' }); return null }
    W.setModel(row, 'built', { addon: r.addon, bytes: r.report.bytes })
    return r.report
  } catch (e) {
    W.setModel(row, 'failed', { error: e instanceof Error && e.message ? e.message : 'The model could not be built.' })
    return null
  }
}

async function buildInner(base: string, d: ContentDeps): Promise<'unknown' | { addon: string, report: BuildReport }> {
  const root = d.root ?? workshopContentRoot()
  const max = d.maxMemberBytes ?? MAX_MEMBER_BYTES
  const report: BuildReport = { addons: 0, materials: 0, textures: 0, fromStock: 0, missing: 0, triangles: 0, bytes: 0, note: null }

  // 1. The addon that holds all of the model's files.
  const holders = W.holders(`${base}.mdl`)
  let holder: string | null = null
  let stockFiles: ModelFiles | null = null
  if (holders.length === 0) {
    // no addon of the index holds it: the game's own content may (a stock weapon, RFC 39, 3.4)
    const got = d.stockModels ? await d.stockModels([`${base}.mdl`]).catch(() => null) : null
    stockFiles = got?.models.get(`${base}.mdl`) ?? null
    if (!stockFiles) return 'unknown'
  } else {
    holder = holders.find(h => { const have = W.heldBy(h, [`${base}.vvd`, ...VTX.map(e => `${base}.${e}`)]); return have.has(`${base}.vvd`) && VTX.some(e => have.has(`${base}.${e}`)) }) ?? null
    if (!holder) throw new BuildError('The addon that holds the model lacks its vertex or triangle file.')
  }

  const wantedVmts: string[][] = []
  const found = new Map<string, Uint8Array>() // materials/... path -> bytes, what the model's materials came to
  const stockFound = new Map<string, Uint8Array>()
  let files: ModelFiles
  const own = holder ? await openAddon(holder, d.fetcher) : null
  if (own) report.addons++
  try {
    if (stockFiles) files = stockFiles
    else {
      const mdl = await extract(own!, `${base}.mdl`, max), vvd = await extract(own!, `${base}.vvd`, max)
      let vtx: Uint8Array | null = null
      for (const e of VTX) { vtx = await extract(own!, `${base}.${e}`, max); if (vtx) break }
      if (!mdl || !vvd || !vtx) throw new BuildError('The addon\'s archive lacks one of the model\'s files.')
      files = { mdl, vvd, vtx }
    }
    // The materials the model names: for each mesh the places its `.vmt` could be at.
    const mesh = readModel(files, paths => { wantedVmts.push(paths.slice(0, 16)); return false }, 5_000_000)
    if (!mesh) throw new BuildError('The model files could not be read (damaged, or too large).')
    await put(modelFile(root, base, 'mdl'), files.mdl); await put(modelFile(root, base, 'vvd'), files.vvd); await put(modelFile(root, base, 'vtx'), files.vtx)

    // 2. The materials and textures, round by round: the `.vmt` files, then the textures they name and the material a patch includes.
    const wanted = new Set<string>()
    const plan = new Map<string, Set<string>>() // another addon -> the paths to take from it
    const gather = async (paths: string[]) => {
      for (const raw of paths) {
        const p = texturePathName(raw)
        if (!p || wanted.has(p) || found.has(p)) continue
        wanted.add(p)
        if (wanted.size > MAX_MATERIALS_PER_MODEL * 3) { report.note = `More than ${MAX_MATERIALS_PER_MODEL * 3} material files named: the rest were left out (a safety ceiling).`; return }
        const cached = await get(textureFile(root, p))
        if (cached) { found.set(p, cached); continue }
        const mine = own ? await extract(own, p, max) : null
        if (mine) { found.set(p, mine); await put(textureFile(root, p), mine); continue }
        const other = W.holders(p).find(h => h !== holder)
        if (other) { const s = plan.get(other) ?? new Set<string>(); s.add(p); plan.set(other, s) }
      }
      for (const [addon, set] of plan) {
        if (report.addons >= MAX_ADDONS_PER_MODEL) { report.note ??= `Materials are spread over more than ${MAX_ADDONS_PER_MODEL} addons: the rest were left out (a safety ceiling).`; plan.clear(); break }
        const other = await openAddon(addon, d.fetcher).catch(e => { report.note ??= e instanceof Error ? e.message : 'An addon could not be fetched.'; return null })
        plan.delete(addon)
        if (!other) continue
        report.addons++
        try {
          for (const p of set) {
            const b = await extract(other, p, max).catch(() => null)
            if (!b) continue
            found.set(p, b); await put(textureFile(root, p), b)
            // The texture a material names is most likely in the same addon: taken now, so that the addon is fetched once.
            if (p.endsWith('.vmt')) {
              const v = parseMaterial(Buffer.from(b).toString('latin1'))
              for (const t of [v.texture, v.texture2]) {
                const vp = t ? texturePathName(`materials/${t}.vtf`) : null
                if (!vp || found.has(vp)) continue
                const tb = await extract(other, vp, max).catch(() => null)
                if (tb) { found.set(vp, tb); await put(textureFile(root, vp), tb) }
              }
            }
          }
        } finally { await other.close() }
      }
      // What the addons do not hold: the game's own, in one request.
      const absent = paths.map(texturePathName).filter((p): p is string => !!p && !found.has(p) && !stockFound.has(p))
      if (absent.length && d.stock) {
        const got = await d.stock([...new Set(absent)].slice(0, MAX_MATERIALS_PER_MODEL * 3)).catch(() => ({ files: new Map<string, Uint8Array>() }))
        for (const [p, b] of got.files) { const t = texturePathName(p); if (t) stockFound.set(t, b) }
      }
    }
    const vmtOf = (p: string) => found.get(p) ?? stockFound.get(p)
    await gather(wantedVmts.flat().slice(0, MAX_MATERIALS_PER_MODEL * 3))
    for (let round = 0; round < 3; round++) {
      const next: string[] = []
      for (const group of wantedVmts) for (const p of group) {
        const bytes = vmtOf(p)
        if (!bytes) continue
        const text = Buffer.from(bytes).toString('latin1')
        const inc = patchOf(text)
        if (inc) next.push(inc, ...(() => { const b = vmtOf(inc); if (!b) return []; const v = parseMaterial(applyPatch(Buffer.from(b).toString('latin1'), text)); return [v.texture, v.texture2].filter(Boolean).map(t => `materials/${t}.vtf`) })())
        else { const v = parseMaterial(text); for (const t of [v.texture, v.texture2]) if (t) next.push(`materials/${t}.vtf`) }
        break // the first of a mesh's candidate places that exists is the material
      }
      const fresh = next.filter(p => { const t = texturePathName(p); return t && !found.has(t) && !stockFound.has(t) && !wanted.has(t) })
      if (fresh.length === 0) break
      await gather(fresh)
    }
  } finally { await own?.close() }

  // 3. The GLB.
  const glb = await modelGlbOf(base, files, found, stockFound, report)
  await put(glbFile(root, base), glb)
  report.bytes = glb.length + files.mdl.length + files.vvd.length + files.vtx.length + [...found.values()].reduce((n, b) => n + b.length, 0)
  return { addon: holder ?? 'game', report }
}

/** The GLB of a model: its triangles, a run for each material, the textures embedded; a material that has no texture is a plain colour (RFC 36's fallback). */
async function modelGlbOf(name: string, files: ModelFiles, found: Map<string, Uint8Array>, stock: Map<string, Uint8Array>, report: BuildReport): Promise<Uint8Array> {
  const bytesOf = (p: string) => found.get(p) ?? stock.get(p)
  const material = (paths: string[]): Vmt | null => {
    const p = paths.find(x => bytesOf(x))
    if (!p) return null
    const text = Buffer.from(bytesOf(p)!).toString('latin1')
    const inc = patchOf(text)
    const included = inc ? bytesOf(inc) : null
    return parseMaterial(included ? applyPatch(Buffer.from(included).toString('latin1'), text) : text)
  }
  const mesh = readModel(files, paths => { const v = material(paths); return v !== null && v.kind !== 'solid' }, 5_000_000)
  if (!mesh) throw new BuildError('The model files could not be read.')
  report.triangles = (mesh.solid.length + mesh.foliage.length) / 9

  const pak: Pak = { entries: new Map(), lump: { offset: 0, length: 0, version: 0, ident: 0 } as never, read: 0 }
  const book = new TextureBook({ size: 0, read: async () => new Uint8Array(0) }, pak, { side: 256, pngBytes: 256 * 1024 * 1024, memberBytes: 24 * 1024 * 1024 })
  for (const [p, b] of [...stock, ...found]) if (p.endsWith('.vtf')) book.stock.set(p, b)
  const parts: StaticPart[] = []
  const seen = new Set<string>()
  const addRuns = async (positions: number[], uvs: number[], runs: { paths: string[], triangles: number }[]) => {
    let at = 0
    for (const run of runs) {
      const n = run.triangles * 9
      const vmt = material(run.paths)
      if (run.paths.some(p => bytesOf(p))) seen.add(run.paths.find(p => bytesOf(p))!)
      let png: Uint8Array | null = null
      let colour: [number, number, number] = [0.6, 0.6, 0.6]
      let key = 'plain'
      if (vmt?.texture) {
        const tex = await book.texture(vmt.texture, vmt.additive, 256)
        if (tex) { png = book.textures[tex.index]!.png; key = `t:${vmt.texture}:${vmt.kind}:${vmt.additive}` ; report.textures = Math.max(report.textures, book.textures.length) }
        else { colour = (await book.average(vmt.texture)) ?? colour; key = `c:${vmt.texture}` }
      }
      if (!vmt || key === 'plain') report.missing++
      const mode = vmt?.kind === 'mask' ? 'mask' : vmt?.kind === 'blend' ? 'blend' : 'opaque'
      const alpha = vmt && vmt.kind === 'blend' && !vmt.explicitAlpha && png ? 0.4 : (vmt?.alpha ?? 1)
      parts.push({
        positions: positions.slice(at, at + n),
        uvs: uvs.length === (positions.length / 3) * 2 ? uvs.slice((at / 3) * 2, ((at + n) / 3) * 2) : null,
        material: { png, colour, mode, alpha, key: `${key}:${mode}:${alpha}` },
      })
      at += n
    }
  }
  await addRuns(mesh.solid, mesh.solidUv, mesh.solidRuns)
  await addRuns(mesh.foliage, mesh.foliageUv, mesh.foliageRuns)
  report.materials = seen.size
  report.fromStock = [...seen].filter(p => stock.has(p) && !found.has(p)).length
  if (parts.length === 0) throw new BuildError('The model has no triangles to draw.')
  return staticModelGlb(parts, name)
}
