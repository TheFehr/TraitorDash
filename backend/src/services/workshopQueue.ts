import { fileSource } from '../maps/fileSource'
import { readGmaIndex, type GmaEntry } from '../maps/gma'
import type { AddonFetcher } from './workshop'
import { itemDetails, resolveCollection, steamPost, workshopCollectionId, type HttpPost } from './workshopCollection'
import * as W from './workshopStore'

// RFC 40, 3.2: the queue that keeps the index of the server's Workshop addons, in the pattern of the map geometry queue (RFC 11): one job at a
// time, resumable (what is pending is in the database), started at boot and every night, with a pause between downloads; a failure is
// recorded on the addon and retried at the next run, never stops the queue. The same queue also builds the models that were asked for
// (3.3), so that an index job and a model build never download at the same time.

export interface QueueDeps {
  fetcher: AddonFetcher
  /** Steam's Web API; default: the real one. */
  http?: HttpPost
  /** The collection; default: `WORKSHOP_COLLECTION`. */
  collection?: string | null
  /** Every addon id the servers mount (the bridges' reports); used for the ones the collection lacks. */
  mounted?: () => string[]
  /** Builds one queued model (`workshop_models` row) and records its outcome itself. */
  build?: (path: string) => Promise<void>
  /** The pause between two downloads, in milliseconds. Default 3000. */
  delayMs?: number
}

const MAX_TABLE = 64 * 1024 * 1024
const MAX_FILES = 1_000_000

let running = false
let stopping = false
let current: { kind: 'index' | 'model' | 'list', id: string } | null = null
export const workshopQueueState = () => ({ running, current })
/** Asks the running queue to stop after the job it is on; what is pending stays pending. */
export const stopWorkshopQueue = () => { stopping = true }

let lastReport = 0
/** A round report is being processed now: the queue waits a moment before its next download (RFC 40, 3.2). */
export const noteRoundReport = () => { lastReport = Date.now() }
const QUIET_MS = 3000
async function waitForQuiet(sleep: (ms: number) => Promise<void>) {
  for (let i = 0; i < 20 && Date.now() - lastReport < QUIET_MS; i++) await sleep(QUIET_MS)
}

/** The rows of an addon's file table: models and materials in full, everything else counted per top directory. */
export function rowsOf(entries: GmaEntry[], into: W.IndexRows = { files: [], dirs: new Map(), bytes: 0, count: 0 }): W.IndexRows {
  for (const e of entries) {
    into.count++
    into.bytes += e.size
    const path = W.cleanPath(e.name)
    if (path && (path.startsWith('models/') || path.startsWith('materials/'))) { into.files.push({ path, size: e.size, crc: e.crc ?? 0 }); continue }
    const parts = (path ?? '').split('/')
    const dir = !path ? '(unsafe names)' : parts.length === 1 ? '(root)' : /^[a-z0-9_.-]{1,40}$/.test(parts[0]!) ? parts[0]! : '(other)'
    const d = into.dirs.get(dir) ?? { files: 0, bytes: 0 }
    d.files++; d.bytes += e.size
    into.dirs.set(dir, d)
  }
  return into
}

/** Reads the file table of one addon, writes the rows, and deletes the download. Never throws: a failure is recorded on the addon. */
export async function indexAddon(id: string, fetcher: AddonFetcher): Promise<'indexed' | 'failed'> {
  const startedAt = W.startIndexing(id)
  let got: Awaited<ReturnType<AddonFetcher>>
  try { got = await fetcher(id) } catch (e) { got = { error: e instanceof Error ? e.message : 'The download failed.' } }
  if ('error' in got) { W.finishFailed(id, got.error); return 'failed' }
  try {
    const rows: W.IndexRows = { files: [], dirs: new Map(), bytes: 0, count: 0 }
    for (const path of got.paths) {
      const { src, close } = await fileSource(path)
      try { rowsOf(await readGmaIndex(src, { maxTableBytes: MAX_TABLE, maxFiles: MAX_FILES }), rows) } finally { await close() }
    }
    rows.bytes = got.bytes // what was downloaded (the archives' size), not the sum of the files in them
    W.finishIndexed(id, rows, startedAt)
    return 'indexed'
  } catch (e) {
    W.finishFailed(id, e instanceof Error && e.message ? e.message : 'The addon could not be read.')
    return 'failed'
  } finally {
    // The download is deleted as soon as its file table is read (or could not be).
    await got.cleanup().catch(() => {})
  }
}

/** The list: resolves the collection, notes the addons the servers mount that it lacks, and sends the stale ones back to pending. Never throws. */
export async function syncList(deps: Pick<QueueDeps, 'http' | 'collection' | 'mounted'>): Promise<void> {
  const http = deps.http ?? steamPost()
  const collection = deps.collection === undefined ? workshopCollectionId() : deps.collection
  const notes: string[] = []
  try {
    if (collection) {
      const r = await resolveCollection(collection, http)
      if (r.addons.length > 0) W.upsertAddons(r.addons, 'collection')
      notes.push(...r.notes)
      W.metaSet('collection_checked', String(Math.floor(Date.now() / 1000)))
      W.metaSet('collection_size', String(r.addons.length))
    }
  } catch (e) { notes.push(`The collection could not be read: ${e instanceof Error ? e.message : e}`) }
  try {
    const mounted = deps.mounted?.() ?? []
    if (mounted.length) {
      // Mounted addons the collection does not list: indexed too (the collection is primary, these fill the gaps).
      const known = W.addonSources()
      const extra = mounted.filter(id => known.get(id) !== 'collection')
      if (extra.length) {
        const details = await itemDetails(http, extra).catch(() => new Map<string, { title: string | null, updated: number, collection: boolean }>())
        W.upsertAddons(extra.map((id, i) => ({ id, title: details.get(id)?.title ?? null, updated: details.get(id)?.updated ?? 0, order: 100_000 + i })), 'server')
      }
    }
  } catch (e) { notes.push(`The server's addons could not be checked: ${e instanceof Error ? e.message : e}`) }
  W.metaSet('list_notes', JSON.stringify(notes.slice(0, 10)))
}

export interface RunResult { started: boolean, indexed: number, failed: number, models: number }

/**
 * One run of the queue: the list is refreshed, then models that were asked for are built and pending addons indexed, one job at a time, with a
 * pause between jobs, until nothing is left (or `stopWorkshopQueue`). Returns at once, with `started: false`, when a run is already going.
 */
export async function runWorkshopQueue(deps: QueueDeps, opts: { retryFailed?: boolean, sync?: boolean, modelsOnly?: boolean } = {}): Promise<RunResult> {
  if (running) return { started: false, indexed: 0, failed: 0, models: 0 }
  running = true; stopping = false
  const t0 = Date.now()
  const result: RunResult = { started: true, indexed: 0, failed: 0, models: 0 }
  let bytesBefore = 0
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  let downloads = 0
  const between = async () => { if (downloads++ > 0) { await sleep(deps.delayMs ?? 3000) } await waitForQuiet(sleep) }
  try {
    bytesBefore = W.status().bytes
    W.resumeAddons(opts.retryFailed === true)
    W.resumeModels(opts.retryFailed === true)
    if (opts.sync !== false && !opts.modelsOnly) { current = { kind: 'list', id: '' }; await syncList(deps) }
    const tried = new Set<string>()
    let second = false
    for (;;) {
      if (stopping) break
      const model = deps.build ? W.nextQueuedModel() : null
      if (model) {
        await between()
        if (stopping) break
        current = { kind: 'model', id: model }
        try { await deps.build!(model); result.models++ } catch (e) { W.setModel(model, 'failed', { error: e instanceof Error ? e.message : 'The build failed.' }) }
        continue
      }
      const id = opts.modelsOnly ? null : W.nextPendingAddon(tried)
      if (id) {
        tried.add(id)
        await between()
        if (stopping) break
        current = { kind: 'index', id }
        const r = await indexAddon(id, deps.fetcher)
        if (r === 'indexed') result.indexed++; else result.failed++
        continue
      }
      // The index learned things: models it did not know before get one more look.
      if (!second && result.indexed > 0 && deps.build) { second = true; W.resumeModels(); if (W.nextQueuedModel()) continue }
      break
    }
  } finally {
    const st = W.status()
    W.metaSet('last_run', JSON.stringify({ at: Math.floor(Date.now() / 1000), seconds: Math.round((Date.now() - t0) / 1000), indexed: result.indexed, failed: result.failed, bytes: Math.max(0, st.bytes - bytesBefore), note: stopping ? 'stopped' : null }))
    running = false; stopping = false; current = null
  }
  return result
}

/** Starts a run in the background. Never throws. */
export function kickWorkshopQueue(deps: QueueDeps, opts: { retryFailed?: boolean, sync?: boolean, modelsOnly?: boolean } = {}) {
  runWorkshopQueue(deps, opts).catch(e => console.error('[Workshop] queue failed:', e instanceof Error ? e.message : e))
}

/** Milliseconds from `now` to the next time the local clock reads `hour`:00 (tomorrow's when it is past). */
export function msUntilHour(now: Date, hour: number): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** The run at boot (after `bootDelayMs`) and every night at 04:00 local time; the timers do not keep the process alive. */
export function startWorkshopSchedule(deps: QueueDeps, bootDelayMs = 30_000) {
  const again = () => setTimeout(() => { kickWorkshopQueue(deps, { retryFailed: true }); again() }, msUntilHour(new Date(), 4)).unref()
  setTimeout(() => kickWorkshopQueue(deps, { retryFailed: true }), bootDelayMs).unref()
  again()
}
