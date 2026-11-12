import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 28: names from the Steam Web API. Steam is a fake `fetch`; the clock is ours.
import { migrate, migrations } from '../src/services/migrations'
import { BACKOFF_MS, MAX_IDS, MISS_TTL_MS, NAME_TTL_MS, SteamNames } from '../src/services/steamNames'
import { configureVoice } from '../src/services/voice'

const KEY = 'SECRETKEY0123456789ABCDEF01234567'
const id = (n: number) => String(76561198000000000n + BigInt(n))
const A = id(1), B = id(2), C = id(3)
const ADMIN = id(0)

const fresh = () => { const db = new Database(':memory:'); migrate(db); return db }

/** A Steam that answers from a table of names; records the addresses asked. */
function fakeSteam(names: Record<string, string | null>, opt: { status?: number, body?: unknown, fail?: Error } = {}) {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(String(url))
    if (opt.fail) throw opt.fail
    if (opt.status && opt.status !== 200) return new Response('no', { status: opt.status })
    if (opt.body !== undefined) return Response.json(opt.body)
    const asked = new URL(String(url)).searchParams.get('steamids')!.split(',')
    return Response.json({ response: { players: asked.filter(i => names[i]).map(i => ({ steamid: i, personaname: names[i], realname: 'Secret Real', loccountry: 'CH', avatar: 'x' })) } })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

function make(fetchFn: typeof fetch, over: { key?: string | null } = {}) {
  const db = fresh()
  const clock = { t: 1_000_000 }
  const logs: string[] = []
  const key = over.key === undefined ? KEY : over.key
  const sn = new SteamNames({ db, key: () => key, fetchFn, now: () => clock.t, log: (m) => logs.push(m) })
  return { sn, db, clock, logs }
}

describe('the migration', () => {
  test('v30 makes steam_names and the schema is at the latest version', () => {
    const db = fresh()
    expect(migrations.length).toBeGreaterThanOrEqual(30)
    expect((db.query('PRAGMA user_version').get() as any).user_version).toBe(migrations.length)
    const cols = db.query("PRAGMA table_info('steam_names')").all() as { name: string, pk: number }[]
    expect(cols.map(c => c.name)).toEqual(['steam_id', 'name', 'fetched_at'])
    expect(cols.find(c => c.name === 'steam_id')!.pk).toBe(1)
  })
})

describe('the lookup', () => {
  test('one call for several ids, only personaname read, the key sent only to Steam', async () => {
    const s = fakeSteam({ [A]: 'Alice', [B]: 'Bob' })
    const { sn, db } = make(s.fetchFn)
    expect(sn.names([A, B, C]).size).toBe(0) // nothing cached yet: the answer does not wait
    await sn.idle()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]).toContain('ISteamUser/GetPlayerSummaries')
    const steamids = new URL(s.calls[0]!).searchParams.get('steamids')!.split(',')
    expect(steamids.sort()).toEqual([A, B, C].sort())
    expect(Object.fromEntries(sn.names([A, B, C]))).toEqual({ [A]: 'Alice', [B]: 'Bob' })
    const rows = db.query('SELECT * FROM steam_names ORDER BY steam_id').all() as any[]
    expect(rows.length).toBe(3)
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['fetched_at', 'name', 'steam_id'])
    expect(JSON.stringify(rows)).not.toContain('Secret Real')
    expect(JSON.stringify(rows)).not.toContain(KEY)
  })

  test('at most 100 ids in a call', async () => {
    const s = fakeSteam({})
    const { sn } = make(s.fetchFn)
    sn.names(Array.from({ length: 250 }, (_, i) => id(i + 1)))
    await sn.idle()
    expect(s.calls.length).toBe(3)
    expect(s.calls.map(c => new URL(c).searchParams.get('steamids')!.split(',').length).sort((a, b) => a - b)).toEqual([50, MAX_IDS, MAX_IDS])
  })

  test('names are cleaned like every nick; a name that is only blanks is a miss; strangers in the answer are ignored', async () => {
    const s = fakeSteam({}, { body: { response: { players: [
      { steamid: A, personaname: '  Al\u0007ice\n' + 'x'.repeat(60) }, { steamid: B, personaname: '  \t ' }, { steamid: id(99), personaname: 'Stranger' }] } } })
    const { sn } = make(s.fetchFn)
    sn.names([A, B]); await sn.idle()
    const got = sn.names([A, B])
    expect([...got.get(A)!].length).toBeLessThanOrEqual(32)
    expect(got.get(A)).not.toContain('\u0007')
    expect(got.has(B)).toBe(false)
    expect(got.has(id(99))).toBe(false)
  })

  test('ids that are not SteamID64s are never sent', async () => {
    const s = fakeSteam({})
    const { sn } = make(s.fetchFn)
    sn.names(['nope', '123', "1' OR 1=1"]); await sn.idle()
    expect(s.calls.length).toBe(0)
  })

  test('no key: nothing is asked, nothing is returned', async () => {
    const s = fakeSteam({ [A]: 'Alice' })
    const { sn } = make(s.fetchFn, { key: null })
    expect(sn.enabled()).toBe(false)
    expect(sn.names([A]).size).toBe(0); await sn.idle()
    expect(s.calls.length).toBe(0)
  })
})

describe('when Steam goes wrong', () => {
  const cases: [string, Parameters<typeof fakeSteam>[1]][] = [
    ['an HTTP error', { status: 403 }],
    ['an answer that is not what Steam sends', { body: { nope: 1 } }],
    ['a timeout', { fail: Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }) }],
    ['a network error that carries the address', { fail: new Error(`connect failed for https://api.steampowered.com/x?key=${KEY}`) }],
  ]
  for (const [label, opt] of cases) {
    test(`${label}: no name, nothing stored, one log line without the key`, async () => {
      const s = fakeSteam({ [A]: 'Alice' }, opt)
      const { sn, db, logs } = make(s.fetchFn)
      expect(sn.names([A]).size).toBe(0)
      await sn.idle()
      expect(sn.names([A]).size).toBe(0)
      expect((db.query('SELECT count(*) AS n FROM steam_names').get() as any).n).toBe(0)
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('[Steam]')
      expect(logs.join('\n')).not.toContain(KEY)
    })
  }

  test('the call carries an abort signal (the 3 second timeout)', async () => {
    let signal: AbortSignal | undefined
    const { sn } = make((async (_u: string, init: RequestInit) => { signal = init.signal as AbortSignal; return Response.json({ response: { players: [] } }) }) as unknown as typeof fetch)
    sn.names([A]); await sn.idle()
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(false)
  })

  test('after a failure Steam is left alone for a while, and logged at most once a minute', async () => {
    const s = fakeSteam({}, { status: 500 })
    const { sn, clock, logs } = make(s.fetchFn)
    sn.names([A]); await sn.idle()
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(1) // not again at the next poll
    clock.t += BACKOFF_MS + 1
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(2)
    expect(logs.length).toBe(1) // the second failure is within the minute
    clock.t += 61_000
    sn.names([A]); await sn.idle()
    expect(logs.length).toBe(2)
  })

  test('an old name is still used when the refresh fails', async () => {
    const ok = fakeSteam({ [A]: 'Alice' })
    const { sn, db, clock } = make(ok.fetchFn)
    sn.names([A]); await sn.idle()
    const bad = new SteamNames({ db, key: () => KEY, fetchFn: fakeSteam({}, { status: 500 }).fetchFn, now: () => clock.t + 30 * 24 * 3600_000, log: () => {} })
    expect(bad.names([A]).get(A)).toBe('Alice') // a month old, still the answer
    await bad.idle()
    expect(bad.names([A]).get(A)).toBe('Alice')
  })
})

describe('the cache', () => {
  test('a fresh name is not asked for again; an old one is shown at once and refreshed in the background', async () => {
    const table: Record<string, string | null> = { [A]: 'Alice' }
    const s = fakeSteam(table)
    const { sn, clock } = make(s.fetchFn)
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(1)
    clock.t += NAME_TTL_MS - 1
    expect(sn.names([A]).get(A)).toBe('Alice'); await sn.idle()
    expect(s.calls.length).toBe(1)
    clock.t += 2
    table[A] = 'Alice renamed'
    expect(sn.names([A]).get(A)).toBe('Alice') // the old one, the page does not wait
    await sn.idle()
    expect(s.calls.length).toBe(2)
    expect(sn.names([A]).get(A)).toBe('Alice renamed')
  })

  test('a miss is kept for an hour, then asked for again', async () => {
    const table: Record<string, string | null> = {}
    const s = fakeSteam(table)
    const { sn, clock } = make(s.fetchFn)
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(1)
    clock.t += MISS_TTL_MS - 1
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(1)
    clock.t += 2
    table[A] = 'Now public'
    sn.names([A]); await sn.idle()
    expect(s.calls.length).toBe(2)
    expect(sn.names([A]).get(A)).toBe('Now public')
  })

  test('only what is missing or old is asked for, and the same id is not asked for twice at once', async () => {
    const s = fakeSteam({ [A]: 'Alice', [B]: 'Bob' })
    const { sn } = make(s.fetchFn)
    sn.names([A]); await sn.idle()
    sn.names([A, B]); sn.names([B]); await sn.idle()
    expect(s.calls.length).toBe(2)
    expect(new URL(s.calls[1]!).searchParams.get('steamids')).toBe(B)
  })
})

describe('the routes: the order of names, and who is looked up', () => {
  let app: any, api: any, Store: any, server: { id: string, token: string }
  const CFG = { url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'devkey', secret: 'devsecret-devsecret-devsecret-00' }
  const cookieFor = async (i: string) => (await serializeSigned('steam_id', i, SECRET)).split(';')[0]!
  const get = async (p: string, as: string) => app.fetch(new Request(`http://localhost${p}`, { headers: { Cookie: await cookieFor(as) } }))
  const token = async (as = ADMIN) => app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers: { Cookie: await cookieFor(as) } }))
  const nameIn = async (as = ADMIN) => JSON.parse(Buffer.from((await (await token(as)).json()).token.split('.')[1], 'base64url').toString()).name
  let steamMod: typeof import('../src/services/steamNames')
  let steamCalls: ReturnType<typeof fakeSteam>

  beforeAll(async () => {
    app = (await import('../src/index')).app
    api = (await import('../src/routes/api')).default
    Store = (await import('../src/services/Store')).Store
    steamMod = await import('../src/services/steamNames')
  })
  beforeEach(async () => {
    server = Store.addServer('Steam names') as any
    ;(await import('../src/index')).voiceTokenLimiter.reset()
    ;(await import('../src/index')).voicePeopleLimiter.reset()
    ;(await import('../src/routes/api')).voiceLimiter.reset()
  })
  afterAll(() => { configureVoice(null); delete process.env.STEAM_API_KEY })

  // The routes use the process's one lookup: point it at our fake by setting the key and swapping its fetch.
  const useSteam = (names: Record<string, string | null>) => {
    steamCalls = fakeSteam(names)
    const sn = steamMod.steamNames as any
    sn.fetchFn = steamCalls.fetchFn
    sn.inflight.clear(); sn.failedAt = -Infinity
    sn.db.run('DELETE FROM steam_names')
    process.env.STEAM_API_KEY = KEY
  }
  const people = async (parts: { identity: string, name: string }[]) => {
    configureVoice(CFG, (async () => Response.json({ participants: parts.map((p, i) => ({ sid: `PA_${i}`, ...p })) })) as unknown as typeof fetch)
    const { voiceHub } = await import('../src/services/voice')
    ;(voiceHub as any).peopleCache.clear()
    return (await (await get(`/servers/${server.id}/voice/people`, ADMIN)).json()).people as { id: string, name: string }[]
  }
  const round = (nick: string, who: string) => api.request('/v1/round', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ round_id: `round-${who}-${nick.replace(/\W/g, '')}-001`, map: 'ttt_x', result: 'innocents', duration: 300, players: [{ steam_id: who, nick, role: 'innocent', team: 'innocents' }], deaths: [] }) })

  test('the token name: game now, last round, Steam, SteamID64', async () => {
    configureVoice(CFG)
    useSteam({ [ADMIN]: 'Steam Phil' })
    expect(await nameIn()).toBe(ADMIN) // Steam is asked in the background; this token does not wait
    await steamMod.steamNames.idle()
    expect(await nameIn()).toBe('Steam Phil')
    expect((await round('Round Phil', ADMIN)).status).toBe(200)
    expect(await nameIn()).toBe('Round Phil')
    const { voiceHub } = await import('../src/services/voice')
    voiceHub.setState(server.id, { boot: 1, seq: 1, phase: 'over', alive: [], names: { [ADMIN]: 'Game Phil' } })
    expect(await nameIn()).toBe('Game Phil')
  })

  test('the token asks Steam for nobody when a round already knows the name', async () => {
    configureVoice(CFG)
    useSteam({ [ADMIN]: 'Steam Phil' })
    await round('Round Phil', ADMIN)
    expect(await nameIn()).toBe('Round Phil')
    await steamMod.steamNames.idle()
    expect(steamCalls.calls.length).toBe(0)
  })

  test('the people list: media server, game, round, Steam, SteamID64; Steam only for the ones left', async () => {
    useSteam({ [A]: 'Steam A', [B]: 'Steam B', [C]: 'Steam C', [id(5)]: 'Steam 5' })
    const { voiceHub } = await import('../src/services/voice')
    voiceHub.setState(server.id, { boot: 1, seq: 1, phase: 'over', alive: [], names: { [B]: 'Game B' } })
    await round('Round C', C)
    const parts = [{ identity: A, name: 'Joined A' }, { identity: B, name: B }, { identity: C, name: '' }, { identity: id(5), name: '' }, { identity: id(6), name: '' }]
    const first = await people(parts)
    expect(first.map(p => p.name)).toEqual(['Joined A', 'Game B', 'Round C', id(5), id(6)]) // Steam has not answered yet
    await steamMod.steamNames.idle()
    const asked = steamCalls.calls.map(c => new URL(c).searchParams.get('steamids')!.split(',').sort())
    expect(asked).toEqual([[id(5), id(6)].sort()]) // only the two nobody else knew
    const second = await people(parts)
    expect(second.map(p => p.name)).toEqual(['Joined A', 'Game B', 'Round C', 'Steam 5', id(6)])
  })

  test('without a key nothing is asked and the names are as before', async () => {
    useSteam({ [A]: 'Steam A' })
    delete process.env.STEAM_API_KEY
    configureVoice(CFG)
    expect((await people([{ identity: A, name: '' }])).map(p => p.name)).toEqual([A])
    expect(await nameIn()).toBe(ADMIN)
    await steamMod.steamNames.idle()
    expect(steamCalls.calls.length).toBe(0)
  })

  test('the key is in no answer', async () => {
    configureVoice(CFG)
    useSteam({ [ADMIN]: 'Steam Phil' })
    const t = await (await token()).text()
    await steamMod.steamNames.idle()
    const p = JSON.stringify(await people([{ identity: A, name: '' }]))
    expect(t + p).not.toContain(KEY)
  })
})
