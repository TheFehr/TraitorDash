import { rm } from 'node:fs/promises'
import { Store } from './Store'
import { BspError, extractMapEntities, extractSurfaces, readHeader, type ByteSource } from '../maps/bsp'
import { buildPropSet, type StockModels } from '../maps/propset'
import { nearTriangles, surfacesToGlb } from '../maps/meshGlb'
import { findParts, soupOfKinds } from '../maps/parts'
import { fileSource } from '../maps/fileSource'
export { fileSource }

/** Is the feature switched on for this backend (RFC 11, 3.1)? Off unless the operator sets MAP_GEOMETRY=1. */
export const geometryEnabled = () => process.env.MAP_GEOMETRY === '1'

/** What is stored about a mesh (and shown on the map page). `props` is what was drawn; `unavailable` models are the game's own, which the map does not carry. */
export interface GeometryInfo {
  vertices: number, triangles: number, levels: number, water: number
  /** False for a hill or terrain (no storeys); the triangles in detached parts; spawn points in the file. */
  storeys?: boolean, detached?: number, spawns?: number
  props?: { placed: number, models: number, foliage: number, cards?: number, fromGame?: number, unavailable: number, unreadable: number, dropped: number }
}

export type GeometryResult =
  | { ok: true, glb: Uint8Array, info: GeometryInfo, note?: string }
  | { ok: false, error: string }

/** The box (x and y) around some triangle soups, or null when they are all empty. */
function boxOf(...soups: number[][]): { minX: number, minY: number, maxX: number, maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of soups) for (let i = 0; i < a.length; i += 3) { minX = Math.min(minX, a[i]!); maxX = Math.max(maxX, a[i]!); minY = Math.min(minY, a[i + 1]!); maxY = Math.max(maxY, a[i + 1]!) }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/**
 * A map file to a mesh. The file must be the one the server reported: its header must hash to
 * `fingerprint` (RFC 11, 3.2). Nothing in the result carries file content except the mesh itself.
 */
export async function buildGeometry(src: ByteSource, map: string, fingerprint: string, stock?: StockModels): Promise<GeometryResult> {
  try {
    const header = await readHeader(src)
    if (header.fingerprint !== fingerprint) return { ok: false, error: 'The file is not the version of the map the server has (fingerprint differs).' }
    const { spawns, skyCameras, fixtureModels, entityProps } = await extractMapEntities(src)
    const surfaces = await extractSurfaces(src, {}, fixtureModels)
    // The parts by shared corners: the skybox goes, detached parts are kept apart (RFC 18, 4.4).
    const found = findParts([surfaces.floors, surfaces.walls], { spawns, skyCameras })
    const kind = (k: ('main' | 'detached')[]) => ({ floors: soupOfKinds(surfaces.floors, found.of[0]!, found.parts, k), walls: soupOfKinds(surfaces.walls, found.of[1]!, found.parts, k) })
    const cleaned = kind(['main'])
    const apart = kind(['detached'])
    const detached = { ...apart, parts: found.parts.filter(p => p.kind === 'detached').sort((a, b) => b.triangles - a.triangles).map(p => ({ triangles: p.triangles, min: p.min.map(Math.round), max: p.max.map(Math.round) })) }
    const water = nearTriangles(surfaces.water, [cleaned.floors, cleaned.walls], 512)
    const { set, report } = await buildPropSet(src, header, entityProps, boxOf(cleaned.floors, cleaned.walls), undefined, stock)
    const out = await surfacesToGlb({ ...surfaces, ...cleaned, water, detached, spawns, props: set }, { map })
    if (!out) return { ok: false, error: 'The map has no surfaces to draw.' }
    return { ok: true, glb: out.glb, note: report.stockError ? `The game's own models could not all be fetched: ${report.stockError}` : undefined, info: {
      vertices: out.info.vertices, triangles: out.info.triangles, levels: out.info.levels.length, water: out.info.waterTriangles, storeys: out.info.storeys, detached: out.info.detached.triangles, spawns: out.info.spawns,
      props: { placed: report.drawnPlacements, models: report.drawnModels, foliage: report.foliageModels, cards: report.cards, fromGame: report.fromGame, unavailable: report.unavailable, unreadable: report.unreadable + report.tooBig, dropped: report.dropped },
    } }
  } catch (e) {
    // BspError messages describe the file's structure, not its content; anything else is ours.
    return { ok: false, error: e instanceof BspError ? e.message : 'Reading the map failed.' }
  }
}

/** Gets the `.bsp` for a map: a file in a scratch directory (or a range inside one), and a function that removes it. */
export type Fetcher = (map: string, fingerprint: string) => Promise<{ path: string, offset?: number, length?: number, cleanup: () => Promise<void> } | { error: string }>

let running = false

/**
 * Works through the queue one map at a time, sequentially so memory and disk stay bounded. The
 * downloaded file is deleted as soon as the mesh is stored or the attempt has failed.
 * Returns how many maps it handled.
 */
export async function runGeometryQueue(fetcher: Fetcher): Promise<number> {
  if (running) return 0
  running = true
  let done = 0
  try {
    for (const job of Store.getGeometryQueue()) {
      if (!Store.startGeometry(job.map, job.fingerprint)) continue
      done++
      let got: Awaited<ReturnType<Fetcher>>
      try { got = await fetcher(job.map, job.fingerprint) } catch { got = { error: 'The download failed.' } }
      if ('error' in got) { Store.finishGeometry(job.map, job.fingerprint, { error: got.error }); continue }
      try {
        const { src, close } = await fileSource(got.path, got.offset, got.length)
        try {
          const r = await buildGeometry(src, job.map, job.fingerprint, stockModels ?? undefined)
          Store.finishGeometry(job.map, job.fingerprint, r.ok ? { mesh: r.glb, info: r.info, note: r.note } : { error: r.error })
        } finally { await close() }
      } catch {
        Store.finishGeometry(job.map, job.fingerprint, { error: 'The downloaded file could not be read.' })
      } finally {
        await got.cleanup().catch(() => rm(got.path, { force: true }).catch(() => {}))
      }
    }
  } finally { running = false }
  return done
}

let stockModels: StockModels | null = null
/** Installs the source of the game's own models (RFC 18, 4.5). Without one, they are counted, not drawn. */
export const setStockModels = (s: StockModels | null) => { stockModels = s }

let fetcher: Fetcher | null = null
/** Installs the way files are fetched (RFC 11, 3.2). Without one, requested maps stay queued. */
export const setGeometryFetcher = (f: Fetcher | null) => { fetcher = f }

/** Starts the queue in the background if a fetcher is installed and the feature is on. Never throws. */
export function kickGeometryQueue() {
  if (!geometryEnabled() || !fetcher) return
  runGeometryQueue(fetcher).catch(e => console.error('[Geometry] queue failed:', e instanceof Error ? e.message : e))
}
