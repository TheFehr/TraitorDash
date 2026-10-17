import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let app: any, Store: any, stats: any, serverId: string, cookie: string

const ALICE = '76561198000000001'
const BOB = '76561198000000002'
const CARA = '76561198000000003'
const BOT = '999000000004'

const P = (steamId: string, nick: string, role: string, team: string, survived: boolean, won: boolean) =>
  ({ steamId, nick, role, team, survived, won })

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  stats = await import('../src/services/stats')
  serverId = Store.addServer('Stats').id
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!

  const rec = (roundId: string, result: string, duration: number, players: any[], deaths: any[]) =>
    Store.recordRound(serverId, { roundId, map: 'ttt_a', startedAt: null, duration, result, players, deaths })

  // R1: traitors win. Alice (traitor) kills Bob and Cara.
  rec('round-0001', 'traitors', 300,
    [P(ALICE, 'Alice', 'traitor', 'traitors', true, true), P(BOB, 'Bob', 'innocent', 'innocents', false, false), P(CARA, 'Cara', 'detective', 'innocents', false, false)],
    [{ victim: BOB, attacker: ALICE, at: 60 }, { victim: CARA, attacker: ALICE, at: 120 }])
  // R2: innocents win. Cara kills Alice.
  rec('round-0002', 'innocents', 180,
    [P(ALICE, 'Alice (renamed)', 'traitor', 'traitors', false, false), P(BOB, 'Bob', 'innocent', 'innocents', true, true), P(CARA, 'Cara', 'detective', 'innocents', true, true)],
    [{ victim: ALICE, attacker: CARA, at: 90 }])
  // R3: timelimit (innocents win), a fall death with no attacker.
  rec('round-0003', 'timelimit', 600,
    [P(ALICE, 'Alice (renamed)', 'traitor', 'traitors', true, false), P(BOB, 'Bob', 'innocent', 'innocents', false, true)],
    [{ victim: BOB, attacker: null, at: 10 }])
  // R4: a bots-only test round must be invisible.
  rec('round-0004', 'traitors', 50, [P(BOT, 'Bot04', 'traitor', 'traitors', true, true)], [])
})

describe('stats queries', () => {
  test('overview counts real rounds and players, ignoring bot-only rounds', () => {
    const o = stats.getOverview(serverId)
    expect(o.rounds).toBe(3)
    expect(o.players).toBe(3)
    expect(o.avgDuration).toBe(360)
    expect(Object.fromEntries(o.results.map((r: any) => [r.name, r.n]))).toEqual({ traitors: 1, innocents: 1, timelimit: 1 })
    expect(stats.getOverview(serverId, { bots: true }).rounds).toBe(4)
  })

  test('role and team win rates', () => {
    const roles = Object.fromEntries(stats.getRoleStats(serverId).map((r: any) => [r.name, r]))
    expect(roles.traitor).toMatchObject({ played: 3, wins: 1, survived: 2 })
    expect(roles.innocent).toMatchObject({ played: 3, wins: 2, survived: 1 })
    expect(roles.detective).toMatchObject({ played: 2, wins: 1, survived: 1 })
    expect(stats.getRoleStats(serverId).some((r: any) => r.name === 'traitor' && r.played === 4)).toBe(false)
  })

  test('leaderboard: kills, deaths, latest nickname, sorting, no bots', () => {
    const board = stats.getLeaderboard(serverId, 'kills')
    expect(board.map((p: any) => p.steamId)).not.toContain(BOT)
    expect(board[0]).toMatchObject({ steamId: ALICE, nick: 'Alice (renamed)', rounds: 3, wins: 1, kills: 2, deaths: 1 })
    const bob = board.find((p: any) => p.steamId === BOB)
    expect(bob).toMatchObject({ rounds: 3, wins: 2, kills: 0, deaths: 2 })
    expect(stats.getLeaderboard(serverId, 'winrate')[0].steamId).toBe(BOB) // Bob 2/3 beats Cara 1/2 and Alice 1/3
    expect(stats.getLeaderboard(serverId, 'bogus' as any)).toHaveLength(3) // unknown sort falls back, never throws
  })

  test('player detail', () => {
    const p = stats.getPlayer(serverId, ALICE)
    expect(p).toMatchObject({ rounds: 3, kills: 2, deaths: 1 })
    expect(p.roles).toEqual([{ name: 'traitor', played: 3, wins: 1, survived: 2 }])
    expect(p.recent).toHaveLength(3)
    expect(p.recent[0].roundId).toBe('round-0003')
    expect(stats.getPlayer(serverId, '76561198099999999')).toBeNull()
  })
})

describe('stats pages', () => {
  const get = (path: string, withCookie = true) => app.fetch(new Request(`http://x${path}`, { headers: withCookie ? { Cookie: cookie } : {} }))

  test('are public: a guest sees the stats, but no link into the rule settings', async () => {
    for (const path of [`/servers/${serverId}/stats`, `/servers/${serverId}/players/${ALICE}`]) {
      const res = await get(path, false)
      expect(res.status).toBe(200)
      expect(await res.text()).not.toContain(`href="/servers/${serverId}"`)
    }
  })

  test('an admin still gets the link back to the server', async () => {
    expect(await (await get(`/servers/${serverId}/stats`)).text()).toContain(`href="/servers/${serverId}"`)
  })

  test('the rule settings stay admin-only', async () => {
    expect((await get(`/servers/${serverId}`, false)).status).toBe(302)
    expect((await get(`/servers/${serverId}/roles/anything`, false)).status).toBe(302)
    expect((await get('/servers', false)).status).toBe(302)
    expect((await get(`/sidebar/${serverId}`, false)).status).toBe(401)
  })

  test('the guest home page links to each server\'s stats', async () => {
    expect(await (await get('/', false)).text()).toContain(`href="/servers/${serverId}/stats"`)
  })

  test('the overview renders totals, the leaderboard and recent rounds, and no bots', async () => {
    const html = await (await get(`/servers/${serverId}/stats`)).text()
    expect(html).toContain('Round stats')
    expect(html).toContain('Alice (renamed)')
    expect(html).toContain(`/servers/${serverId}/players/${ALICE}`)
    expect(html).toContain('timelimit')
    expect(html).not.toContain('Bot04')
    expect(html).toContain('datetime=') // the viewer's-timezone element
  })

  test('sorting links work and an unknown sort does not break the page', async () => {
    expect((await get(`/servers/${serverId}/stats?sort=kd`)).status).toBe(200)
    expect((await get(`/servers/${serverId}/stats?sort=evil'--`)).status).toBe(200)
  })

  test('?bots=1 includes bot rounds, keeps the switch in the links, and says so', async () => {
    const html = await (await get(`/servers/${serverId}/stats?bots=1`)).text()
    expect(html).toContain('Bot04')
    expect(html).toContain('Including bot test rounds')
    expect(html).toContain('sort=wins&amp;bots=1')
    expect((await get(`/servers/${serverId}/players/${BOT}?bots=1`)).status).toBe(200)
  })

  test('a player page renders, and unknown or bot players go back to the overview', async () => {
    const html = await (await get(`/servers/${serverId}/players/${ALICE}`)).text()
    expect(html).toContain('Alice (renamed)')
    expect(html).toContain('By role')
    expect((await get(`/servers/${serverId}/players/${BOT}`)).status).toBe(302)
    expect((await get(`/servers/${serverId}/players/nobody`)).status).toBe(302)
  })

  test('a server with no rounds says so', async () => {
    const empty = Store.addServer('Empty').id
    const html = await (await get(`/servers/${empty}/stats`)).text()
    expect(html).toContain('No rounds recorded yet')
  })

  test('the server page links to the stats', async () => {
    const html = await (await get(`/servers/${serverId}`)).text()
    expect(html).toContain(`/servers/${serverId}/stats`)
  })
})
