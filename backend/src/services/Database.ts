import { Database } from 'bun:sqlite'

const db = new Database('traitordash.sqlite', { create: true })

let { user_version } = db.query('PRAGMA user_version').get() as { user_version: number }

// Legacy database detection: assign a version to unversioned databases
if (user_version === 0) {
  const hasServersTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='servers'").get()
  if (hasServersTable) {
    const rolesTable = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='roles'").get() as { sql: string }
    if (rolesTable && rolesTable.sql.includes('md5_hash')) {
      user_version = 2
      db.run('PRAGMA user_version = 2')
    } else {
      user_version = 1
      db.run('PRAGMA user_version = 1')
    }
  }
}

const migrations = [
  // v1: Initial Schema (RFC 1-6 base)
  () => {
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
  () => {
    const tableInfo = db.query("PRAGMA table_info(roles)").all() as any[]
    const columns = tableInfo.map(c => c.name)
    
    if (!columns.includes('team')) db.run('ALTER TABLE roles ADD COLUMN team TEXT DEFAULT "unknown"')
    if (!columns.includes('is_policing')) db.run('ALTER TABLE roles ADD COLUMN is_policing BOOLEAN DEFAULT 0')
    if (!columns.includes('baserole')) db.run('ALTER TABLE roles ADD COLUMN baserole INTEGER DEFAULT -1')
    if (!columns.includes('md5_hash')) db.run('ALTER TABLE roles ADD COLUMN md5_hash TEXT')
  }
]

// Apply pending migrations transactionally
if (user_version < migrations.length) {
  db.transaction(() => {
    for (let i = user_version; i < migrations.length; i++) {
      const migration = migrations[i]
      if (migration) {
        console.log(`[Database] Applying migration v${i + 1}...`)
        migration()
      }
    }
    db.run(`PRAGMA user_version = ${migrations.length}`)
  })()
}

export default db
