import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

// API tokens are 256 random bits (see Store.newToken), not passwords: there is nothing to
// brute-force, so a fast hash is the right tool (a slow password hash would only add cost to
// every bridge request, which checks the token on each poll). Same approach as GitHub's.
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Versioned schema migrations, tracked with PRAGMA user_version.
 *
 * v3/v4 bring this codebase in line with the schema the previously deployed
 * dashboard already ran at (user_version 4): hashed API tokens and an audit
 * log. A database already at v4 is therefore adopted as-is.
 */
export const migrations: Array<(db: Database) => void> = [
  // v1: Initial Schema (RFC 1-6 base)
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_token TEXT NOT NULL UNIQUE,
        last_seen DATETIME
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS roles (
        server_id TEXT,
        role_name TEXT,
        schema_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, role_name),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS config (
        server_id TEXT,
        convar TEXT,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, convar),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        staged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
  },
  // v2: Added columns for RFCs and MD5 caching
  (db) => {
    const tableInfo = db.query("PRAGMA table_info(roles)").all() as any[]
    const columns = tableInfo.map(c => c.name)

    if (!columns.includes('team')) db.run('ALTER TABLE roles ADD COLUMN team TEXT DEFAULT "unknown"')
    if (!columns.includes('is_policing')) db.run('ALTER TABLE roles ADD COLUMN is_policing BOOLEAN DEFAULT 0')
    if (!columns.includes('baserole')) db.run('ALTER TABLE roles ADD COLUMN baserole INTEGER DEFAULT -1')
    if (!columns.includes('md5_hash')) db.run('ALTER TABLE roles ADD COLUMN md5_hash TEXT')
  },
  // v3: Audit log and per-server authorized admins (RFC 5)
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS authorized_admins (
        server_id TEXT,
        steam_id TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, steam_id),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        steam_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
  },
  // v4: Store only a hash of each server's API token. Existing plaintext tokens
  // are hashed in place, so bridges already configured with them keep working.
  (db) => {
    const columns = (db.query('PRAGMA table_info(servers)').all() as any[]).map(c => c.name)
    if (columns.includes('api_token_hash')) return

    db.run(`
      CREATE TABLE servers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_token_hash TEXT NOT NULL UNIQUE,
        last_seen DATETIME
      )
    `)
    const insert = db.prepare('INSERT INTO servers_new (id, name, api_token_hash, last_seen) VALUES (?, ?, ?, ?)')
    for (const row of db.query('SELECT id, name, api_token, last_seen FROM servers').all() as any[]) {
      insert.run(row.id, row.name, hashToken(row.api_token), row.last_seen)
    }
    db.run('DROP TABLE servers')
    db.run('ALTER TABLE servers_new RENAME TO servers')
  },
  // v5: live ConVar state reported by the game server's bridge: current value,
  // default, bounds, and whether the ConVar exists at all on that server.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS convar_values (
        server_id TEXT NOT NULL,
        convar TEXT NOT NULL,
        role_name TEXT,
        present INTEGER NOT NULL DEFAULT 1,
        value TEXT,
        default_value TEXT,
        min_value REAL,
        max_value REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, convar),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
  },
  // v6: the game server's English language files (TTT2 core + one per role addon),
  // pushed once per sync by the bridge. They resolve `label_*` translation keys while
  // a role's settings menu is extracted.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS lang_files (
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, name),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
  },
  // v7: per-round stats reported by the bridge once a round has ended. A round is
  // identified by the bridge-generated round_id, so a repeated POST is a no-op.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS rounds (
        server_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        map TEXT,
        started_at TEXT,
        duration INTEGER,
        result TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, round_id),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS round_players (
        server_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        nick TEXT,
        role TEXT,
        team TEXT,
        survived INTEGER NOT NULL DEFAULT 0,
        won INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, round_id, steam_id),
        FOREIGN KEY (server_id, round_id) REFERENCES rounds(server_id, round_id)
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_round_players_steam ON round_players (server_id, steam_id)')
    db.run(`
      CREATE TABLE IF NOT EXISTS deaths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        victim_steam_id TEXT NOT NULL,
        attacker_steam_id TEXT,
        at_seconds INTEGER,
        FOREIGN KEY (server_id, round_id) REFERENCES rounds(server_id, round_id)
      )
    `)
  },
  // v8: single-use pairing codes (RFC 9). Only the hash of a code is stored, and the partial
  // unique index allows one outstanding (unused) code per server.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash  TEXT PRIMARY KEY,
        server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      )
    `)
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS pairing_codes_open ON pairing_codes(server_id) WHERE used_at IS NULL')
  },
  // v9: the maps a server has and which of them it will play (RFC 10). The bridge's latest report
  // replaces the previous one as a whole. The flags are nullable: NULL means "not known", which is
  // different from "no" (for example, there was no gamemode pattern to match against).
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS server_maps (
        server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        size             INTEGER,
        fingerprint      TEXT,
        matches_gamemode INTEGER,
        in_cycle         INTEGER,
        on_cooldown      INTEGER,
        is_current       INTEGER,
        in_vote_pool     INTEGER,
        votable          INTEGER,
        seen_at          TEXT NOT NULL,
        PRIMARY KEY (server_id, name)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS server_map_state (
        server_id     TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        current_map   TEXT,
        next_map      TEXT,
        gamemode      TEXT,
        pattern       TEXT,
        pool_basis    TEXT,
        config_source TEXT,
        vote_addon    INTEGER NOT NULL DEFAULT 0,
        reported_at   TEXT NOT NULL
      )
    `)
  },
  // v10: the latest floor-plan scan per server and map (RFC 10, 4.5). The plan is the grid as JSON
  // text; the counts are computed by the backend from it, never taken from the client.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS map_plans (
        server_id     TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        map_name      TEXT NOT NULL,
        fingerprint   TEXT,
        cell          INTEGER NOT NULL,
        nx            INTEGER NOT NULL,
        ny            INTEGER NOT NULL,
        floor_cells   INTEGER NOT NULL,
        crouch_floors INTEGER NOT NULL,
        seeds         INTEGER NOT NULL,
        traces        INTEGER,
        seconds       REAL,
        scanned_at    TEXT NOT NULL,
        plan          TEXT NOT NULL,
        PRIMARY KEY (server_id, map_name)
      )
    `)
  },

  // v11: exact map geometry (RFC 11). The mesh belongs to the map file, so it is keyed by
  // (map name, fingerprint) and shared by every server with that version. Who asked for it is per
  // server, and kept apart from server_maps because a map report replaces that table as a whole.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS map_geometry (
        map_name    TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status      TEXT NOT NULL,
        detail      TEXT,
        mesh        BLOB,
        info        TEXT,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (map_name, fingerprint)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS map_geometry_requests (
        server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        map_name     TEXT NOT NULL,
        requested_by TEXT,
        requested_at TEXT NOT NULL,
        PRIMARY KEY (server_id, map_name)
      )
    `)
  },

  // v12: the Workshop IDs of a server's mounted map addons, as reported (RFC 11, 3.2): where the
  // backend looks when it fetches a map's file. And what was found inside the addons it has
  // downloaded, so the next request for any of those maps skips the search.
  (db) => {
    db.run('ALTER TABLE server_map_state ADD COLUMN map_addons TEXT')
    db.run(`
      CREATE TABLE IF NOT EXISTS addon_maps (
        wsid        TEXT NOT NULL,
        map_name    TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (wsid, map_name, fingerprint)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS addon_scans (
        wsid       TEXT PRIMARY KEY,
        scanned_at TEXT NOT NULL
      )
    `)
  }
]

/** Brings `db` up to the latest schema, in one transaction. */
export function migrate(db: Database) {
  let { user_version } = db.query('PRAGMA user_version').get() as { user_version: number }

  // Legacy database detection: assign a version to unversioned databases
  if (user_version === 0) {
    const hasServersTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='servers'").get()
    if (hasServersTable) {
      const rolesTable = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='roles'").get() as { sql: string }
      user_version = rolesTable && rolesTable.sql.includes('md5_hash') ? 2 : 1
      db.run(`PRAGMA user_version = ${user_version}`)
    }
  }

  if (user_version > migrations.length) {
    throw new Error(`Database is at schema v${user_version}, newer than this build supports (v${migrations.length}).`)
  }

  if (user_version < migrations.length) {
    db.transaction(() => {
      for (let i = user_version; i < migrations.length; i++) {
        console.log(`[Database] Applying migration v${i + 1}...`)
        migrations[i]!(db)
      }
      db.run(`PRAGMA user_version = ${migrations.length}`)
    })()
  }
}
