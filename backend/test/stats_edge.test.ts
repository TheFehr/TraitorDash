import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

// Edge cases of the stats queries and pages, ported from the test-gap audit's scratch tests.
// (Suicides and deaths of players who were not in the round are refused earlier, at POST
// /v1/round, and tested in hardening.test.ts.)
const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let app: any, Store: any, stats: any, roundLimiter: any, cookie: string
const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003'
const P = (steamId: string, nick: string | null, won = false, survived = true) => ({ steamId, nick, role: 'innocent', team: 'innocents', survived, won })
const rec = (sid: string, id: string, players: any[], deaths: any[] = [], over: any = {}) =>
  Store.recordRound(sid, { roundId: id, map: 'm', startedAt: null, duration: 10, result: 'innocents', players, deaths, ...over })

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  stats = await import('../src/services/stats')
  roundLimiter = (await import('../src/routes/api')).roundLimiter
  cookie = (await serializeSigned('steam_id', '76561198000000000', SECRET)).split(';')[0]!
})
beforeEach(() => roundLimiter.reset())

const get = (p: string) => app.fetch(new Request('http://localhost:3000' + p, { headers: { Cookie: cookie } }))
const fresh = (name: string) => Store.addServer(name) as { id: string, token: string }

describe('stats edge cases', () => {
  test('an empty server: every query returns zeros, not NaN or an exception', () => {
    const e = fresh('E').id
    expect(stats.getOverview(e)).toMatchObject({ rounds: 0, players: 0, avgDuration: null, lastRound: null, results: [] })
    expect(stats.getLeaderboard(e)).toEqual([])
    expect(stats.getRecentRounds(e)).toEqual([])
    expect(stats.getPlayer(e, A)).toBeNull()
  })

  test('a round with no deaths counts survivors and K/D 0 without dividing by zero', () => {
    const s = fresh('ND').id
    rec(s, 'round-nodeath', [P(A, 'A', true)])
    expect(stats.getLeaderboard(s, 'kd')[0]).toMatchObject({ rounds: 1, wins: 1, survived: 1, kills: 0, deaths: 0 })
    expect(stats.getRecentRounds(s)[0]).toMatchObject({ players: 1, deaths: 0 })
  })

  test('ties sort by nickname, the same way for every sort key', () => {
    const s = fresh('Ties').id
    rec(s, 'round-ties-1', [P(C, 'Zed', true), P(A, 'Amy', true), P(B, 'Bob', true)])
    for (const k of stats.SORTS) expect(stats.getLeaderboard(s, k).map((r: any) => r.nick)).toEqual(['Amy', 'Bob', 'Zed'])
  })

  test('nickname changes: the latest non-null nickname wins, a later null does not erase it', () => {
    const s = fresh('Nick').id
    rec(s, 'round-nick-1', [P(A, 'Old')]); rec(s, 'round-nick-2', [P(A, 'New')]); rec(s, 'round-nick-3', [P(A, null)])
    expect(stats.getLeaderboard(s)[0].nick).toBe('New')
  })

  test('stats are per server: the same SteamID on two servers is two separate players', () => {
    const s = fresh('IsoS').id, t = fresh('IsoT').id
    rec(s, 'round-iso-1', [P(C, 'Iso')])
    expect(stats.getLeaderboard(t).find((r: any) => r.steamId === C)).toBeUndefined()
    expect(stats.getPlayer(t, C)).toBeNull()
  })

  test('the same round_id on two different servers is two rounds', () => {
    const s = fresh('Same1').id, t = fresh('Same2').id
    expect(rec(s, 'shared-round-id', [P(A, 'A')])).toBe(true)
    expect(rec(t, 'shared-round-id', [P(A, 'A')])).toBe(true)
  })

  test('huge numbers: a duration of 1e15, 2^53 or 1e300 is stored and rendered without throwing', async () => {
    const s = fresh('Huge')
    for (const d of [1e15, 2 ** 53, 1e300]) {
      const r = await app.fetch(new Request('http://localhost:3000/api/v1/round', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ round_id: `huge-${String(d).replace(/\W/g, '')}`, result: 'traitors', duration: d, players: [{ steam_id: A, nick: 'x' }], deaths: [{ victim: A, at: d }] }),
      }))
      expect(r.status).toBe(200)
    }
    expect((await get(`/servers/${s.id}/stats`)).status).toBe(200)
  })

  test('SQL-looking input in the sort key, server id and player id is inert', async () => {
    const s = fresh('Sql').id
    rec(s, 'round-sql-1', [P(A, 'A')])
    expect((await get(`/servers/${s}/stats?sort=${encodeURIComponent('rounds; DROP TABLE rounds;--')}`)).status).toBe(200)
    expect(stats.getLeaderboard(s, "kd' OR 1=1 --" as any).length).toBeGreaterThan(0)
    for (const bad of [`1' OR '1'='1`, '%', '999000%', '']) expect(stats.getPlayer(s, bad)).toBeNull()
    expect((await get(`/servers/${encodeURIComponent("x' OR '1'='1")}/stats`)).status).toBe(302)
  })

  test('HTML in a nickname is escaped on the leaderboard and the player page', async () => {
    const s = fresh('XSS').id
    rec(s, 'round-xss-1', [P(A, '<script>alert(1)</script>')])
    for (const p of [`/servers/${s}/stats`, `/servers/${s}/players/${A}`]) {
      expect(await (await get(p)).text()).not.toContain('<script>alert(1)</script>')
    }
  })

  test('a real player killed by a bot still gets the death, and the bot is never listed', () => {
    const s = fresh('Bots').id
    rec(s, 'round-bots-1', [P(A, 'A'), P('999000000007', 'Bot')], [{ victim: A, attacker: '999000000007', at: 1 }])
    expect(stats.getLeaderboard(s)[0].deaths).toBe(1)
    expect(stats.getLeaderboard(s).map((r: any) => r.steamId)).toEqual([A])
  })
})
