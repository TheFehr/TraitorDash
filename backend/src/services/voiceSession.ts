import { createHmac, timingSafeEqual } from 'node:crypto'
import { getCookie } from 'hono/cookie'
import { SESSION_SECRET, VOICE_COOKIE, getSession, maySignIn, type Session } from '../middleware/session'
import { STEAM_ID64 } from './validators'

// The voice cookie (RFC 31): a browser that paired with a code from the game is remembered for 30 days, for the voice
// page only. The value is `<SteamID64>.<expiry in seconds>.<signature>`; the signature is an HMAC under a key derived
// from the session secret for this purpose alone, so it is not the game key's and not the session cookie's, and none of
// the three can be used as another. `getSession` does not read it: only the voice routes do, through `getVoiceSession`.

export const VOICE_COOKIE_SECONDS = 30 * 24 * 60 * 60

const SHAPE = /^\d{17}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/

const sign = (payload: string): string =>
  createHmac('sha256', createHmac('sha256', SESSION_SECRET).update('traitordash voice').digest()).update(payload).digest('base64url')

export function makeVoiceCookie(steamId: string, now: number = Date.now()): string {
  const payload = `${steamId}.${Math.floor(now / 1000) + VOICE_COOKIE_SECONDS}`
  return `${payload}.${sign(payload)}`
}

/** The SteamID64 a voice cookie vouches for, or null when it is malformed, forged or expired. */
export function readVoiceCookie(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== 'string' || value.length > 100 || !SHAPE.test(value)) return null
  const [steamId, expiry, signature] = value.split('.') as [string, string, string]
  if (!STEAM_ID64.test(steamId)) return null
  const expected = Buffer.from(sign(`${steamId}.${expiry}`))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  return Number(expiry) * 1000 > now ? steamId : null
}

/** Who is asking the voice page, and whether only the voice cookie says so. */
export async function getVoiceSessionVia(c: any): Promise<{ session: Session | null, viaCookie: boolean }> {
  // The real session or the game's first: someone who has one does not need the code.
  const real = await getSession(c)
  if (real) return { session: real, viaCookie: false }
  const steamId = readVoiceCookie(getCookie(c, VOICE_COOKIE))
  // The same switches as a sign-in, looked at on every request; a plain user whoever it is for, an admin included.
  if (steamId && maySignIn(steamId)) return { session: { steamId, admin: false }, viaCookie: true }
  return { session: null, viaCookie: false }
}

export const getVoiceSession = async (c: any): Promise<Session | null> => (await getVoiceSessionVia(c)).session
