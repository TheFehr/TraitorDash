import { createHash } from 'node:crypto'
import { getSession, openSignin, type Session } from '../middleware/session'
import { RateLimiter } from './rateLimit'
import { clientAddress } from './gates'
import { browserOf, type Ctx } from '../components/kit'
import { Store } from './Store'
import { teamColoursOf } from '../teamColours'

// What the case-file pages (RFC 15, 16, 17) have in common on the way in and out: who is asking, how
// often, which headers go with the page, and the cache. The pages themselves are components.

/** One count per address for every case-file page, the role guide included. */
export const pageLimiter = new RateLimiter(Number(process.env.ROLE_PAGE_LIMIT) || 120, 60_000)

/**
 * The Content-Security-Policy of a page: nothing but its own stylesheet and fonts. A page that has
 * scripts (the replay, the 3D view, the confirmation of a delete) gets `script-src 'self'`, and the
 * connections and images those scripts need; never an inline script and never another site.
 */
export const pageHeaders = (scripts = false, connect: string[] = [], wasm = false): Record<string, string> => ({
  'Content-Security-Policy': scripts
    ? `default-src 'none'; script-src 'self'${wasm ? " 'wasm-unsafe-eval'" : ''}; connect-src ${["'self'", ...connect].join(' ')}; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  // Not `no-referrer`: under it Firefox sends `Origin: null` with a form post, which the cross-site check
  // (middleware/csrf.ts) must refuse, so the pin, delete and settings forms of these pages would not work there.
  // `same-origin` sends nothing to another site.
  'Referrer-Policy': 'same-origin',
})

export const isEmbed = (c: any): boolean => ['1', 'true'].includes(c.req.query('embed') ?? '')

/** Who is asking and where the page is shown. */
export async function ctxOf(c: any, given?: { session: Session | null }): Promise<Ctx> {
  // `given`: a page that takes a session of its own kind too (the voice page, RFC 31) has looked already.
  const session = given ? given.session : await getSession(c)
  const serverId = c.req.param?.('serverId') as string | undefined
  return {
    embed: isEmbed(c),
    viewer: session ? { steamId: session.steamId, admin: session.admin } : null,
    browser: browserOf(c.req.header('User-Agent')),
    signinOpen: openSignin(),
    teams: serverId ? teamColoursOf(Store.getRoles(serverId)) : undefined,
  }
}

/** Over the limit for this address: the answer to send, else null. */
export const limited = (c: any) => {
  const address = clientAddress(c)
  const wait = address ? pageLimiter.hit(address) : 0
  if (wait <= 0) return null
  c.header('Retry-After', String(wait))
  return c.text('Too many requests; slow down', 429, pageHeaders())
}

/**
 * The answer for a page: its headers, and an ETag so a repeat costs nothing. What the page shows
 * depends on who asks, so no shared cache may keep it; an admin's page is checked on every request.
 */
export function respond(c: any, ctx: Ctx, page: { toString(): string }, opts: { scripts?: boolean, status?: 200 | 404, connect?: string[], wasm?: boolean, noStore?: boolean } = {}) {
  const headers = pageHeaders(opts.scripts, opts.connect, opts.wasm)
  if (ctx.embed) headers['X-Robots-Tag'] = 'noindex'
  const html = '<!DOCTYPE html>' + page.toString()
  // `noStore`: a page that is the answer to a sign-in must not be shown again from the browser's cache (the voice page, RFC 31)
  if (opts.noStore || (opts.status && opts.status !== 200)) {
    headers['Cache-Control'] = 'no-store'
    return c.html(html, opts.status ?? 200, headers)
  }
  headers['Cache-Control'] = ctx.viewer?.admin ? 'private, max-age=0, must-revalidate' : 'private, max-age=30'
  const etag = 'W/"' + createHash('sha1').update(html).digest('hex').slice(0, 20) + '"'
  headers.ETag = etag
  const given = c.req.header('If-None-Match')
  if (given && given.split(',').map((x: string) => x.trim()).includes(etag)) return c.body(null, 304, headers)
  return c.html(html, 200, headers)
}
