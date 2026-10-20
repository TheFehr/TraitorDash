import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { validateTrack, MAX_TRACK_EVENTS } from '../src/services/tracks'
import { migrate, migrations } from '../src/services/migrations'

// RFC 14: revivals and role changes. Backend side: the track's events, the round report's
// revivals and end state, the schema, and the statistics by end state.

const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003'

// ---- the track's events (4.3) ----

const round = { roundId: 'a1b2c3d4-0001', map: 'ttt_example', players: new Set([A, B]) }
const track = (events?: unknown) => ({
  round_id: round.roundId, map: 'ttt_example', t: [0, 200, 200, 200],
  players: [{ id: A, segments: [{ from: 0, x: [1, 1, 1, 1], y: [1, 0, 0, 0], z: [1, 0, 0, 0], a: [1, 0, 0, 0] }] }],
  ...(events === undefined ? {} : { events }),
})
const refused = (events: unknown, part: RegExp) => {
  const r = validateTrack(track(events), round)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(part)
}

describe('track events', () => {
  test('a track with no events is valid and has an empty list', () => {
    const r = validateTrack(track(), round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.events).toEqual([])
  })

  test('good events are kept as they are, and nothing else on them', () => {
    const events = [
      { t: 31000, p: A, k: 'role', role: 'sheriff', team: 'innocents' },
      { t: 94000, p: B, k: 'revive', by: A, how: 'weapon_ttt_defibrillator', why: 'revived_by_player' },
      { t: 94000, p: B, k: 'role', role: 'zombie', team: 'necromancers' },
      { t: 95000, p: A, k: 'revive' },
    ]
    const r = validateTrack(track(events.map(e => ({ ...e, extra: 1 }))), round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.events as unknown).toEqual(events)
  })

  test('refuses events out of time order, with an invalid time, or for a player not in the round', () => {
    refused([{ t: 200, p: A, k: 'revive' }, { t: 100, p: A, k: 'revive' }], /time order/)
    refused([{ t: -1, p: A, k: 'revive' }], /invalid time/)
    refused([{ t: 1.5, p: A, k: 'revive' }], /invalid time/)
    refused([{ t: 7 * 3600 * 1000, p: A, k: 'revive' }], /invalid time/)
    refused([{ t: 1, p: C, k: 'revive' }], /not in the round/)
    refused([{ t: 1, k: 'revive' }], /not in the round/)
  })

  test('refuses an unknown kind and a non-object', () => {
    refused([{ t: 1, p: A, k: 'heal' }], /unknown kind/)
    refused([{ t: 1, p: A }], /unknown kind/)
    refused(['revive'], /object/)
    refused({ t: 1 }, /at most/)
  })

  test('a role event needs a role and a team of the allowed characters', () => {
    refused([{ t: 1, p: A, k: 'role', team: 'innocents' }], /role and a team/)
    refused([{ t: 1, p: A, k: 'role', role: 'zombie' }], /role and a team/)
    refused([{ t: 1, p: A, k: 'role', role: 'zom bie', team: 'x' }], /role and a team/)
    refused([{ t: 1, p: A, k: 'role', role: 'a'.repeat(65), team: 'x' }], /role and a team/)
    refused([{ t: 1, p: A, k: 'role', role: '<script>', team: 'x' }], /role and a team/)
    refused([{ t: 1, p: A, k: 'role', role: 'x', team: 'y', by: A }], /reviver fields/)
  })

  test('a revive event takes no role, a reviver in the round and clean names', () => {
    refused([{ t: 1, p: A, k: 'revive', role: 'x' }], /role or team/)
    refused([{ t: 1, p: A, k: 'revive', team: 'x' }], /role or team/)
    refused([{ t: 1, p: A, k: 'revive', by: C }], /reviver who was not/)
    refused([{ t: 1, p: A, k: 'revive', by: 5 }], /reviver who was not/)
    refused([{ t: 1, p: A, k: 'revive', how: 'bad name' }], /invalid how/)
    refused([{ t: 1, p: A, k: 'revive', why: '../x' }], /invalid why/)
  })

  test('at most the cap of events', () => {
    const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i, p: A, k: 'revive' }))
    expect(validateTrack(track(ev(MAX_TRACK_EVENTS)), round).ok).toBe(true)
    refused(ev(MAX_TRACK_EVENTS + 1), /at most/)
  })
})

// ---- the schema (5) ----

describe('migration v15', () => {
  test('adds the end state and the revival table to a database at v14, keeping what is there', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = OFF')
    db.transaction(() => { for (const m of migrations.slice(0, 14)) m(db) })()
    db.run('PRAGMA user_version = 14')
    db.run("INSERT INTO servers (id, name, api_token_hash) VALUES ('s', 'S', 'h')")
    db.run("INSERT INTO rounds (server_id, round_id, result) VALUES ('s', 'r1', 'traitors')")
    db.run("INSERT INTO round_players (server_id, round_id, steam_id, role, team) VALUES ('s', 'r1', '1', 'traitor', 'traitors')")

    migrate(db)
    const cols = (db.query('PRAGMA table_info(round_players)').all() as any[]).map(c => c.name)
    expect(cols).toContain('end_role')
    expect(cols).toContain('end_team')
    expect(db.query("SELECT role, end_role, end_team FROM round_players WHERE steam_id = '1'").get()).toEqual({ role: 'traitor', end_role: null, end_team: null })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'round_revives'").get()).toBeTruthy()
    expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(migrations.length)

    migrate(db) // a second run changes nothing
    expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(migrations.length)
  })
})

// ---- the round report (4.4) and the statistics (4.5) ----

let api: any, db: any, Store: any, stats: any, serverId: string, token: string
beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  stats = await import('../src/services/stats')
})
beforeEach(async () => {
  const added = Store.addServer('Revivals') as any
  serverId = added.id
  token = added.token
  ;(await import('../src/routes/api')).roundLimiter.reset()
})

const post = (body: unknown) =>
  api.request('/v1/round', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
const report = (over: Record<string, unknown> = {}) => ({
  round_id: 'a1b2c3d4-0001', map: 'ttt_x', started_at: '2026-10-20T20:00:00Z', duration: 300, result: 'necromancers',
  players: [
    { steam_id: A, nick: 'Alice', role: 'necromancer', team: 'necromancers', survived: true, won: true, end_role: 'necromancer', end_team: 'necromancers' },
    { steam_id: B, nick: 'Bob', role: 'innocent', team: 'innocents', survived: true, won: true, end_role: 'zombie', end_team: 'necromancers' },
  ],
  deaths: [{ victim: B, attacker: A, at: 100 }],
  revives: [{ victim: B, reviver: A, how: 'weapon_ttth_necrodefi', why: 'revived_by_necromancer', at: 110 }],
  ...over,
})
const rows = (sql: string, ...args: unknown[]) => db.query(sql).all(...args) as any[]

describe('POST /v1/round: revivals and end state', () => {
  test('stores the end state and the revivals', async () => {
    expect((await post(report())).status).toBe(200)
    expect(rows('SELECT role, team, end_role, end_team FROM round_players WHERE server_id = ? AND steam_id = ?', serverId, B)[0])
      .toEqual({ role: 'innocent', team: 'innocents', end_role: 'zombie', end_team: 'necromancers' })
    expect(rows('SELECT victim, reviver, how, why, at_seconds FROM round_revives WHERE server_id = ?', serverId))
      .toEqual([{ victim: B, reviver: A, how: 'weapon_ttth_necrodefi', why: 'revived_by_necromancer', at_seconds: 110 }])
    expect(stats.getRevives(serverId, 'a1b2c3d4-0001')).toEqual([{ victim: B, reviver: A, how: 'weapon_ttth_necrodefi', why: 'revived_by_necromancer', at: 110 }])
  })

  test('a round without the new fields is accepted and stores nulls', async () => {
    const old = report()
    old.players = old.players.map(({ end_role, end_team, ...p }: any) => p)
    delete (old as any).revives
    expect((await post(old)).status).toBe(200)
    expect(rows('SELECT end_role, end_team FROM round_players WHERE server_id = ?', serverId).every(r => r.end_role === null && r.end_team === null)).toBe(true)
    expect(rows('SELECT * FROM round_revives WHERE server_id = ?', serverId)).toEqual([])
  })

  test('a reviver who is not in the round, or a name with other characters, is stored as unknown, not refused', async () => {
    const res = await post(report({ revives: [
      { victim: B, reviver: C, how: 'weapon x', why: '<b>', at: 5 },
      { victim: A, at: 6 },
    ] }))
    expect(res.status).toBe(200)
    expect(rows('SELECT victim, reviver, how, why FROM round_revives WHERE server_id = ? ORDER BY id', serverId))
      .toEqual([{ victim: B, reviver: null, how: null, why: null }, { victim: A, reviver: null, how: null, why: null }])
  })

  test('a revival of someone not in the round is dropped; a malformed one or too many is refused', async () => {
    expect((await post(report({ revives: [{ victim: C, reviver: A, at: 1 }] }))).status).toBe(200)
    expect(rows('SELECT * FROM round_revives WHERE server_id = ?', serverId)).toEqual([])
    expect((await post(report({ round_id: 'a1b2c3d4-0002', revives: [{ victim: 'x; DROP TABLE rounds' }] }))).status).toBe(400)
    expect((await post(report({ round_id: 'a1b2c3d4-0003', revives: 'yes' }))).status).toBe(400)
    expect((await post(report({ round_id: 'a1b2c3d4-0004', revives: Array.from({ length: 513 }, () => ({ victim: B })) }))).status).toBe(400)
    expect(rows('SELECT * FROM rounds WHERE server_id = ? AND round_id IN (?, ?, ?)', serverId, 'a1b2c3d4-0002', 'a1b2c3d4-0003', 'a1b2c3d4-0004')).toEqual([])
  })

  test('a repeated round stores its revivals once', async () => {
    await post(report())
    await post(report())
    expect(rows('SELECT * FROM round_revives WHERE server_id = ?', serverId).length).toBe(1)
  })

  test('deleting the server removes its revivals', async () => {
    await post(report())
    Store.deleteServer(serverId)
    expect(rows('SELECT * FROM round_revives WHERE server_id = ?', serverId)).toEqual([])
  })

  test('pruning old rounds removes their revivals', async () => {
    const rep = (id: string) => ({ roundId: id, map: 'm', startedAt: null, duration: 1, result: 'x', players: [{ steamId: A, nick: 'A', role: 'r', team: 't', survived: true, won: true }], deaths: [], revives: [{ victim: A, reviver: null, how: null, why: null, at: 1 }] })
    Store.recordRound(serverId, rep('r-0000001'), 1)
    Store.recordRound(serverId, rep('r-0000002'), 1)
    expect(rows('SELECT DISTINCT round_id FROM round_revives WHERE server_id = ?', serverId)).toEqual([{ round_id: 'r-0000002' }])
  })
})

describe('statistics by end state', () => {
  const roundOf = (id: string, players: Record<string, unknown>[]) => ({ round_id: id, map: 'm', duration: 60, result: 'x', players })
  const p = (sid: string, role: string, team: string, won: boolean, end?: [string, string]) =>
    ({ steam_id: sid, nick: sid.slice(-2), role, team, survived: true, won, ...(end ? { end_role: end[0], end_team: end[1] } : {}) })
  const byName = (rows: any[]) => Object.fromEntries(rows.map(r => [r.name, r]))

  test('as played groups by the end state, as dealt by the start state, and the rounds played add up the same', async () => {
    await post(roundOf('r-conv-001', [p(A, 'necromancer', 'necromancers', true), p(B, 'innocent', 'innocents', true, ['zombie', 'necromancers'])]))
    const played = byName(stats.getRoleStats(serverId, { by: 'end' }))
    const dealt = byName(stats.getRoleStats(serverId, { by: 'start' }))
    expect(played.zombie).toMatchObject({ played: 1, wins: 1 })
    expect(played.innocent).toBeUndefined()
    expect(dealt.innocent).toMatchObject({ played: 1, wins: 1 })
    expect(dealt.zombie).toBeUndefined()
    const sum = (r: any[]) => r.reduce((n, x) => n + x.played, 0)
    expect(sum(stats.getRoleStats(serverId, { by: 'end' }))).toBe(sum(stats.getRoleStats(serverId, { by: 'start' })))
    expect(byName(stats.getTeamStats(serverId, { by: 'end' })).necromancers).toMatchObject({ played: 2, wins: 2 })
    expect(byName(stats.getTeamStats(serverId, { by: 'start' })).innocents).toMatchObject({ played: 1 })
  })

  test('the default is as played; rows without an end state count as dealt in both views', async () => {
    await post(roundOf('r-old-0001', [p(A, 'traitor', 'traitors', true), p(B, 'innocent', 'innocents', false)]))
    const dflt = stats.getRoleStats(serverId)
    expect(dflt).toEqual(stats.getRoleStats(serverId, { by: 'end' }))
    expect(dflt).toEqual(stats.getRoleStats(serverId, { by: 'start' }))
    expect(byName(dflt).traitor).toMatchObject({ played: 1, wins: 1 })
  })

  test('parseBy accepts start and end and falls back to end', () => {
    expect(stats.parseBy('start')).toBe('start')
    expect(stats.parseBy('end')).toBe('end')
    for (const v of [undefined, null, '', 'x', 'START', "end'; --"]) expect(stats.parseBy(v as any)).toBe('end')
  })

  test('the coverage counts the rows that have an end state', async () => {
    await post(roundOf('r-old-0002', [p(A, 'traitor', 'traitors', true)]))
    await post(roundOf('r-new-0001', [p(A, 'traitor', 'traitors', true, ['traitor', 'traitors']), p(B, 'innocent', 'innocents', false, ['innocent', 'innocents'])]))
    expect(stats.getEndStateCoverage(serverId)).toEqual({ withEnd: 2, total: 3 })
  })

  test('a player page counts revivals done (a known reviver, not themselves) and times revived, and groups roles by the switch', async () => {
    await post(report())
    await post(report({ round_id: 'a1b2c3d4-0009', revives: [{ victim: B, reviver: B, at: 5 }, { victim: B, at: 6 }] }))
    const bob = stats.getPlayer(serverId, B)
    expect(bob).toMatchObject({ revived: 3, revivals: 0 })
    const alice = stats.getPlayer(serverId, A)
    expect(alice).toMatchObject({ revived: 0, revivals: 1 })
    expect(byName(stats.getPlayer(serverId, B, { by: 'end' }).roles).zombie).toMatchObject({ played: 2 })
    expect(byName(stats.getPlayer(serverId, B, { by: 'start' }).roles).innocent).toMatchObject({ played: 2 })
    expect(stats.getPlayer(serverId, B).recent[0]).toMatchObject({ role: 'innocent', endRole: 'zombie', endTeam: 'necromancers' })
  })
})
