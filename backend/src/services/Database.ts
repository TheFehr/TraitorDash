import { Database } from 'bun:sqlite'

const db = new Database('traitordash.sqlite', { create: true })

// Initialize Tables
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
    team TEXT DEFAULT 'unknown',
    is_policing BOOLEAN DEFAULT 0,
    baserole INTEGER DEFAULT -1,
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

export default db
