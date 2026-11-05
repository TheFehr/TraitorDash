import type { BspHeader, ByteSource, Placement } from './bsp'
import type { PropSet } from './meshGlb'
import { readModel, type ModelFiles, type ModelMesh } from './model'
import { readPak, readPakMember, type Pak } from './pak'
import { readVtf } from './vtf'
import { encodePng } from './png'
import { readStaticProps } from './props'

// RFC 18, 4.3 and 7: the props of a map, ready to be written into the mesh. The models come from the map's own pack;
// a model that is not there (the game's own content) is counted, not drawn. The limits are in the open so that tests
// can pin them; over a limit, the largest models go first and the result says how many went.

export interface PropLimits {
  /** Places drawn. */
  maxPlacements: number
  /** Distinct models. */
  maxModels: number
  /** One model's triangles. */
  maxModelTriangles: number
  /** The triangles drawn, counting every place of a model. */
  maxTriangles: number
  /** How far outside the map's own geometry (units) a prop may stand and still be drawn: a 3D skybox has props of its own, far away. */
  nearMargin: number
}
export const PROP_LIMITS: PropLimits = { maxPlacements: 4000, maxModels: 2000, maxModelTriangles: 50_000, maxTriangles: 600_000, nearMargin: 2048 }

export interface PropReport {
  /** Places in the map's lumps, and the ones that were near the map. */
  found: number
  near: number
  /** Distinct models of the near places that are in the map's pack and could be read. */
  drawnModels: number
  drawnPlacements: number
  triangles: number
  /** Distinct drawn models that have foliage in them. */
  foliageModels: number
  /** Textures written for the leaves, and the materials that are drawn with one (the others are grey). */
  leafTextures: number
  leafMaterials: number
  /** Triangles of leaves that have no texture to be cut out with (the texture is not in the map's pack): they are not drawn. */
  leavesWithoutTexture: number
  /** Distinct models that have cards (flat sheets that need their texture, see `CARD_TRIANGLE_AREA`), which are left out; a model of nothing else is not drawn at all. */
  cards: number
  /** Distinct drawn models that came from the game's own content (RFC 18, 4.5), not from the map. */
  fromGame: number
  /** Distinct models that are in neither the pack nor the game content given (not drawn), unreadable, or over the triangle limit. */
  unavailable: number
  unreadable: number
  tooBig: number
  /** Places left out because a limit was reached. */
  dropped: number
  skippedRecords: number
  /** Why the game's own models could not all be fetched, when that is so. */
  stockError?: string
}

const FOLIAGE = /["']?\$(alphatest|translucent)["']?\s+["']?1/i
const ALPHATEST = /["']?\$alphatest["']?\s+["']?1/i
const BASETEXTURE = /["']?\$basetexture["']?\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'{}]+))/i
const ALPHA = /["']?\$alpha["']?\s+["']?([0-9.]+)/i

/** What a foliage material (a `.vmt`) says that is needed to draw its leaves: the texture, whether it is cut out or translucent, and how much. */
interface Vmt { texture: string | null, mode: 'mask' | 'blend', alpha: number }
/** null for a material that is not foliage. */
export function parseVmt(text: string): Vmt | null {
  if (!FOLIAGE.test(text)) return null
  const found = BASETEXTURE.exec(text)
  const texture = (found?.[1] ?? found?.[2] ?? found?.[3])?.trim().toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '') ?? null
  const alpha = Number(ALPHA.exec(text)?.[1])
  return { texture: texture && /^[a-z0-9_ ./-]{1,200}$/.test(texture) && !texture.includes('..') ? texture : null, mode: ALPHATEST.test(text) ? 'mask' : 'blend', alpha: Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? alpha : 1 }
}

/** The textures of the leaves: how many, how big (the longer side) and how many bytes of PNG a map may have (RFC 18, 7). */
export const LEAF_LIMITS = { textures: 24, side: 256, pngBytes: 4 * 1024 * 1024, memberBytes: 24 * 1024 * 1024 }

/**
 * The game's own models (RFC 18, 4.5): the files of the models it has, by model name; names it does not have are left out.
 * `error` says why some could not be fetched (a download failed); the models that were fetched are in the answer anyway.
 */
export type StockModels = (names: string[]) => Promise<{ models: Map<string, ModelFiles>, error?: string }>

/** The three files of a model in the map's pack, or null when they are not all there. */
async function packFiles(src: ByteSource, pak: Pak, name: string): Promise<ModelFiles | null> {
  const base = name.replace(/\.mdl$/, '')
  const [mdl, vvd, vtx] = await Promise.all([
    readPakMember(src, pak, `${base}.mdl`),
    readPakMember(src, pak, `${base}.vvd`),
    readPakMember(src, pak, `${base}.dx90.vtx`).then(b => b ?? readPakMember(src, pak, `${base}.dx80.vtx`)),
  ])
  return mdl && vvd && vtx ? { mdl, vvd, vtx } : null
}

/** The mesh of a model from its files, and the answer to "is this material foliage" for the materials it names (those in the pack; the game's own count as solid). */
async function loadModel(src: ByteSource, pak: Pak, files: ModelFiles, foliageCache: Map<string, Vmt | null>, maxTriangles: number): Promise<'unreadable' | 'big' | ModelMesh> {
  // First ask which materials the model names, read those that are in the pack, then ask again with the answers.
  const wanted = new Set<string>()
  if (!readModel(files, paths => { for (const p of paths) wanted.add(p); return false }, maxTriangles)) {
    return readModel(files, () => false, Infinity) ? 'big' : 'unreadable'
  }
  for (const path of wanted) {
    if (foliageCache.has(path) || !pak.entries.has(path)) continue
    const text = await readPakMember(src, pak, path, { maxMemberBytes: 64 * 1024 })
    foliageCache.set(path, text ? parseVmt(Buffer.from(text).toString('latin1')) : null)
  }
  return readModel(files, paths => paths.some(p => foliageCache.get(p) != null), maxTriangles) ?? 'unreadable'
}

/**
 * The leaves of the plants (RFC 18, 4.6): the texture of each foliage material is read from the pack, as pixels at a small size with the alpha
 * that cuts the leaves out, and kept as a PNG; each is read once for the whole map. A material whose texture is not in the pack (a stock one),
 * cannot be read, or is over the limits is left without one and its triangles are drawn grey as before.
 */
class LeafBook {
  materials: NonNullable<PropSet['leafMaterials']> = []
  textures: NonNullable<PropSet['leafTextures']> = []
  private material = new Map<string, number>()
  private texture = new Map<string, number | null>()
  private bytes = 0
  constructor(private src: ByteSource, private pak: Pak, private cache: Map<string, Vmt | null>) {}

  private async textureOf(name: string): Promise<number | null> {
    if (this.texture.has(name)) return this.texture.get(name)!
    let index: number | null = null
    const path = `materials/${name}.vtf`
    if (this.textures.length < LEAF_LIMITS.textures && this.pak.entries.has(path)) {
      const file = await readPakMember(this.src, this.pak, path, { maxMemberBytes: LEAF_LIMITS.memberBytes })
      const pixels = file ? readVtf(file, LEAF_LIMITS.side) : null
      if (pixels) {
        const png = encodePng(pixels.width, pixels.height, pixels.rgba)
        if (this.bytes + png.length <= LEAF_LIMITS.pngBytes) {
          this.bytes += png.length
          index = this.textures.length
          this.textures.push({ name, width: pixels.width, height: pixels.height, png })
        }
      }
    }
    this.texture.set(name, index)
    return index
  }

  /** The index of the material of a `.vmt` among `materials`, or -1 when its leaves have no texture to be drawn with. */
  private async materialOf(vmtPath: string): Promise<number> {
    const known = this.material.get(vmtPath)
    if (known !== undefined) return known
    const vmt = this.cache.get(vmtPath)
    const texture = vmt?.texture ? await this.textureOf(vmt.texture) : null
    let index = -1
    if (vmt && texture !== null) { index = this.materials.length; this.materials.push({ name: vmtPath, texture, mode: vmt.mode, alpha: vmt.alpha }) }
    this.material.set(vmtPath, index)
    return index
  }

  /** The runs of a model with a material of this book for each (-1: none). */
  async resolve(runs: { paths: string[], triangles: number }[]): Promise<{ material: number, triangles: number }[]> {
    const out: { material: number, triangles: number }[] = []
    for (const r of runs) {
      const vmt = r.paths.find(p => this.cache.get(p) != null)
      out.push({ material: vmt ? await this.materialOf(vmt) : -1, triangles: r.triangles })
    }
    return out
  }
}

/**
 * The props of a map that are near its geometry: static props from the game lump and entity props from the entity lump,
 * their models read from the pack. `around` is a box (min x, y, max x, y) of the map's floors and walls.
 */
export async function buildPropSet(
  src: ByteSource, header: BspHeader, entityProps: Placement[], around: { minX: number, minY: number, maxX: number, maxY: number } | null,
  limits: PropLimits = PROP_LIMITS, stock?: StockModels,
): Promise<{ set: PropSet, report: PropReport }> {
  const statics = await readStaticProps(src, header)
  const all = [...statics.placements, ...entityProps]
  const m = limits.nearMargin
  const near = around ? all.filter(p => p.x >= around.minX - m && p.x <= around.maxX + m && p.y >= around.minY - m && p.y <= around.maxY + m) : []
  const report: PropReport = { found: all.length, near: near.length, drawnModels: 0, drawnPlacements: 0, fromGame: 0, triangles: 0, foliageModels: 0, leafTextures: 0, leafMaterials: 0, leavesWithoutTexture: 0, cards: 0, unavailable: 0, unreadable: 0, tooBig: 0, dropped: 0, skippedRecords: statics.skipped }
  const set: PropSet = { models: [], placements: [] }
  if (near.length === 0) return { set, report }

  const pak = await readPak(src, header.lumps[40]!)
  const foliageCache = new Map<string, Vmt | null>()
  const leaves = new LeafBook(src, pak, foliageCache)
  const loaded = new Map<string, { solid: number[], foliage: number[], foliageUv: number[], runs: { paths: string[], triangles: number }[], triangles: number } | null>()
  const names = [...new Set(near.map(p => p.model))]
  const fromGame = new Set<string>()
  const settle = (name: string, r: Awaited<ReturnType<typeof loadModel>> | 'unavailable') => {
    if (r === 'unavailable') { report.unavailable++; loaded.set(name, null) }
    else if (r === 'unreadable') { report.unreadable++; loaded.set(name, null) }
    else if (r === 'big') { report.tooBig++; loaded.set(name, null) }
    else {
      if (r.cards > 0) report.cards++
      // A model that is nothing but cards has nothing to draw.
      loaded.set(name, r.solid.length + r.foliage.length === 0 ? null : { solid: r.solid, foliage: r.foliage, foliageUv: r.foliageUv, runs: r.foliageRuns, triangles: (r.solid.length + r.foliage.length) / 9 })
    }
  }
  const missing: string[] = []
  for (const name of names) {
    const files = await packFiles(src, pak, name)
    if (files) settle(name, await loadModel(src, pak, files, foliageCache, limits.maxModelTriangles))
    else missing.push(name)
  }
  const answer = stock && missing.length ? await stock(missing) : { models: new Map<string, ModelFiles>() }
  const game = answer.models
  if ('error' in answer && answer.error) report.stockError = answer.error
  for (const name of missing) {
    const files = game.get(name)
    if (!files) { settle(name, 'unavailable'); continue }
    fromGame.add(name)
    settle(name, await loadModel(src, pak, files, foliageCache, limits.maxModelTriangles))
  }

  // Over a limit, the biggest models go first: the places are sorted by the triangles of their model, and the list is cut.
  const usable = near.filter(p => loaded.get(p.model))
  usable.sort((a, b) => loaded.get(a.model)!.triangles - loaded.get(b.model)!.triangles)
  const index = new Map<string, number>()
  let triangles = 0
  for (const p of usable) {
    const model = loaded.get(p.model)!
    const isNew = !index.has(p.model)
    if (set.placements.length >= limits.maxPlacements || triangles + model.triangles > limits.maxTriangles || (isNew && index.size >= limits.maxModels)) { report.dropped++; continue }
    if (isNew) {
      index.set(p.model, set.models.length)
      const runs = await leaves.resolve(model.runs)
      for (const r of runs) if (r.material < 0) report.leavesWithoutTexture += r.triangles
      set.models.push({ name: p.model, solid: model.solid, foliage: model.foliage, foliageUv: model.foliageUv, foliageRuns: runs })
    }
    set.placements.push({ model: index.get(p.model)!, x: p.x, y: p.y, z: p.z, pitch: p.pitch, yaw: p.yaw, roll: p.roll })
    triangles += model.triangles
  }
  report.drawnModels = set.models.length
  report.fromGame = set.models.filter(m => fromGame.has(m.name)).length
  report.foliageModels = set.models.filter(m => m.foliage.length > 0).length
  set.leafMaterials = leaves.materials // (also none: then the leaves are left out, not drawn grey)
  set.leafTextures = leaves.textures
  report.leafTextures = leaves.textures.length
  report.leafMaterials = leaves.materials.length
  report.drawnPlacements = set.placements.length
  report.triangles = triangles
  return { set, report }
}
