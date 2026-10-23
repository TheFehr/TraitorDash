import type { BspHeader, ByteSource, Placement } from './bsp'
import type { PropSet } from './meshGlb'
import { readModel } from './model'
import { readPak, readPakMember, type Pak } from './pak'
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
  /** Distinct models that have cards (flat sheets that need their texture, see `CARD_TRIANGLE_AREA`), which are left out; a model of nothing else is not drawn at all. */
  cards: number
  /** Distinct models that are not in the pack (the game's own: not drawn), unreadable, or over the triangle limit. */
  unavailable: number
  unreadable: number
  tooBig: number
  /** Places left out because a limit was reached. */
  dropped: number
  skippedRecords: number
}

const FOLIAGE = /["']?\$(alphatest|translucent)["']?\s+["']?1/i

/** What the pack of a map holds for a model, and the answer to "is this material foliage" for the materials it names. */
async function loadModel(src: ByteSource, pak: Pak, name: string, foliageCache: Map<string, boolean>, maxTriangles: number): Promise<'unavailable' | 'unreadable' | 'big' | { solid: number[], foliage: number[], cards: number }> {
  const base = name.replace(/\.mdl$/, '')
  const [mdl, vvd, vtx] = await Promise.all([
    readPakMember(src, pak, `${base}.mdl`),
    readPakMember(src, pak, `${base}.vvd`),
    readPakMember(src, pak, `${base}.dx90.vtx`).then(b => b ?? readPakMember(src, pak, `${base}.dx80.vtx`)),
  ])
  if (!mdl) return 'unavailable'
  if (!vvd || !vtx) return 'unavailable'
  const files = { mdl, vvd, vtx }
  // First ask which materials the model names, read those that are in the pack, then ask again with the answers.
  const wanted = new Set<string>()
  if (!readModel(files, paths => { for (const p of paths) wanted.add(p); return false }, maxTriangles)) {
    return readModel(files, () => false, Infinity) ? 'big' : 'unreadable'
  }
  for (const path of wanted) {
    if (foliageCache.has(path) || !pak.entries.has(path)) continue
    const text = await readPakMember(src, pak, path, { maxMemberBytes: 64 * 1024 })
    foliageCache.set(path, text ? FOLIAGE.test(Buffer.from(text).toString('latin1')) : false)
  }
  return readModel(files, paths => paths.some(p => foliageCache.get(p) === true), maxTriangles) ?? 'unreadable'
}

/**
 * The props of a map that are near its geometry: static props from the game lump and entity props from the entity lump,
 * their models read from the pack. `around` is a box (min x, y, max x, y) of the map's floors and walls.
 */
export async function buildPropSet(
  src: ByteSource, header: BspHeader, entityProps: Placement[], around: { minX: number, minY: number, maxX: number, maxY: number } | null,
  limits: PropLimits = PROP_LIMITS,
): Promise<{ set: PropSet, report: PropReport }> {
  const statics = await readStaticProps(src, header)
  const all = [...statics.placements, ...entityProps]
  const m = limits.nearMargin
  const near = around ? all.filter(p => p.x >= around.minX - m && p.x <= around.maxX + m && p.y >= around.minY - m && p.y <= around.maxY + m) : []
  const report: PropReport = { found: all.length, near: near.length, drawnModels: 0, drawnPlacements: 0, triangles: 0, foliageModels: 0, cards: 0, unavailable: 0, unreadable: 0, tooBig: 0, dropped: 0, skippedRecords: statics.skipped }
  const set: PropSet = { models: [], placements: [] }
  if (near.length === 0) return { set, report }

  const pak = await readPak(src, header.lumps[40]!)
  const foliageCache = new Map<string, boolean>()
  const loaded = new Map<string, { solid: number[], foliage: number[], triangles: number } | null>()
  const names = [...new Set(near.map(p => p.model))]
  for (const name of names) {
    const r = await loadModel(src, pak, name, foliageCache, limits.maxModelTriangles)
    if (r === 'unavailable') { report.unavailable++; loaded.set(name, null) }
    else if (r === 'unreadable') { report.unreadable++; loaded.set(name, null) }
    else if (r === 'big') { report.tooBig++; loaded.set(name, null) }
    else {
      if (r.cards > 0) report.cards++
      // A model that is nothing but cards has nothing to draw.
      loaded.set(name, r.solid.length + r.foliage.length === 0 ? null : { solid: r.solid, foliage: r.foliage, triangles: (r.solid.length + r.foliage.length) / 9 })
    }
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
    if (isNew) { index.set(p.model, set.models.length); set.models.push({ name: p.model, solid: model.solid, foliage: model.foliage }) }
    set.placements.push({ model: index.get(p.model)!, x: p.x, y: p.y, z: p.z, pitch: p.pitch, yaw: p.yaw, roll: p.roll })
    triangles += model.triangles
  }
  report.drawnModels = set.models.length
  report.foliageModels = set.models.filter(m => m.foliage.length > 0).length
  report.drawnPlacements = set.placements.length
  report.triangles = triangles
  return { set, report }
}
