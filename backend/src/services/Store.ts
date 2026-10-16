import db from './Database'
import { hashToken } from './migrations'

// Never select api_token_hash for anything that can reach a template.
const SERVER_COLS = 'id, name, last_seen'

/** 256 random bits, hex. Shown to an admin once; only its hash is stored. */
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

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
    db.run('DELETE FROM servers WHERE id = ?', [id])
  }

  /** Stores one finished round. Returns false (and stores nothing) if this round_id was already recorded. */
  static recordRound(serverId: string, r: RoundReport): boolean {
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
      return true
    })()
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

  static pollCommands(serverId: string): any[] {
    const query = db.prepare('SELECT id, command, args FROM commands WHERE server_id = ? ORDER BY staged_at ASC')
    const rows = query.all(serverId) as any[]

    if (rows.length > 0) {
      // Clear polled commands
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
    const incoming = new Map(Object.entries(files).map(([name, content]) => [name, hashToken(content)]))

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
