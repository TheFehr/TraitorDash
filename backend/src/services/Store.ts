import db from './Database'
import type { MapPlan } from './mapplan'
import { createHash } from 'node:crypto'
import { hashToken } from './migrations'
import { CODE_TTL_MS, generateCode, hashCode } from './pairing'

/** Change detection for language file contents. Not a security use: just "did this text change". */
const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')

// Never select api_token_hash for anything that can reach a template.
const SERVER_COLS = 'id, name, last_seen'

/** 256 random bits, hex. Shown to an admin once; only its hash is stored. */
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

/** Stats history kept per server; older rounds are removed as new ones arrive. */
export const MAX_ROUNDS_PER_SERVER = 50_000

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
}

export interface RoundReport {
  roundId: string
  map: string | null
  startedAt: string | null
  duration: number | null
  result: string
  players: { steamId: string, nick: string | null, role: string | null, team: string | null, survived: boolean, won: boolean }[]
  deaths: { victim: string, attacker: string | null, at: number | null }[]
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

  static deleteServer(id: string) {
    db.run('DELETE FROM roles WHERE server_id = ?', [id])
    db.run('DELETE FROM commands WHERE server_id = ?', [id])
    db.run('DELETE FROM authorized_admins WHERE server_id = ?', [id])
    db.run('DELETE FROM convar_values WHERE server_id = ?', [id])
    db.run('DELETE FROM lang_files WHERE server_id = ?', [id])
    db.run('DELETE FROM deaths WHERE server_id = ?', [id])
    db.run('DELETE FROM round_players WHERE server_id = ?', [id])
    db.run('DELETE FROM rounds WHERE server_id = ?', [id])
    db.run('DELETE FROM pairing_codes WHERE server_id = ?', [id])
    db.run('DELETE FROM server_maps WHERE server_id = ?', [id])
    db.run('DELETE FROM server_map_state WHERE server_id = ?', [id])
    db.run('DELETE FROM map_plans WHERE server_id = ?', [id])
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
        'INSERT OR REPLACE INTO round_players (server_id, round_id, steam_id, nick, role, team, survived, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const p of r.players) {
        player.run(serverId, r.roundId, p.steamId, p.nick, p.role, p.team, p.survived ? 1 : 0, p.won ? 1 : 0)
      }
      const death = db.prepare(
        'INSERT INTO deaths (server_id, round_id, victim_steam_id, attacker_steam_id, at_seconds) VALUES (?, ?, ?, ?, ?)'
      )
      for (const d of r.deaths) death.run(serverId, r.roundId, d.victim, d.attacker, d.at)

      const old = db.prepare(
        'SELECT round_id FROM rounds WHERE server_id = ? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?'
      ).all(serverId, keep) as { round_id: string }[]
      for (const { round_id } of old) {
        db.run('DELETE FROM deaths WHERE server_id = ? AND round_id = ?', [serverId, round_id])
        db.run('DELETE FROM round_players WHERE server_id = ? AND round_id = ?', [serverId, round_id])
        db.run('DELETE FROM rounds WHERE server_id = ? AND round_id = ?', [serverId, round_id])
      }
      return true
    })()
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
        INSERT INTO server_map_state (server_id, current_map, next_map, gamemode, pattern, pool_basis, config_source, vote_addon, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          current_map = excluded.current_map, next_map = excluded.next_map, gamemode = excluded.gamemode,
          pattern = excluded.pattern, pool_basis = excluded.pool_basis, config_source = excluded.config_source,
          vote_addon = excluded.vote_addon, reported_at = excluded.reported_at
      `).run(serverId, r.current, r.next, r.gamemode, r.pattern, r.poolBasis, r.configSource, r.voteAddon ? 1 : 0, now)
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

  static updateHeartbeat(serverId: string) {
    const update = db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    update.run(new Date().toISOString(), serverId)
  }

  static getRoleHash(serverId: string, roleName: string): string | null {
    const query = db.prepare('SELECT md5_hash FROM roles WHERE server_id = ? AND role_name = ?')
    const row = query.get(serverId, roleName) as { md5_hash: string } | null
    return row ? row.md5_hash : null
  }

  static saveSchema(serverId: string, roleName: string, team: string, isPolicing: boolean, baserole: number, schema: any[], md5Hash?: string) {
    this.updateHeartbeat(serverId)
    const upsert = db.prepare(`
      INSERT INTO roles (server_id, role_name, team, is_policing, baserole, schema_json, md5_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, role_name) DO UPDATE SET
        team = excluded.team,
        is_policing = excluded.is_policing,
        baserole = excluded.baserole,
        schema_json = excluded.schema_json,
        md5_hash = excluded.md5_hash,
        updated_at = excluded.updated_at
    `)
    const now = new Date().toISOString()
    upsert.run(serverId, roleName, team, isPolicing ? 1 : 0, baserole, JSON.stringify(schema), md5Hash || null, now)
  }

  static getRoles(serverId: string): any[] {
    const query = db.prepare('SELECT role_name, team, is_policing, baserole FROM roles WHERE server_id = ? ORDER BY team ASC, role_name ASC')
    return query.all(serverId)
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
