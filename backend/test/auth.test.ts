import { expect, test, describe, beforeAll, afterEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let auth: any
const ADMIN = '76561198000000000'
const OTHER = '76561198000000099'
const realFetch = globalThis.fetch

// The realm is fixed when the module is first imported, which another test file may have done
// already (all files share one process), so it is read from the app instead of assumed.
let REALM = ''
beforeAll(async () => {
  auth = (await import('../src/routes/auth')).default
  const res = await auth.request('/steam')
  REALM = new URL(res.headers.get('location')!).searchParams.get('openid.realm')!
})
afterEach(() => { globalThis.fetch = realFetch })

const steam = (verdict: string | Error) => {
  globalThis.fetch = (async () => {
    if (verdict instanceof Error) throw verdict
    return new Response(verdict)
  }) as any
}

/** Starts a login the way a browser does and returns the state cookie plus the state value. */
const start = async () => {
  const res = await auth.request('/steam')
  const cookie = res.headers.get('set-cookie')!
  const state = /td_login=([0-9a-f]+)/.exec(cookie)![1]!
  return { res, cookie: `td_login=${state}`, state }
}

const callback = (state: string, over: Record<string, string> = {}, cookie?: string) => {
  const q = new URLSearchParams({
    td_state: state,
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.return_to': `${REALM}/auth/steam/callback?td_state=${state}`,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${ADMIN}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${ADMIN}`,
    ...over,
  })
  return auth.request(`/steam/callback?${q}`, { headers: cookie ? { Cookie: cookie } : {} })
}

describe('Steam login', () => {
  test('starting a login sets a browser-bound state and puts it in return_to', async () => {
    const { res, state } = await start()
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    const target = new URL(res.headers.get('location')!)
    expect(target.searchParams.get('openid.return_to')).toBe(`${REALM}/auth/steam/callback?td_state=${state}`)
  })

  test('an admin with a valid assertion gets a signed session', async () => {
    steam('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n')
    const { cookie, state } = await start()
    const res = await callback(state, {}, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('steam_id=')
  })

  const rejected = async (over: Record<string, string>, useCookie = true, stateOverride?: string) => {
    steam('is_valid:true') // Steam itself would say yes; our own checks must still refuse
    const { cookie, state } = await start()
    const res = await callback(stateOverride ?? state, over, useCookie ? cookie : undefined)
    expect(res.status).toBe(400)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('steam_id=')
  }

  test('an assertion made for another site (return_to) is refused', async () => {
    await rejected({ 'openid.return_to': 'https://evil.example/cb' })
  })
  test('an assertion without the state cookie (another browser) is refused', async () => {
    await rejected({}, false)
  })
  test('an assertion with a different state is refused', async () => {
    await rejected({ td_state: 'deadbeef', 'openid.return_to': `${REALM}/auth/steam/callback?td_state=deadbeef` })
  })
  test('a claimed_id that is not a Steam account URL is refused', async () => {
    await rejected({ 'openid.claimed_id': `https://evil.example/openid/id/${ADMIN}`, 'openid.identity': `https://evil.example/openid/id/${ADMIN}` })
    await rejected({ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/123', 'openid.identity': 'https://steamcommunity.com/openid/id/123' })
  })
  test('identity must equal claimed_id', async () => {
    await rejected({ 'openid.identity': `https://steamcommunity.com/openid/id/${OTHER}` })
  })
  test('a different operator or mode is refused', async () => {
    await rejected({ 'openid.op_endpoint': 'https://evil.example/login' })
    await rejected({ 'openid.mode': 'cancel' })
  })

  test('an invalid assertion (Steam says no) is a 401 with no session', async () => {
    steam('is_valid:false')
    const { cookie, state } = await start()
    const res = await callback(state, {}, cookie)
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('steam_id=')
  })

  test('a valid Steam account that is not an admin is a 403 with no session', async () => {
    steam('is_valid:true')
    const { cookie, state } = await start()
    const res = await callback(state, {
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${OTHER}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${OTHER}`,
    }, cookie)
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('steam_id=')
  })

  test('Steam being unreachable fails closed', async () => {
    steam(new Error('network down'))
    const { cookie, state } = await start()
    const res = await callback(state, {}, cookie)
    expect(res.status).toBe(500)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('steam_id=')
  })

  test('the state is single-use: the cookie is cleared by the callback', async () => {
    steam('is_valid:true')
    const { cookie, state } = await start()
    const res = await callback(state, {}, cookie)
    expect(res.headers.get('set-cookie')).toMatch(/td_login=;|td_login=\s*;|Max-Age=0/i)
  })
})

describe('BASE_URL', () => {
  // REALM is fixed at import time, so each variant is checked in a fresh process.
  const loginUrl = async (baseUrl: string) => {
    const proc = Bun.spawn([process.execPath, '-e', `
      const auth = (await import('./src/routes/auth')).default
      const res = await auth.request('/steam')
      const u = new URL(res.headers.get('location'))
      console.log(JSON.stringify({ realm: u.searchParams.get('openid.realm'), returnTo: u.searchParams.get('openid.return_to') }))
    `], {
      cwd: import.meta.dir + '/..',
      env: { PATH: process.env.PATH, SESSION_SECRET: 'x'.repeat(40), ADMIN_STEAM_IDS: ADMIN, BASE_URL: baseUrl },
      stdout: 'pipe', stderr: 'pipe',
    })
    return JSON.parse(await new Response(proc.stdout).text())
  }

  test('a trailing slash (or several) never produces a double slash in the callback URL', async () => {
    for (const base of ['https://td.example', 'https://td.example/', 'https://td.example///', ' https://td.example/ ']) {
      const { realm, returnTo } = await loginUrl(base)
      expect(realm).toBe('https://td.example')
      expect(returnTo).toStartWith('https://td.example/auth/steam/callback?td_state=')
      expect(returnTo).not.toContain('//auth')
    }
  })
})

describe('session secret', () => {
  const boot = async (env: Record<string, string | undefined>) => {
    const proc = Bun.spawn([process.execPath, '-e', "await import('./src/middleware/session'); console.log('BOOTED')"], {
      cwd: import.meta.dir + '/..',
      env: { PATH: process.env.PATH, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, out, err }
  }

  test('the app refuses to start without SESSION_SECRET (no public fallback)', async () => {
    const r = await boot({ ADMIN_STEAM_IDS: ADMIN })
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('BOOTED')
    expect(r.err).toContain('SESSION_SECRET')
  })

  test('the old public fallback value and short secrets are refused', async () => {
    expect((await boot({ SESSION_SECRET: 'insecure-fallback-secret', ADMIN_STEAM_IDS: ADMIN })).code).not.toBe(0)
    expect((await boot({ SESSION_SECRET: 'short', ADMIN_STEAM_IDS: ADMIN })).code).not.toBe(0)
  })

  test('a long random secret starts fine, and a cookie signed with the old fallback is useless', async () => {
    const ok = await boot({ SESSION_SECRET: 'x'.repeat(40), ADMIN_STEAM_IDS: ADMIN })
    expect(ok.out).toContain('BOOTED')

    const { getAdminId } = await import('../src/middleware/session')
    const forged = (await serializeSigned('steam_id', ADMIN, 'insecure-fallback-secret')).split(';')[0]!
    const c: any = { req: { raw: { headers: new Headers({ Cookie: forged }) }, header: (n: string) => new Headers({ Cookie: forged }).get(n) } }
    expect(await getAdminId(c)).toBeNull()
  })
})
