import { getSignedCookie } from 'hono/cookie'

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

// Comma-separated SteamID64s allowed to administer. Empty list = nobody (fail closed).
const ADMIN_STEAM_IDS = new Set(
  (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
)

if (ADMIN_STEAM_IDS.size === 0) {
  console.warn('[Auth] ADMIN_STEAM_IDS is empty: nobody will be able to log in as admin.')
}

export const isAdmin = (steamId: string) => ADMIN_STEAM_IDS.has(steamId)

/** Returns the SteamID64 of the logged-in admin, or null. Re-checks the allowlist on every call. */
export const getAdminId = async (c: any): Promise<string | null> => {
  const steamId = await getSignedCookie(c, SESSION_SECRET, 'steam_id')
  return steamId && isAdmin(steamId) ? steamId : null
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
