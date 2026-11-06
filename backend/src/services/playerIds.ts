import { randomBytes } from 'node:crypto'
import db from './Database'

// RFC 25: the address of a player's page is an id of this site's own, not the SteamID64. A player's id is made the first time it is needed,
// is random (nothing can be worked out from it), and stays the same. The SteamID64 is still what the statistics are kept under.

const PID = /^[0-9a-f]{16}$/
export const isPid = (v: string) => PID.test(v)

const byPid = new Map<string, string>()
const bySteam = new Map<string, string>()
const CACHE_MAX = 5000

const remember = (pid: string, steamId: string) => {
  if (bySteam.size >= CACHE_MAX) { byPid.clear(); bySteam.clear() }
  byPid.set(pid, steamId); bySteam.set(steamId, pid)
}

/** The id of a player's page; made if the player has none yet. */
export function pidOf(steamId: string): string {
  const known = bySteam.get(steamId)
  if (known) return known
  const row = db.prepare('SELECT pid FROM player_ids WHERE steam_id = ?').get(steamId) as { pid: string } | null
  if (row) { remember(row.pid, steamId); return row.pid }
  const pid = randomBytes(8).toString('hex')
  db.prepare('INSERT OR IGNORE INTO player_ids (pid, steam_id, created_at) VALUES (?, ?, ?)').run(pid, steamId, Date.now())
  const stored = db.prepare('SELECT pid FROM player_ids WHERE steam_id = ?').get(steamId) as { pid: string }
  remember(stored.pid, steamId)
  return stored.pid
}

/** The SteamID64 (or bot id) behind a player's page id; null for an id that was never given out. */
export function steamIdOf(pid: string): string | null {
  if (!PID.test(pid)) return null
  const known = byPid.get(pid)
  if (known) return known
  const row = db.prepare('SELECT steam_id AS steamId FROM player_ids WHERE pid = ?').get(pid) as { steamId: string } | null
  if (!row) return null
  remember(pid, row.steamId)
  return row.steamId
}

/** For tests that start from an empty database. */
export const resetPlayerIdCache = () => { byPid.clear(); bySteam.clear() }
