import { Hono } from 'hono'
import { setSignedCookie, setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { SESSION_SECRET, isAdmin } from '../middleware/session'

const auth = new Hono()

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login'
const REALM = process.env.BASE_URL || 'http://localhost:3000'
const CALLBACK_URL = `${REALM}/auth/steam/callback`
const STEAM_CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/
const LOGIN_COOKIE = 'td_login'

// Each login attempt carries a random value that is also kept in a cookie in the browser that
// started it. The callback only accepts an assertion whose return_to contains that same value,
// so one minted for another site (or another browser) cannot be replayed here.
const returnUrl = (state: string) => `${CALLBACK_URL}?td_state=${state}`

auth.get('/steam', (c) => {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')
  setCookie(c, LOGIN_COOKIE, state, {
    path: '/auth',
    httpOnly: true,
    secure: REALM.startsWith('https://'),
    maxAge: 600,
    sameSite: 'Lax',
  })

  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.return_to': returnUrl(state),
    'openid.realm': REALM,
  })

  return c.redirect(`${STEAM_OPENID_URL}?${params.toString()}`)
})

auth.get('/steam/callback', async (c) => {
  const query = c.req.query()

  // 0. Only an assertion made for THIS login attempt, by Steam, for a Steam account.
  const state = getCookie(c, LOGIN_COOKIE)
  deleteCookie(c, LOGIN_COOKIE, { path: '/auth' })
  const claimedId = query['openid.claimed_id']
  const claimed = claimedId ? STEAM_CLAIMED_ID.exec(claimedId) : null
  if (
    !state ||
    query['td_state'] !== state ||
    query['openid.mode'] !== 'id_res' ||
    query['openid.return_to'] !== returnUrl(state) ||
    query['openid.op_endpoint'] !== STEAM_OPENID_URL ||
    !claimed ||
    query['openid.identity'] !== claimedId
  ) {
    console.warn('[Auth] Rejected a Steam callback that does not belong to a login started here')
    return c.text('Invalid login response', 400)
  }

  // 1. Prepare verification request
  const verificationParams = new URLSearchParams(query)
  verificationParams.set('openid.mode', 'check_authentication')

  // 2. Verify with Steam
  try {
    const response = await fetch(STEAM_OPENID_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'TraitorDash-Auth'
      },
      body: verificationParams.toString(),
    })

    const text = await response.text()
    const isValid = text.includes('is_valid:true')

    if (!isValid) {
      return c.text('Steam authentication failed', 401)
    }

    // 3. The SteamID64 (already shape-checked above)
    const steamId = claimed[1]!

    if (!isAdmin(steamId)) {
      console.warn(`[Auth] Login denied for non-admin SteamID ${steamId}`)
      return c.text('This Steam account is not authorized to administer TraitorDash.', 403)
    }

    // 4. Set Secure Signed Session
    await setSignedCookie(c, 'steam_id', steamId, SESSION_SECRET, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7, // 1 week
      sameSite: 'Lax',
    })

    return c.redirect('/')
  } catch (err) {
    console.error('[Auth] Error:', err)
    return c.text('Internal Auth Error', 500)
  }
})

auth.get('/logout', (c) => {
  deleteCookie(c, 'steam_id')
  return c.redirect('/')
})

export default auth
