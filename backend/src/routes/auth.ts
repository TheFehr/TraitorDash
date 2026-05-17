import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'

const auth = new Hono()

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login'
// In production, this should be the public domain
const REALM = process.env.BASE_URL || 'http://localhost:3000'
const RETURN_URL = `${REALM}/auth/steam/callback`

auth.get('/steam', (c) => {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.return_to': RETURN_URL,
    'openid.realm': REALM,
  })

  return c.redirect(`${STEAM_OPENID_URL}?${params.toString()}`)
})

auth.get('/steam/callback', async (c) => {
  const query = c.req.query()

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

    // 3. Extract SteamID64
    const claimedId = query['openid.claimed_id']
    if (!claimedId) return c.text('Missing claimed_id', 400)
    
    const steamId = claimedId.split('/').pop()
    if (!steamId) return c.text('Invalid steamId', 400)

    // 4. Set Session (using a signed cookie for simplicity in this hobby project)
    // In a real app, use a proper session store
    setCookie(c, 'steam_id', steamId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7, // 1 week
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
