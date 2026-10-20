// Authorization boundaries, token lifecycle, the poll queue, /ingest, save and server deletion.
// Ported from the test-gap audit's scratch tests.
import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'
let app: any, Store: any, db: any, A: any, B: any, cookie: string
beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})
// Two fresh servers for every test (A has a role 'r'), so no test depends on another and the
// suite passes in any order. All test files share one in-memory database.
beforeEach(() => {
  A = Store.addServer('A'); B = Store.addServer('B')
  Store.saveSchema(A.id, 'r', 'innocents', false, -1, [{ type: 'conVarData', args: { convar: 'ttt_r_pct' } }])
})
const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost:3000' + path, init))
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

describe('authorization matrix: every admin route refuses an anonymous caller', () => {
  const routes: [string, string][] = [
    ['GET', '/api/servers'], ['POST', '/api/servers'], ['DELETE', '/api/servers/x'], ['POST', '/api/servers/x/regenerate-token'],
    ['POST', '/api/save/x/y'], ['GET', '/sidebar/x'],
  ]
  for (const [m, p] of routes) test(`${m} ${p}`, async () => {
    const r = await req(p, { method: m, body: m === 'POST' ? 'name=x' : undefined, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(r.status).toBe(401)
  })
  // /servers/:id/stats and /players/:id are public on purpose (see stats_pages.test.tsx).
  for (const p of ['/servers', `/servers/${'x'}`, '/servers/x/roles/r/config'])
    test(`GET ${p} redirects to /`, async () => { const r = await req(p); expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/') })
  test('guest home page never leaks tokens / hashes', async () => {
    const html = await (await req('/')).text(); expect(html).not.toContain(A.token); expect(html).not.toMatch(/[0-9a-f]{64}/)
  })
  test('bridge routes refuse a session cookie (bearer only) and admin routes refuse a server token', async () => {
    expect((await req('/api/v1/poll', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(401)
    expect((await req('/api/servers', { headers: bearer(A.token) })).status).toBe(401)
    expect((await req(`/api/save/${A.id}/r`, { method: 'POST', headers: bearer(A.token), body: '{}' })).status).toBe(401)
  })
  test('malformed Authorization headers', async () => {
    for (const h of ['Bearer', 'Bearer ', 'bearer ' + A.token, 'Basic abc', A.token])
      expect((await req('/api/v1/poll', { method: 'POST', headers: { Authorization: h } })).status).toBe(401)
  })
})

describe('token lifecycle', () => {
  test('regenerate-token invalidates the old token, new one works; delete kills the token', async () => {
    const s = Store.addServer('Life')
    const r = await req(`/api/servers/${s.id}/regenerate-token`, { method: 'POST', headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
    expect((await req('/api/v1/poll', { method: 'POST', headers: bearer(s.token) })).status).toBe(401)
    const fresh = Store.regenerateToken(s.id)
    expect((await req('/api/v1/poll', { method: 'POST', headers: bearer(fresh) })).status).toBe(200)
    await req(`/api/servers/${s.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect((await req('/api/v1/poll', { method: 'POST', headers: bearer(fresh) })).status).toBe(401)
  })
  test('regenerate for an unknown server -> 404 and nothing is audited', async () => {
    const before = (db.query('SELECT COUNT(*) n FROM audit_log').get() as any).n
    expect((await req('/api/servers/nope/regenerate-token', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(404)
    expect((db.query('SELECT COUNT(*) n FROM audit_log').get() as any).n).toBe(before)
  })
  test('the plaintext token is shown once: responses are no-store and a later listing has no token', async () => {
    const r = await req('/api/servers', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Once' })
    expect(r.headers.get('cache-control')).toBe('no-store')
    const html = await r.text(); const tok = html.match(/[0-9a-f]{64}/)![0]
    const list = await (await req('/api/servers', { headers: { Cookie: cookie } })).text()
    expect(list).not.toContain(tok)
  })
})

describe('poll / command queue', () => {
  const poll = (t: string, body: string = '{}') => req('/api/v1/poll', { method: 'POST', headers: bearer(t), body })
  test('commands are delivered once, in staging order, only to their own server', async () => {
    Store.stageCommand(A.id, 'convar', 'ttt_r_pct 1'); Store.stageCommand(A.id, 'convar', 'ttt_r_pct 2'); Store.stageCommand(B.id, 'convar', 'ttt_b 9')
    for (let i = 0; i < 30; i++) Store.stageCommand(A.id, 'convar', `ttt_r_pct ${10 + i}`)  // same second
    const got = (await (await poll(A.token)).json()).commands.map((c: any) => c.payload)
    expect(got.slice(0, 2)).toEqual(['ttt_r_pct 1', 'ttt_r_pct 2'])
    expect(got.length).toBe(32)
    expect(got).toEqual(['ttt_r_pct 1', 'ttt_r_pct 2', ...Array.from({ length: 30 }, (_, i) => `ttt_r_pct ${10 + i}`)])
    expect((await (await poll(A.token)).json()).commands).toEqual([])
    expect((await (await poll(B.token)).json()).commands.map((c: any) => c.payload)).toEqual(['ttt_b 9'])
  })
  test('a "data" command with corrupt JSON is delivered as the raw string, not a 500', async () => {
    Store.stageCommand(A.id, 'data', '{not json')
    const r = await poll(A.token); expect(r.status).toBe(200)
    expect((await r.json()).commands[0]).toMatchObject({ type: 'data', payload: '{not json' })
  })
  test('poll with a body that is valid JSON but not an object ("null") is not a 500', async () => {
    expect((await poll(A.token, 'null')).status).toBe(200)
  })
  test('poll with garbage / empty body still heartbeats', async () => {
    expect((await poll(A.token, '')).status).toBe(200)
    expect((await poll(A.token, '{{{')).status).toBe(200)
    expect(Store.getServerById(A.id).last_seen).not.toBeNull()
  })
  test('/ingest with body "null" or an array is a 400, not a 500', async () => {
    for (const body of ['null', '[]', '"str"']) {
      const r = await req('/api/ingest', { method: 'POST', headers: bearer(A.token), body })
      expect(r.status).toBe(400)
    }
  })
  test('/ingest md5 cache: same hash -> cached:true with schema; force:true re-extracts', async () => {
    const code = 'function ROLE:AddToSettingsMenu(p) p:MakeCheckbox({ label = "x", convar = "ttt_c" }) end'
    const post = (b: any) => req('/api/ingest', { method: 'POST', headers: bearer(A.token), body: JSON.stringify(b) }).then((r: Response) => r.json())
    expect((await post({ role_name: 'c', role_code: code, md5_hash: 'h1' })).cached).toBe(false)
    const again = await post({ role_name: 'c', role_code: code, md5_hash: 'h1' })
    expect(again.cached).toBe(true); expect(again.schema[0].args.convar).toBe('ttt_c')
    expect((await post({ role_name: 'c', role_code: code, md5_hash: 'h1', force: true })).cached).toBe(false)
    expect((await post({ role_name: 'c', md5_hash: 'h1' }))).toEqual({ error: 'Missing role_code' })
  })
  test('/ingest md5 cache is per server (same role+hash on server B is NOT a cache hit)', async () => {
    const post = (t: string) => req('/api/ingest', { method: 'POST', headers: bearer(t), body: JSON.stringify({ role_name: 'c', role_code: code, md5_hash: 'h1' }) }).then((r: Response) => r.json())
    const code = 'function ROLE:AddToSettingsMenu(p) p:MakeCheckbox({ label = "x", convar = "ttt_c" }) end'
    expect((await post(A.token)).cached).toBe(false)
    expect((await post(A.token)).cached).toBe(true)
    expect((await post(B.token)).cached).toBe(false)
  })
  test('broken role code -> 500 with success:false, and nothing is stored', async () => {
    const r = await req('/api/ingest', { method: 'POST', headers: bearer(A.token), body: JSON.stringify({ role_name: 'broken', role_code: 'function (((' }) })
    expect(r.status).toBe(500); expect(Store.getSchema(A.id, 'broken')).toBeNull()
  })
})

describe('save boundaries', () => {
  const save = (sid: string, role: string, body: string, ck = cookie) => req(`/api/save/${sid}/${role}`, { method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  test('unknown server / unknown role -> 400 and nothing staged', async () => {
    db.run('DELETE FROM commands WHERE server_id IN (?, ?)', [A.id, 'nope'])
    expect((await save('nope', 'r', 'ttt_r_pct=1')).status).toBe(400)
    expect((await save(A.id, 'nope', 'ttt_r_pct=1')).status).toBe(400)
    expect((db.query('SELECT COUNT(*) n FROM commands WHERE server_id IN (?, ?)').get(A.id, 'nope') as any).n).toBe(0)
  })
  test("a role's schema on server A cannot be used to stage commands on server B", async () => {
    expect((await save(B.id, 'r', 'ttt_r_pct=1')).status).toBe(400)
  })
  test('empty save stages nothing and writes no audit row', async () => {
    const before = (db.query("SELECT COUNT(*) n FROM audit_log WHERE action='SAVE_CONFIG'").get() as any).n
    const r = await save(A.id, 'r', ''); expect((await r.json()).commands_staged).toBe(0)
    expect((db.query("SELECT COUNT(*) n FROM audit_log WHERE action='SAVE_CONFIG'").get() as any).n).toBe(before)
  })
  test('a schema-declared ConVar NAME containing a newline/semicolon must never become a staged command', async () => {
    Store.saveSchema(A.id, 'evil', 'x', false, -1, [{ type: 'conVarData', args: { convar: 'ttt_real 1\nquit' } }])
    db.run('DELETE FROM commands WHERE server_id = ?', [A.id])
    await save(A.id, 'evil', new URLSearchParams({ 'ttt_real 1\nquit': '1' }).toString())
    const staged = (db.query('SELECT args FROM commands WHERE server_id = ?').all(A.id) as any[]).map(r => r.args)
    expect(staged.some(a => a.includes('\n'))).toBe(false)
  })
})

describe('deleteServer leaves no orphans', () => {
  test('every per-server table is emptied', async () => {
    const s = Store.addServer('Gone')
    Store.saveSchema(s.id, 'r', 't', false, -1, []); Store.stageCommand(s.id, 'convar', 'a 1')
    Store.setLangFiles(s.id, { core: 'x' }); Store.setConVarValues(s.id, [{ name: 'ttt_a', present: true }])
    Store.recordRound(s.id, { roundId: 'round-gone-1', map: null, startedAt: null, duration: null, result: 'x', players: [{ steamId: '76561198000000001', nick: 'n', role: null, team: null, survived: true, won: true }], deaths: [{ victim: '76561198000000001', attacker: null, at: 1 }] })
    db.run("INSERT INTO authorized_admins (server_id, steam_id) VALUES (?, '1')", [s.id])
    Store.deleteServer(s.id)
    for (const t of ['servers', 'roles', 'commands', 'authorized_admins', 'convar_values', 'lang_files', 'rounds', 'round_players', 'deaths', 'config']) {
      const col = t === 'servers' ? 'id' : 'server_id'
      expect([t, (db.query(`SELECT COUNT(*) n FROM ${t} WHERE ${col} = ?`).get(s.id) as any).n]).toEqual([t, 0])
    }
  })
})
