import db from './Database'

// RFC 40: what is stored about the server's Workshop addons. Times are seconds since 1970 (Steam's own `time_updated` is, so the two compare directly).

export type AddonStatus = 'pending' | 'indexing' | 'indexed' | 'failed'
export type ModelStatus = 'queued' | 'building' | 'built' | 'failed' | 'unknown'
export interface ListedAddon { id: string, title: string | null, updated: number, order: number }
export interface IndexRows { files: { path: string, size: number, crc: number }[], dirs: Map<string, { files: number, bytes: number }>, bytes: number, count: number }

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * A path from an addon's file table (or from a model's materials) as the index and the cache know it: lower case, forward slashes, no leading `./`.
 * Null for a name that is absolute, has a `..` or an empty or `.` part, a NUL or a drive letter, or is over 300 characters: such a name is never
 * stored, looked up or extracted (RFC 40, 3.4).
 */
export function cleanPath(name: string): string | null {
  const n = name.toLowerCase().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!n || n.length > 300 || n.startsWith('/') || n.includes('\0') || n.includes(':')) return null
  for (const part of n.split('/')) if (part === '' || part === '.' || part === '..') return null
  return n
}

export function metaGet(key: string): string | null {
  return (db.prepare('SELECT value FROM workshop_meta WHERE key = ?').get(key) as { value: string } | null)?.value ?? null
}
export function metaSet(key: string, value: string) {
  db.prepare('INSERT INTO workshop_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/**
 * Puts the listed addons into the table: new ones are pending; a known one keeps its status unless Steam says it changed after it was
 * indexed (`updated` newer than `indexed_at`), which makes it pending again. Addons of an earlier list of the same source that are no longer
 * listed stay (their files are still read) but are no longer indexed again. Returns how many were new and how many went back to pending.
 */
export function upsertAddons(list: ListedAddon[], source: 'collection' | 'server'): { added: number, stale: number } {
  let added = 0, stale = 0
  db.transaction(() => {
    const get = db.prepare('SELECT status, indexed_at AS indexedAt, updated, source FROM workshop_addons WHERE id = ?')
    const insert = db.prepare('INSERT INTO workshop_addons (id, title, updated, status, source, ord) VALUES (?, ?, ?, \'pending\', ?, ?)')
    const touch = db.prepare('UPDATE workshop_addons SET title = COALESCE(?, title), updated = ?, source = ?, ord = ? WHERE id = ?')
    const again = db.prepare('UPDATE workshop_addons SET status = \'pending\', error = NULL WHERE id = ?')
    for (const a of list) {
      const row = get.get(a.id) as { status: AddonStatus, indexedAt: number | null, updated: number, source: string } | null
      if (!row) { insert.run(a.id, a.title, a.updated, source, a.order); added++; continue }
      // The collection is the primary list: an addon the server also mounts without it stays the collection's.
      const keep = row.source === 'collection' && source === 'server' ? 'collection' : source
      touch.run(a.title, a.updated || row.updated, keep, a.order, a.id)
      if (row.status === 'indexed' && row.indexedAt !== null && a.updated > row.indexedAt) { again.run(a.id); stale++ }
    }
    if (source === 'collection') {
      const ids = new Set(list.map(a => a.id))
      for (const r of db.prepare('SELECT id FROM workshop_addons WHERE source = \'collection\'').all() as { id: string }[]) {
        if (!ids.has(r.id)) db.prepare('UPDATE workshop_addons SET source = \'former\' WHERE id = ?').run(r.id)
      }
    }
  })()
  return { added, stale }
}

/** The source of every addon in the table: 'collection', 'server' (mounted, not in the collection) or 'former' (left the collection). */
export const addonSources = (): Map<string, string> => new Map((db.prepare('SELECT id, source FROM workshop_addons').all() as { id: string, source: string }[]).map(r => [r.id, r.source]))

/** Of the addons a server mounts, those that are not in the collection (the cross-check of 3.1). */
export function notInCollection(mounted: string[]): string[] {
  const src = addonSources()
  return mounted.filter(id => src.get(id) !== 'collection')
}

/** An addon the queue stopped in the middle of (`indexing`) is pending again; a failed one too when `retryFailed`. */
export function resumeAddons(retryFailed: boolean) {
  db.run('UPDATE workshop_addons SET status = \'pending\' WHERE status = \'indexing\'')
  if (retryFailed) db.run('UPDATE workshop_addons SET status = \'pending\' WHERE status = \'failed\' AND source != \'former\'')
}
export function retryFailedAddons(): number {
  return db.prepare('UPDATE workshop_addons SET status = \'pending\' WHERE status = \'failed\'').run().changes
}

/** The next addon to index that is not in `skip`, in the collection's order, or null. */
export function nextPendingAddon(skip: Set<string>): string | null {
  for (const r of db.prepare('SELECT id FROM workshop_addons WHERE status = \'pending\' AND source != \'former\' ORDER BY ord, id').iterate() as Iterable<{ id: string }>) {
    if (!skip.has(r.id)) return r.id
  }
  return null
}

export function startIndexing(id: string): number {
  const at = nowSeconds()
  db.prepare('UPDATE workshop_addons SET status = \'indexing\', error = NULL WHERE id = ?').run(id)
  return at
}

/** Replaces the rows of an addon with `rows`, and marks it indexed as of `startedAt` (the time its download began). */
export function finishIndexed(id: string, rows: IndexRows, startedAt: number) {
  db.transaction(() => {
    db.prepare('DELETE FROM workshop_files WHERE addon_id = ?').run(id)
    db.prepare('DELETE FROM workshop_dirs WHERE addon_id = ?').run(id)
    const ins = db.prepare('INSERT OR REPLACE INTO workshop_files (addon_id, path, size, crc) VALUES (?, ?, ?, ?)')
    for (const f of rows.files) ins.run(id, f.path, f.size, f.crc)
    const dir = db.prepare('INSERT OR REPLACE INTO workshop_dirs (addon_id, dir, files, bytes) VALUES (?, ?, ?, ?)')
    for (const [d, v] of rows.dirs) dir.run(id, d, v.files, v.bytes)
    db.prepare('UPDATE workshop_addons SET status = \'indexed\', indexed_at = ?, bytes = ?, file_count = ?, error = NULL WHERE id = ?').run(startedAt, rows.bytes, rows.count, id)
  })()
}

export function finishFailed(id: string, error: string) {
  db.prepare('UPDATE workshop_addons SET status = \'failed\', error = ? WHERE id = ?').run(error.slice(0, 300), id)
}

/** The indexed addons that hold the exact path, the most recently updated first (then by id, so the choice is the same every time). */
export function holders(path: string): string[] {
  return (db.prepare(`
    SELECT f.addon_id AS id FROM workshop_files f JOIN workshop_addons a ON a.id = f.addon_id
    WHERE f.path = ? AND a.status = 'indexed' ORDER BY a.updated DESC, a.id
  `).all(path) as { id: string }[]).map(r => r.id)
}

/** Which of `paths` the addon holds. */
export function heldBy(addon: string, paths: string[]): Set<string> {
  const out = new Set<string>()
  const q = db.prepare('SELECT 1 FROM workshop_files WHERE addon_id = ? AND path = ?')
  for (const p of paths) if (q.get(addon, p)) out.add(p)
  return out
}

/** Are there addons not indexed yet (pending or being indexed)? The index may still learn where a model is. */
export const indexIncomplete = (): boolean => !!db.prepare('SELECT 1 FROM workshop_addons WHERE status IN (\'pending\', \'indexing\') AND source != \'former\' LIMIT 1').get()

export interface AddonRow { id: string, title: string | null, updated: number, indexedAt: number | null, status: AddonStatus, bytes: number, fileCount: number, error: string | null, source: string }
export function failedAddons(limit = 50): AddonRow[] {
  return db.prepare('SELECT id, title, updated, indexed_at AS indexedAt, status, bytes, file_count AS fileCount, error, source FROM workshop_addons WHERE status = \'failed\' ORDER BY ord, id LIMIT ?').all(limit) as AddonRow[]
}

export interface WorkshopStatus {
  addons: number, indexed: number, failed: number, pending: number
  /** Archive bytes downloaded for indexing (the sum over the indexed addons, as of their last index). */
  bytes: number
  files: number, dirs: number
  /** What the index rows take in the database: an estimate from the lengths of what is stored. */
  rowBytes: number
  models: { built: number, queued: number, building: number, failed: number, unknown: number }
  lastRun: { at: number, seconds: number, indexed: number, failed: number, bytes: number, note: string | null } | null
}

export function status(): WorkshopStatus {
  const a = db.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(status = 'indexed'), 0) AS indexed, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status IN ('pending', 'indexing')), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'indexed' THEN bytes ELSE 0 END), 0) AS bytes
    FROM workshop_addons WHERE source != 'former'`).get() as any
  const f = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(path) + 24), 0) AS b FROM workshop_files').get() as any
  const d = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(dir) + 24), 0) AS b FROM workshop_dirs').get() as any
  const models = { built: 0, queued: 0, building: 0, failed: 0, unknown: 0 }
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM workshop_models GROUP BY status').all() as { status: ModelStatus, n: number }[]) models[r.status] = r.n
  let lastRun: WorkshopStatus['lastRun'] = null
  try { const raw = metaGet('last_run'); if (raw) lastRun = JSON.parse(raw) } catch { /* a bad row is no run */ }
  return { addons: a.n, indexed: a.indexed, failed: a.failed, pending: a.pending, bytes: a.bytes, files: f.n, dirs: d.n, rowBytes: f.b + d.b, models, lastRun }
}

// Models (RFC 40, 3.3)

/** Queues a model path; false when it is already queued, building or built (a failed or unknown one is queued again). */
export function queueModel(path: string): boolean {
  const row = db.prepare('SELECT status FROM workshop_models WHERE path = ?').get(path) as { status: ModelStatus } | null
  if (row && (row.status === 'queued' || row.status === 'building' || row.status === 'built')) return false
  db.prepare(`INSERT INTO workshop_models (path, status, queued_at) VALUES (?, 'queued', ?)
    ON CONFLICT(path) DO UPDATE SET status = 'queued', error = NULL, queued_at = excluded.queued_at`).run(path, nowSeconds())
  return true
}
export const modelStatus = (path: string): { status: ModelStatus, error: string | null } | null =>
  db.prepare('SELECT status, error FROM workshop_models WHERE path = ?').get(path) as { status: ModelStatus, error: string | null } | null
export const nextQueuedModel = (): string | null => (db.prepare('SELECT path FROM workshop_models WHERE status = \'queued\' ORDER BY queued_at, path LIMIT 1').get() as { path: string } | null)?.path ?? null
export function setModel(path: string, status: ModelStatus, extra: { error?: string | null, addon?: string | null, bytes?: number } = {}) {
  db.prepare('UPDATE workshop_models SET status = ?, error = ?, addon_id = COALESCE(?, addon_id), bytes = COALESCE(?, bytes), built_at = ? WHERE path = ?')
    .run(status, extra.error ? extra.error.slice(0, 300) : null, extra.addon ?? null, extra.bytes ?? null, status === 'built' ? nowSeconds() : null, path)
}
/** Models a run was stopped in (`building`) are queued again, and those the index did not know yet (`unknown`) get another look. */
export function resumeModels(retryFailed = false) {
  db.run('UPDATE workshop_models SET status = \'queued\' WHERE status IN (\'building\', \'unknown\')')
  if (retryFailed) db.run('UPDATE workshop_models SET status = \'queued\', error = NULL WHERE status = \'failed\'')
}
export function retryFailedModels(): number {
  return db.prepare('UPDATE workshop_models SET status = \'queued\', error = NULL WHERE status = \'failed\'').run().changes
}
