import db from './Database'
import { HEX6 } from '../teamColours'
import { BOT_ID_PREFIX } from './validators'
import type { MapPlan } from './mapplan'
import { createHash } from 'node:crypto'
import { hashToken } from './migrations'
import { CODE_TTL_MS, generateCode, hashCode } from './pairing'
import { TRACK_DEFAULTS, effectiveLimits, type Track, type TrackConfig } from './tracks'

/** Change detection for language file contents. Not a security use: just "did this text change". */
const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')

// Never select api_token_hash for anything that can reach a template.
const SERVER_COLS = 'id, name, last_seen'

/** 256 random bits, hex. Shown to an admin once; only its hash is stored. */
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

/** How long views of gated content are kept, in days (RFC 13, 6.3); 0 switches the logging off. */
export const viewLogDays = () => {
  const raw = (process.env.VIEW_LOG_DAYS ?? '').trim()
  return /^\d+$/.test(raw) ? Number(raw) : 90
}

/** Stats history kept per server; older rounds are removed as new ones arrive. */
export const MAX_ROUNDS_PER_SERVER = 50_000

export interface GeometryState {
  fingerprint: string | null
  /** queued | fetching | parsed | failed | unknown (the map has no fingerprint) */
  status: string
  detail: string | null
  info: { vertices: number, triangles: number, levels: number } | null
}

export interface MapPlanMeta {
  map: string, fingerprint: string | null, cell: number, nx: number, ny: number
  floorCells: number, crouchFloors: number, seeds: number, scannedAt: string
}

export interface MapRow {
  name: string, size: number | null, fingerprint: string | null
  matchesGamemode: boolean | null, inCycle: boolean | null, onCooldown: boolean | null
  isCurrent: boolean | null, inVotePool: boolean | null, votable: boolean | null
}
export interface MapsState {
  current: string | null, next: string | null, gamemode: string | null, pattern: string | null
  poolBasis: string | null, configSource: string | null, voteAddon: boolean, reportedAt: string
}
export interface MapsReport {
  current: string | null, next: string | null, gamemode: string | null, pattern: string | null
  poolBasis: string | null, configSource: string | null, voteAddon: boolean, maps: MapRow[]
  /** Workshop IDs of the mounted map addons (digits). */
  mapAddons?: string[]
}

export interface RoundReport {
  roundId: string
  map: string | null
  startedAt: string | null
  duration: number | null
  result: string
  players: { steamId: string, nick: string | null, role: string | null, team: string | null, survived: boolean, won: boolean, endRole?: string | null, endTeam?: string | null }[]
  deaths: { victim: string, attacker: string | null, at: number | null }[]
  /** Who was brought back, by whom and how (RFC 14, 4.2); reviver, how and why are null when unknown. */
  revives?: { victim: string, reviver: string | null, how: string | null, why: string | null, at: number | null }[]
}

export class Store {
  static getServers(): any[] {
    const query = db.prepare(`SELECT ${SERVER_COLS} FROM servers ORDER BY name ASC`)
    return query.all()
  }

  static getServerById(id: string): any | null {
    const query = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE id = ?`)
    return query.get(id) || null
  }

  static getServerByToken(token: string): any | null {
    const query = db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE api_token_hash = ?`)
    return query.get(hashToken(token)) || null
  }

  static addServer(name: string) {
    const id = crypto.randomUUID()
    const token = newToken()
    const insert = db.prepare('INSERT INTO servers (id, name, api_token_hash) VALUES (?, ?, ?)')
    insert.run(id, name, hashToken(token))
    return { id, token }
  }

  /** Replaces a server's token. The old one stops working immediately. */
  static regenerateToken(id: string): string | null {
    const token = newToken()
    const result = db.prepare('UPDATE servers SET api_token_hash = ? WHERE id = ?').run(hashToken(token), id)
    return result.changes > 0 ? token : null
  }

  /**
   * A new pairing code for a server (RFC 9), or null if the server does not exist. The previous
   * unused code of that server stops working. Only the code's hash is stored.
   */
  static createPairingCode(serverId: string, adminId: string, now: number = Date.now()): string | null {
    if (!Store.getServerById(serverId)) return null
    const code = generateCode()
    db.transaction(() => {
      db.run('DELETE FROM pairing_codes WHERE server_id = ? AND used_at IS NULL', [serverId])
      db.run(
        'INSERT INTO pairing_codes (code_hash, server_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        [hashCode(code), serverId, adminId, now, now + CODE_TTL_MS]
      )
    })()
    return code
  }

  /**
   * Exchanges a valid code for a new token of its server, in one transaction: the code is marked
   * used and the old token is replaced together, or neither happens. Returns null for an unknown,
   * expired or already used code (the three are not told apart).
   */
  static redeemPairingCode(raw: string, now: number = Date.now()): { token: string, serverId: string, name: string } | null {
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT p.code_hash, p.server_id, s.name
        FROM pairing_codes p JOIN servers s ON s.id = p.server_id
        WHERE p.code_hash = ? AND p.used_at IS NULL AND p.expires_at > ?
      `).get(hashCode(raw), now) as { code_hash: string, server_id: string, name: string } | null
      if (!row) return null

      db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', [now, row.code_hash])
      const token = Store.regenerateToken(row.server_id)
      if (!token) return null
      return { token, serverId: row.server_id, name: row.name }
    })()
  }

  /** Removes expired and used codes. */
  static cleanupPairingCodes(now: number = Date.now()) {
    db.run('DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?', [now])
  }

  static audit(serverId: string | null, steamId: string | null, action: string, details?: string) {
    db.prepare('INSERT INTO audit_log (server_id, steam_id, action, details) VALUES (?, ?, ?, ?)')
      .run(serverId, steamId, action, details ?? null)
  }

  /**
   * Writes one row for a signed-in user opening gated content (RFC 13, 6.3): the account, the server,
   * what was opened. The same user opening the same thing again within the hour is one row.
   * `days` 0 switches the log off. Returns whether a row was written.
   */
  static logView(serverId: string, steamId: string, action: 'VIEW_REPLAY' | 'VIEW_MESH', what: string, days: number = viewLogDays()): boolean {
    if (days <= 0) return false
    const recent = db.prepare(
      "SELECT 1 FROM audit_log WHERE steam_id = ? AND action = ? AND details = ? AND server_id = ? AND timestamp > datetime('now', '-1 hour') LIMIT 1"
    ).get(steamId, action, what, serverId)
    if (recent) return false
    Store.audit(serverId, steamId, action, what)
    return true
  }

  /** Removes view rows older than `days` (RFC 13, 6.3). With 0 the log is off and the rows are removed too. */
  static cleanupViewLog(days: number = viewLogDays()): number {
    const r = days <= 0
      ? db.prepare("DELETE FROM audit_log WHERE action IN ('VIEW_REPLAY', 'VIEW_MESH')").run()
      : db.prepare("DELETE FROM audit_log WHERE action IN ('VIEW_REPLAY', 'VIEW_MESH') AND timestamp < datetime('now', ?)").run(`-${Math.floor(days)} days`)
    return r.changes
  }

  static deleteServer(id: string) {
    db.run('DELETE FROM roles WHERE server_id = ?', [id])
    db.run('DELETE FROM commands WHERE server_id = ?', [id])
    db.run('DELETE FROM authorized_admins WHERE server_id = ?', [id])
    db.run('DELETE FROM convar_values WHERE server_id = ?', [id])
    db.run('DELETE FROM lang_files WHERE server_id = ?', [id])
    db.run('DELETE FROM deaths WHERE server_id = ?', [id])
    db.run('DELETE FROM round_revives WHERE server_id = ?', [id])
    db.run('DELETE FROM round_tracks WHERE server_id = ?', [id])
    db.run('DELETE FROM round_players WHERE server_id = ?', [id])
    db.run('DELETE FROM rounds WHERE server_id = ?', [id])
    db.run('DELETE FROM pairing_codes WHERE server_id = ?', [id])
    db.run('DELETE FROM server_maps WHERE server_id = ?', [id])
    db.run('DELETE FROM server_map_state WHERE server_id = ?', [id])
    db.run('DELETE FROM map_plans WHERE server_id = ?', [id])
    db.run('DELETE FROM map_geometry_requests WHERE server_id = ?', [id])
    db.run('DELETE FROM servers WHERE id = ?', [id])
  }

  /**
   * Stores one finished round. Returns false (and stores nothing) if this round_id was already
   * recorded. Keeps at most `keep` rounds per server: the oldest are removed together with their
   * players and deaths, so the tables cannot grow without bound.
   */
  static recordRound(serverId: string, r: RoundReport, keep: number = MAX_ROUNDS_PER_SERVER): boolean {
    return db.transaction(() => {
      const inserted = db.prepare(
        'INSERT OR IGNORE INTO rounds (server_id, round_id, map, started_at, duration, result) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(serverId, r.roundId, r.map, r.startedAt, r.duration, r.result)
      if (inserted.changes === 0) return false

      const player = db.prepare(
        'INSERT OR REPLACE INTO round_players (server_id, round_id, steam_id, nick, role, team, survived, won, end_role, end_team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const p of r.players) {
        player.run(serverId, r.roundId, p.steamId, p.nick, p.role, p.team, p.survived ? 1 : 0, p.won ? 1 : 0, p.endRole ?? null, p.endTeam ?? null)
      }
      const death = db.prepare(
        'INSERT INTO deaths (server_id, round_id, victim_steam_id, attacker_steam_id, at_seconds) VALUES (?, ?, ?, ?, ?)'
      )
      for (const d of r.deaths) death.run(serverId, r.roundId, d.victim, d.attacker, d.at)
      const revive = db.prepare(
        'INSERT INTO round_revives (server_id, round_id, victim, reviver, how, why, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const v of r.revives ?? []) revive.run(serverId, r.roundId, v.victim, v.reviver, v.how, v.why, v.at)

      const old = db.prepare(
        'SELECT round_id FROM rounds WHERE server_id = ? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?'
      ).all(serverId, keep) as { round_id: string }[]
      for (const { round_id } of old) Store.removeRound(serverId, round_id)
      return true
    })()
  }

  /** Removes a round and everything stored for it: its players, deaths, revivals and track. Returns whether it existed. */
  private static removeRound(serverId: string, roundId: string): boolean {
    db.run('DELETE FROM round_tracks WHERE server_id = ? AND round_id = ?', [serverId, roundId])
    db.run('DELETE FROM deaths WHERE server_id = ? AND round_id = ?', [serverId, roundId])
    db.run('DELETE FROM round_revives WHERE server_id = ? AND round_id = ?', [serverId, roundId])
    db.run('DELETE FROM round_players WHERE server_id = ? AND round_id = ?', [serverId, roundId])
    return db.run('DELETE FROM rounds WHERE server_id = ? AND round_id = ?', [serverId, roundId]).changes > 0
  }

  /** Deletes one round with its replay (an admin's choice: pinned ones too). */
  static deleteRound(serverId: string, roundId: string): boolean {
    return db.transaction(() => Store.removeRound(serverId, roundId))()
  }

  /** Deletes several rounds with their replays. Returns the ids that existed and are now gone. */
  static deleteRounds(serverId: string, roundIds: string[]): string[] {
    return db.transaction(() => roundIds.filter(id => Store.removeRound(serverId, id)))()
  }

  /** Deletes only a round's replay (its track); the round stays in the statistics. Returns whether there was one. */
  static deleteTrack(serverId: string, roundId: string): boolean {
    return db.run('DELETE FROM round_tracks WHERE server_id = ? AND round_id = ?', [serverId, roundId]).changes > 0
  }

  /** The rounds only test bots played in: at least one bot and no one else. */
  private static botRoundIds(serverId: string): string[] {
    return (db.prepare(`
      SELECT r.round_id FROM rounds r WHERE r.server_id = ?
        AND EXISTS (SELECT 1 FROM round_players rp WHERE rp.server_id = r.server_id AND rp.round_id = r.round_id AND rp.steam_id LIKE '${BOT_ID_PREFIX}%')
        AND NOT EXISTS (SELECT 1 FROM round_players rp WHERE rp.server_id = r.server_id AND rp.round_id = r.round_id AND rp.steam_id NOT LIKE '${BOT_ID_PREFIX}%')
    `).all(serverId) as { round_id: string }[]).map(r => r.round_id)
  }

  static countBotRounds(serverId: string): number {
    return Store.botRoundIds(serverId).length
  }

  /** Deletes every round only test bots played in, with their replays. Returns how many. */
  static deleteBotRounds(serverId: string): number {
    return db.transaction(() => Store.botRoundIds(serverId).filter(id => Store.removeRound(serverId, id)).length)()
  }

  // ---- Position tracks (RFC 12, 3.4) ----

  private static trackCfg: TrackConfig = TRACK_DEFAULTS

  /** Sets what the instance keeps (from the environment, at start-up). */
  static setTrackConfig(c: TrackConfig) { Store.trackCfg = c }
  static getTrackConfig(): TrackConfig { return Store.trackCfg }

  /** The round a track would belong to: its map and players; null when this server has no such round. */
  static getRoundForTrack(serverId: string, roundId: string): { map: string | null, players: Set<string> } | null {
    const r = db.prepare('SELECT map FROM rounds WHERE server_id = ? AND round_id = ?').get(serverId, roundId) as { map: string | null } | null
    if (!r) return null
    const rows = db.prepare('SELECT steam_id FROM round_players WHERE server_id = ? AND round_id = ?').all(serverId, roundId) as { steam_id: string }[]
    return { map: r.map, players: new Set(rows.map(x => x.steam_id)) }
  }

  static hasTrack(serverId: string, roundId: string): boolean {
    return !!db.prepare('SELECT 1 FROM round_tracks WHERE server_id = ? AND round_id = ?').get(serverId, roundId)
  }

  /** What this server keeps: its own override, else the instance default, never above the ceiling. */
  static getTrackLimits(serverId: string): { count: number, mb: number, own: { count: number | null, mb: number | null } } {
    const row = db.prepare('SELECT track_keep_count AS count, track_keep_mb AS mb FROM servers WHERE id = ?').get(serverId) as { count: number | null, mb: number | null } | null
    const own = { count: row?.count ?? null, mb: row?.mb ?? null }
    return { ...effectiveLimits(Store.trackCfg, own), own }
  }

  /** Stores the limits an admin chose (null: use the default). Takes effect now. */
  static setTrackLimits(serverId: string, count: number | null, mb: number | null) {
    db.prepare('UPDATE servers SET track_keep_count = ?, track_keep_mb = ? WHERE id = ?').run(count, mb, serverId)
    Store.enforceTrackLimits(serverId)
  }

  static getTrackUsage(serverId: string): { count: number, bytes: number, pinned: number } {
    const r = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(pinned), 0) AS pinned FROM round_tracks WHERE server_id = ?').get(serverId) as { count: number, bytes: number, pinned: number }
    return r
  }

  /**
   * Stores a validated track. `stored` is false and nothing is written when the round already has
   * one, or when this server keeps no tracks (0); `tooBig` names the limit a track larger than the
   * whole size limit hit.
   */
  static recordTrack(serverId: string, t: Track, json: string): { status: 'stored' | 'duplicate' | 'discarded' } | { status: 'too_big', limit: string } {
    const limits = Store.getTrackLimits(serverId)
    if (Store.hasTrack(serverId, t.roundId)) return { status: 'duplicate' }
    if (limits.count === 0 || limits.mb === 0) return { status: 'discarded' }
    const bytes = Buffer.byteLength(json)
    if (bytes > limits.mb * 1024 * 1024) return { status: 'too_big', limit: `this server keeps at most ${limits.mb} MB of tracks` }
    db.transaction(() => {
      db.prepare(
        'INSERT INTO round_tracks (server_id, round_id, map, fingerprint, truncated, degraded, bytes, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(serverId, t.roundId, t.map, t.fingerprint, t.truncated ? 1 : 0, t.degraded ? 1 : 0, bytes, new Date().toISOString(), json)
      Store.enforceTrackLimits(serverId)
    })()
    return { status: 'stored' }
  }

  /** Removes the oldest unpinned tracks until the count and the size both fit. Pinned ones are never removed. */
  static enforceTrackLimits(serverId: string) {
    const limits = Store.getTrackLimits(serverId)
    const rows = db.prepare('SELECT round_id, bytes FROM round_tracks WHERE server_id = ? AND pinned = 0 ORDER BY created_at ASC, rowid ASC').all(serverId) as { round_id: string, bytes: number }[]
    let count = rows.length, bytes = rows.reduce((a, r) => a + r.bytes, 0)
    const cap = limits.mb * 1024 * 1024
    for (const r of rows) {
      if (count <= limits.count && bytes <= cap) break
      db.run('DELETE FROM round_tracks WHERE server_id = ? AND round_id = ?', [serverId, r.round_id])
      count--; bytes -= r.bytes
    }
  }

  /** The limits of every server, applied (at start-up, so a lowered limit takes effect at once). */
  static enforceAllTrackLimits() {
    for (const s of db.prepare('SELECT id FROM servers').all() as { id: string }[]) Store.enforceTrackLimits(s.id)
  }

  /** Pins or unpins a track. 'max' when the server already has the most pins the instance allows. */
  static pinTrack(serverId: string, roundId: string, pinned: boolean, by: string): 'ok' | 'none' | 'max' {
    const row = db.prepare('SELECT pinned FROM round_tracks WHERE server_id = ? AND round_id = ?').get(serverId, roundId) as { pinned: number } | null
    if (!row) return 'none'
    if (pinned) {
      if (row.pinned === 1) return 'ok'
      if (Store.getTrackUsage(serverId).pinned >= Store.trackCfg.maxPinned) return 'max'
      db.prepare('UPDATE round_tracks SET pinned = 1, pinned_by = ?, pinned_at = ? WHERE server_id = ? AND round_id = ?').run(by, new Date().toISOString(), serverId, roundId)
    } else {
      db.prepare('UPDATE round_tracks SET pinned = 0, pinned_by = NULL, pinned_at = NULL WHERE server_id = ? AND round_id = ?').run(serverId, roundId)
      Store.enforceTrackLimits(serverId) // an unpinned track is now subject to the limits
    }
    return 'ok'
  }

  /** The stored track and what is known about it; null when the round has none. */
  static getTrack(serverId: string, roundId: string): { track: Track, meta: { map: string, fingerprint: string | null, truncated: boolean, degraded: boolean, bytes: number, createdAt: string, pinned: boolean } } | null {
    const r = db.prepare('SELECT map, fingerprint, truncated, degraded, bytes, created_at, pinned, data FROM round_tracks WHERE server_id = ? AND round_id = ?').get(serverId, roundId) as any
    if (!r) return null
    return { track: JSON.parse(r.data) as Track, meta: { map: r.map, fingerprint: r.fingerprint, truncated: !!r.truncated, degraded: !!r.degraded, bytes: r.bytes, createdAt: r.created_at, pinned: !!r.pinned } }
  }

  /** Which of `roundIds` have a track (and whether it is pinned), for marking the round list. */
  static getTrackedRounds(serverId: string, roundIds: string[]): Map<string, { pinned: boolean }> {
    const out = new Map<string, { pinned: boolean }>()
    if (roundIds.length === 0) return out
    const rows = db.prepare(`SELECT round_id, pinned FROM round_tracks WHERE server_id = ? AND round_id IN (${roundIds.map(() => '?').join(',')})`).all(serverId, ...roundIds) as { round_id: string, pinned: number }[]
    for (const r of rows) out.set(r.round_id, { pinned: !!r.pinned })
    return out
  }

  /** Replaces the server's map report with `r`, as a whole and in one transaction (RFC 10). */
  static setMaps(serverId: string, r: MapsReport) {
    const now = new Date().toISOString()
    const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0)
    db.transaction(() => {
      db.run('DELETE FROM server_maps WHERE server_id = ?', [serverId])
      const insert = db.prepare(`
        INSERT OR IGNORE INTO server_maps
          (server_id, name, size, fingerprint, matches_gamemode, in_cycle, on_cooldown, is_current, in_vote_pool, votable, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const m of r.maps) {
        insert.run(serverId, m.name, m.size, m.fingerprint, flag(m.matchesGamemode), flag(m.inCycle), flag(m.onCooldown), flag(m.isCurrent), flag(m.inVotePool), flag(m.votable), now)
      }
      db.prepare(`
        INSERT INTO server_map_state (server_id, current_map, next_map, gamemode, pattern, pool_basis, config_source, vote_addon, reported_at, map_addons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          current_map = excluded.current_map, next_map = excluded.next_map, gamemode = excluded.gamemode,
          pattern = excluded.pattern, pool_basis = excluded.pool_basis, config_source = excluded.config_source,
          vote_addon = excluded.vote_addon, reported_at = excluded.reported_at, map_addons = excluded.map_addons
      `).run(serverId, r.current, r.next, r.gamemode, r.pattern, r.poolBasis, r.configSource, r.voteAddon ? 1 : 0, now, JSON.stringify(r.mapAddons ?? []))
    })()
  }

  /** The server's latest map report: its maps (by name) and the state around them. `state` is null before the first report. */
  static getMaps(serverId: string): { state: MapsState | null, maps: MapRow[] } {
    const bool = (v: number | null) => (v === null ? null : v === 1)
    const rows = db.prepare('SELECT * FROM server_maps WHERE server_id = ? ORDER BY name').all(serverId) as any[]
    const st = db.prepare('SELECT * FROM server_map_state WHERE server_id = ?').get(serverId) as any
    return {
      maps: rows.map(r => ({
        name: r.name, size: r.size, fingerprint: r.fingerprint,
        matchesGamemode: bool(r.matches_gamemode), inCycle: bool(r.in_cycle), onCooldown: bool(r.on_cooldown),
        isCurrent: bool(r.is_current), inVotePool: bool(r.in_vote_pool), votable: bool(r.votable),
      })),
      state: st ? {
        current: st.current_map, next: st.next_map, gamemode: st.gamemode, pattern: st.pattern,
        poolBasis: st.pool_basis, configSource: st.config_source, voteAddon: st.vote_addon === 1, reportedAt: st.reported_at,
      } : null,
    }
  }

  /** Stores a floor-plan scan, replacing the server's previous plan for that map (RFC 10, 4.5). */
  static setMapPlan(serverId: string, p: MapPlan) {
    db.prepare(`
      INSERT INTO map_plans (server_id, map_name, fingerprint, cell, nx, ny, floor_cells, crouch_floors, seeds, traces, seconds, scanned_at, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, map_name) DO UPDATE SET
        fingerprint = excluded.fingerprint, cell = excluded.cell, nx = excluded.nx, ny = excluded.ny,
        floor_cells = excluded.floor_cells, crouch_floors = excluded.crouch_floors, seeds = excluded.seeds,
        traces = excluded.traces, seconds = excluded.seconds, scanned_at = excluded.scanned_at, plan = excluded.plan
    `).run(serverId, p.map, p.fingerprint, p.cell, p.nx, p.ny, p.floorCells, p.crouchFloors, p.seeds, p.traces, p.seconds, new Date().toISOString(), JSON.stringify(p.grid))
  }

  /** What is known about the server's stored plans, without the plans themselves. */
  static getMapPlans(serverId: string): MapPlanMeta[] {
    return (db.prepare(`
      SELECT map_name, fingerprint, cell, nx, ny, floor_cells, crouch_floors, seeds, scanned_at
      FROM map_plans WHERE server_id = ? ORDER BY map_name
    `).all(serverId) as any[]).map(r => ({
      map: r.map_name, fingerprint: r.fingerprint, cell: r.cell, nx: r.nx, ny: r.ny,
      floorCells: r.floor_cells, crouchFloors: r.crouch_floors, seeds: r.seeds, scannedAt: r.scanned_at,
    }))
  }

  /** The plan itself (grid as JSON text), or null. */
  static getMapPlan(serverId: string, map: string): string | null {
    const row = db.prepare('SELECT plan FROM map_plans WHERE server_id = ? AND map_name = ?').get(serverId, map) as { plan: string } | null
    return row ? row.plan : null
  }

  /** Switches exact geometry on or off for one of the server's maps (RFC 11, 3.1). */
  static setGeometryRequested(serverId: string, map: string, on: boolean, steamId: string | null) {
    if (on) {
      // Asking again is how a failed attempt is retried.
      db.prepare("DELETE FROM map_geometry WHERE map_name = ? AND status = 'failed'").run(map)
      db.prepare('INSERT OR IGNORE INTO map_geometry_requests (server_id, map_name, requested_by, requested_at) VALUES (?, ?, ?, ?)')
        .run(serverId, map, steamId, new Date().toISOString())
    } else {
      db.prepare('DELETE FROM map_geometry_requests WHERE server_id = ? AND map_name = ?').run(serverId, map)
    }
  }

  /**
   * For each map the server asked geometry for: the state of the row for the fingerprint the server
   * reported. `queued` when no row exists yet; `unknown` when the map has no fingerprint (nothing to
   * fetch against). Meshes are not loaded.
   */
  static getGeometryStates(serverId: string): Map<string, GeometryState> {
    const rows = db.prepare(`
      SELECT r.map_name AS map, m.fingerprint AS fingerprint, g.status AS status, g.detail AS detail, g.info AS info
      FROM map_geometry_requests r
      LEFT JOIN server_maps m ON m.server_id = r.server_id AND m.name = r.map_name
      LEFT JOIN map_geometry g ON g.map_name = r.map_name AND g.fingerprint = m.fingerprint
      WHERE r.server_id = ?
    `).all(serverId) as any[]
    const out = new Map<string, GeometryState>()
    for (const r of rows) {
      out.set(r.map, {
        fingerprint: r.fingerprint ?? null,
        status: r.fingerprint ? (r.status ?? 'queued') : 'unknown',
        detail: r.detail ?? null,
        info: r.info ? JSON.parse(r.info) : null,
      })
    }
    return out
  }

  /** Requested (server, map, fingerprint) triples that no job has picked up yet, oldest request first. */
  /** The Workshop addons that the servers asking for this map version have mounted (the places to look). */
  static getCandidateAddons(map: string, fingerprint: string): string[] {
    const rows = db.prepare(`
      SELECT st.map_addons AS a FROM map_geometry_requests r
      JOIN server_maps m ON m.server_id = r.server_id AND m.name = r.map_name AND m.fingerprint = ?
      JOIN server_map_state st ON st.server_id = r.server_id
      WHERE r.map_name = ?
    `).all(fingerprint, map) as { a: string | null }[]
    const out = new Set<string>()
    for (const r of rows) for (const id of r.a ? JSON.parse(r.a) : []) out.add(String(id))
    return [...out]
  }

  /** Addons already known to hold this exact map version. */
  static getKnownAddons(map: string, fingerprint: string): string[] {
    return (db.prepare('SELECT wsid FROM addon_maps WHERE map_name = ? AND fingerprint = ?').all(map, fingerprint) as any[]).map(r => r.wsid)
  }

  static isAddonScanned(wsid: string): boolean {
    return !!db.prepare('SELECT 1 FROM addon_scans WHERE wsid = ?').get(wsid)
  }

  /** Records what a downloaded addon holds (every map in it, whether or not anyone asked for it). */
  static recordAddonScan(wsid: string, maps: { name: string, fingerprint: string }[]) {
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO addon_scans (wsid, scanned_at) VALUES (?, ?)').run(wsid, new Date().toISOString())
      const ins = db.prepare('INSERT OR IGNORE INTO addon_maps (wsid, map_name, fingerprint) VALUES (?, ?, ?)')
      for (const m of maps) ins.run(wsid, m.name, m.fingerprint)
    })()
  }

  static getGeometryQueue(): { map: string, fingerprint: string }[] {
    return db.prepare(`
      SELECT r.map_name AS map, m.fingerprint AS fingerprint
      FROM map_geometry_requests r
      JOIN server_maps m ON m.server_id = r.server_id AND m.name = r.map_name AND m.fingerprint IS NOT NULL
      LEFT JOIN map_geometry g ON g.map_name = r.map_name AND g.fingerprint = m.fingerprint
      WHERE g.status IS NULL
      GROUP BY r.map_name, m.fingerprint
      ORDER BY MIN(r.requested_at)
    `).all() as any[]
  }

  /** Records that a job has taken the map (so it is not started twice), or replaces an earlier failure. */
  static startGeometry(map: string, fingerprint: string): boolean {
    const now = new Date().toISOString()
    const r = db.prepare(`
      INSERT INTO map_geometry (map_name, fingerprint, status, created_at) VALUES (?, ?, 'fetching', ?)
      ON CONFLICT(map_name, fingerprint) DO UPDATE SET status = 'fetching', detail = NULL, created_at = excluded.created_at
      WHERE status = 'failed'
    `).run(map, fingerprint, now)
    return r.changes > 0
  }

  static finishGeometry(map: string, fingerprint: string, r: { mesh: Uint8Array, info: unknown } | { error: string }) {
    if ('error' in r) {
      db.prepare("UPDATE map_geometry SET status = 'failed', detail = ?, mesh = NULL, info = NULL WHERE map_name = ? AND fingerprint = ?")
        .run(r.error.slice(0, 300), map, fingerprint)
    } else {
      db.prepare("UPDATE map_geometry SET status = 'parsed', detail = NULL, mesh = ?, info = ? WHERE map_name = ? AND fingerprint = ?")
        .run(r.mesh, JSON.stringify(r.info), map, fingerprint)
    }
  }

  /** Jobs that were running when the process stopped never finish; a restart puts them back in the queue. */
  static resetStaleGeometry() {
    db.run("DELETE FROM map_geometry WHERE status = 'fetching'")
  }

  /** The stored mesh for the map as this server reported it (same fingerprint), or null. */
  static getMesh(serverId: string, map: string): Uint8Array | null {
    const row = db.prepare(`
      SELECT g.mesh AS mesh FROM server_maps m
      JOIN map_geometry g ON g.map_name = m.name AND g.fingerprint = m.fingerprint AND g.status = 'parsed'
      WHERE m.server_id = ? AND m.name = ?
    `).get(serverId, map) as { mesh: Uint8Array } | null
    return row?.mesh ?? null
  }

  static updateHeartbeat(serverId: string) {
    const update = db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    update.run(new Date().toISOString(), serverId)
  }

  static getRoleHash(serverId: string, roleName: string): string | null {
    const query = db.prepare('SELECT md5_hash FROM roles WHERE server_id = ? AND role_name = ?')
    const row = query.get(serverId, roleName) as { md5_hash: string } | null
    return row ? row.md5_hash : null
  }

  static setRoleTeam(serverId: string, roleName: string, team: string) {
    db.prepare('UPDATE roles SET team = ? WHERE server_id = ? AND role_name = ? AND team != ?').run(team, serverId, roleName, team)
  }

  static saveSchema(serverId: string, roleName: string, team: string, isPolicing: boolean, baserole: number, schema: any[], md5Hash?: string, description: string | null = null, color: string | null = null) {
    this.updateHeartbeat(serverId)
    const upsert = db.prepare(`
      INSERT INTO roles (server_id, role_name, team, is_policing, baserole, schema_json, md5_hash, updated_at, description, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, role_name) DO UPDATE SET
        team = excluded.team,
        is_policing = excluded.is_policing,
        baserole = excluded.baserole,
        schema_json = excluded.schema_json,
        md5_hash = excluded.md5_hash,
        updated_at = excluded.updated_at,
        description = excluded.description,
        color = excluded.color
    `)
    const now = new Date().toISOString()
    upsert.run(serverId, roleName, team, isPolicing ? 1 : 0, baserole, JSON.stringify(schema), md5Hash || null, now, description, HEX6.test(color ?? '') ? color : null)
  }

  static getRoles(serverId: string): any[] {
    const query = db.prepare('SELECT role_name, team, is_policing, baserole, color FROM roles WHERE server_id = ? ORDER BY team ASC, role_name ASC')
    return query.all(serverId)
  }

  /** Replaces the server's role-to-addon list. `rows` are already checked. */
  static setRoleAddons(serverId: string, rows: { role: string, wsid: string, title: string }[]) {
    db.transaction(() => {
      db.run('DELETE FROM role_addons WHERE server_id = ?', [serverId])
      const insert = db.prepare('INSERT OR IGNORE INTO role_addons (server_id, role_name, wsid, title) VALUES (?, ?, ?, ?)')
      for (const r of rows) insert.run(serverId, r.role, r.wsid, r.title)
    })()
  }

  /** The addons a role comes from, each with the number of roles that addon holds on this server and the others it holds. */
  static getRoleAddons(serverId: string, roleName: string): { wsid: string, title: string, roles: string[] }[] {
    const own = db.prepare('SELECT wsid, title FROM role_addons WHERE server_id = ? AND role_name = ? ORDER BY wsid').all(serverId, roleName) as { wsid: string, title: string }[]
    return own.map(a => ({
      ...a,
      roles: (db.prepare('SELECT role_name FROM role_addons WHERE server_id = ? AND wsid = ? AND role_name != ? ORDER BY role_name').all(serverId, a.wsid, roleName) as { role_name: string }[]).map(r => r.role_name),
    }))
  }

  /** Every Workshop id any server's roles come from. */
  static getAllRoleAddonIds(): string[] {
    return (db.prepare('SELECT DISTINCT wsid FROM role_addons').all() as { wsid: string }[]).map(r => r.wsid)
  }

  /** Every Workshop id the server's roles come from. */
  static getRoleAddonIds(serverId: string): string[] {
    return (db.prepare('SELECT DISTINCT wsid FROM role_addons WHERE server_id = ?').all(serverId) as { wsid: string }[]).map(r => r.wsid)
  }

  static getWorkshopText(wsid: string): { title: string | null, description: string | null, status: string, fetchedAt: string } | null {
    const row = db.prepare('SELECT title, description, status, fetched_at FROM workshop_text WHERE wsid = ?').get(wsid) as any
    return row ? { title: row.title, description: row.description, status: row.status, fetchedAt: row.fetched_at } : null
  }

  static setWorkshopText(wsid: string, title: string | null, description: string | null, status: 'ok' | 'missing' | 'failed') {
    db.prepare(`INSERT INTO workshop_text (wsid, title, description, status, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wsid) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status, fetched_at = excluded.fetched_at`)
      .run(wsid, title, description, status, new Date().toISOString())
  }

  /** The role's description from the language files, as the extractor found it (untrusted text); null when it has none. */
  static getRoleDescription(serverId: string, roleName: string): string | null {
    const row = db.prepare('SELECT description FROM roles WHERE server_id = ? AND role_name = ?').get(serverId, roleName) as { description: string | null } | null
    return row?.description ?? null
  }

  /** Changes when anything the public role pages show changes: roles, live values or language files. */
  static getRoleDataVersion(serverId: string): string {
    const one = (sql: string) => JSON.stringify(db.prepare(sql).get(serverId))
    return [
      one('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM roles WHERE server_id = ?'),
      one('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM convar_values WHERE server_id = ?'),
      one('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM lang_files WHERE server_id = ?'),
    ].join('|')
  }

  static getSchema(serverId: string, roleName: string): any[] | null {
    const query = db.prepare('SELECT schema_json FROM roles WHERE server_id = ? AND role_name = ?')
    const row = query.get(serverId, roleName) as { schema_json: string } | null
    return row ? JSON.parse(row.schema_json) : null
  }

  static stageCommand(serverId: string, command: string, args: string) {
    const insert = db.prepare('INSERT INTO commands (server_id, command, args) VALUES (?, ?, ?)')
    insert.run(serverId, command, args)
  }

  /**
   * Commands waiting for a server. A bridge that sends `acked` (the ids it has applied)
   * gets at-least-once delivery: commands stay queued until acknowledged, so a lost response
   * or a crash mid-apply does not lose a change. Without `acked` (an older bridge) they are
   * deleted as soon as they are handed out. Unacknowledged commands expire after an hour.
   */
  static pollCommands(serverId: string, acked?: number[]): any[] {
    db.run("DELETE FROM commands WHERE server_id = ? AND staged_at < datetime('now', '-1 hour')", [serverId])
    if (acked && acked.length > 0) {
      const ids = acked.filter(n => Number.isInteger(n)).slice(0, 1000)
      if (ids.length > 0) {
        db.run(`DELETE FROM commands WHERE server_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [serverId, ...ids])
      }
    }

    const query = db.prepare('SELECT id, command, args FROM commands WHERE server_id = ? ORDER BY staged_at ASC, id ASC')
    const rows = query.all(serverId) as any[]

    if (rows.length > 0 && !acked) {
      const ids = rows.map(r => r.id).join(',')
      db.run(`DELETE FROM commands WHERE id IN (${ids})`)
    }

    return rows
  }

  /**
   * Replaces a server's language files. If anything changed, every role's cached
   * extraction is invalidated (md5_hash cleared): a role file can be unchanged while its
   * labels are not, and the bridge's md5 check would otherwise keep serving old labels.
   */
  static setLangFiles(serverId: string, files: Record<string, string>): { changed: boolean, stored: number } {
    const existing = new Map<string, string>(
      (db.prepare('SELECT name, hash FROM lang_files WHERE server_id = ?').all(serverId) as any[]).map(r => [r.name, r.hash])
    )
    const incoming = new Map(Object.entries(files).map(([name, content]) => [name, contentHash(content)]))

    let changed = existing.size !== incoming.size
    for (const [name, hash] of incoming) if (existing.get(name) !== hash) changed = true

    if (changed) {
      const upsert = db.prepare(`
        INSERT INTO lang_files (server_id, name, content, hash, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(server_id, name) DO UPDATE SET content = excluded.content, hash = excluded.hash, updated_at = excluded.updated_at
      `)
      const now = new Date().toISOString()
      db.transaction(() => {
        db.run('DELETE FROM lang_files WHERE server_id = ?', [serverId])
        for (const [name, content] of Object.entries(files)) upsert.run(serverId, name, content, incoming.get(name)!, now)
        db.run('UPDATE roles SET md5_hash = NULL WHERE server_id = ?', [serverId])
      })()
    }
    return { changed, stored: incoming.size }
  }

  /** Language file sources in load order: TTT2 core first, then the role addons alphabetically. */
  static getLangSources(serverId: string): string[] {
    const rows = db.prepare('SELECT name, content FROM lang_files WHERE server_id = ?').all(serverId) as any[]
    rows.sort((a, b) => (a.name === 'core' ? -1 : b.name === 'core' ? 1 : a.name.localeCompare(b.name)))
    return rows.map(r => r.content)
  }

  /** Live ConVar state as reported by a server's bridge (upserts, one transaction). */
  static setConVarValues(serverId: string, entries: LiveConVarEntry[]) {
    const upsert = db.prepare(`
      INSERT INTO convar_values (server_id, convar, role_name, present, value, default_value, min_value, max_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, convar) DO UPDATE SET
        role_name = COALESCE(excluded.role_name, convar_values.role_name),
        present = excluded.present,
        value = excluded.value,
        default_value = excluded.default_value,
        min_value = excluded.min_value,
        max_value = excluded.max_value,
        updated_at = excluded.updated_at
    `)
    const now = new Date().toISOString()
    db.transaction(() => {
      for (const e of entries) {
        upsert.run(serverId, e.name, e.role ?? null, e.present ? 1 : 0, e.value ?? null, e.default ?? null, e.min ?? null, e.max ?? null, now)
      }
    })()
  }

  /** Every reported ConVar for a server, keyed by ConVar name. */
  static getConVarValues(serverId: string): Record<string, LiveConVar> {
    const rows = db.prepare('SELECT convar, role_name, present, value, default_value, min_value, max_value, updated_at FROM convar_values WHERE server_id = ?').all(serverId) as any[]
    const out: Record<string, LiveConVar> = {}
    for (const r of rows) {
      out[r.convar] = {
        role: r.role_name,
        present: r.present === 1,
        value: r.value,
        default: r.default_value,
        min: r.min_value,
        max: r.max_value,
        updatedAt: r.updated_at,
      }
    }
    return out
  }
}

/** What the bridge sends per ConVar. */
export type LiveConVarEntry = {
  name: string
  role?: string | null
  present: boolean
  value?: string | null
  default?: string | null
  min?: number | null
  max?: number | null
}

/** What the UI reads back. */
export type LiveConVar = {
  role: string | null
  present: boolean
  value: string | null
  default: string | null
  min: number | null
  max: number | null
  updatedAt: string
}
