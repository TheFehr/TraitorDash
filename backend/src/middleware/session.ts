import { getSignedCookie } from 'hono/cookie'
import { STEAM_ID64 } from '../services/validators'

// The session cookie is signed with this. There is deliberately NO fallback: a default value
// is public, and with it anyone could sign a cookie for an admin's (public) SteamID64.
const MIN_SECRET_LENGTH = 32

function loadSessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters ` +
      '(for example: openssl rand -hex 32). Refusing to start without it.'
    )
  }
  return secret
}

export const SESSION_SECRET = loadSessionSecret()

// Behind https the cookie gets the __Host- prefix: browsers then refuse to accept it unless it
// is Secure, has Path=/ and no Domain, so a sibling subdomain (or an http page) cannot plant
// or overwrite it. Plain http (local development) keeps the unprefixed name.
export const SESSION_COOKIE_SECURE = /^https:\/\//i.test((process.env.BASE_URL || '').trim())
export const SESSION_COOKIE = SESSION_COOKIE_SECURE ? '__Host-steam_id' : 'steam_id'

// Comma-separated SteamID64s allowed to administer. Empty list = nobody (fail closed).
const ADMIN_STEAM_IDS = new Set(
  (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
)

if (ADMIN_STEAM_IDS.size === 0) {
  console.warn('[Auth] ADMIN_STEAM_IDS is empty: nobody will be able to log in as admin.')
}

export const isAdmin = (steamId: string) => ADMIN_STEAM_IDS.has(steamId)

/**
 * Whether any Steam account may sign in (RFC 13, 4.7). Off by default: then only the admin
 * allow-list can, exactly as before. Read at each request so the switch takes effect at once.
 */
export const openSignin = () => process.env.OPEN_SIGNIN === '1'

/** Accounts that may not sign in or keep a session (RFC 13, 4.7). An admin on the allow-list cannot be blocked. */
export const isBlocked = (steamId: string) =>
  (process.env.BLOCKED_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(steamId)

/** Whether `steamId` may hold a session now: an admin always; anyone else only with open sign-in on, if not blocked. */
export const maySignIn = (steamId: string) => isAdmin(steamId) || (openSignin() && STEAM_ID64.test(steamId) && !isBlocked(steamId))

export interface Session { steamId: string, admin: boolean }

/**
 * Who is asking (RFC 13, 4.3): null for an anonymous visitor (no cookie, a forged or expired one,
 * an account that may not sign in); otherwise the SteamID64 and whether it is on the admin
 * allow-list *now*. Nothing in the cookie says "admin": the list is checked on every call, so a
 * removed admin is a plain user, and a cookie alone grants nothing beyond a signed-in user.
 */
export const getSession = async (c: any): Promise<Session | null> => {
  const steamId = await getSignedCookie(c, SESSION_SECRET, SESSION_COOKIE)
  if (!steamId || !maySignIn(steamId)) return null
  return { steamId, admin: isAdmin(steamId) }
}

/** Returns the SteamID64 of the logged-in admin, or null. Re-checks the allowlist on every call. */
export const getAdminId = async (c: any): Promise<string | null> => {
  const session = await getSession(c)
  return session?.admin ? session.steamId : null
}

/**
 * Data routes for signed-in users (RFC 13, 4.4): `401` with a body that says sign-in is needed.
 * Sets `session` on the context. Page routes use `signinRedirect` instead.
 */
export const requireUser = async (c: any, next: any) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: 'Sign-in required', signin: '/auth/steam' }, 401)
  c.set('session', session)
  await next()
}

/**
 * Rejects requests without a valid admin session.
 * Used for the admin-facing API (the plugin-facing routes use bearer tokens instead).
 */
export const requireSession = async (c: any, next: any) => {
  const adminId = await getAdminId(c)
  if (!adminId) return c.json({ error: 'Unauthorized' }, 401)
  c.set('adminId', adminId)
  await next()
}

/**
 * A path to return to after signing in, or null (RFC 13, 4.2). This is the one place a redirect
 * target comes from the request, so it must be a same-site relative path and nothing else: it
 * starts with a single "/", has no backslash, no control character and no "//", and is at most 200
 * characters. Encoded forms are checked after decoding too ("/%2F/evil", "/%5Cevil").
 */
export const safeNext = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null
  const ok = (p: string) => p.startsWith('/') && !p.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(p) && !p.includes('//') && !/^\/[a-z][a-z0-9+.-]*:/i.test(p)
  if (!ok(raw)) return null
  let once: string, twice: string
  try { once = decodeURIComponent(raw); twice = decodeURIComponent(once) } catch { return null }
  return ok(once) && ok(twice) ? raw : null
}

/** The sign-in link for a page that needs a signed-in user; the visitor comes back to `path` afterwards. */
export const signinUrl = (path: string) => {
  const next = safeNext(path)
  return next ? `/auth/steam?next=${encodeURIComponent(next)}` : '/auth/steam'
}
