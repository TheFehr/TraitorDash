// Browsers attach an Origin header to every cross-site POST/DELETE. Requests that change
// state with the login cookie must come from this site; requests without an Origin are not
// from a browser form (curl, the game server) and cannot ride on someone's cookie.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

const hostOf = (url: string): string | null => {
  try { return new URL(url).host } catch { return null }
}

export const sameOrigin = async (c: any, next: any) => {
  if (SAFE.has(c.req.method)) return next()
  // Bridge calls authenticate with a bearer token, not a cookie.
  if (c.req.header('Authorization')) return next()

  const origin = c.req.header('Origin')
  if (!origin) return next()

  const allowed = new Set<string>()
  for (const h of [c.req.header('Host'), c.req.header('X-Forwarded-Host'), process.env.BASE_URL && hostOf(process.env.BASE_URL)]) {
    if (h) allowed.add(h)
  }
  const originHost = hostOf(origin)
  if (!originHost || !allowed.has(originHost)) {
    console.warn(`[Security] Refused a cross-site ${c.req.method} ${c.req.path} from origin ${origin.slice(0, 80)}`)
    return c.json({ error: 'Cross-site request refused' }, 403)
  }
  return next()
}
