import { expect, test, describe } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate, migrations, hashToken } from '../src/services/migrations'

const version = (db: Database) => (db.query('PRAGMA user_version').get() as any).user_version
const columns = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name)

describe('migrations', () => {
  test('a fresh database ends at the latest schema with hashed tokens', () => {
    const db = new Database(':memory:')
    migrate(db)

    expect(version(db)).toBe(migrations.length)
    expect(columns(db, 'servers')).toEqual(['id', 'name', 'api_token_hash', 'last_seen', 'track_keep_count', 'track_keep_mb'])
    expect(columns(db, 'audit_log')).toContain('action')
    expect(columns(db, 'authorized_admins')).toContain('steam_id')
  })

  test('a v2 database with plaintext tokens is upgraded and the old token still matches', () => {
    const db = new Database(':memory:')
    // The schema this codebase created before token hashing existed.
    for (const m of migrations.slice(0, 2)) m(db)
    db.run('PRAGMA user_version = 2')
    db.run("INSERT INTO servers (id, name, api_token) VALUES ('s1', 'Old', 'plain-token-123')")

    migrate(db)

    expect(version(db)).toBe(migrations.length)
    expect(columns(db, 'servers')).not.toContain('api_token')
    const row = db.query('SELECT api_token_hash FROM servers WHERE id = ?').get('s1') as any
    expect(row.api_token_hash).toBe(hashToken('plain-token-123'))
    expect(row.api_token_hash).not.toContain('plain-token')
  })

  test('an unversioned legacy database is detected and upgraded', () => {
    const db = new Database(':memory:')
    for (const m of migrations.slice(0, 2)) m(db) // user_version stays 0
    db.run("INSERT INTO servers (id, name, api_token) VALUES ('s1', 'Legacy', 'tok')")

    migrate(db)

    expect(version(db)).toBe(migrations.length)
    expect(columns(db, 'servers')).toContain('api_token_hash')
  })

  test('a database already at v4 (the previously deployed dashboard) keeps its data and gains only the newer tables', () => {
    const db = new Database(':memory:')
    // Schema as found on the live volume.
    db.run(`CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_token_hash TEXT NOT NULL UNIQUE, last_seen DATETIME)`)
    db.run(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT, steam_id TEXT, action TEXT NOT NULL, details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    db.run(`INSERT INTO servers (id, name, api_token_hash) VALUES ('s1', 'Live', '${'f'.repeat(64)}')`)
    db.run('PRAGMA user_version = 4')

    migrate(db)

    // Only migrations after v4 run: servers is not rebuilt, so the existing hash survives as-is.
    expect(version(db)).toBe(migrations.length)
    const row = db.query('SELECT api_token_hash FROM servers WHERE id = ?').get('s1') as any
    expect(row.api_token_hash).toBe('f'.repeat(64))
    expect(columns(db, 'convar_values')).toContain('present')
  })

  test('a database from a newer build is refused rather than mangled', () => {
    const db = new Database(':memory:')
    db.run(`PRAGMA user_version = ${migrations.length + 1}`)
    expect(() => migrate(db)).toThrow(/newer than this build/)
  })
})
