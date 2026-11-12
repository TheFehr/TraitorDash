import type { Database as Db } from 'bun:sqlite'
import database from './Database'
import { cleanNick } from './voice'
import { STEAM_ID64 } from './validators'

/**
 * Player names from the Steam Web API (RFC 28): the last resort before a SteamID64 on the voice page. Without STEAM_API_KEY nothing here
 * does anything. Answers are made from a cache in the database; whatever is missing or old is fetched in the background, so a page never
 * waits for Steam. Only `personaname` is read, and the key is never logged, returned or put in an error.
 */

/** A name is kept this long; a miss (no profile, no name) is kept shorter so a missing player is not asked for at every poll. */
export const NAME_TTL_MS = 24 * 3600_000
export const MISS_TTL_MS = 3600_000
/** What one call may hold (Steam's limit). */
export const MAX_IDS = 100
export const TIMEOUT_MS = 3000
/** After a failure nothing is asked for this long, so a Steam that is down is not called at every poll. */
export const BACKOFF_MS = 30_000
const LOG_EVERY_MS = 60_000
const ENDPOINT = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/'

export interface SteamNamesOptions {
  db?: Db
  key?: () => string | null
  fetchFn?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
}

export class SteamNames {
  private db: Db
  private key: () => string | null
  private fetchFn: typeof fetch
  private now: () => number
  private log: (msg: string) => void
  private inflight = new Set<string>()
  private running = new Set<Promise<void>>()
  private failedAt = -Infinity
  private loggedAt = -Infinity

  constructor(o: SteamNamesOptions = {}) {
    this.db = o.db ?? database
    this.key = o.key ?? (() => process.env.STEAM_API_KEY?.trim() || null)
    this.fetchFn = o.fetchFn ?? fetch
    this.now = o.now ?? Date.now
    this.log = o.log ?? ((m) => console.warn(m))
  }

  enabled(): boolean { return this.key() !== null }

  /**
   * The Steam names known for these players, from the cache (an old name too, however old: it is better than none). A refresh for the ones
   * missing or old is started in the background. Only SteamID64s that are on the voice chat or ask for a token may be passed in.
   */
  names(ids: string[]): Map<string, string> {
    const out = new Map<string, string>()
    if (!this.enabled()) return out
    const now = this.now()
    const wanted = [...new Set(ids)].filter(i => STEAM_ID64.test(i))
    const stale: string[] = []
    const get = this.db.prepare('SELECT name, fetched_at FROM steam_names WHERE steam_id = ?')
    for (const id of wanted) {
      const row = get.get(id) as { name: string | null, fetched_at: number } | null
      if (row?.name) out.set(id, row.name)
      const ttl = row?.name ? NAME_TTL_MS : MISS_TTL_MS
      if (!row || now - row.fetched_at >= ttl) stale.push(id)
    }
    if (stale.length) this.refresh(stale)
    return out
  }

  /** Resolves when the background refreshes started so far are over (for tests and for a clean stop). */
  async idle(): Promise<void> { while (this.running.size) await Promise.all([...this.running]) }

  private refresh(ids: string[]) {
    if (this.now() - this.failedAt < BACKOFF_MS) return
    const todo = ids.filter(i => !this.inflight.has(i))
    for (let i = 0; i < todo.length; i += MAX_IDS) {
      const chunk = todo.slice(i, i + MAX_IDS)
      for (const id of chunk) this.inflight.add(id)
      const p: Promise<void> = this.fetchChunk(chunk).finally(() => { for (const id of chunk) this.inflight.delete(id); this.running.delete(p) })
      this.running.add(p)
    }
  }

  private async fetchChunk(ids: string[]): Promise<void> {
    const key = this.key()
    if (!key) return
    try {
      const found = await this.lookup(key, ids)
      const at = this.now()
      const put = this.db.prepare('INSERT INTO steam_names (steam_id, name, fetched_at) VALUES (?, ?, ?) ON CONFLICT(steam_id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at')
      this.db.transaction(() => { for (const id of ids) put.run(id, found.get(id) ?? null, at) })()
    } catch (err) {
      this.failedAt = this.now()
      this.complain(key, err)
    }
  }

  /** One call for these ids; the names it gave, cleaned. Throws on a timeout, an HTTP error or an answer that is not what Steam sends. */
  private async lookup(key: string, ids: string[]): Promise<Map<string, string>> {
    const url = `${ENDPOINT}?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body: any = await res.json()
    const players = body?.response?.players
    if (!Array.isArray(players)) throw new Error('the answer has no list of players')
    const asked = new Set(ids)
    const out = new Map<string, string>()
    for (const p of players) {
      if (typeof p?.steamid !== 'string' || !asked.has(p.steamid)) continue
      const name = cleanNick(p.personaname)
      if (name) out.set(p.steamid, name)
    }
    return out
  }

  private complain(key: string, err: unknown) {
    const at = this.now()
    if (at - this.loggedAt < LOG_EVERY_MS) return
    this.loggedAt = at
    const raw = err instanceof Error ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timed out' : err.message) : 'failed'
    this.log(`[Steam] could not look up names: ${raw.split(key).join('***').slice(0, 200)}`)
  }
}

/** The one lookup of this process. */
export const steamNames = new SteamNames()
