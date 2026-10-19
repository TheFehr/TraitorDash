import { RateLimiter } from './rateLimit'
import { getSession, type Session } from '../middleware/session'

/**
 * The gate in front of heavy content for signed-in users (RFC 13, 4.4 and 4.6): an anonymous
 * request is answered `401` at once (and counted per client address, only behind TRUST_PROXY=1, so
 * a loop cannot fill the log); a signed-in one is counted per account, `429` with `Retry-After`
 * over 30 a minute. Each gated endpoint has its own counters.
 */

/** The last X-Forwarded-For entry is the one our own proxy appended; earlier ones are client-supplied. */
export const clientAddress = (c: any): string | null => {
  if (process.env.TRUST_PROXY !== '1') return null
  const forwarded = c.req.header('X-Forwarded-For')
  return forwarded ? forwarded.split(',').pop()!.trim() || null : null
}

const LIMIT = 30
const limiters = new Map<string, { account: RateLimiter, anon: RateLimiter }>()
const limitersFor = (name: string) => {
  let l = limiters.get(name)
  if (!l) { l = { account: new RateLimiter(LIMIT, 60_000), anon: new RateLimiter(LIMIT, 60_000) }; limiters.set(name, l) }
  return l
}

/** For tests, which share one process. */
export const resetGates = () => { for (const l of limiters.values()) { l.account.reset(); l.anon.reset() } }

/** Hono middleware: signed-in users only. Sets `session` on the context. */
export const gated = (name: string) => async (c: any, next: any) => {
  const { account, anon } = limitersFor(name)
  const session: Session | null = await getSession(c)
  if (!session) {
    const address = clientAddress(c)
    const wait = address ? anon.hit(address) : 0
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json({ error: 'Too many requests; slow down' }, 429)
    }
    return c.json({ error: 'Sign-in required', signin: '/auth/steam' }, 401)
  }
  const wait = account.hit(session.steamId)
  if (wait > 0) {
    c.header('Retry-After', String(wait))
    return c.json({ error: 'Too many requests; slow down' }, 429)
  }
  c.set('session', session)
  await next()
}
