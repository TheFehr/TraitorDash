import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 16, 4: the game vouches for a player. The bridge gets a key for each player in the game, the client puts it
// in the link, /auth/game turns it into a game session: a plain user, never an admin, in a cookie of its own.

let mod: any, app: any, Store: any, gk: any, session: any, token: string, serverId: string
const SECRET = 'test-secret-test-secret-test-secret-0'
const ADMIN = '76561198000000000', P1 = '76561198000000011', P2 = '76561198000000012'
let n = 0

beforeAll(async () => {
  mod = await import('../src/index')
  app = mod.default
  Store = (await import('../src/services/Store')).Store
  gk = await import('../src/services/gameKey')
  session = await import('../src/middleware/session')
})
beforeEach(async () => {
  mod.resetRolePages()
  const added = Store.addServer('Vouch') as any
  serverId = added.id; token = added.token
  ;(await import('../src/routes/api')).ingameKeysLimiter.reset()
  ;(await import('../src/routes/auth')).gameLimiter.reset()
})
afterEach(() => { delete process.env.OPEN_SIGNIN; delete process.env.BLOCKED_STEAM_IDS })

const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${path}`, { headers }))
const cookieOf = (r: Response, name = 'td_game') => {
  const raw = r.headers.get('set-cookie') ?? ''
  const m = new RegExp(`${name}=([^;]+)`).exec(raw)
  return m ? `${name}=${m[1]}` : null
}
const keys = (body: unknown, auth: string | null = `Bearer ${token}`) =>
  app.fetch(new Request('http://localhost/api/v1/ingame-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) }))

function round(track = true) {
  const id = `round-${String(++n).padStart(6, '0')}`
  Store.recordRound(serverId, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'traitors',
    players: [{ steamId: P1, nick: 'Ann', role: 'traitor', team: 'traitors', survived: true, won: true }], deaths: [] })
  if (track) {
    const t = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0], players: [{ id: P1, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [] }
    Store.recordTrack(serverId, t, JSON.stringify(t))
  }
  return id
}

describe('a key', () => {
  test('names the player, expires, and cannot be forged or altered', () => {
    const now = Date.parse('2026-10-22T12:00:00Z')
    const k = gk.makeGameKey(P1, now)
    expect(gk.readGameKey(k, now)).toBe(P1)
    expect(gk.readGameKey(k, now + 14 * 60_000)).toBe(P1)
    expect(gk.readGameKey(k, now + 16 * 60_000)).toBeNull()
    const [id, exp, sig] = k.split('.')
    expect(gk.readGameKey(`${P2}.${exp}.${sig}`, now)).toBeNull()                    // another player, same signature
    expect(gk.readGameKey(`${id}.${Number(exp) + 99999}.${sig}`, now)).toBeNull()    // a longer life
    expect(gk.readGameKey(`${id}.${exp}.${sig.slice(0, -1)}A`, now)).toBeNull()
    for (const junk of [null, undefined, 5, '', 'a.b.c', `${P1}.1.x`, k + 'x', 'x'.repeat(500)]) expect(gk.readGameKey(junk as any, now)).toBeNull()
  })
  test('a session cookie is not a key, and a key is not a session cookie', async () => {
    const cookie = (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]!.split('=')[1]!
    expect(gk.readGameKey(decodeURIComponent(cookie))).toBeNull()
    const r = await get('/servers/' + serverId + '/stats', { Cookie: `steam_id=${encodeURIComponent(gk.makeGameKey(ADMIN))}` })
    expect(r.status).toBe(200)
    expect(await r.text()).not.toContain('admin')
  })
})

describe('POST /api/v1/ingame-keys', () => {
  test('gives a key per player, each of which reads back as that player', async () => {
    const r = await keys({ players: [P1, P2, P1] })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(Array.isArray(body.keys)).toBe(true)           // a list: JSONToTable would mangle SteamID64 object keys
    expect(body.keys.map((k: any) => k.steam_id)).toEqual([P1, P2])
    for (const k of body.keys) expect(gk.readGameKey(k.key)).toBe(k.steam_id)
    expect(body.ttl).toBe(900)
  })
  test('needs the server token; checks the list', async () => {
    expect((await keys({ players: [P1] }, null)).status).toBe(401)
    expect((await keys({ players: [P1] }, 'Bearer nope')).status).toBe(401)
    expect((await keys({ players: 'x' })).status).toBe(400)
    expect((await keys({ players: ['123'] })).status).toBe(400)
    expect((await keys({ players: [5] })).status).toBe(400)
    expect((await keys({ players: Array.from({ length: 129 }, (_, i) => `7656119800000${String(1000 + i)}`) })).status).toBe(400)
    expect((await keys({ players: [] })).status).toBe(200)
  })
  test('6 a minute per server', async () => {
    for (let i = 0; i < 6; i++) expect((await keys({ players: [P1] })).status).toBe(200)
    expect((await keys({ players: [P1] })).status).toBe(429)
  })
})

describe('GET /auth/game', () => {
  const key = (id = P1) => gk.makeGameKey(id)
  const go = (k: string | null, to = `/servers/${serverId}/stats?embed=1`) =>
    get(`/auth/game?${k ? `k=${encodeURIComponent(k)}&` : ''}to=${encodeURIComponent(to)}`)

  test('with open sign-in a key gives a game session cookie and goes on to the page', async () => {
    process.env.OPEN_SIGNIN = '1'
    const r = await go(key())
    expect(r.status).toBe(302)
    expect(r.headers.get('Location')).toBe(`/servers/${serverId}/stats?embed=1`)
    expect(cookieOf(r)).not.toBeNull()
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(r.headers.get('set-cookie')).toMatch(/SameSite=Lax/i)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
  test('without open sign-in only an admin gets one, and as a plain user', async () => {
    expect(cookieOf(await go(key(P1)))).toBeNull()
    expect(cookieOf(await go(key(ADMIN)))).not.toBeNull()
  })
  test('a blocked account, a bad key and an old key give no cookie, and still end on the page', async () => {
    process.env.OPEN_SIGNIN = '1'
    process.env.BLOCKED_STEAM_IDS = P2
    for (const k of [key(P2), 'junk', gk.makeGameKey(P1, Date.now() - 3_600_000), null]) {
      const r = await go(k)
      expect(r.status).toBe(302)
      expect(cookieOf(r)).toBeNull()
      expect(r.headers.get('Location')).toBe(`/servers/${serverId}/stats?embed=1`)
    }
  })
  test('only a page of this site under /servers/ is a target', async () => {
    process.env.OPEN_SIGNIN = '1'
    for (const to of ['//evil.example', 'https://evil.example', '/\\evil', '/auth/steam', '/', '/%2F/evil']) {
      expect((await go(key(), to)).headers.get('Location'), to).toBe('/')
    }
  })
  test('a flood is a 429', async () => {
    process.env.TRUST_PROXY = '1'
    for (let i = 0; i < 30; i++) expect((await get('/auth/game?to=%2F', { 'X-Forwarded-For': '10.9.0.1' })).status).toBe(302)
    expect((await get('/auth/game?to=%2F', { 'X-Forwarded-For': '10.9.0.1' })).status).toBe(429)
    delete process.env.TRUST_PROXY
  })
})

describe('what a game session may do', () => {
  const via = async (id: string) => {
    const r = await get(`/auth/game?k=${encodeURIComponent(gk.makeGameKey(id))}&to=%2Fservers%2F${serverId}%2Fstats`)
    return cookieOf(r)!
  }
  test('it opens the replay and the data of a round, like a signed-in user', async () => {
    process.env.OPEN_SIGNIN = '1'
    const id = round()
    const c = await via(P1)
    expect((await get(`/servers/${serverId}/rounds/${id}/replay?embed=1`, { Cookie: c })).status).toBe(200)
    expect((await get(`/servers/${serverId}/rounds/${id}/track.json`, { Cookie: c })).status).toBe(200)
    expect((await get(`/servers/${serverId}/rounds/${id}/track.json`)).status).toBe(401)
  })
  test('it is never an admin, not even for an admin', async () => {
    const c = await via(ADMIN)
    const adminOnly = [`/servers/${serverId}`, `/servers`, `/servers/${serverId}/maps/ttt_a/plan.json`, `/sidebar/${serverId}`]
    for (const p of adminOnly) {
      const r = await get(p, { Cookie: c })
      expect([302, 401], p).toContain(r.status)
    }
    const stats = await (await get(`/servers/${serverId}/stats`, { Cookie: c })).text()
    expect(stats).not.toContain('Delete selected')
    expect(stats).not.toContain('data-admin-mark')
  })
  test('it stops with open sign-in (for non-admins) and for a blocked account', async () => {
    process.env.OPEN_SIGNIN = '1'
    const id = round()
    const c = await via(P1)
    delete process.env.OPEN_SIGNIN
    expect((await get(`/servers/${serverId}/rounds/${id}/track.json`, { Cookie: c })).status).toBe(401)
    process.env.OPEN_SIGNIN = '1'
    process.env.BLOCKED_STEAM_IDS = P1
    expect((await get(`/servers/${serverId}/rounds/${id}/track.json`, { Cookie: c })).status).toBe(401)
  })
  test('a real sign-in wins over a game session, and the logout removes both', async () => {
    process.env.OPEN_SIGNIN = '1'
    const game = await via(P1)
    const real = (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]!
    const r = await get(`/servers/${serverId}/stats`, { Cookie: `${real}; ${game}` })
    expect(await r.text()).toContain('data-admin-mark')
    const out = await app.fetch(new Request('http://localhost/auth/logout', { method: 'POST', headers: { Cookie: `${real}; ${game}` } }))
    expect(out.headers.get('set-cookie')).toMatch(/td_game=;/)
  })
  test('the game pages offer the replay to a game session and the round, with embed kept', async () => {
    process.env.OPEN_SIGNIN = '1'
    const id = round()
    const c = await via(P1)
    const html = await (await get(`/servers/${serverId}/rounds/${id}?embed=1`, { Cookie: c })).text()
    expect(html).toContain(`/rounds/${id}/replay?embed=1`)
    const list = await (await get(`/servers/${serverId}/stats?embed=1&view=rounds`, { Cookie: c })).text()
    expect(list).toContain(`/rounds/${id}/replay?embed=1`)
  })
})

describe('every game page says who it takes the visitor for', () => {
  test('"Not signed in." without a session, "Signed in as <id>." with a game session, on all four pages', async () => {
    process.env.OPEN_SIGNIN = '1'
    const id = round()
    Store.setMaps(serverId, { current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: null, poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps: [{ name: 'ttt_a', size: 1, fingerprint: null, matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: true, inVotePool: true, votable: false }] })
    const c = cookieOf(await get(`/auth/game?k=${encodeURIComponent(gk.makeGameKey(P1))}&to=%2Fservers%2Fx`))!
    for (const path of [`/servers/${serverId}/stats?embed=1&view=rounds`, `/servers/${serverId}/rounds/${id}?embed=1`, `/servers/${serverId}/maps?embed=1`, `/servers/${serverId}/maps/ttt_a/rounds?embed=1`]) {
      expect(await (await get(path)).text(), path).toContain('Not signed in.')
      expect(await (await get(path, { Cookie: c })).text(), path).toContain(`Signed in as ${P1}.`)
    }
  })
  test('the 3D button says that opening it is logged with the SteamID64, while logging is on', async () => {
    process.env.OPEN_SIGNIN = '1'; process.env.MAP_GEOMETRY = '1'
    Store.setMaps(serverId, { current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: null, poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps: [{ name: 'ttt_a', size: 1, fingerprint: 'f', matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: true, inVotePool: true, votable: false }] })
    const orig = Store.getGeometryStates
    Store.getGeometryStates = () => new Map([['ttt_a', { status: 'parsed' }]])
    try {
      const c = cookieOf(await get(`/auth/game?k=${encodeURIComponent(gk.makeGameKey(P1))}&to=%2Fservers%2Fx`))!
      const html = await (await get(`/servers/${serverId}/maps/ttt_a/rounds?embed=1`, { Cookie: c })).text()
      expect(html).toMatch(/logged with your SteamID64 for \d+ days/)
    } finally { Store.getGeometryStates = orig; delete process.env.MAP_GEOMETRY }
  })
})

describe('the browser is named, because it decides what the pages may use', () => {
  test('browserOf reads the Chrome version from the User-Agent; anything else is nothing', async () => {
    const { browserOf } = await import('../src/components/GamePages')
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.100 Safari/537.36')).toBe('Chrome 76')
    expect(browserOf('Mozilla/5.0 Gecko/20100101 Firefox/120.0')).toBeNull()
    expect(browserOf(null)).toBeNull()
    expect(browserOf(undefined)).toBeNull()
  })
  test('every game page shows it at the bottom, and nothing when there is no User-Agent', async () => {
    const id = round()
    const ua = { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.100 Safari/537.36' }
    for (const path of [`/servers/${serverId}/stats?embed=1`, `/servers/${serverId}/rounds/${id}?embed=1`, `/servers/${serverId}/maps?embed=1`]) {
      expect(await (await get(path, ua)).text(), path).toContain('Browser: Chrome 76.')
      expect(await (await get(path)).text(), path).not.toContain('Browser:')
    }
  })
})

describe('the full pages inside the game window', () => {
  test('the replay without the site header and without the Steam login, with the way back inside the window', async () => {
    process.env.OPEN_SIGNIN = '1'
    const id = round()
    const c = cookieOf(await get(`/auth/game?k=${encodeURIComponent(gk.makeGameKey(P1))}&to=%2Fservers%2Fx`))!
    const html = await (await get(`/servers/${serverId}/rounds/${id}/replay?embed=1`, { Cookie: c })).text()
    expect(html).not.toContain('TraitorDash</a>')
    expect(html).not.toContain('Logout')
    expect(html).toContain(`/stats?embed=1&amp;view=rounds`)
    const plain = await (await get(`/servers/${serverId}/rounds/${id}/replay`, { Cookie: c })).text()
    expect(plain).toContain('Dashboard')
  })
  test('without a session in the game nobody is sent to the Steam login: the replay and the 3D page go back to the game pages', async () => {
    const id = round()
    expect((await get(`/servers/${serverId}/rounds/${id}/replay?embed=1`)).headers.get('Location')).toBe(`/servers/${serverId}/rounds/${id}?embed=1`)
    expect((await get(`/servers/${serverId}/maps/ttt_a?embed=1`)).headers.get('Location')).toBe(`/servers/${serverId}/maps/ttt_a/rounds?embed=1`)
    process.env.OPEN_SIGNIN = '1'
    expect((await get(`/servers/${serverId}/rounds/${id}/replay`)).headers.get('Location')).toContain('/auth/steam')   // the website is as before
  })
  test('the map file offers the 3D view to a visitor with a session, and says it needs one to everybody else', async () => {
    process.env.OPEN_SIGNIN = '1'
    process.env.MAP_GEOMETRY = '1'
    Store.setMaps(serverId, { current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: null, poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps: [{ name: 'ttt_a', size: 1, fingerprint: 'f', matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: true, inVotePool: true, votable: false }] })
    const orig = Store.getGeometryStates
    Store.getGeometryStates = () => new Map([['ttt_a', { status: 'parsed' }]])
    try {
      const c = cookieOf(await get(`/auth/game?k=${encodeURIComponent(gk.makeGameKey(P1))}&to=%2Fservers%2Fx`))!
      expect(await (await get(`/servers/${serverId}/maps/ttt_a/rounds?embed=1`, { Cookie: c })).text()).toContain(`/maps/ttt_a?embed=1`)
      const anon = await (await get(`/servers/${serverId}/maps/ttt_a/rounds?embed=1`)).text()
      expect(anon).not.toContain('View in 3D')
      expect(anon).toContain('opens for signed-in visitors')
    } finally { Store.getGeometryStates = orig; delete process.env.MAP_GEOMETRY }
  })
})
