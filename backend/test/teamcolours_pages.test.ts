import { expect, test, beforeAll } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// The result bars and pills of a server's pages use the game's colour of the team (the role named like it), not the table's.

let app: any, Store: any, api: any
beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  api = (await import('../src/routes/api')).default
})

test('the Jackals bar and the result pill take the Jackal role colour from the game', async () => {
  const added = Store.addServer('Colours') as any
  Store.saveSchema(added.id, 'jackal', 'jackals', false, -1, [], 'h1', null, '#1dd1e0')
  const players = [
    { steam_id: '76561198000000001', nick: 'A', role: 'jackal', team: 'jackals', survived: true, won: true },
    { steam_id: '76561198000000002', nick: 'B', role: 'innocent', team: 'innocents', survived: false, won: false },
  ]
  const res = await api.fetch(new Request('http://localhost/v1/round', {
    method: 'POST', headers: { Authorization: `Bearer ${added.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ round_id: 'a1b2c3d4-0001', map: 'ttt_a', started_at: '2026-11-04T20:00:00Z', duration: 100, result: 'jackals', players, deaths: [] }),
  }))
  expect(res.status).toBe(200)
  const t = await (await app.fetch(new Request(`http://localhost/servers/${added.id}/stats`))).text()
  expect(t).toContain('#1dd1e0'); expect(t).not.toContain('#f97316')
  // innocents have no role colour here: the table's
  expect(t).toContain('#22c55e')
})
