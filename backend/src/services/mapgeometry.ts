import { rm } from 'node:fs/promises'
import { Store } from './Store'
import { BspError, extractMapEntities, extractSurfaces, readHeader, type ByteSource } from '../maps/bsp'
import { removeSkybox, surfacesToGlb } from '../maps/meshGlb'
import { fileSource } from '../maps/fileSource'
export { fileSource }

/** Is the feature switched on for this backend (RFC 11, 3.1)? Off unless the operator sets MAP_GEOMETRY=1. */
export const geometryEnabled = () => process.env.MAP_GEOMETRY === '1'

export type GeometryResult =
  | { ok: true, glb: Uint8Array, info: { vertices: number, triangles: number, levels: number } }
  | { ok: false, error: string }

/**
 * A map file to a mesh. The file must be the one the server reported: its header must hash to
 * `fingerprint` (RFC 11, 3.2). Nothing in the result carries file content except the mesh itself.
 */
export async function buildGeometry(src: ByteSource, map: string, fingerprint: string): Promise<GeometryResult> {
  try {
    const header = await readHeader(src)
    if (header.fingerprint !== fingerprint) return { ok: false, error: 'The file is not the version of the map the server has (fingerprint differs).' }
    const surfaces = await extractSurfaces(src)
    const { spawns, skyCameras } = await extractMapEntities(src)
    const cleaned = removeSkybox(surfaces, { skyCameras, spawns })
    const out = await surfacesToGlb({ ...surfaces, ...cleaned }, { map })
    if (!out) return { ok: false, error: 'The map has no surfaces to draw.' }
    return { ok: true, glb: out.glb, info: { vertices: out.info.vertices, triangles: out.info.triangles, levels: out.info.levels.length } }
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
          const r = await buildGeometry(src, job.map, job.fingerprint)
          Store.finishGeometry(job.map, job.fingerprint, r.ok ? { mesh: r.glb, info: r.info } : { error: r.error })
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

let fetcher: Fetcher | null = null
/** Installs the way files are fetched (RFC 11, 3.2). Without one, requested maps stay queued. */
export const setGeometryFetcher = (f: Fetcher | null) => { fetcher = f }

/** Starts the queue in the background if a fetcher is installed and the feature is on. Never throws. */
export function kickGeometryQueue() {
  if (!geometryEnabled() || !fetcher) return
  runGeometryQueue(fetcher).catch(e => console.error('[Geometry] queue failed:', e instanceof Error ? e.message : e))
}
