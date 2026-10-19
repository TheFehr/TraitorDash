import { expect, test, describe, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 13: three tiers (anonymous, signed in, admin). Any Steam account may sign in when the
// operator turns OPEN_SIGNIN on; admin is decided live from the allow-list; heavy content needs a
// signed-in user.

let app: any, auth: any, Store: any, db: any, session: any, REALM = ''
const ADMIN = '76561198000000000', USER = '76561198000000042', USER2 = '76561198000000043'
const realFetch = globalThis.fetch

beforeAll(async () => {
  const idx = await import('../src/index')
  app = idx.app
  auth = (await import('../src/routes/auth')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  session = await import('../src/middleware/session')
  const res = await auth.request('/steam')
  REALM = new URL(res.headers.get('location')!).searchParams.get('openid.realm')!
})
beforeEach(() => { delete process.env.OPEN_SIGNIN; delete process.env.BLOCKED_STEAM_IDS; delete process.env.VIEW_LOG_DAYS })
// All test files share one process: leave the switches as they were found.
afterAll(() => { for (const k of ['OPEN_SIGNIN', 'BLOCKED_STEAM_IDS', 'VIEW_LOG_DAYS', 'MAP_GEOMETRY', 'TRUST_PROXY']) delete process.env[k] })
afterEach(() => { globalThis.fetch = realFetch })

const cookieFor = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const req = (path: string, init: RequestInit & { as?: string | null } = {}) =>
  cookieFor(init.as ?? '').then(ck => app.fetch(new Request(`http://localhost${path}`, {
    ...init, headers: { ...(init.as ? { Cookie: ck } : {}), ...(init.headers as any) },
  })))

describe('the session helper', () => {
  const who = async (cookie: string | null) => {
    const c: any = { req: { raw: { headers: new Headers(cookie ? { Cookie: cookie } : {}) }, header: (n: string) => (n.toLowerCase() === 'cookie' ? cookie ?? undefined : undefined) } }
    return session.getSession(c)
  }

  test('no cookie, a forged signature, a tampered ID and a non-SteamID are anonymous', async () => {
    process.env.OPEN_SIGNIN = '1'
    expect(await who(null)).toBeNull()
    expect(await who(`steam_id=${USER}.AAAA`)).toBeNull()
    const good = await cookieFor(USER)
    expect(await who(good)).toEqual({ steamId: USER, admin: false })
    expect(await who(good.replace(USER, '76561198000000044'))).toBeNull()
    expect(await who(await cookieFor('not-a-steam-id'))).toBeNull()
    expect(await who(await cookieFor('1234'))).toBeNull()
  })

  test('with sign-in closed (the default) only admins have a session, so a user cookie is anonymous', async () => {
    expect(await who(await cookieFor(USER))).toBeNull()
    expect(await who(await cookieFor(ADMIN))).toEqual({ steamId: ADMIN, admin: true })
  })

  test('admin is the allow-list, now: nobody is promoted by a cookie', async () => {
    process.env.OPEN_SIGNIN = '1'
    expect((await who(await cookieFor(USER)))!.admin).toBe(false)
    expect((await who(await cookieFor(ADMIN)))!.admin).toBe(true)
  })

  test('the blocked list removes a user but never an admin', async () => {
    process.env.OPEN_SIGNIN = '1'
    process.env.BLOCKED_STEAM_IDS = ` ${USER} , ${ADMIN}`
    expect(await who(await cookieFor(USER))).toBeNull()
    expect(await who(await cookieFor(USER2))).toEqual({ steamId: USER2, admin: false })
    expect(await who(await cookieFor(ADMIN))).toEqual({ steamId: ADMIN, admin: true })
  })

  test('turning the switch off ends non-admin sessions at the next request', async () => {
    process.env.OPEN_SIGNIN = '1'
    const ck = await cookieFor(USER)
    expect(await who(ck)).not.toBeNull()
    delete process.env.OPEN_SIGNIN
    expect(await who(ck)).toBeNull()
  })

  test('getAdminId keeps its meaning: the ID of an admin, else null', async () => {
    process.env.OPEN_SIGNIN = '1'
    const c = (ck: string) => ({ req: { raw: { headers: new Headers({ Cookie: ck }) }, header: () => ck } }) as any
    expect(await session.getAdminId(c(await cookieFor(ADMIN)))).toBe(ADMIN)
    expect(await session.getAdminId(c(await cookieFor(USER)))).toBeNull()
  })
})

describe('the callback', () => {
  const steam = (verdict: string) => { globalThis.fetch = (async () => new Response(verdict)) as any }
  const login = async (id: string, next?: string) => {
    const started = await auth.request(next === undefined ? '/steam' : `/steam?next=${encodeURIComponent(next)}`)
    const cookies = started.headers.getSetCookie().map((c: string) => c.split(';')[0]).join('; ')
    const state = /td_login=([0-9a-f]+)/.exec(cookies)![1]!
    const q = new URLSearchParams({
      td_state: state, 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.return_to': `${REALM}/auth/steam/callback?td_state=${state}`,
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${id}`, 'openid.identity': `https://steamcommunity.com/openid/id/${id}`,
    })
    return auth.request(`/steam/callback?${q}`, { headers: { Cookie: cookies } })
  }
  const sessionSet = (res: Response) => res.headers.getSetCookie().some(c => /(^|\s)(__Host-)?steam_id=[^;]+/.test(c) && !/Max-Age=0/i.test(c))

  test('with sign-in open, any Steam account gets a session; an admin still does', async () => {
    process.env.OPEN_SIGNIN = '1'
    steam('is_valid:true')
    const u = await login(USER)
    expect(u.status).toBe(302)
    expect(sessionSet(u)).toBe(true)
    expect(sessionSet(await login(ADMIN))).toBe(true)
  })

  test('with it off (the default) a non-admin gets 403 and no cookie, as before', async () => {
    steam('is_valid:true')
    const r = await login(USER)
    expect(r.status).toBe(403)
    expect(sessionSet(r)).toBe(false)
    expect(sessionSet(await login(ADMIN))).toBe(true)
  })

  test('a blocked account gets neither a session nor a way round; an admin cannot be blocked', async () => {
    process.env.OPEN_SIGNIN = '1'
    process.env.BLOCKED_STEAM_IDS = `${USER},${ADMIN}`
    steam('is_valid:true')
    const r = await login(USER)
    expect(r.status).toBe(403)
    expect(sessionSet(r)).toBe(false)
    expect(sessionSet(await login(ADMIN))).toBe(true)
  })

  test('a bad Steam answer, a wrong state and a replayed login still fail for everyone', async () => {
    process.env.OPEN_SIGNIN = '1'
    steam('is_valid:false')
    expect((await login(USER)).status).toBe(401)
    steam('is_valid:true')
    const started = await auth.request('/steam')
    const state = /td_login=([0-9a-f]+)/.exec(started.headers.get('set-cookie')!)![1]!
    const q = new URLSearchParams({ td_state: 'bad', 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.return_to': `${REALM}/auth/steam/callback?td_state=bad`, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${USER}`, 'openid.identity': `https://steamcommunity.com/openid/id/${USER}` })
    const wrong = await auth.request(`/steam/callback?${q}`, { headers: { Cookie: `td_login=${state}` } })
    expect(wrong.status).toBe(400)
    expect(sessionSet(wrong)).toBe(false)
    const noCookie = await auth.request(`/steam/callback?${q}`)
    expect(noCookie.status).toBe(400)
  })

  test('the visitor comes back to the page they asked for, and the next cookie is cleared', async () => {
    process.env.OPEN_SIGNIN = '1'
    steam('is_valid:true')
    const r = await login(USER, '/servers/abc/maps/ttt_x')
    expect(r.headers.get('location')).toBe('/servers/abc/maps/ttt_x')
    expect(r.headers.getSetCookie().join('\n')).toMatch(/td_next=;|td_next=\s*;|td_next=[^;]*Max-Age=0/i)
    expect((await login(USER)).headers.get('location')).toBe('/')
  })
})

describe('next (the one redirect target that comes from the request)', () => {
  const set = (res: Response) => res.headers.getSetCookie().find(c => c.startsWith('td_next=') && !/Max-Age=0/i.test(c))
  const refused = [
    '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', 'evil.example', '',
    '/' + 'a'.repeat(200), '/a\nb', '/a\rb', '/a\tb', '/a\u0000b', '/\u007f',
    '/%2F/evil.example', '/%2f%2fevil.example', '/%5Cevil.example', '/%5cevil.example', '/%0d%0aLocation:%20x', '/%250d',
    '/a//b', '/%E0%A4%A', '/javascript:alert(1)', '///evil.example', '/%252F%252Fevil.example',
  ]
  test('accepts a same-site relative path', async () => {
    for (const ok of ['/', '/servers/x/maps/y', '/servers/x/rounds/r-1/replay', '/servers/x/stats?sort=wins', '/servers/x/maps/ttt_a%20b']) {
      const res = await auth.request(`/steam?next=${encodeURIComponent(ok)}`)
      expect(decodeURIComponent(set(res)!.split(';')[0]!.slice('td_next='.length))).toBe(ok)
    }
  })
  test('refuses every open-redirect trick, and the visitor lands on /', async () => {
    for (const bad of refused) {
      const res = await auth.request(`/steam?next=${encodeURIComponent(bad)}`)
      expect(set(res), JSON.stringify(bad)).toBeUndefined()
    }
  })
  test('a td_next cookie planted in the browser is checked again at the callback', async () => {
    process.env.OPEN_SIGNIN = '1'
    globalThis.fetch = (async () => new Response('is_valid:true')) as any
    for (const bad of ['//evil.example', 'https://evil.example', '/%2F/evil']) {
      const started = await auth.request('/steam')
      const state = /td_login=([0-9a-f]+)/.exec(started.headers.get('set-cookie')!)![1]!
      const q = new URLSearchParams({ td_state: state, 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
        'openid.return_to': `${REALM}/auth/steam/callback?td_state=${state}`, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${USER}`, 'openid.identity': `https://steamcommunity.com/openid/id/${USER}` })
      const res = await auth.request(`/steam/callback?${q}`, { headers: { Cookie: `td_login=${state}; td_next=${encodeURIComponent(bad)}` } })
      expect(res.headers.get('location')).toBe('/')
    }
  })
  test('safeNext on its own', () => {
    expect(session.safeNext('/a/b?c=d')).toBe('/a/b?c=d')
    expect(session.safeNext(undefined)).toBeNull()
    expect(session.safeNext(42)).toBeNull()
    expect(session.signinUrl('/servers/x/maps/y')).toBe('/auth/steam?next=%2Fservers%2Fx%2Fmaps%2Fy')
    expect(session.signinUrl('//evil')).toBe('/auth/steam')
  })
})

describe('the sweep: every route is declared, and behaves as declared', () => {
  const { TIERS } = require('../src/routes/tiers') as typeof import('../src/routes/tiers')
  const sample: Record<string, string> = {
    ':serverId': 'srv-1', ':id': 'srv-1', ':map': 'ttt_a', ':roundId': 'round-0001', ':playerId': '76561198000000007',
    ':roleName': 'traitor', ':role': 'traitor',
  }
  const url = (path: string) => path.replace(/:[A-Za-z]+/g, m => sample[m] ?? 'x')
  const routes = () => {
    const seen = new Map<string, { method: string, path: string }>()
    for (const r of app.routes) if (r.method !== 'ALL') seen.set(`${r.method} ${r.path}`, { method: r.method, path: r.path })
    return [...seen.entries()]
  }

  test('a route without a declared tier fails (so does a declaration for a route that is gone)', () => {
    const real = routes().map(([k]) => k).filter(k => !k.includes('/public/'))
    expect(real.filter(k => !(k in TIERS))).toEqual([])
    expect(Object.keys(TIERS).filter(k => !real.includes(k))).toEqual([])
  })

  test('with sign-in open, a plain signed-in user is refused by every route that is not public or user-level', async () => {
    process.env.OPEN_SIGNIN = '1'
    Store.addServer('Sweep')
    for (const [key, r] of routes()) {
      const tier = TIERS[key]
      if (tier !== 'admin') continue
      const res = await req(url(r.path), { method: r.method, as: USER, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: r.method === 'GET' ? undefined : '' })
      const refused = [401, 403].includes(res.status) || (res.status === 302 && !String(res.headers.get('location')).startsWith('/auth/steam'))
      expect(refused, `${key} gave ${res.status} to a signed-in user`).toBe(true)
      expect(res.status === 200, `${key} answered a signed-in user with 200`).toBe(false)
    }
  })

  test('an anonymous visitor is refused by every admin and user route, and not by the public ones', async () => {
    process.env.OPEN_SIGNIN = '1'
    for (const [key, r] of routes()) {
      const tier = TIERS[key]
      const res = await req(url(r.path), { method: r.method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: r.method === 'GET' ? undefined : '' })
      if (tier === 'admin') expect([401, 403, 302], `${key} gave ${res.status} to an anonymous visitor`).toContain(res.status)
      if (tier === 'user') {
        const ok = res.status === 401 || (res.status === 302 && String(res.headers.get('location')).startsWith('/auth/steam')) || res.status === 302
        expect(ok, `${key} gave ${res.status} to an anonymous visitor`).toBe(true)
      }
      if (tier === 'public') expect([401, 403], `${key} refused an anonymous visitor`).not.toContain(res.status)
      if (tier === 'bridge') expect(res.status, `${key} took no token`).toBe(401)
    }
  })

  test('a session cookie is not a bridge credential', async () => {
    process.env.OPEN_SIGNIN = '1'
    for (const [key, r] of routes()) {
      if (TIERS[key] !== 'bridge') continue
      for (const as of [USER, ADMIN]) {
        const res = await req(url(r.path), { method: r.method, as, headers: { 'Content-Type': 'application/json' }, body: '{}' })
        expect(res.status, `${key} took a session cookie from ${as}`).toBe(401)
      }
    }
  })

  test('an admin gets through the admin routes (nothing answers an admin with 401 or 403)', async () => {
    for (const [key, r] of routes()) {
      if (TIERS[key] !== 'admin') continue
      const res = await req(url(r.path), { method: r.method, as: ADMIN, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: r.method === 'GET' ? undefined : '' })
      expect([401, 403], `${key} refused an admin`).not.toContain(res.status)
    }
  })
})

describe('gated content: the mesh', () => {
  let serverId: string
  const FP = 'ab'.repeat(32)
  const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])

  beforeEach(async () => {
    process.env.OPEN_SIGNIN = '1'
    ;(await import('../src/services/gates')).resetGates()
    db.run('DELETE FROM map_geometry'); db.run('DELETE FROM map_geometry_requests')
    db.run("DELETE FROM audit_log WHERE action IN ('VIEW_MESH', 'VIEW_REPLAY')")
    serverId = (Store.addServer('Gate') as any).id
    Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
      maps: [{ name: 'ttt_a', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
    Store.setGeometryRequested(serverId, 'ttt_a', true, null)
    Store.startGeometry('ttt_a', FP)
    Store.finishGeometry('ttt_a', FP, { mesh: GLB, info: { vertices: 3, triangles: 1, levels: 2 } })
  })
  const mesh = (as: string | null = null, extra: Record<string, string> = {}) => req(`/servers/${serverId}/maps/ttt_a/mesh.glb`, { as, headers: extra })
  const views = (id = USER) => db.query("SELECT details, server_id FROM audit_log WHERE steam_id = ? AND action = 'VIEW_MESH'").all(id) as any[]

  test('an anonymous visitor gets 401 with a body that says sign-in is needed; a user and an admin get the mesh', async () => {
    const anon = await mesh()
    expect(anon.status).toBe(401)
    expect(await anon.json()).toEqual({ error: 'Sign-in required', signin: '/auth/steam' })
    for (const as of [USER, ADMIN]) {
      const r = await mesh(as)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('model/gltf-binary')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(GLB)
    }
  })

  test('with sign-in closed, only admins are signed in, so a user cookie gets 401', async () => {
    delete process.env.OPEN_SIGNIN
    expect((await mesh(USER)).status).toBe(401)
    expect((await mesh(ADMIN)).status).toBe(200)
  })

  test('a blocked account is turned away at once', async () => {
    process.env.BLOCKED_STEAM_IDS = USER
    expect((await mesh(USER)).status).toBe(401)
    expect((await mesh(USER2)).status).toBe(200)
  })

  test('a map without a mesh is a 404, and nothing is logged for it', async () => {
    const r = await req(`/servers/${serverId}/maps/ttt_none/mesh.glb`, { as: USER })
    expect(r.status).toBe(404)
    expect(views()).toHaveLength(0)
  })

  test('is limited per account: 30 a minute, then 429 with Retry-After; another account is not held up', async () => {
    for (let i = 0; i < 30; i++) expect((await mesh(USER)).status).toBe(200)
    const over = await mesh(USER)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await mesh(USER2)).status).toBe(200)
  })

  test('anonymous requests are limited per address only behind TRUST_PROXY=1', async () => {
    for (let i = 0; i < 40; i++) expect((await mesh(null, { 'X-Forwarded-For': '10.0.0.1' })).status).toBe(401) // no proxy trusted: no limit
    process.env.TRUST_PROXY = '1'
    try {
      let last = 0
      for (let i = 0; i < 31; i++) last = (await mesh(null, { 'X-Forwarded-For': '203.0.113.9' })).status
      expect(last).toBe(429)
      expect((await mesh(null, { 'X-Forwarded-For': '203.0.113.10' })).status).toBe(401)
    } finally { delete process.env.TRUST_PROXY }
  })

  describe('the view log', () => {
    test('one VIEW_MESH row with the SteamID64 and the map; the same user again within the hour writes none', async () => {
      await mesh(USER); await mesh(USER); await mesh(USER)
      expect(views()).toEqual([{ details: 'ttt_a', server_id: serverId }])
    })
    test('another user, another map and an hour later each write one', async () => {
      await mesh(USER); await mesh(USER2)
      expect(views(USER2)).toHaveLength(1)
      Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
        maps: [{ name: 'ttt_a', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true },
               { name: 'ttt_b', size: 1, fingerprint: 'cd'.repeat(32), matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
      Store.setGeometryRequested(serverId, 'ttt_b', true, null)
      Store.startGeometry('ttt_b', 'cd'.repeat(32))
      Store.finishGeometry('ttt_b', 'cd'.repeat(32), { mesh: GLB, info: { vertices: 3, triangles: 1, levels: 1 } })
      await req(`/servers/${serverId}/maps/ttt_b/mesh.glb`, { as: USER })
      expect(views().map(v => v.details).sort()).toEqual(['ttt_a', 'ttt_b'])
      db.run("UPDATE audit_log SET timestamp = datetime('now', '-61 minutes') WHERE steam_id = ? AND action = 'VIEW_MESH'", [USER])
      await mesh(USER)
      expect(views().filter(v => v.details === 'ttt_a')).toHaveLength(2)
    })
    test('anonymous requests write none', async () => {
      await mesh()
      expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'VIEW_MESH'").get().n).toBe(0)
    })
    test('rows older than VIEW_LOG_DAYS are removed by the cleanup; other audit rows stay; 0 logs nothing', async () => {
      await mesh(USER)
      Store.audit(serverId, ADMIN, 'MAP_GEOMETRY_REQUESTED', 'ttt_a')
      // Only this server's rows: all test files share one database, and the cleanup counts every view row.
      db.run("DELETE FROM audit_log WHERE action IN ('VIEW_MESH', 'VIEW_REPLAY') AND server_id != ?", [serverId])
      db.run("UPDATE audit_log SET timestamp = datetime('now', '-100 days') WHERE server_id = ?", [serverId])
      expect(Store.cleanupViewLog()).toBe(1)
      expect(views()).toHaveLength(0)
      expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'MAP_GEOMETRY_REQUESTED' AND server_id = ?").get(serverId).n).toBe(1)
      process.env.VIEW_LOG_DAYS = '0'
      await mesh(USER2)
      expect(views(USER2)).toHaveLength(0)
      expect((await mesh(USER2)).status).toBe(200) // still served
    })
    test('a shorter VIEW_LOG_DAYS removes sooner', async () => {
      await mesh(USER)
      db.run("UPDATE audit_log SET timestamp = datetime('now', '-8 days') WHERE action = 'VIEW_MESH'")
      process.env.VIEW_LOG_DAYS = '7'
      expect(Store.cleanupViewLog()).toBe(1)
    })
  })
})

describe('pages and the header', () => {
  let serverId: string
  const FP = 'ef'.repeat(32)
  beforeEach(() => {
    process.env.OPEN_SIGNIN = '1'
    process.env.MAP_GEOMETRY = '1'
    db.run('DELETE FROM map_geometry'); db.run('DELETE FROM map_geometry_requests')
    serverId = (Store.addServer('Pages') as any).id
    Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
      maps: [
        { name: 'ttt_3d', size: 1, fingerprint: FP, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true },
        { name: 'ttt_flat', size: 1, fingerprint: null, matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
    Store.setGeometryRequested(serverId, 'ttt_3d', true, null)
    Store.startGeometry('ttt_3d', FP)
    Store.finishGeometry('ttt_3d', FP, { mesh: new Uint8Array([1]), info: { vertices: 3, triangles: 1, levels: 2 } })
  })
  const html = async (path: string, as: string | null = null) => { const r = await req(path, { as }); return { status: r.status, loc: r.headers.get('location'), text: await r.text() } }

  test('the header: anonymous sees the sign-in button; a user sees the ID, no Servers link and a logout; an admin also the mark and the link', async () => {
    const anon = (await html('/')).text
    expect(anon).toContain('Login with Steam')
    expect(anon).not.toContain('data-user')
    const user = (await html('/', USER)).text
    expect(user).toContain(USER)
    expect(user).toContain('data-user')
    expect(user).not.toContain('Login with Steam')
    expect(user).not.toContain('href="/servers"')
    expect(user).not.toContain('data-admin-mark')
    expect(user).toMatch(/<form method="post" action="\/auth\/logout"/)
    const admin = (await html('/', ADMIN)).text
    expect(admin).toContain('data-admin-mark')
    expect(admin).toContain('href="/servers"')
  })

  test('the header shows a signed-in user on the public pages too', async () => {
    for (const path of [`/servers/${serverId}/stats`, `/servers/${serverId}/maps`]) {
      const t = (await html(path, USER)).text
      expect(t, path).toContain('data-user')
    }
  })

  test('with sign-in closed a user cookie is anonymous on the public pages', async () => {
    delete process.env.OPEN_SIGNIN
    const t = (await html('/', USER)).text
    expect(t).toContain('Login with Steam')
  })

  test('the maps list offers a map with a 3D view: a user the link, an anonymous visitor a sign-in link when sign-in is open, nobody else anything', async () => {
    const user = (await html(`/servers/${serverId}/maps`, USER)).text
    expect(user).toContain(`href="/servers/${serverId}/maps/ttt_3d"`)
    expect(user).toContain('data-3d')
    expect(user).not.toContain('ttt_flat"') // no link for a map without a mesh
    const anon = (await html(`/servers/${serverId}/maps`)).text
    expect(anon).toContain('data-3d-signin')
    expect(anon).toContain(`/auth/steam?next=${encodeURIComponent(`/servers/${serverId}/maps/ttt_3d`)}`)
    expect(anon).toContain('data-3d-note')
    expect(anon).toContain('logged with your SteamID64 for 90 days')
    process.env.VIEW_LOG_DAYS = '0'
    expect((await html(`/servers/${serverId}/maps`)).text).not.toContain('logged with your SteamID64')
    delete process.env.VIEW_LOG_DAYS
    delete process.env.OPEN_SIGNIN
    const closed = (await html(`/servers/${serverId}/maps`)).text
    expect(closed).not.toContain('data-3d')
  })

  test('the map page: anonymous is sent to sign-in and brought back (or to the list when sign-in is closed); a user sees the 3D view and nothing of the admin parts', async () => {
    const anon = await html(`/servers/${serverId}/maps/ttt_3d`)
    expect(anon.status).toBe(302)
    expect(anon.loc).toBe(`/auth/steam?next=${encodeURIComponent(`/servers/${serverId}/maps/ttt_3d`)}`)
    delete process.env.OPEN_SIGNIN
    expect((await html(`/servers/${serverId}/maps/ttt_3d`)).loc).toBe(`/servers/${serverId}/maps`)
    process.env.OPEN_SIGNIN = '1'

    const user = await html(`/servers/${serverId}/maps/ttt_3d`, USER)
    expect(user.status).toBe(200)
    expect(user.text).toContain('data-mapview')
    expect(user.text).not.toContain('Exact geometry')
    expect(user.text).not.toContain('Floor plan')
    expect(user.text).not.toContain(`href="/servers/${serverId}"`)

    const admin = await html(`/servers/${serverId}/maps/ttt_3d`, ADMIN)
    expect(admin.text).toContain('Floor plan')
    expect(admin.text).toContain('data-mapview')
  })

  test('a map without a 3D view has nothing for a plain user: back to the list', async () => {
    const r = await html(`/servers/${serverId}/maps/ttt_flat`, USER)
    expect(r.status).toBe(302)
    expect(r.loc).toBe(`/servers/${serverId}/maps`)
    expect((await html(`/servers/${serverId}/maps/ttt_flat`, ADMIN)).status).toBe(200) // an admin still sees the map
  })
})
