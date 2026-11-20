import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 26, stage C, package C4: who speaks on the dashboard's voice page. The page's spans, the route, the log that ties them to a round by
// time, the table, the track.json merge. Times and ids only: never audio, never text.

import { TALK, TalkLog, attachTalk, cleanTalk, cleanTalkBody, mergeSpans, talkEnabled, talkLog, type Span } from '../src/services/talk'
import { configureVoice } from '../src/services/voice'

const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003', OUT = '76561198000000099'
const ADMIN = '76561198000000000'
const CFG = { url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'devkey', secret: 'devsecret-devsecret-devsecret-00' }

describe('cleanTalkBody', () => {
  const NOW = 1_900_000_000_000
  const ok = (body: unknown) => { const r = cleanTalkBody(body, NOW); if (typeof r === 'string') throw new Error(r); return r }
  test('takes whole spans and gives them back in the server\'s clock', () => {
    expect(ok({ now: NOW, spans: [{ from: NOW - 3000, to: NOW - 1000 }, { from: NOW - 900, to: NOW - 500 }] })).toEqual({ spans: [[NOW - 3000, NOW - 1000], [NOW - 900, NOW - 500]], dropped: 0 })
  })
  test('the browser\'s clock may be off: the difference between its `now` and the server\'s is taken off every span', () => {
    const skew = 3_600_000 // a browser an hour fast
    expect(ok({ now: NOW + skew, spans: [{ from: NOW + skew - 3000, to: NOW + skew - 1000 }] }).spans).toEqual([[NOW - 3000, NOW - 1000]])
    expect(ok({ now: NOW - skew, spans: [{ from: NOW - skew - 3000, to: NOW - skew - 1000 }] }).spans).toEqual([[NOW - 3000, NOW - 1000]])
    // without a `now` the times are taken as they are (the sanity bounds then judge them)
    expect(ok({ spans: [{ from: NOW - 3000, to: NOW - 1000 }] }).spans).toEqual([[NOW - 3000, NOW - 1000]])
  })
  test('refuses a body that is not an object with a list of at most 50 spans', () => {
    for (const bad of [null, 'x', 5, [], {}, { spans: 'x' }, { spans: {} }, { now: NOW, spans: Array(51).fill({ from: NOW - 2000, to: NOW - 1000 }) }]) expect(typeof cleanTalkBody(bad, NOW)).toBe('string')
    expect(typeof cleanTalkBody({ now: NOW, spans: Array(50).fill({ from: NOW - 2000, to: NOW - 1000 }) }, NOW)).toBe('object')
  })
  test('drops the spans that cannot be right, one by one, and keeps the others', () => {
    const good = { from: NOW - 3000, to: NOW - 2000 }
    const r = ok({ now: NOW, spans: [
      good,
      { from: NOW - 2000, to: NOW - 2000 }, // empty
      { from: NOW - 1000, to: NOW - 2000 }, // backwards
      { from: 'a', to: 5 }, { from: null, to: NOW }, { from: NaN, to: NOW }, { from: NOW - 2000 }, null, 7, [],
      { from: NOW - 11 * 60_000, to: NOW - 10 * 60_000 - 1 }, // over ten minutes ago
      { from: NOW - 1000, to: NOW + 5001 }, // ends too far in the future
      { from: NOW - 11 * 60_000 - 5000, to: NOW - 5000 }, // longer than ten minutes
    ] })
    expect(r.spans).toEqual([[NOW - 3000, NOW - 2000]])
    expect(r.dropped).toBe(12)
  })
  test('the edges: ends 5 s ahead and 10 minutes back are kept, a millisecond more is not; 1 ms and 10 minutes long are kept', () => {
    expect(ok({ now: NOW, spans: [{ from: NOW + 4000, to: NOW + 5000 }] }).spans).toHaveLength(1)
    expect(ok({ now: NOW, spans: [{ from: NOW + 4001, to: NOW + 5001 }] }).spans).toHaveLength(0)
    expect(ok({ now: NOW, spans: [{ from: NOW - 11 * 60_000, to: NOW - 10 * 60_000 }] }).spans).toHaveLength(1)
    expect(ok({ now: NOW, spans: [{ from: NOW - 11 * 60_000, to: NOW - 10 * 60_000 - 1 }] }).spans).toHaveLength(0)
    expect(ok({ now: NOW, spans: [{ from: NOW - 1001, to: NOW - 1000 }] }).spans).toHaveLength(1)
    expect(ok({ now: NOW, spans: [{ from: NOW - 600_000, to: NOW }] }).spans).toHaveLength(1)
    expect(ok({ now: NOW, spans: [{ from: NOW - 600_001, to: NOW }] }).spans).toHaveLength(0)
  })
  test('anything else in a span or the body is ignored, not kept', () => {
    const r = ok({ now: NOW, audio: 'AAAA', spans: [{ from: NOW - 3000, to: NOW - 2000, text: 'hello', steamId: B }] })
    expect(r).toEqual({ spans: [[NOW - 3000, NOW - 2000]], dropped: 0 })
  })
})

describe('mergeSpans and cleanTalk', () => {
  test('sorts, and joins spans that overlap or are at most the gap apart', () => {
    expect(mergeSpans([[5000, 6000], [0, 1000], [1600, 2000], [2601, 3000]], 600)).toEqual([[0, 2000], [2601, 3000], [5000, 6000]])
    expect(mergeSpans([[0, 5000], [1000, 2000]], 600)).toEqual([[0, 5000]]) // inside another: it does not shorten it
    expect(mergeSpans([], 600)).toEqual([])
  })
  test('cleanTalk keeps only players of the round, whole numbers, 0 <= from < to, in order of time', () => {
    const players = new Set([A, B])
    const r = cleanTalk([
      { p: B, from: 5000, to: 6000 }, { p: A, from: 1000, to: 2000 }, { p: OUT, from: 0, to: 10 }, { p: A, from: 3, to: 3 }, { p: A, from: -1, to: 5 },
      { p: A, from: 1.5, to: 3 }, { p: A, from: 0, to: TALK.maxRoundMs + 1 }, { p: 5, from: 0, to: 1 }, null, 'x', { p: A, from: '1', to: 2 }, { p: A, from: 0, to: 1, text: 'hi' },
    ], players)
    expect(r).toEqual([{ p: A, from: 0, to: 1 }, { p: A, from: 1000, to: 2000 }, { p: B, from: 5000, to: 6000 }])
    expect(cleanTalk('x', players)).toEqual([])
  })
  test('cleanTalk caps each player at 1 024 and the round at 10 240', () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ p, from: i * 10, to: i * 10 + 5 }))
    expect(cleanTalk(many(A, 1025), new Set([A]))).toHaveLength(1024)
    const eleven = Array.from({ length: 11 }, (_, i) => `76561198000000${String(100 + i)}`)
    expect(cleanTalk(eleven.flatMap(p => many(p, 1024)), new Set(eleven))).toHaveLength(10_240)
  })
})

describe('the log: windows, spans, and the round they belong to', () => {
  let log: TalkLog, clock = 0
  const S = 'srv'
  beforeEach(() => { clock = 1_000_000; log = new TalkLog(() => clock) })

  test('a round is the time between the voice state "active" and the state that ends it', () => {
    log.phase(S, 'prep', true, 100); expect(log.windowsOf(S)).toHaveLength(0)
    log.phase(S, 'active', true, 200); log.phase(S, 'active', true, 300) // the state repeats: one window
    expect(log.windowsOf(S)).toMatchObject([{ from: 200, to: null }])
    log.phase(S, 'over', true, 900)
    expect(log.windowsOf(S)).toMatchObject([{ from: 200, to: 900 }])
    log.phase(S, 'over', true, 950); expect(log.windowsOf(S)[0]!.to).toBe(900) // a later state does not move the end
    log.phase(S, 'active', true, 2000)
    expect(log.windowsOf(S)).toHaveLength(2)
  })

  test('keeps only the last eight windows, and forgets one half an hour after it ended', () => {
    for (let i = 0; i < 10; i++) { log.phase(S, 'active', true, i * 1000); log.phase(S, 'over', true, i * 1000 + 500) }
    expect(log.windowsOf(S)).toHaveLength(8)
    log.phase(S, 'over', true, 9500 + TALK.forgetMs + 1)
    expect(log.windowsOf(S)).toHaveLength(0)
  })

  test('spans are kept only while a round that began with the setting on is on (or not yet written): talk in the lobby is not kept', () => {
    expect(log.add(S, A, [[10, 20]])).toBe(0) // no round
    log.phase(S, 'active', false, 1000)
    expect(log.add(S, A, [[1100, 1200]])).toBe(0) // the setting was off when the round began
    log.phase(S, 'over', false, 2000)
    log.phase(S, 'active', true, 3000)
    expect(log.add(S, A, [[100, 200], [3100, 3200], [2999, 3001]])).toBe(2) // the first is before the round; the third reaches into it
    log.phase(S, 'over', true, 4000)
    expect(log.add(S, A, [[3900, 4100], [4200, 4300]])).toBe(1) // one that reaches over the end counts, one after it does not
    expect(log.held(S, A)).toEqual([[3100, 3200], [2999, 3001], [3900, 4100]])
  })

  test('only a SteamID64 may have spans, at most 64 players a server and 2 048 spans a player in memory', () => {
    log.phase(S, 'active', true, 0)
    expect(log.add(S, 'BOT', [[1, 2]])).toBe(0)
    expect(log.add(S, '123', [[1, 2]])).toBe(0)
    for (let i = 0; i < TALK.memoryPlayers; i++) expect(log.add(S, `7656119811${String(i).padStart(7, '0')}`, [[1, 2]])).toBe(1)
    expect(log.add(S, A, [[1, 2]])).toBe(0)
    const first = `7656119811${String(0).padStart(7, '0')}`
    log.add(S, first, Array.from({ length: 2100 }, (_, i) => [i + 3, i + 4] as Span))
    expect(log.held(S, first)).toHaveLength(2048)
    expect(log.held(S, first)[2047]).toEqual([2102, 2103]) // the oldest go
  })

  test('the round report claims the window of about its length (15 s either way), once, the best fit first', () => {
    log.phase(S, 'active', true, 0); log.phase(S, 'over', true, 120_000)
    log.phase(S, 'active', true, 130_000); log.phase(S, 'over', true, 190_000)
    clock = 191_000
    expect(log.claim(S, 61)).toMatchObject({ from: 130_000 }) // 60 s: the second one fits best
    expect(log.claim(S, 61)).toBeNull() // the first is 120 s: not within 15 s of 61
    expect(log.claim(S, 118)).toMatchObject({ from: 0 })
    // (now claimed) nothing left of that length
    expect(log.claim(S, 61)).toBeNull()
  })
  test('the edges of the match: 15 s off is taken, 15.001 s is not; no duration, no match', () => {
    log.phase(S, 'active', true, 0); log.phase(S, 'over', true, 100_000)
    clock = 101_000
    expect(log.claim(S, 115.001)).toBeNull()
    expect(log.claim(S, 84.999)).toBeNull()
    expect(log.claim(S, null)).toBeNull()
    expect(log.claim(S, 115)).toMatchObject({ from: 0 })
  })
  test('a window that ended more than ten minutes ago is not claimed; one still on is, and ends at the report', () => {
    log.phase(S, 'active', true, 0); log.phase(S, 'over', true, 100_000)
    clock = 100_000 + TALK.claimWithinMs + 1
    expect(log.claim(S, 100)).toBeNull()
    log.phase(S, 'active', true, clock - 60_000)
    const w = log.claim(S, 60)!
    expect(w.to).toBe(clock)
  })
  test('a round that began with the setting off is never claimed for writing', () => {
    log.phase(S, 'active', false, 0); log.phase(S, 'over', false, 60_000)
    clock = 61_000
    expect(log.claim(S, 60)).toBeNull()
  })

  test('collect: clipped to the window, relative to its start, merged (600 ms), short ones (under 200 ms) out, only players of the round', () => {
    log.phase(S, 'active', true, 10_000)
    log.add(S, A, [[9_000, 10_500], [11_800, 12_000], [12_600, 13_000], [13_601, 14_000], [15_000, 15_199], [16_000, 16_200]])
    log.add(S, B, [[20_000, 21_000]])
    log.add(S, C, [[11_000, 11_999]])
    log.phase(S, 'over', true, 20_000)
    clock = 21_000
    const w = log.claim(S, 10)!
    const got = log.collect(S, w, new Set([A, B]))
    expect(got).toEqual([
      { p: A, from: 0, to: 500 },           // clipped at the start of the round
      { p: A, from: 1800, to: 3000 },       // 12000 to 12600 is 600 apart: one (a span of exactly 200 ms alone would be kept)
      { p: A, from: 3601, to: 4000 },       // 601 apart: two
      { p: A, from: 6000, to: 6200 },       // exactly 200 ms is kept; 15000-15199 (199 ms) was dropped
    ])
    // B's span is after the end of the window; C was not in the round
    expect(got.some(s => s.p === B || s.p === C)).toBe(false)
  })
  test('collect: a span of 199 ms is dropped, 200 ms kept; per player 1 024 and in all 10 240', () => {
    log.phase(S, 'active', true, 0)
    log.add(S, A, [[1000, 1199], [3000, 3200]])
    log.phase(S, 'over', true, 10_000)
    clock = 10_500
    expect(log.collect(S, log.claim(S, 10)!, new Set([A]))).toEqual([{ p: A, from: 3000, to: 3200 }])
    const big = new TalkLog(() => 0)
    big.phase(S, 'active', true, 0)
    for (let i = 0; i < 11; i++) big.add(S, `76561198000000${String(100 + i)}`, Array.from({ length: 1500 }, (_, k) => [k * 1000, k * 1000 + 300] as Span))
    big.phase(S, 'over', true, 2_000_000)
    const w = big.windowsOf(S)[0]!
    const players = new Set(Array.from({ length: 11 }, (_, i) => `76561198000000${String(100 + i)}`))
    const all = big.collect(S, w, players)
    expect(all).toHaveLength(10_240)
    for (const p of players) expect(all.filter(s => s.p === p).length).toBeLessThanOrEqual(1024)
  })
  test('finish: the spans of the written round leave the memory, what came after stays', () => {
    log.phase(S, 'active', true, 0)
    log.add(S, A, [[1000, 2000]])
    log.phase(S, 'over', true, 5000)
    log.add(S, A, [[4800, 5200]])
    clock = 5500
    const w = log.claim(S, 5)!
    log.finish(S, w)
    expect(w.done).toBe(true)
    expect(log.held(S, A)).toEqual([[4800, 5200]]) // reaches past the end: not part of this round, never part of another
    expect(log.add(S, A, [[4900, 5100]])).toBe(0) // a written window takes nothing more
  })
})

describe('the tables', () => {
  let db: any, Store: any
  beforeAll(async () => {
    db = (await import('../src/services/Database')).default
    Store = (await import('../src/services/Store')).Store
  })
  const fresh = (name = 'Talk') => (Store.addServer(name) as any).id as string
  const report = (serverId: string, id: string, players = [A, B]) => Store.recordRound(serverId, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'traitors',
    players: players.map((p, i) => ({ steamId: p, nick: `N${i}`, role: 'innocent', team: 'innocents', survived: true, won: true })), deaths: [] })
  const track = (serverId: string, id: string) => { const t = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0, 200, 200], players: [{ id: A, segments: [{ from: 0, x: [1, 1, 1], y: [1, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [] }; Store.recordTrack(serverId, t, JSON.stringify(t)) }
  const rows = (serverId: string) => (db.query('SELECT COUNT(*) AS n FROM round_talk WHERE server_id = ?').get(serverId) as any).n

  test('a fresh database and one upgraded from the version before have the table', async () => {
    const { Database } = await import('bun:sqlite')
    const { migrate, migrations } = await import('../src/services/migrations')
    const cols = (d: any) => (d.query("SELECT name FROM pragma_table_info('round_talk')").all() as any[]).map(r => r.name)
    const fresh = new Database(':memory:')
    migrate(fresh)
    expect(cols(fresh)).toEqual(['server_id', 'round_id', 'spans', 'bytes', 'created_at', 'data'])
    expect((fresh.query('PRAGMA user_version').get() as any).user_version).toBe(migrations.length)
    const old = new Database(':memory:')
    for (const m of migrations.slice(0, 30)) m(old)
    old.run('PRAGMA user_version = 30')
    expect(cols(old)).toEqual([])
    migrate(old)
    expect(cols(old)).toEqual(['server_id', 'round_id', 'spans', 'bytes', 'created_at', 'data'])
    expect(migrations.length).toBe(31)
  })

  test('a round\'s talk is stored as given and read back with a tag that changes when it does', () => {
    const s = fresh(); report(s, 'round-talk-01')
    expect(Store.getTalk(s, 'round-talk-01')).toBeNull()
    expect(Store.recordTalk(s, 'round-talk-01', [{ p: A, from: 1000, to: 2000 }])).toBe(true)
    const one = Store.getTalk(s, 'round-talk-01')
    expect(one.list).toEqual([{ p: A, from: 1000, to: 2000 }])
    Store.recordTalk(s, 'round-talk-01', [{ p: A, from: 1000, to: 2500 }])
    expect(Store.getTalk(s, 'round-talk-01').tag).not.toBe(one.tag)
    expect(rows(s)).toBe(1) // replaced, not added
    expect(Store.recordTalk(s, 'round-nothing-1', [{ p: A, from: 1, to: 2 }])).toBe(false) // no round, no row
  })

  test('the stored data is times and ids only: no key but p, from and to', () => {
    const s = fresh(); report(s, 'round-talk-02')
    Store.recordTalk(s, 'round-talk-02', [{ p: A, from: 1000, to: 2000 }])
    const raw = (db.query('SELECT data FROM round_talk WHERE server_id = ?').get(s) as any).data
    for (const row of JSON.parse(raw)) expect(Object.keys(row).sort()).toEqual(['from', 'p', 'to'])
    expect(raw).toMatch(/^\[(\{"p":"\d{17}","from":\d+,"to":\d+\},?)+\]$/)
  })

  test('deleting the round deletes its talk; so does deleting several, deleting only the replay, the retention limits and deleting the server', () => {
    const s = fresh(); const other = fresh('Other')
    for (const id of ['round-talk-11', 'round-talk-12', 'round-talk-13', 'round-talk-14']) { report(s, id); track(s, id); Store.recordTalk(s, id, [{ p: A, from: 1, to: 2 }]) }
    report(other, 'round-talk-11'); Store.recordTalk(other, 'round-talk-11', [{ p: A, from: 1, to: 2 }])
    expect(rows(s)).toBe(4)
    Store.deleteRound(s, 'round-talk-11'); expect(rows(s)).toBe(3)
    Store.deleteRounds(s, ['round-talk-12']); expect(rows(s)).toBe(2)
    Store.deleteTrack(s, 'round-talk-13'); expect(rows(s)).toBe(1)
    expect(Store.getTalk(s, 'round-talk-14')).not.toBeNull()
    expect(rows(other)).toBe(1) // another server's round of the same id is untouched
    Store.deleteServer(s); expect(rows(s)).toBe(0)
    expect(rows(other)).toBe(1)
  })

  test('a track removed by the retention limits takes its talk with it, and a pinned one keeps it', () => {
    const s = fresh()
    for (const id of ['round-talk-21', 'round-talk-22', 'round-talk-23']) { report(s, id); track(s, id); Store.recordTalk(s, id, [{ p: A, from: 1, to: 2 }]) }
    expect(Store.pinTrack(s, 'round-talk-21', true, ADMIN)).toBe('ok')
    Store.setTrackConfig({ keepCount: 1, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 2 })
    Store.enforceTrackLimits(s)
    expect(Store.getTrack(s, 'round-talk-22')).toBeNull(); expect(Store.getTalk(s, 'round-talk-22')).toBeNull()
    expect(Store.getTalk(s, 'round-talk-21')).not.toBeNull() // pinned
    Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 2 })
  })

  test('the oldest rounds a server keeps go with their talk (the retention of rounds)', () => {
    const s = fresh()
    for (let i = 0; i < 3; i++) { const id = `round-talk-3${i}`; Store.recordRound(s, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'x', players: [{ steamId: A, nick: 'a', role: 'i', team: 'i', survived: true, won: true }], deaths: [] }, 2); Store.recordTalk(s, id, [{ p: A, from: 1, to: 2 }]) }
    expect(Store.getTalk(s, 'round-talk-30')).toBeNull()
    expect(rows(s)).toBe(2)
  })
})

describe('the route and the round', () => {
  let app: any, api: any, Store: any, db: any, server: { id: string, token: string }, idx: any, vs: any, session: any
  const cookieFor = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
  const NOW = () => Date.now()
  const post = async (as: string | null, body: unknown, extra: Record<string, string> = {}, path = `/servers/${server.id}/voice/talk`) =>
    app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(as ? { Cookie: await cookieFor(as) } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const bridge = (path: string, body: unknown, tok = server.token) => api.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
  const setting = (on: boolean | null) => bridge('/v1/settings', { format: 1, settings: on === null ? { traitordash_track: '1' } : { traitordash_track: '1', traitordash_track_voice: on ? '1' : '0' }, saved: {} })
  const span = (from: number, to: number) => ({ from, to })
  /** The request's travel time shifts a span by a few ms (the browser's clock is corrected by the difference of the two clocks at the moment of the post): compare to the nearest 100 ms. */
  const rough = (list: { p: string, from: number, to: number }[]) => list.map(s => ({ p: s.p, from: Math.round(s.from / 100) * 100, to: Math.round(s.to / 100) * 100 }))
  let seq = 0
  const state = (phase: 'prep' | 'active' | 'over') => bridge('/v1/voice', { boot: 1, seq: ++seq, phase, alive: [A, B] })
  let n = 0

  beforeAll(async () => {
    idx = await import('../src/index')
    app = idx.app
    api = (await import('../src/routes/api')).default
    Store = (await import('../src/services/Store')).Store
    db = (await import('../src/services/Database')).default
    vs = await import('../src/services/voiceSession'); session = await import('../src/middleware/session')
  })
  /** A round that is on, began two minutes ago, with the setting on: spans of the last minutes fall inside it. */
  async function openRound() { await setting(true); await state('active'); talkLog.windowsOf(server.id).at(-1)!.from = NOW() - 120_000 }
  beforeEach(() => {
    process.env.OPEN_SIGNIN = '1'
    server = Store.addServer('Talk') as any
    seq = 0
    configureVoice(CFG)
    talkLog.reset()
    TALK.graceMs = 0
    idx.voiceTalkLimiter.reset()
    ;(idx.voiceTokenLimiter as any).reset()
    api.roundLimiter?.reset?.()
  })
  afterAll(() => { configureVoice(null); TALK.graceMs = 8000; delete process.env.OPEN_SIGNIN; talkLog.reset() })

  /** A round on the bridge's side: the voice state says it begins `lengthS` seconds ago, and the report comes now. Returns the id and the start of the window. */
  async function playedRound(lengthS = 60, players = [A, B]) {
    await setting(true)
    await state('active')
    const w = talkLog.windowsOf(server.id).at(-1)!
    w.from = NOW() - lengthS * 1000 // the round began lengthS seconds ago
    const id = `round-c4-${String(++n).padStart(6, '0')}`
    return { id, start: w.from, report: () => bridge('/v1/round', { round_id: id, map: 'ttt_a', result: 'innocents', duration: lengthS, players: players.map(p => ({ steam_id: p, nick: p.slice(-3), role: 'innocent', team: 'innocents' })), deaths: [] }) }
  }

  test('the route is for a signed-in or paired player, in the tiers as "user"', async () => {
    const { TIERS } = await import('../src/routes/tiers')
    expect((TIERS as any)['POST /servers/:serverId/voice/talk']).toBe('user')
    await setting(true)
    expect((await post(null, { spans: [] })).status).toBe(401)
    expect((await post(A, { spans: [] }, {}, '/servers/nope/voice/talk')).status).toBe(404)
    configureVoice(null)
    expect((await post(A, { spans: [] })).status).toBe(503)
    configureVoice(CFG)
    expect((await post(A, { spans: [] })).status).toBe(204)
    delete process.env.OPEN_SIGNIN
    expect((await post(A, { spans: [] })).status).toBe(401) // sign-in closed: the player is nobody
    process.env.OPEN_SIGNIN = '1'
  })

  test('a browser that paired with a code from the game is the same player for this route', async () => {
    await openRound()
    const t = NOW()
    const res = await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/talk`, { method: 'POST', headers: { Cookie: `${session.VOICE_COOKIE}=${vs.makeVoiceCookie(B)}` }, body: JSON.stringify({ now: t, spans: [span(t - 2000, t - 1000)] }) }))
    expect(res.status).toBe(204)
    expect(talkLog.held(server.id, B)).toHaveLength(1)
  })

  test('with the setting off, or never reported, nothing is read or kept and the answer says so, quietly', async () => {
    await state('active') // a round is on
    const t = NOW()
    for (const s of [null, false]) {
      await setting(s)
      const res = await post(A, { now: t, spans: [span(t - 2000, t - 1000)] })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ record: false })
      expect(talkLog.held(server.id, A)).toEqual([])
    }
    expect(talkEnabled(server.id)).toBe(false)
    // the body is not even read: garbage gets the same quiet answer
    expect((await (await post(A, 'not json at all')).json())).toEqual({ record: false })
    await setting(true)
    expect(talkEnabled(server.id)).toBe(true)
    expect((await post(A, { now: t, spans: [span(t - 2000, t - 1000)] })).status).toBe(204)
  })

  test('a round that began with the setting off stays unrecorded when the setting is turned on during it', async () => {
    await setting(false); await state('active')
    await setting(true)
    const t = NOW()
    expect((await post(A, { now: t, spans: [span(t - 2000, t - 1000)] })).status).toBe(204)
    expect(talkLog.held(server.id, A)).toEqual([]) // answered, but not kept: it is not "from the next round"
  })

  test('the identity is the session\'s: whatever the body says about who speaks, the spans are the signed-in player\'s own', async () => {
    await openRound()
    const t = NOW()
    const res = await post(A, { now: t, steamId: B, p: B, player: B, spans: [{ from: t - 2000, to: t - 1000, steamId: B, p: B }] })
    expect(res.status).toBe(204)
    expect(talkLog.held(server.id, A)).toHaveLength(1)
    expect(talkLog.held(server.id, B)).toEqual([])
  })

  test('refuses a cross-site post (the same check as the other voice routes)', async () => {
    await setting(true)
    const res = await post(A, { spans: [] }, { Origin: 'https://evil.example', Host: 'localhost' })
    expect(res.status).toBe(403)
    expect((await post(A, { spans: [] }, { Origin: 'http://localhost', Host: 'localhost' })).status).toBe(204)
  })

  test('the body: at most 4 096 bytes, an object with at most 50 spans; bad ones are 400/413 and keep nothing', async () => {
    await openRound()
    const t = NOW()
    expect((await post(A, 'x'.repeat(TALK.maxBodyBytes + 1))).status).toBe(413)
    expect((await post(A, '{"spans":[]}', { 'Content-Length': '5000' })).status).toBe(413)
    expect((await post(A, 'not json')).status).toBe(400)
    expect((await post(A, [])).status).toBe(400)
    expect((await post(A, { spans: 'x' })).status).toBe(400)
    expect((await post(A, { now: t, spans: Array(51).fill(span(t - 2000, t - 1000)) })).status).toBe(400)
    expect(talkLog.held(server.id, A)).toEqual([])
    expect((await post(A, { now: t, spans: Array(50).fill(span(t - 2000, t - 1000)) })).status).toBe(204)
    expect(talkLog.held(server.id, A)).toHaveLength(50)
  })

  test('is limited per player (20 in 10 s), and the limit is per player', async () => {
    await setting(true)
    let last = 204
    for (let i = 0; i < 22; i++) last = (await post(A, { spans: [] })).status
    expect(last).toBe(429)
    expect((await post(B, { spans: [] })).status).toBe(204)
  })

  test('the join token tells the page whether this server records who speaks', async () => {
    const token = async () => (await (await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers: { Cookie: await cookieFor(A) } }))).json()).talk
    expect(await token()).toBe(false)
    await setting(true)
    ;(idx.voiceTokenLimiter as any).reset()
    expect(await token()).toBe(true)
  })

  test('a round: the spans in its window are written, relative to its start, for its players only', async () => {
    const r = await playedRound(60)
    const t = NOW()
    // A talks 10 s to 20 s into the round and again at 30 s to 35 s; B talks 40 s to 41 s; OUT was never in the round
    for (const [as, from, to] of [[A, 10_000, 20_000], [A, 30_000, 35_000], [B, 40_000, 41_000], [OUT, 12_000, 14_000]] as const) {
      expect((await post(as, { now: t, spans: [span(r.start + from, r.start + to)] })).status).toBe(204)
    }
    expect((await r.report()).status).toBe(200)
    expect(rough(Store.getTalk(server.id, r.id).list)).toEqual([
      { p: A, from: 10_000, to: 20_000 }, { p: A, from: 30_000, to: 35_000 }, { p: B, from: 40_000, to: 41_000 },
    ])
  })

  test('a round with nobody on the voice page, or with the setting off, has no row', async () => {
    const quiet = await playedRound(60)
    expect((await quiet.report()).status).toBe(200)
    expect(Store.getTalk(server.id, quiet.id)).toBeNull()
    const off = await playedRound(60)
    const t = NOW()
    await post(A, { now: t, spans: [span(off.start + 1000, off.start + 5000)] })
    await setting(false) // turned off before the report: nothing is written
    expect((await off.report()).status).toBe(200)
    expect(Store.getTalk(server.id, off.id)).toBeNull()
  })

  test('the voice state decides which round: a window of another length is not the round, and a window is used once', async () => {
    const r = await playedRound(60)
    const t = NOW()
    await post(A, { now: t, spans: [span(r.start + 1000, r.start + 5000)] })
    const wrong = await bridge('/v1/round', { round_id: 'round-c4-wrong1', map: 'ttt_a', result: 'innocents', duration: 200, players: [{ steam_id: A, nick: 'a', role: 'innocent', team: 'innocents' }], deaths: [] })
    expect(wrong.status).toBe(200)
    expect(Store.getTalk(server.id, 'round-c4-wrong1')).toBeNull()
    await r.report()
    expect(Store.getTalk(server.id, r.id)).not.toBeNull()
    const again = await bridge('/v1/round', { round_id: 'round-c4-again', map: 'ttt_a', result: 'innocents', duration: 60, players: [{ steam_id: A, nick: 'a', role: 'innocent', team: 'innocents' }], deaths: [] })
    expect(again.status).toBe(200)
    expect(Store.getTalk(server.id, 'round-c4-again')).toBeNull() // the window was spent
  })

  test('the last spans of a round come after its report: they are written after the grace, not at the report', async () => {
    TALK.graceMs = 40
    const r = await playedRound(60)
    const t = NOW()
    await post(A, { now: t, spans: [span(r.start + 1000, r.start + 5000)] })
    await r.report()
    expect(Store.getTalk(server.id, r.id)).toBeNull() // not yet
    await post(A, { now: NOW(), spans: [span(r.start + 55_000, r.start + 59_000)] }) // a late one, still inside the round
    await new Promise(res => setTimeout(res, 120))
    expect(rough(Store.getTalk(server.id, r.id).list).map((s: any) => [s.from, s.to])).toEqual([[1000, 5000], [55_000, 59_000]])
    TALK.graceMs = 0
  })

  test('a report that fails to attach does not fail the round', async () => {
    const r = await playedRound(60)
    const orig = Store.recordTalk
    Store.recordTalk = () => { throw new Error('disk') }
    const t = NOW()
    await post(A, { now: t, spans: [span(r.start + 1000, r.start + 5000)] })
    const res = await r.report()
    Store.recordTalk = orig
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, stored: true })
  })

  test('attachTalk: stores nothing for a round the log has no window for, and says how many it wrote', async () => {
    await setting(true)
    expect(await attachTalk(server.id, 'round-x', 60, new Set([A]), 0)).toBe(0)
    expect(await attachTalk(server.id, 'round-x', null, new Set([A]), 0)).toBe(0)
  })

  // ---- track.json
  const trackFor = (id: string, players = [A, B]) => { const t = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0, 200, 200],
    players: players.map(p => ({ id: p, segments: [{ from: 0, x: [10, 1, 1], y: [10, 0, 0], z: [0, 0, 0], a: [0, 8, 8] }] })), deaths: [] }; Store.recordTrack(server.id, t, JSON.stringify(t)) }
  const getTrackJson = async (id: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost/servers/${server.id}/rounds/${id}/track.json`, { headers: { Cookie: await cookieFor(A), ...headers } }))
  const reportPlain = (id: string, players = [A, B]) => Store.recordRound(server.id, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'traitors',
    players: players.map((p, i) => ({ steamId: p, nick: `N${i}`, role: 'innocent', team: 'innocents', survived: true, won: true })), deaths: [] })

  test('track.json carries `talk` when the round has it, in order, for its players only; without it there is no field', async () => {
    reportPlain('round-c4-tj01'); trackFor('round-c4-tj01')
    const none = await (await getTrackJson('round-c4-tj01')).json() as any
    expect('talk' in none.track).toBe(false)
    Store.recordTalk(server.id, 'round-c4-tj01', [{ p: B, from: 5000, to: 6000 }, { p: A, from: 1000, to: 2000 }, { p: OUT, from: 0, to: 10 }, { p: A, from: 9, to: 3 }])
    const body = await (await getTrackJson('round-c4-tj01')).json() as any
    expect(body.track.talk).toEqual([{ p: A, from: 1000, to: 2000 }, { p: B, from: 5000, to: 6000 }]) // the stranger and the backwards span are gone
    expect(body.track.t).toEqual([0, 200, 200]) // the rest of the track is as it was
    expect(Object.keys(body.track.talk[0]).sort()).toEqual(['from', 'p', 'to'])
  })

  test('a stored row that only holds strangers or garbage adds no field', async () => {
    reportPlain('round-c4-tj02'); trackFor('round-c4-tj02')
    Store.recordTalk(server.id, 'round-c4-tj02', [{ p: OUT, from: 0, to: 10 }])
    expect('talk' in (await (await getTrackJson('round-c4-tj02')).json() as any).track).toBe(false)
    db.run("UPDATE round_talk SET data = 'not json' WHERE server_id = ?", [server.id])
    expect((await getTrackJson('round-c4-tj02')).status).toBe(200)
  })

  test('the ETag changes when who spoke changes, and an old copy is not answered 304', async () => {
    reportPlain('round-c4-tj03'); trackFor('round-c4-tj03')
    const first = await getTrackJson('round-c4-tj03')
    const etag0 = first.headers.get('etag')!
    expect((await getTrackJson('round-c4-tj03', { 'If-None-Match': etag0 })).status).toBe(304)
    Store.recordTalk(server.id, 'round-c4-tj03', [{ p: A, from: 1000, to: 2000 }])
    const second = await getTrackJson('round-c4-tj03', { 'If-None-Match': etag0 })
    expect(second.status).toBe(200) // the copy without talk is replaced
    const etag1 = second.headers.get('etag')!
    expect(etag1).not.toBe(etag0)
    expect((await getTrackJson('round-c4-tj03', { 'If-None-Match': etag1 })).status).toBe(304)
    Store.recordTalk(server.id, 'round-c4-tj03', [{ p: A, from: 1000, to: 2001 }])
    expect((await getTrackJson('round-c4-tj03', { 'If-None-Match': etag1 })).status).toBe(200)
    expect((await getTrackJson('round-c4-tj03')).headers.get('etag')).not.toBe(etag1)
    // and the same data gives the same ETag again
    const a = (await getTrackJson('round-c4-tj03')).headers.get('etag'), b = (await getTrackJson('round-c4-tj03')).headers.get('etag')
    expect(a).toBe(b)
  })

  test('deleting the round deletes who spoke; a track without its talk row is as before', async () => {
    reportPlain('round-c4-tj04'); trackFor('round-c4-tj04')
    Store.recordTalk(server.id, 'round-c4-tj04', [{ p: A, from: 1000, to: 2000 }])
    Store.deleteTrack(server.id, 'round-c4-tj04')
    expect(Store.getTalk(server.id, 'round-c4-tj04')).toBeNull()
    Store.deleteRound(server.id, 'round-c4-tj04')
    expect((await getTrackJson('round-c4-tj04')).status).toBe(404)
  })

  test('end to end: the route, the voice state, the round report and the track.json', async () => {
    const r = await playedRound(90)
    const t = NOW()
    await post(A, { now: t, spans: [span(r.start + 20_000, r.start + 26_000)] })
    await post(B, { now: t + 7_200_000, spans: [span(t + 7_200_000 - 50_000, t + 7_200_000 - 45_000)] }) // B's browser clock is two hours fast
    await r.report()
    trackFor(r.id)
    const body = await (await getTrackJson(r.id)).json() as any
    const [a, b] = body.track.talk
    expect(rough([a])).toEqual([{ p: A, from: 20_000, to: 26_000 }])
    // B's clock was two hours off: its spans land where they happened, to within the time the request took
    expect(b.p).toBe(B)
    expect(Math.abs(b.from - (t - 50_000 - r.start))).toBeLessThan(500)
    expect(b.to - b.from).toBe(5000)
  })
})
