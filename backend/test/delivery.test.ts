import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let api: any, appFetch: any, Store: any, db: any, cookie: string
const app = { request: (path: string, init?: RequestInit) => appFetch(new Request(`http://td.test${path}`, { redirect: 'manual', ...init })) }

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  appFetch = (await import('../src/index')).default.fetch
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

describe('command delivery', () => {
  let id: string, token: string
  beforeEach(() => {
    const s = Store.addServer('Delivery')
    id = s.id; token = s.token
  })
  const poll = async (body: unknown) =>
    (await api.request('/v1/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })).json()

  test('an older bridge (no acked field) still gets each command once', async () => {
    Store.stageCommand(id, 'convar', 'ttt_a 1')
    expect((await poll({})).commands).toHaveLength(1)
    expect((await poll({})).commands).toHaveLength(0)
  })

  test('with acked, a command is redelivered until it is acknowledged', async () => {
    Store.stageCommand(id, 'convar', 'ttt_a 1')
    const first = (await poll({ acked: [] })).commands
    expect(first).toHaveLength(1)
    expect(typeof first[0].id).toBe('number')
    expect((await poll({ acked: [] })).commands).toHaveLength(1) // response was lost
    expect((await poll({ acked: [first[0].id] })).commands).toHaveLength(0)
  })

  test("acknowledging another server's command id deletes nothing", async () => {
    const other = Store.addServer('Other')
    Store.stageCommand(other.id, 'convar', 'ttt_b 1')
    const otherId = (db.query('SELECT id FROM commands WHERE server_id = ?').get(other.id) as any).id
    await poll({ acked: [otherId, 'x; DROP TABLE commands', 1.5] })
    expect(db.query('SELECT COUNT(*) n FROM commands WHERE server_id = ?').get(other.id)).toEqual({ n: 1 })
  })

  test('commands nobody acknowledged expire after an hour', async () => {
    Store.stageCommand(id, 'convar', 'ttt_old 1')
    db.run("UPDATE commands SET staged_at = datetime('now', '-2 hours') WHERE server_id = ?", [id])
    expect((await poll({ acked: [] })).commands).toHaveLength(0)
  })
})

describe('cross-site requests', () => {
  const post = (path: string, headers: Record<string, string>) =>
    app.request(path, { method: 'POST', headers: { Cookie: cookie, Host: 'td.test', ...headers }, body: '' })

  test('a POST from another site is refused, even with a valid login cookie', async () => {
    expect((await post('/auth/logout', { Origin: 'https://evil.example' })).status).toBe(403)
  })

  test('a POST from this site is allowed, and so is one without an Origin', async () => {
    expect((await post('/auth/logout', { Origin: 'http://td.test' })).status).toBe(302)
    expect((await post('/auth/logout', {})).status).toBe(302)
  })

  test('logout is no longer reachable with a GET', async () => {
    expect((await app.request('/auth/logout')).status).toBe(404)
  })

  test('bridge requests with a bearer token are not subject to the origin check', async () => {
    const s = Store.addServer('Bearer')
    const res = await app.request('/api/v1/poll', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
  })
})

describe('language file size', () => {
  test('a set larger than the total cap is refused', async () => {
    const s = Store.addServer('BigLang')
    const files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}.lua`, 'x'.repeat(999_999)]))
    const res = await api.request('/v1/lang', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ files }),
    })
    expect(res.status).toBe(413)
  })
})
