import { expect, test, describe, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { serializeSigned } from 'hono/utils/cookie'

// Edge cases from the test-gap audit that had no test: upgrading a populated database to the
// latest schema, the heartbeat boundary, value normalisation, and the sidebar filter.
const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { migrate, migrations } from '../src/services/migrations'
import { isServerOnline, HEARTBEAT_THRESHOLD_MS } from '../src/services/ServerUtils'
import { normalizeConVarValue } from '../src/services/convars'

const version = (db: Database) => (db.query('PRAGMA user_version').get() as any).user_version
const tables = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map(r => r.name)

describe('upgrading a populated database', () => {
  for (const from of [5, 6]) {
    test(`from v${from}: existing data survives and the stats tables appear`, () => {
      const db = new Database(':memory:')
      for (const m of migrations.slice(0, from)) m(db)
      db.run(`PRAGMA user_version = ${from}`)
      db.run("INSERT INTO servers (id, name, api_token_hash) VALUES ('s1', 'Old', 'hash')")
      db.run("INSERT INTO commands (server_id, command, args) VALUES ('s1', 'convar', 'ttt_a 1')")
      db.run("INSERT INTO convar_values (server_id, convar, present, value) VALUES ('s1', 'ttt_a', 1, '1')")
      expect(tables(db)).not.toContain('rounds')

      migrate(db)

      expect(version(db)).toBe(migrations.length)
      expect(tables(db)).toEqual(expect.arrayContaining(['rounds', 'round_players', 'deaths']))
      expect((db.query("SELECT name FROM servers WHERE id = 's1'").get() as any).name).toBe('Old')
      expect((db.query('SELECT COUNT(*) AS n FROM commands').get() as any).n).toBe(1)
      expect((db.query('SELECT value FROM convar_values').get() as any).value).toBe('1')
      // and the new tables work
      db.run("INSERT INTO rounds (server_id, round_id, result) VALUES ('s1', 'r1', 'traitors')")
      migrate(db) // running it again is a no-op
      expect((db.query('SELECT COUNT(*) AS n FROM rounds').get() as any).n).toBe(1)
    })
  }
})

describe('isServerOnline', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  test('the threshold is 60 seconds: just inside is online, at and past it is not', () => {
    expect(HEARTBEAT_THRESHOLD_MS).toBe(60_000)
    expect(isServerOnline(ago(59_000))).toBe(true)
    expect(isServerOnline(ago(61_000))).toBe(false)
  })

  test('never seen and unparseable timestamps are offline', () => {
    expect(isServerOnline(null)).toBe(false)
    expect(isServerOnline('')).toBe(false)
    expect(isServerOnline('not a date')).toBe(false)
  })
})

describe('normalizeConVarValue edges', () => {
  test('whitespace is trimmed and an empty value stays empty', () => {
    expect(normalizeConVarValue('   ')).toBe('')
    expect(normalizeConVarValue('')).toBe('')
    expect(normalizeConVarValue('  42  ')).toBe('42')
  })

  test('numbers in exponent form pass through unchanged', () => {
    expect(normalizeConVarValue('1e5')).toBe('1e5')
    expect(normalizeConVarValue('-0.25')).toBe('-0.25')
  })

  test('on/off words are normalised in any case', () => {
    expect(normalizeConVarValue('ON')).toBe('1')
    expect(normalizeConVarValue('True')).toBe('1')
    expect(normalizeConVarValue('Off')).toBe('0')
    expect(normalizeConVarValue('FALSE')).toBe('0')
  })

  test('length limit and non-text values', () => {
    expect(normalizeConVarValue('a'.repeat(64))).toBe('a'.repeat(64))
    expect(normalizeConVarValue('a'.repeat(65))).toBeNull()
    for (const v of [null, undefined, 5, true, {}, [], new File(['x'], 'f.txt')]) expect(normalizeConVarValue(v)).toBeNull()
  })

  test('unicode, control characters and shell/console metacharacters are refused', () => {
    for (const v of ['é', '日本', '1\u0000', '1\t2', 'a;b', 'a"b', "a'b", 'a\\b', 'a`b', 'a$b', 'a{b}', 'a|b', 'a&b', 'a#b', '$(id)']) {
      expect(normalizeConVarValue(v)).toBeNull()
    }
  })
})

describe('GET /sidebar/:serverId', () => {
  let app: any, serverId: string, cookie: string
  beforeAll(async () => {
    app = (await import('../src/index')).default
    const Store = (await import('../src/services/Store')).Store
    serverId = Store.addServer('Side').id
    for (const r of ['survivalist', 'surgeon', 'medic', 'detective']) Store.saveSchema(serverId, r, 'innocents', false, 0, [])
    cookie = (await serializeSigned('steam_id', '76561198000000000', SECRET)).split(';')[0]!
  })
  const get = (q: string, withCookie = true) =>
    app.fetch(new Request(`http://x/sidebar/${serverId}${q}`, { headers: withCookie ? { Cookie: cookie } : {} }))

  test('needs an admin session', async () => {
    expect((await get('', false)).status).toBe(401)
  })

  test('filters roles by the search text, case-insensitively', async () => {
    const html = await (await get('?q=SUR')).text()
    expect(html).toContain('survivalist')
    expect(html).toContain('surgeon')
    expect(html).not.toContain('medic')
    expect(html).not.toContain('detective')
  })

  test('no query lists every role, and a query that matches nothing lists none', async () => {
    const all = await (await get('')).text()
    for (const r of ['survivalist', 'surgeon', 'medic', 'detective']) expect(all).toContain(r)
    expect((await (await get('?q=zzzz')).text()).trim()).toBe('')
  })

  test('the search text is escaped, not interpreted', async () => {
    const res = await get(`?q=${encodeURIComponent('<script>alert(1)</script>')}`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('<script>')
  })
})
