import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { configureVoice } from '../src/services/voice'
import { setVoiceClock, voiceCodes, VOICE_CODE_FAILED, CODE_TTL_MS, PLAYER_WAIT_MS, MAX_FAILURES_PER_WINDOW } from '../src/services/voiceCode'

// RFC 31, section 7: the bridge route that makes a code, the form route that turns a code into the voice cookie, where the cookie is read
// (the voice page and its two data routes) and where it is not (everywhere else), and the pages.

const ADMIN = '76561198000000000', USER = '76561198000000042', OTHER = '76561198000000043'
const CFG = { url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'devkey', secret: 'devsecret-devsecret-devsecret-00' }
const SHAPE = /^[23456789BCDFGHJKMNPQRSTVWXYZ]{3}-[23456789BCDFGHJKMNPQRSTVWXYZ]{3}$/

let app: any, api: any, Store: any, session: any, vs: any, tiers: any, apiMod: any, authMod: any, idx: any
let server: { id: string, token: string }
let now = 1_900_000_000_000

const bridge = (body: unknown, token = server.token, raw = false) => api.request('/v1/voice-codes', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? (body as string) : JSON.stringify(body),
})
const SAME = { 'Sec-Fetch-Site': 'same-origin' }
const enter = (code: string, extra: { to?: string, headers?: Record<string, string>, omitTo?: boolean } = {}) => app.fetch(new Request('http://localhost/auth/voice-code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(extra.headers ?? SAME) },
  body: new URLSearchParams({ code, ...(extra.omitTo ? {} : { to: extra.to ?? `/servers/${server.id}/voice` }) }).toString(),
}))
const voiceCookieOf = (res: Response): string | null => {
  for (const c of res.headers.getSetCookie()) {
    const m = new RegExp(`^${session.VOICE_COOKIE}=([^;]*)`).exec(c)
    if (m && !/Max-Age=0/i.test(c) && m[1]) return decodeURIComponent(m[1])
  }
  return null
}
const withVoice = (value: string) => ({ Cookie: `${session.VOICE_COOKIE}=${value}` })
const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${path}`, { headers }))
const post = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers }))
const adminCookie = async () => (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]!
let serial = 0
const fresh = () => '76561198' + String(100000000 + ++serial)
/** A player says !voice, then types the code: the cookie it gives. */
const pair = async (id = USER): Promise<string> => {
  now += PLAYER_WAIT_MS // the same player may ask again
  const made = await (await bridge({ steam_id: id })).json()
  const res = await enter(made.code)
  const value = voiceCookieOf(res)
  if (!value) throw new Error('no cookie for ' + id)
  return value
}

beforeAll(async () => {
  idx = await import('../src/index')
  app = idx.app
  api = (await import('../src/routes/api')).default
  apiMod = await import('../src/routes/api')
  authMod = await import('../src/routes/auth')
  Store = (await import('../src/services/Store')).Store
  session = await import('../src/middleware/session')
  vs = await import('../src/services/voiceSession')
  tiers = await import('../src/routes/tiers')
})
beforeEach(() => {
  server = Store.addServer('Voice Code') as any
  configureVoice(CFG, (async () => Response.json({ participants: [] })) as unknown as typeof fetch)
  now += 3_600_000
  setVoiceClock(() => now)
  voiceCodes.reset()
  apiMod.voiceCodesLimiter.reset()
  authMod.voiceCodeLimiter.reset()
  idx.voiceTokenLimiter.reset(); idx.voicePeopleLimiter.reset()
  delete process.env.OPEN_SIGNIN; delete process.env.BLOCKED_STEAM_IDS; delete process.env.TRUST_PROXY
  process.env.OPEN_SIGNIN = '1'
})
afterAll(() => {
  setVoiceClock(null)
  configureVoice(null)
  for (const k of ['OPEN_SIGNIN', 'BLOCKED_STEAM_IDS', 'TRUST_PROXY']) delete process.env[k]
})

describe('the bridge route that makes a code', () => {
  test('it needs the server\'s token: none, a wrong one and a session cookie are refused', async () => {
    expect((await bridge({ steam_id: USER }, '')).status).toBe(401)
    expect((await bridge({ steam_id: USER }, 'wrong')).status).toBe(401)
    const res = await api.request('/v1/voice-codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() }, body: JSON.stringify({ steam_id: USER }) })
    expect(res.status).toBe(401)
    expect(voiceCodes.size).toBe(0)
  })

  test('a missing, wrong or odd SteamID64 and a body that is not JSON are 400', async () => {
    for (const body of [{}, { steam_id: '' }, { steam_id: 76561198000000042 }, { steam_id: '7656119800000004' }, { steam_id: '765611980000000420' }, { steam_id: 'STEAM_0:1:2' },
      { steam_id: '76561198000000042 ' }, { steam_id: ['76561198000000042'] }, { steam_id: null }, [], 'x']) {
      expect((await bridge(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await bridge('not json', server.token, true)).status).toBe(400)
    expect((await bridge('', server.token, true)).status).toBe(400)
    expect(voiceCodes.size).toBe(0)
  })

  test('the answer: a code in two groups, five minutes, the path of this server\'s voice page; not cached', async () => {
    const res = await bridge({ steam_id: USER })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.code).toMatch(SHAPE)
    expect(body.ttl).toBe(300)
    expect(body.path).toBe(`/servers/${server.id}/voice`)
    expect(Object.keys(body).sort()).toEqual(['code', 'path', 'success', 'ttl'])
    expect(voiceCodes.size).toBe(1)
  })

  test('without a media server on this backend it says so, as the voice routes do (503), and makes nothing', async () => {
    configureVoice(null)
    const res = await bridge({ steam_id: USER })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Voice chat is not set up' })
    expect(voiceCodes.size).toBe(0)
  })

  test('one new code per player every ten seconds: the second one is 429 with the wait, and the first code stays good', async () => {
    const first = await (await bridge({ steam_id: USER })).json()
    const again = await bridge({ steam_id: USER })
    expect(again.status).toBe(429)
    expect(Number(again.headers.get('retry-after'))).toBe(10)
    expect((await bridge({ steam_id: OTHER })).status).toBe(200) // another player is not held up
    now += PLAYER_WAIT_MS
    const later = await bridge({ steam_id: USER })
    expect(later.status).toBe(200)
    expect((await later.json()).code).not.toBe(first.code)
    expect(voiceCodes.redeem(first.code)).toBeNull() // replaced
  })

  test('a server gets a few codes a minute, and the limit is per server', async () => {
    const other = Store.addServer('Other') as any
    const statuses: number[] = []
    for (let i = 0; i < 25; i++) statuses.push((await bridge({ steam_id: `7656119800001${String(1000 + i)}` })).status)
    expect(statuses.filter(s => s === 200).length).toBe(20)
    expect(statuses.slice(20)).toEqual([429, 429, 429, 429, 429])
    expect((await bridge({ steam_id: `76561198000019999` }, other.token)).status).toBe(200)
    const refused = await bridge({ steam_id: '76561198000018888' })
    expect(refused.headers.get('retry-after')).toBeTruthy()
  })
})

describe('the entry route', () => {
  test('a right code sets the cookie and goes to the voice page of the server; the cookie is the player\'s, HttpOnly, SameSite Lax, 30 days, for the whole site', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    const res = await enter(made.code)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/servers/${server.id}/voice`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const raw = res.headers.getSetCookie().find((c: string) => c.startsWith(session.VOICE_COOKIE + '='))!
    expect(raw).toMatch(/HttpOnly/i); expect(raw).toMatch(/SameSite=Lax/i); expect(raw).toMatch(/Max-Age=2592000/); expect(raw).toMatch(/Path=\//); expect(raw).not.toMatch(/Domain=/i)
    expect(vs.readVoiceCookie(voiceCookieOf(res))).toBe(USER)
    // no other cookie, no session
    expect(res.headers.getSetCookie().filter((c: string) => !c.startsWith(session.VOICE_COOKIE + '='))).toEqual([])
  })

  test('the code is taken as typed: lower case, with spaces or without the dash', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    const typed = made.code.toLowerCase().replace('-', ' ')
    expect(vs.readVoiceCookie(voiceCookieOf(await enter(typed)))).toBe(USER)
  })

  test('single use: the same code a second time does not work', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    expect(voiceCookieOf(await enter(made.code))).not.toBeNull()
    expect(voiceCookieOf(await enter(made.code))).toBeNull()
  })

  test('a wrong, a used and an expired code (and a replaced one) all say the same thing and set nothing', async () => {
    const used = await (await bridge({ steam_id: USER })).json()
    await enter(used.code)
    const expired = await (await bridge({ steam_id: OTHER })).json()
    now += CODE_TTL_MS
    const replaced = await (await bridge({ steam_id: ADMIN })).json()
    now += PLAYER_WAIT_MS
    await bridge({ steam_id: ADMIN })
    const answers: { status: number, location: string | null, cookie: string | null }[] = []
    for (const code of ['222-222', used.code, expired.code, replaced.code, '', 'garbage', 'K7F-3QX-ZZZ']) {
      const res = await enter(code)
      answers.push({ status: res.status, location: res.headers.get('location'), cookie: voiceCookieOf(res) })
      expect(res.headers.getSetCookie().length, String(code)).toBe(0)
    }
    for (const a of answers) expect(a).toEqual({ status: 303, location: `/servers/${server.id}/voice?code=failed`, cookie: null })
  })

  test('a cross-origin post is refused (403) and uses no code; a GET does nothing', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' },
      { Origin: 'https://evil.example' }, { Origin: 'null' }, {}, // neither header: not a browser form
      { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://localhost' },
    ]) {
      const res = await enter(made.code, { headers: headers as Record<string, string> })
      expect(res.status, JSON.stringify(headers)).toBe(403)
      expect(res.headers.getSetCookie()).toEqual([])
    }
    const get1 = await get('/auth/voice-code')
    expect([404, 405]).toContain(get1.status)
    expect(get1.headers.getSetCookie()).toEqual([])
    const withQuery = await get(`/auth/voice-code?code=${made.code}&to=/servers/${server.id}/voice`)
    expect(withQuery.headers.getSetCookie()).toEqual([])
    // the code is still good after all that
    expect(vs.readVoiceCookie(voiceCookieOf(await enter(made.code)))).toBe(USER)
  })

  test('a form from this site is accepted by its Origin where the browser sends no Sec-Fetch-Site', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    const res = await enter(made.code, { headers: { Origin: 'http://localhost', 'X-Forwarded-Host': 'localhost' } })
    expect(voiceCookieOf(res)).not.toBeNull()
  })

  test('where it goes: a right code always to the issuing server\'s voice page, whatever `to` says; a failure only back to a voice page of this site, else /voice', async () => {
    for (const to of ['https://evil.example/servers/x/voice', '//evil.example', '/servers/x/stats', '/servers/x/voice/token', '/servers/x/voice?next=1', '/\\evil', '/servers/../voice', '', '/servers//voice', `/servers/${server.id}/voice`]) {
      const made = await (await bridge({ steam_id: fresh() })).json()
      const res = await enter(made.code, { to })
      expect(res.status, to).toBe(303)
      expect(res.headers.get('location'), to).toBe(`/servers/${server.id}/voice`)
      expect(voiceCookieOf(res), to).not.toBeNull()
      const failed = await enter('222-222', { to })
      expect(failed.headers.get('location'), to).toBe(to === `/servers/${server.id}/voice` ? `${to}?code=failed` : '/voice?code=failed')
    }
  })

  test('a code from server A typed on the page of server B lands on A\'s page, with the cookie', async () => {
    const other = Store.addServer('Other Voice') as any
    const made = await (await bridge({ steam_id: USER })).json()
    const res = await enter(made.code, { to: `/servers/${other.id}/voice` })
    expect(res.headers.get('location')).toBe(`/servers/${server.id}/voice`)
    expect(voiceCookieOf(res)).not.toBeNull()
  })

  test('a player who may not sign in gets no cookie, and the code is used up', async () => {
    delete process.env.OPEN_SIGNIN // a non-admin cannot, then
    const made = await (await bridge({ steam_id: USER })).json()
    const res = await enter(made.code)
    expect(voiceCookieOf(res)).toBeNull()
    expect(res.headers.get('location')).toBe(`/servers/${server.id}/voice?code=failed`)
    process.env.OPEN_SIGNIN = '1'
    expect(voiceCookieOf(await enter(made.code))).toBeNull()
    // blocked, with sign-in open
    process.env.BLOCKED_STEAM_IDS = OTHER
    const blocked = await (await bridge({ steam_id: OTHER })).json()
    const r2 = await enter(blocked.code)
    expect(voiceCookieOf(r2)).toBeNull()
    expect(r2.headers.get('location')).toBe(`/servers/${server.id}/voice?code=failed`)
  })

  test('an admin\'s account can pair without open sign-in, and the cookie is a plain user\'s', async () => {
    delete process.env.OPEN_SIGNIN
    const value = await pair(ADMIN)
    expect(vs.readVoiceCookie(value)).toBe(ADMIN)
    expect(await vs.getVoiceSession({ req: { raw: { headers: new Headers({ Cookie: `${session.VOICE_COOKIE}=${value}` }) }, header: () => `${session.VOICE_COOKIE}=${value}` } })).toEqual({ steamId: ADMIN, admin: false })
  })

  test('each address may try ten times a minute; the eleventh is 429 with a Retry-After, another address is not held up', async () => {
    process.env.TRUST_PROXY = '1'
    const as = (ip: string) => ({ ...SAME, 'X-Forwarded-For': ip })
    for (let i = 0; i < 10; i++) expect((await enter('222-222', { headers: as('203.0.113.7') })).status).toBe(303)
    const over = await enter('222-222', { headers: as('203.0.113.7') })
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(over.headers.get('cache-control')).toBe('no-store')
    const made = await (await bridge({ steam_id: USER })).json()
    expect(voiceCookieOf(await enter(made.code, { headers: as('203.0.113.7') }))).toBeNull() // even the right code waits
    expect(voiceCookieOf(await enter(made.code, { headers: as('203.0.113.8') }))).not.toBeNull()
  })

  test('after 60 failed entries in a minute, from anywhere, entry waits (the right code too) until the minute is over', async () => {
    process.env.TRUST_PROXY = '1'
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect((await enter('222-222', { headers: { ...SAME, 'X-Forwarded-For': `198.51.100.${i + 1}` } })).status).toBe(303)
    }
    const made = await (await bridge({ steam_id: USER })).json()
    const waiting = await enter(made.code, { headers: { ...SAME, 'X-Forwarded-For': '192.0.2.1' } })
    expect(waiting.status).toBe(429)
    expect(Number(waiting.headers.get('retry-after'))).toBe(60)
    expect(voiceCookieOf(waiting)).toBeNull()
    now += 30_000
    expect(Number((await enter(made.code, { headers: { ...SAME, 'X-Forwarded-For': '192.0.2.1' } })).headers.get('retry-after'))).toBe(30)
    now += 30_000
    expect(voiceCookieOf(await enter(made.code, { headers: { ...SAME, 'X-Forwarded-For': '192.0.2.1' } }))).not.toBeNull()
  })

  test('failures are counted for the whole server also when there is no address to go by', async () => {
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) await enter('222-222')
    expect((await enter('222-222')).status).toBe(429)
  })

  test('the forget route clears the cookie and goes to the voice page; a cross-site post does not', async () => {
    const form = (headers: Record<string, string>) => app.fetch(new Request('http://localhost/auth/voice-logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: `to=/servers/${server.id}/voice` }))
    const ok = await form(SAME)
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe(`/servers/${server.id}/voice`)
    const cleared = ok.headers.getSetCookie().find((c: string) => c.startsWith(session.VOICE_COOKIE + '='))!
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
    expect((await form({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await form({})).status).toBe(403)
    expect((await get('/auth/voice-logout')).headers.getSetCookie()).toEqual([])
  })

  test('the usual logout clears the voice cookie too', async () => {
    const res = await post('/auth/logout')
    const cleared = res.headers.getSetCookie().find((c: string) => c.startsWith(session.VOICE_COOKIE + '='))
    expect(cleared).toBeTruthy()
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })
})

describe('where the voice cookie is read: the voice page and its two data routes', () => {
  test('with only the cookie, the page, the token and the people all work, as the player', async () => {
    const value = await pair()
    const page = await get(`/servers/${server.id}/voice`, withVoice(value))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('data-join')
    expect(html).not.toContain('action="/auth/voice-code"')
    const token = await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers: withVoice(value) }))
    expect(token.status).toBe(200)
    const claims = JSON.parse(Buffer.from((await token.json()).token.split('.')[1], 'base64url').toString())
    expect(claims.sub).toBe(USER)
    expect((await get(`/servers/${server.id}/voice/people`, withVoice(value))).status).toBe(200)
  })

  test('forged, expired, changed cookies, and the game\'s key or a session cookie in its place, give nothing on the data routes', async () => {
    const good = await pair()
    const [id, exp, sig] = good.split('.') as [string, string, string]
    const gameKey = (await import('../src/services/gameKey')).makeGameKey(USER)
    const signedSession = (await serializeSigned('steam_id', USER, SECRET)).split(';')[0]!.split('=').slice(1).join('=')
    const bad = [`${OTHER}.${exp}.${sig}`, `${id}.${Number(exp) + 5}.${sig}`, `${id}.${exp}.${'A'.repeat(43)}`, vs.makeVoiceCookie(USER, Date.now() - 31 * 24 * 3600 * 1000), gameKey, signedSession, 'x', '']
    for (const value of bad) {
      const token = await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers: withVoice(value) }))
      expect(token.status, String(value)).toBe(401)
      expect((await get(`/servers/${server.id}/voice/people`, withVoice(value))).status, String(value)).toBe(401)
      const page = await (await get(`/servers/${server.id}/voice`, withVoice(value))).text()
      expect(page, String(value)).toContain('action="/auth/voice-code"')
      expect(page, String(value)).not.toContain('data-join')
    }
    // and the good one still works
    expect((await get(`/servers/${server.id}/voice/people`, withVoice(good))).status).toBe(200)
  })

  test('a game key or a signed session cookie value sent as the voice cookie is refused on the page too, and a voice value in the other cookies opens nothing', async () => {
    const value = await pair()
    for (const name of [session.SESSION_COOKIE, session.GAME_COOKIE]) {
      const headers = { Cookie: `${name}=${value}` }
      expect((await get(`/servers/${server.id}/voice/people`, headers)).status, String(name)).toBe(401)
      expect((await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers }))).status, String(name)).toBe(401)
    }
  })

  test('blocking the player, or turning open sign-in off for a non-admin, ends the cookie at the next request', async () => {
    const value = await pair()
    const ok = async () => (await get(`/servers/${server.id}/voice/people`, withVoice(value))).status
    expect(await ok()).toBe(200)
    process.env.BLOCKED_STEAM_IDS = USER
    expect(await ok()).toBe(401)
    expect(await (await get(`/servers/${server.id}/voice`, withVoice(value))).text()).toContain('action="/auth/voice-code"')
    delete process.env.BLOCKED_STEAM_IDS
    expect(await ok()).toBe(200)
    delete process.env.OPEN_SIGNIN
    expect(await ok()).toBe(401)
    expect((await app.fetch(new Request(`http://localhost/servers/${server.id}/voice/token`, { method: 'POST', headers: withVoice(value) }))).status).toBe(401)
  })

  test('an admin\'s voice cookie is no admin: the page has no admin marks and the token route still answers as for a user', async () => {
    const value = await pair(ADMIN)
    const html = await (await get(`/servers/${server.id}/voice`, withVoice(value))).text()
    expect(html).toContain('data-join')
    expect(html).not.toContain('data-admin-mark')
    expect(html).not.toContain('Manage')
    expect(html).toContain('data-user') // shown as a plain user
    expect((await get('/api/servers', withVoice(value))).status).toBe(401)
    expect((await get('/servers', withVoice(value))).status).not.toBe(200)
  })
})

describe('where it is NOT read: every other route answers as for an anonymous visitor', () => {
  const sample: Record<string, string> = { ':serverId': 'x', ':id': 'x', ':map': 'ttt_a', ':roundId': 'round-0001', ':playerId': '76561198000000007', ':roleName': 'traitor', ':role': 'traitor' }

  test('a list of the routes that matter', async () => {
    const id = server.id
    Store.setMaps(id, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
      maps: [{ name: 'ttt_a', size: 1, fingerprint: 'ab'.repeat(32), matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
    const value = await pair()
    const named = [
      ['GET', `/servers/${id}/rounds/round-0001/track.json`], ['GET', `/servers/${id}/rounds/round-0001/replay`], ['GET', `/servers/${id}/maps/ttt_a`],
      ['GET', `/servers/${id}/maps/ttt_a/mesh.glb`], ['GET', `/servers/${id}/playermodel.glb`], ['GET', `/servers/${id}`], ['GET', '/servers'], ['GET', '/api/servers'],
      ['POST', '/api/servers'], ['GET', `/servers/${id}/views`], ['GET', `/servers/${id}/settings`], ['GET', `/servers/${id}/bridge`], ['POST', `/servers/${id}/rounds/delete-bots`],
    ] as const
    for (const [method, path] of named) {
      const init = { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      const anon = await app.fetch(new Request(`http://localhost${path}`, init))
      const cookie = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...init.headers, ...withVoice(value) } }))
      expect(cookie.status, `${method} ${path}`).toBe(anon.status)
      expect(cookie.headers.get('location'), `${method} ${path}`).toBe(anon.headers.get('location'))
      expect(cookie.status, `${method} ${path}`).not.toBe(200)
    }
  })

  test('the public pages show the visitor as nobody (no account marks): the cookie is not a sign-in there', async () => {
    const id = server.id
    for (const path of ['/', `/servers/${id}/stats`, `/servers/${id}/maps`, `/servers/${id}/roles`]) {
      const anon = await (await get(path)).text()
      const html = await (await get(path, withVoice(await pair())))
      const text = await html.text()
      expect(text, path).not.toContain('data-user')
      expect(text, path).not.toContain('Logout')
      expect(text, path).toContain('Sign in with Steam')
      expect(text.length, path).toBe(anon.length)
    }
  })

  test('the sweep: every route that is not public or one of the three voice routes answers the cookie as it answers nobody', async () => {
    const value = await pair()
    const voiceRoutes = new Set(['GET /servers/:serverId/voice', 'POST /servers/:serverId/voice/token', 'GET /servers/:serverId/voice/people'])
    const seen = new Map<string, { method: string, path: string }>()
    for (const r of app.routes) if (r.method !== 'ALL') seen.set(`${r.method} ${r.path}`, { method: r.method, path: r.path })
    let checked = 0
    for (const [key, r] of seen) {
      const tier = tiers.TIERS[key]
      if (voiceRoutes.has(key) || !['user', 'admin'].includes(tier)) continue
      const url = r.path.replace(/:[A-Za-z]+/g, (m: string) => sample[m] ?? 'x')
      const init = { method: r.method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: r.method === 'GET' ? undefined : '' }
      const anon = await app.fetch(new Request(`http://localhost${url}`, init))
      const cookie = await app.fetch(new Request(`http://localhost${url}`, { ...init, headers: { ...init.headers, ...withVoice(value) } }))
      expect(cookie.status, `${key} with the voice cookie`).toBe(anon.status)
      expect(cookie.headers.get('location'), key).toBe(anon.headers.get('location'))
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  test('the tiers file: exactly the three voice routes are named as taking the voice cookie in its comment, and the new routes are declared', () => {
    expect(tiers.TIERS['POST /api/v1/voice-codes']).toBe('bridge')
    expect(tiers.TIERS['POST /auth/voice-code']).toBe('login')
    expect(tiers.TIERS['POST /auth/voice-logout']).toBe('login')
    expect(tiers.TIERS['GET /voice']).toBe('public')
    expect(tiers.TIERS['GET /servers/:serverId/voice']).toBe('user')
    expect(tiers.TIERS['POST /servers/:serverId/voice/token']).toBe('user')
    expect(tiers.TIERS['GET /servers/:serverId/voice/people']).toBe('user')
  })
})

describe('the short address /voice', () => {
  const second = () => Store.addServer('Second Voice Server') as { id: string, token: string }
  const bridgeFor = (srv: { token: string }, id: string) => bridge({ steam_id: id }, srv.token)
  /** What the form of /voice posts: the code and no `to`. */
  const vpost = (code: string, headers: Record<string, string> = SAME) => enter(code, { headers, omitTo: true })

  test('the bridge stores the issuing server with the code', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    expect(voiceCodes.redeem(made.code)).toEqual({ steamId: USER, serverId: server.id })
  })

  test('the page shows the code form and no Steam link, a muted hint, no server; never cached', async () => {
    const res = await get('/voice')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('action="/auth/voice-code"')
    expect(html).toMatch(/name="code"/)
    expect(html).not.toContain('name="to"')
    // no sign-in that would have to know the server (the site header's own generic link, which returns home, is not the page's)
    expect(html).not.toContain('/auth/steam?next=')
    expect(html).not.toContain('Sign in with Steam instead')
    expect(html.slice(html.indexOf('<h1'))).not.toContain('/auth/steam')
    expect(html).toContain('No code? Say <b>!voice</b> in the game.')
    expect(html).not.toContain('class="sections"') // no server, so no section buttons
    expect(html).not.toContain('<script')
    expect(html).not.toContain(VOICE_CODE_FAILED)
    expect(html).not.toContain(server.id)
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'")
  })

  test('after a failure the same page says the fixed message in the reserved line, and nothing else changes; the query is not printed', async () => {
    const plain = await (await get('/voice')).text()
    const failed = await (await get('/voice?code=failed')).text()
    const line = (html: string) => /<p class="note vmsg"[^>]*>(.*?)<\/p>/.exec(html)
    expect(line(plain)?.[1]).toBe('')
    expect(line(failed)?.[1]).toBe(VOICE_CODE_FAILED)
    expect(failed.replace(VOICE_CODE_FAILED, '')).toBe(plain)
    expect(await (await get('/voice?code=%3Cb%3Ex')).text()).toBe(plain)
  })

  test('a visitor with a session sees the form too; in the game\'s window and without a media server it redirects home', async () => {
    const withSession = await (await get('/voice', { Cookie: await adminCookie() })).text()
    expect(withSession).toContain('action="/auth/voice-code"')
    expect((await get('/voice?embed=1')).status).toBe(302)
    configureVoice(null)
    const res = await get('/voice')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  test('the right code (no `to`) sets the cookie and goes to the voice page of the server that issued it', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    const res = await vpost(made.code)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/servers/${server.id}/voice`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(vs.readVoiceCookie(voiceCookieOf(res))).toBe(USER)
  })

  test('with two servers, a code issued by A lands on A\'s page and one issued by B on B\'s', async () => {
    const b = second()
    const fromA = await (await bridgeFor(server, fresh())).json()
    const fromB = await (await bridgeFor(b, fresh())).json()
    expect((await vpost(fromB.code)).headers.get('location')).toBe(`/servers/${b.id}/voice`)
    expect((await vpost(fromA.code)).headers.get('location')).toBe(`/servers/${server.id}/voice`)
  })

  test('a wrong, used and expired code give one answer: back to /voice?code=failed, no cookie', async () => {
    const used = await (await bridge({ steam_id: USER })).json()
    await vpost(used.code)
    const expired = await (await bridge({ steam_id: OTHER })).json()
    now += CODE_TTL_MS
    for (const code of ['222-222', used.code, expired.code, '', 'garbage']) {
      const res = await vpost(code)
      expect({ status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie().length }, code).toEqual({ status: 303, location: '/voice?code=failed', cookies: 0 })
    }
  })

  test('a cross-origin post is refused and uses no code', async () => {
    const made = await (await bridge({ steam_id: USER })).json()
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, {}]) {
      const res = await vpost(made.code, headers as Record<string, string>)
      expect(res.status, JSON.stringify(headers)).toBe(403)
    }
    expect(vs.readVoiceCookie(voiceCookieOf(await vpost(made.code)))).toBe(USER)
  })

  test('the same limiters apply: ten tries an address a minute, and sixty failures in all', async () => {
    process.env.TRUST_PROXY = '1'
    const from = (ip: string) => ({ ...SAME, 'X-Forwarded-For': ip })
    for (let i = 0; i < 10; i++) expect((await vpost('222-222', from('203.0.113.5'))).status).toBe(303)
    const over = await vpost('222-222', from('203.0.113.5'))
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await vpost('222-222', from('203.0.113.6'))).status).toBe(303)
    authMod.voiceCodeLimiter.reset()
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) voiceCodes.noteFailure()
    const made = await (await bridge({ steam_id: USER })).json()
    expect((await vpost(made.code, from('203.0.113.7'))).status).toBe(429)
  })

  test('a code of a server that has been deleted still pairs the browser; the page it goes to answers as it always does', async () => {
    const gone = second()
    const made = await (await bridgeFor(gone, USER)).json()
    Store.deleteServer(gone.id)
    const res = await vpost(made.code)
    expect(res.headers.get('location')).toBe(`/servers/${gone.id}/voice`)
    const page = await get(`/servers/${gone.id}/voice`, withVoice(voiceCookieOf(res)!))
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/')
  })

  test('the page names no server and does not change with the servers there are', async () => {
    const before = await (await get('/voice')).text()
    second()
    expect(await (await get('/voice')).text()).toBe(before)
  })
})

describe('the pages', () => {
  test('without a session the voice page shows the code form and the Steam link, not a redirect to Steam; never cached', async () => {
    const res = await get(`/servers/${server.id}/voice`)
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('action="/auth/voice-code"')
    expect(html).toContain('method="post"')
    expect(html).toMatch(/name="code"/)
    expect(html).toContain(`name="to" value="/servers/${server.id}/voice"`)
    expect(html).toContain('Sign in with Steam instead')
    expect(html).toContain(`href="/auth/steam?next=${encodeURIComponent(`/servers/${server.id}/voice`)}"`)
    expect(html).toContain('!voice')
    expect(html).not.toContain('data-join')
    expect(html).not.toContain('<script')
    expect(html).not.toContain(VOICE_CODE_FAILED)
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'")
  })

  test('the entry page has the head of every section page (PageHead): the way back, the buttons, then the title', async () => {
    const html = await (await get(`/servers/${server.id}/voice`)).text()
    const crumbs = html.indexOf('class="crumbs"'), nav = html.indexOf('class="sections"'), h1 = html.indexOf('<h1')
    expect(crumbs).toBeGreaterThan(-1)
    expect(nav).toBeGreaterThan(crumbs)
    expect(h1).toBeGreaterThan(nav)
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>[^<]*Voice/)
  })

  test('after a code that did not work, the same page says so, in the line that is there when it is empty', async () => {
    const plain = await (await get(`/servers/${server.id}/voice`)).text()
    const failed = await (await get(`/servers/${server.id}/voice?code=failed`)).text()
    expect(failed).toContain(VOICE_CODE_FAILED)
    const line = (html: string) => /<p class="note vmsg"[^>]*>(.*?)<\/p>/.exec(html)
    expect(line(plain)?.[1]).toBe('')
    expect(line(failed)?.[1]).toBe(VOICE_CODE_FAILED)
    // nothing else changes: without the message the two pages are the same
    expect(failed.replace(VOICE_CODE_FAILED, '')).toBe(plain)
    // what the query says is not printed: only the fixed message
    const odd = await (await get(`/servers/${server.id}/voice?code=%3Cb%3Ex`)).text()
    expect(odd).toBe(plain)
  })

  test('the form is one field and a button; in the game\'s window nobody is shown it (the old answer stays)', async () => {
    const html = await (await get(`/servers/${server.id}/voice`)).text()
    expect((html.match(/<form /g) ?? []).length).toBe(1)
    expect((html.match(/<input /g) ?? []).length).toBe(2) // the hidden path and the code
    expect((await get(`/servers/${server.id}/voice?embed=1`)).status).toBe(302)
  })

  test('with no media server on this dashboard there is no code form: the old answer (to the sign-in) stays', async () => {
    configureVoice(null)
    expect((await get(`/servers/${server.id}/voice`)).status).toBe(302)
  })

  test('the forget button is on the page only for a visitor who has nothing but the voice cookie', async () => {
    const value = await pair()
    const viaCookie = await (await get(`/servers/${server.id}/voice`, withVoice(value))).text()
    expect(viaCookie).toContain('Forget this browser')
    expect(viaCookie).toContain('action="/auth/voice-logout"')
    expect(viaCookie).toContain(`name="to" value="/servers/${server.id}/voice"`)
    const real = await (await get(`/servers/${server.id}/voice`, { Cookie: await adminCookie() })).text()
    expect(real).not.toContain('Forget this browser')
    // with both, the real session is the one: no button
    const both = await (await get(`/servers/${server.id}/voice`, { Cookie: `${await adminCookie()}; ${session.VOICE_COOKIE}=${value}` })).text()
    expect(both).not.toContain('Forget this browser')
    expect(await (await get(`/servers/${server.id}/voice`)).text()).not.toContain('Forget this browser')
  })

  test('the voice page of a session is never cached (the answer to a sign-in must not come from the cache)', async () => {
    const res = await get(`/servers/${server.id}/voice`, { Cookie: await adminCookie() })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
