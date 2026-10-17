import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { RateLimiter } from '../src/services/rateLimit'

let api: any, Store: any, db: any, roundLimiter: any
beforeAll(async () => {
  const mod = await import('../src/routes/api')
  api = mod.default
  roundLimiter = mod.roundLimiter
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
})
beforeEach(() => roundLimiter?.reset())

const A = '76561198000000001'
const B = '76561198000000002'
const GHOST = '76561198000000099'

const server = (name: string) => Store.addServer(name) as { id: string, token: string }
const post = (path: string, token: string, body: unknown, raw = false) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: raw ? (body as string) : JSON.stringify(body),
  })
const round = (id: string, over: Record<string, unknown> = {}) => ({
  round_id: id, map: 'ttt_x', duration: 60, result: 'traitors',
  players: [{ steam_id: A, nick: 'A', role: 'traitor', team: 'traitors', survived: true, won: true },
            { steam_id: B, nick: 'B', role: 'innocent', team: 'innocents', survived: false, won: false }],
  deaths: [], ...over,
})
const count = (table: string, serverId: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`).get(serverId) as any).n

describe('/v1/poll', () => {
  test('a body that is not a JSON object still gets a heartbeat and the queued commands', async () => {
    const s = server('Poll')
    for (const raw of ['null', '[]', '"str"', '42', 'garbage', '']) {
      Store.stageCommand(s.id, 'convar', 'ttt_known 1')
      db.run('UPDATE servers SET last_seen = NULL WHERE id = ?', [s.id])
      const res = await post('/v1/poll', s.token, raw, true)
      expect(res.status).toBe(200)
      expect((await res.json()).commands).toMatchObject([{ type: 'convar', payload: 'ttt_known 1' }])
      expect((db.query('SELECT last_seen FROM servers WHERE id = ?').get(s.id) as any).last_seen).not.toBeNull()
    }
  })
})

describe('/v1/round death rows', () => {
  test('a death for someone who was not in the round is dropped', async () => {
    const s = server('Ghost')
    expect((await post('/v1/round', s.token, round('ghost-round-1', { deaths: [{ victim: GHOST, attacker: A, at: 5 }, { victim: B, attacker: A, at: 9 }] }))).status).toBe(200)
    const rows = db.query('SELECT victim_steam_id FROM deaths WHERE server_id = ?').all(s.id) as any[]
    expect(rows.map(r => r.victim_steam_id)).toEqual([B])
  })

  test('a suicide, or a killer who was not in the round, is stored without a killer', async () => {
    const s = server('Suicide')
    await post('/v1/round', s.token, round('suicide-round-1', {
      deaths: [{ victim: B, attacker: B, at: 1 }, { victim: A, attacker: GHOST, at: 2 }, { victim: B, attacker: A, at: 3 }],
    }))
    const rows = db.query('SELECT victim_steam_id AS v, attacker_steam_id AS a FROM deaths WHERE server_id = ? ORDER BY at_seconds').all(s.id) as any[]
    expect(rows).toEqual([{ v: B, a: null }, { v: A, a: null }, { v: B, a: A }])
  })

  test('so the leaderboard never credits a suicide as a kill', async () => {
    const s = server('NoSelfKills')
    await post('/v1/round', s.token, round('selfkill-round-1', { deaths: [{ victim: B, attacker: B, at: 1 }] }))
    const stats = await import('../src/services/stats')
    const b = stats.getLeaderboard(s.id).find((p: any) => p.steamId === B)
    expect(b).toMatchObject({ kills: 0, deaths: 1 })
  })
})

describe('/v1/round limits', () => {
  test('a server that floods rounds gets 429 with Retry-After, other servers are unaffected', async () => {
    const flood = server('Flood'), calm = server('Calm')
    for (let i = 0; i < 10; i++) expect((await post('/v1/round', flood.token, round(`flood-round-${i}0`))).status).toBe(200)
    const refused = await post('/v1/round', flood.token, round('flood-round-final'))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(count('rounds', flood.id)).toBe(10)
    expect((await post('/v1/round', calm.token, round('calm-round-1'))).status).toBe(200)
  })

  test('the limiter counts a window and then lets the client back in', () => {
    let now = 1_000
    const limiter = new RateLimiter(3, 60_000, () => now)
    expect([limiter.hit('k'), limiter.hit('k'), limiter.hit('k')]).toEqual([0, 0, 0])
    expect(limiter.hit('k')).toBe(60)
    now += 59_000
    expect(limiter.hit('k')).toBe(1)
    expect(limiter.hit('other')).toBe(0)
    now += 1_000
    expect(limiter.hit('k')).toBe(0)
  })
})

describe('stats retention', () => {
  const report = (id: string) => ({
    roundId: id, map: null, startedAt: null, duration: 1, result: 'traitors',
    players: [{ steamId: A, nick: 'A', role: 'traitor', team: 'traitors', survived: true, won: true }],
    deaths: [{ victim: A, attacker: null, at: 1 }],
  })

  test('only the newest rounds are kept, with their players and deaths', () => {
    const s = server('Retention')
    for (let i = 1; i <= 6; i++) Store.recordRound(s.id, report(`retention-${i}`), 3)
    const kept = (db.query('SELECT round_id FROM rounds WHERE server_id = ? ORDER BY rowid').all(s.id) as any[]).map(r => r.round_id)
    expect(kept).toEqual(['retention-4', 'retention-5', 'retention-6'])
    expect(count('round_players', s.id)).toBe(3)
    expect(count('deaths', s.id)).toBe(3)
  })

  test('another server\'s rounds are never touched', () => {
    const a = server('KeepA'), b = server('KeepB')
    for (let i = 1; i <= 4; i++) Store.recordRound(a.id, report(`a-${i}-round`), 2)
    Store.recordRound(b.id, report('b-1-round'), 2)
    expect(count('rounds', a.id)).toBe(2)
    expect(count('rounds', b.id)).toBe(1)
  })
})

describe('the save handler', () => {
  test('does not log submitted values', async () => {
    const { serializeSigned } = await import('hono/utils/cookie')
    const cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
    const s = server('Log')
    Store.saveSchema(s.id, 'r', 'innocents', false, 0, [{ type: 'MakeCheckbox', args: { label: 'x', convar: 'ttt_r_x' } }])
    const logged: string[] = []
    const orig = console.log
    console.log = (...a: any[]) => { logged.push(a.map(String).join(' ')) }
    try {
      await api.request(`/save/${s.id}/r`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ttt_r_x=SECRETVALUE123' })
    } finally { console.log = orig }
    expect(logged.join('\n')).not.toContain('SECRETVALUE123')
  })
})
