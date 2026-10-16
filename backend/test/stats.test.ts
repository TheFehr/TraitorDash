import { expect, test, describe, beforeAll } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let api: any, db: any, token: string, serverId: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  const { Store } = await import('../src/services/Store')
  db = (await import('../src/services/Database')).default
  const added = Store.addServer('Stats') as any
  serverId = added.id
  token = added.token ?? added.api_token
})

const A = '76561198000000001'
const B = '76561198000000002'

const round = (over: Record<string, unknown> = {}) => ({
  round_id: 'a1b2c3d4-0001',
  map: 'ttt_minecraft_b5',
  started_at: '2026-10-16T20:00:00Z',
  duration: 312,
  result: 'traitors',
  players: [
    { steam_id: A, nick: 'Alice', role: 'traitor', team: 'traitors', survived: true, won: true },
    { steam_id: B, nick: 'Bob', role: 'innocent', team: 'innocents', survived: false, won: false },
  ],
  deaths: [{ victim: B, attacker: A, at: 120 }],
  ...over,
})

const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
  api.request('/v1/round', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  })

// Scoped to this file's server: test files share one in-memory database.
const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`).get(serverId) as any).n

describe('POST /v1/round', () => {
  test('requires a server token', async () => {
    expect((await post(round(), null)).status).toBe(401)
    expect((await post(round(), 'Bearer nope')).status).toBe(401)
  })

  test('stores the round, its players and its deaths', async () => {
    const res = await post(round())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, stored: true })
    expect(count('rounds')).toBe(1)
    expect(count('round_players')).toBe(2)
    expect(count('deaths')).toBe(1)
    const p = db.query('SELECT * FROM round_players WHERE steam_id = ?').get(A) as any
    expect(p).toMatchObject({ nick: 'Alice', role: 'traitor', team: 'traitors', survived: 1, won: 1 })
  })

  test('a repeated round_id is acknowledged but stores nothing more', async () => {
    const res = await post(round())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, stored: false })
    expect(count('rounds')).toBe(1)
    expect(count('deaths')).toBe(1)
  })

  test('a death without a player attacker (world/fall damage) is kept with a null attacker', async () => {
    const res = await post(round({ round_id: 'a1b2c3d4-0002', deaths: [{ victim: B, attacker: null, at: 5 }] }))
    expect(res.status).toBe(200)
    const d = db.query("SELECT * FROM deaths WHERE round_id = 'a1b2c3d4-0002'").get() as any
    expect(d.attacker_steam_id).toBeNull()
  })

  test('rejects malformed bodies and stores nothing', async () => {
    const before = count('rounds')
    for (const bad of [
      round({ round_id: 'x' }),
      round({ result: '' }),
      round({ players: [] }),
      round({ players: [{ steam_id: "1; DROP TABLE rounds", role: 'x' }] }),
      round({ deaths: [{ victim: 'abc', attacker: null }] }),
      round({ players: Array.from({ length: 129 }, (_, i) => ({ steam_id: String(76561198000001000 + i) })) }),
    ]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect(count('rounds')).toBe(before)
  })

  test('deleting the server removes its stats', async () => {
    const { Store } = await import('../src/services/Store')
    Store.deleteServer(serverId)
    expect(count('rounds') + count('round_players') + count('deaths')).toBe(0)
  })
})
