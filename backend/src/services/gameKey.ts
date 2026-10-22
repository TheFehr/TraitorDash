import { createHmac, timingSafeEqual } from 'node:crypto'
import { SESSION_SECRET } from '../middleware/session'
import { STEAM_ID64 } from './validators'

// A game vouches for a player (RFC 16, 4): the bridge asks for a key for each player in the game, the
// client puts it into the link it opens, and the dashboard turns it into a game session. A key
// is `<SteamID64>.<expiry in seconds>.<signature>`; the signature is an HMAC of the first two parts
// under a key derived from the session secret, so a key cannot be made without it and cannot be
// used as a session cookie (a different key and a different cookie).

/** How long a key may be exchanged for a session. */
export const KEY_TTL_SECONDS = 15 * 60
/** How long a game session lasts once it exists. */
export const GAME_SESSION_SECONDS = 6 * 60 * 60

const KEY_SHAPE = /^\d{17}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/

const sign = (payload: string): string =>
  createHmac('sha256', createHmac('sha256', SESSION_SECRET).update('traitordash game key').digest()).update(payload).digest('base64url')

export function makeGameKey(steamId: string, now: number = Date.now()): string {
  const payload = `${steamId}.${Math.floor(now / 1000) + KEY_TTL_SECONDS}`
  return `${payload}.${sign(payload)}`
}

/** The SteamID64 a key vouches for, or null when it is malformed, forged or expired. */
export function readGameKey(key: unknown, now: number = Date.now()): string | null {
  if (typeof key !== 'string' || key.length > 100 || !KEY_SHAPE.test(key)) return null
  const [steamId, expiry, signature] = key.split('.') as [string, string, string]
  if (!STEAM_ID64.test(steamId)) return null
  const expected = Buffer.from(sign(`${steamId}.${expiry}`))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  return Number(expiry) * 1000 > now ? steamId : null
}
