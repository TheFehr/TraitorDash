import { Hono } from 'hono'
import { Extractor } from '../services/Extractor'
import { Store, type LiveConVarEntry, type RoundReport, type MapRow } from '../services/Store'
import { ServerManager } from '../components/ServerManager'
import { requireSession } from '../middleware/session'
import { normalizeConVarValue, formatConVarCommand } from '../services/convars'
import { RateLimiter } from '../services/rateLimit'
import { clientAddress } from '../services/gates'
import { validatePlan, MAX_PLAN_BYTES } from '../services/mapplan'
import { formatCode } from '../services/pairing'
import { validateTrack, MAX_TRACK_BYTES } from '../services/tracks'
import { refreshWorkshopText } from '../services/workshopText'
import { NONCE, signResponse } from '../services/signing'
import { FINGERPRINT, NAME, ROUND_ID, STEAM_ID, STEAM_ID64, WSID } from '../services/validators'
import { makeGameKey, KEY_TTL_SECONDS } from '../services/gameKey'

type Variables = {
  server: {
    id: string
    name: string
    last_seen: string | null
  }
  adminId: string
}

const api = new Hono<{ Variables: Variables }>()

// Names from a game server end up in URLs, HTML, SQL parameters and console commands, so
// they are restricted to a plain identifier character set at the door.
const ROLE_NAME = /^[A-Za-z0-9_]{1,64}$/
const TEAM_ID = /^[a-z0-9_]{1,32}$/
const CONVAR_NAME = /^[A-Za-z0-9_]{1,80}$/
const MAX_ROLE_CODE_BYTES = 256 * 1024

/** Drops schema entries naming a ConVar that is not a plain identifier. Returns what it dropped. */
function dropUnsafeConVars(schema: any[]): { schema: any[], dropped: string[] } {
  const dropped: string[] = []
  const safe = schema.filter((item: any) => {
    for (const key of ['convar', 'serverConvar']) {
      const v = item?.args?.[key]
      if (v !== undefined && v !== null && (typeof v !== 'string' || !CONVAR_NAME.test(v))) {
        dropped.push(String(v).slice(0, 80))
        return false
      }
    }
    return true
  })
  return { schema: safe, dropped }
}

// Middleware to get server by token
const getServer = async (c: any, next: any) => {
  const auth = c.req.header('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  
  const token = auth.split(' ')[1]
  const server = Store.getServerByToken(token)
  
  if (!server) {
    return c.json({ error: 'Invalid Token' }, 401)
  }
  
  c.set('server', server)
  await next()
}

// Admin-facing routes require a logged-in session
api.use('/servers', requireSession)
api.use('/servers/*', requireSession)
api.use('/save/*', requireSession)

// Token responses must never be cached: the plaintext token is shown exactly once.
const serverManager = (c: any, newToken?: { serverId: string, token: string }, pairing?: { serverId: string, command: string, token?: string }) => {
  c.header('Cache-Control', 'no-store')
  return c.html(<ServerManager servers={Store.getServers()} newToken={newToken} pairing={pairing} />)
}

api.get('/servers', async (c) => serverManager(c))

/** The address the owner types into the game server: the dashboard's own, from BASE_URL. It is quoted in the command: the game console treats // as a comment. */
const dashboardUrl = (c: any) => {
  const configured = (process.env.BASE_URL || '').trim().replace(/\/+$/, '')
  return configured || new URL(c.req.url).origin
}

/** The command shown to the owner, ready to paste into the game server's console. */
const connectCommand = (c: any, code: string) => `traitordash_connect "${dashboardUrl(c)}" ${formatCode(code)}`

api.post('/servers', async (c) => {
  const { name } = await c.req.parseBody()
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) return serverManager(c)

  const { id, token } = Store.addServer(trimmed)
  Store.audit(id, c.get('adminId'), 'CREATE_SERVER', `Name: ${trimmed}`)

  // The way to connect it is a pairing code; the raw token stays available for provisioning tools.
  const code = Store.createPairingCode(id, c.get('adminId'))
  if (!code) return serverManager(c, { serverId: id, token })
  Store.audit(id, c.get('adminId'), 'PAIR_CODE_CREATED')
  return serverManager(c, undefined, { serverId: id, command: connectCommand(c, code), token })
})

api.post('/servers/:id/regenerate-token', async (c) => {
  const id = c.req.param('id')
  const token = Store.regenerateToken(id)
  if (!token) return c.json({ error: 'Server not found' }, 404)

  Store.audit(id, c.get('adminId'), 'REGEN_TOKEN')
  return serverManager(c, { serverId: id, token })
})

api.post('/servers/:id/pairing-code', async (c) => {
  const id = c.req.param('id')
  const code = Store.createPairingCode(id, c.get('adminId'))
  if (!code) return c.json({ error: 'Server not found' }, 404)

  // The code itself is a credential for ten minutes: it is not written to the audit log.
  Store.audit(id, c.get('adminId'), 'PAIR_CODE_CREATED')
  return serverManager(c, undefined, { serverId: id, command: connectCommand(c, code) })
})

api.delete('/servers/:id', async (c) => {
  const id = c.req.param('id')
  const server = Store.getServerById(id)
  if (server) {
    Store.audit(id, c.get('adminId'), 'DELETE_SERVER', `Name: ${server.name}`)
    Store.deleteServer(id)
  }
  return serverManager(c)
})

api.post('/ingest', getServer, async (c) => {
  try {
    const server = c.get('server')
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400)
    }
    const { role_code, role_name, convar_state, data_state, active_admins, md5_hash, force } = body
    // The game's own word for the role's team, when the bridge has it.
    const liveTeam = typeof body.team === 'string' && TEAM_ID.test(body.team) ? body.team : null

    if (!role_code || typeof role_code !== 'string') {
      return c.json({ error: 'Missing role_code' }, 400)
    }
    if (role_code.length > MAX_ROLE_CODE_BYTES) {
      return c.json({ error: `role_code is larger than ${MAX_ROLE_CODE_BYTES} bytes` }, 413)
    }

    const name = role_name ?? 'unknown'
    if (typeof name !== 'string' || !ROLE_NAME.test(name)) {
      return c.json({ error: 'role_name must be 1-64 characters of letters, digits and underscores' }, 400)
    }

    // Update active admins for the server if provided
    if (active_admins && Array.isArray(active_admins)) {
      console.log(`[API] Active admins on ${server.name}:`, active_admins)
      // TODO: Persist to authorized_admins table in RFC 5
    }

    // MD5 Caching Logic
    if (!force && md5_hash) {
      const existingHash = Store.getRoleHash(server.id, name)
      if (existingHash === md5_hash) {
        console.log(`[API] Ingest: ${name} for ${server.name} unchanged (MD5: ${md5_hash}). Skipping extraction.`)
        if (liveTeam) Store.setRoleTeam(server.id, name, liveTeam)
        // Schema included so the bridge can still work out which ConVars to report.
        return c.json({
          success: true,
          role: name,
          cached: true,
          schema: Store.getSchema(server.id, name) ?? []
        })
      }
    }

    console.log(`[API] Ingesting role: ${name} for server ${server.name} (Size: ${role_code.length} bytes, Force: ${!!force})`)
    const extracted = await Extractor.extractSchema(role_code, convar_state, data_state, name, Store.getLangSources(server.id))
    const { isPolicingRole, baserole } = extracted
    const team = liveTeam ?? extracted.team
    const { schema, dropped } = dropUnsafeConVars(extracted.schema)
    if (dropped.length > 0) {
      console.warn(`[API] SECURITY ALERT: ${name} on ${server.name} declared ConVar names that are not plain identifiers; dropped: ${JSON.stringify(dropped)}`)
    }

    // Save to database via Store
    Store.saveSchema(server.id, name, team, isPolicingRole, baserole, schema, md5_hash, extracted.description, extracted.color)

    return c.json({
      success: true,
      role: name,
      team: team,
      isPolicingRole,
      baserole,
      schema: schema,
      cached: false
    })
  } catch (err: any) {
    console.error('[API] Extraction failed:', err)
    return c.json({
      success: false,
      error: String(err?.message ?? 'Extraction failed').slice(0, 300)
    }, 500)
  }
})

// The bridge pushes the game server's English language files (TTT2 core + one per role
// addon) once per sync; they resolve translation keys during extraction.
// Real TTT2 language sets are a few hundred KB in all.
const MAX_LANG_TOTAL = 8_000_000
api.post('/v1/lang', getServer, async (c) => {
  const server = c.get('server')
  const body = await c.req.json().catch(() => null)
  const files = body?.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return c.json({ error: 'files must be an object of name -> Lua source' }, 400)
  }

  const entries = Object.entries(files)
  if (entries.length === 0 || entries.length > 100) {
    return c.json({ error: 'between 1 and 100 language files are expected' }, 400)
  }
  let total = 0
  for (const [name, content] of entries) {
    total += typeof content === 'string' ? content.length : 0
    if (total > MAX_LANG_TOTAL) {
      return c.json({ error: `language files are larger than ${MAX_LANG_TOTAL} bytes in total` }, 413)
    }
    if (!NAME.test(name) || typeof content !== 'string' || content.length > 1_000_000) {
      return c.json({ error: `Invalid language file: ${name.slice(0, 40)}` }, 400)
    }
  }

  const result = Store.setLangFiles(server.id, files as Record<string, string>)
  Store.updateHeartbeat(server.id)
  console.log(`[API] Language files from ${server.name}: ${result.stored} stored${result.changed ? ' (changed: cached extractions cleared)' : ''}`)
  return c.json({ success: true, ...result })
})

const short = (v: unknown) => (typeof v === 'string' && v.length <= 256 ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// The bridge reports each ConVar's live state: value, default, bounds, or that it does not exist.
api.post('/v1/values', getServer, async (c) => {
  const server = c.get('server')
  const body = await c.req.json().catch(() => null)
  const convars = body?.convars
  if (!Array.isArray(convars) || convars.length > 400) {
    return c.json({ error: 'convars must be an array of at most 400 entries' }, 400)
  }

  const entries: LiveConVarEntry[] = []
  for (const e of convars) {
    if (typeof e?.name !== 'string' || !CONVAR_NAME.test(e.name)) {
      return c.json({ error: `Invalid ConVar name: ${String(e?.name).slice(0, 40)}` }, 400)
    }
    const role = typeof e.role === 'string' && CONVAR_NAME.test(e.role) ? e.role : null
    entries.push({
      name: e.name,
      role,
      present: e.present === true,
      value: short(e.value),
      default: short(e.default),
      min: num(e.min),
      max: num(e.max),
    })
  }

  Store.setConVarValues(server.id, entries)
  Store.updateHeartbeat(server.id)
  return c.json({ success: true, stored: entries.length })
})

// The bridge reports one finished round: who played which role, who won, who died.
// Best effort on the bridge side (no retry), so the body is validated strictly but a
// duplicate round_id is answered with success rather than an error.
const label = (v: unknown, max = 64) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null)
const whole = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

// A server reports one round every few minutes. This only stops a runaway or hostile client from
// filling the database: a real server never gets near it, and a refused round is simply lost
// (the bridge does not retry), exactly like any other failed report.
export const roundLimiter = new RateLimiter(10, 60_000)

api.post('/v1/round', getServer, async (c) => {
  const server = c.get('server')
  const wait = roundLimiter.hit(server.id)
  if (wait > 0) {
    console.warn(`[Stats] Rate limit hit by ${server.name}; refusing rounds for ${wait}s`)
    c.header('Retry-After', String(wait))
    return c.json({ error: 'Too many rounds reported; slow down' }, 429)
  }
  const body = await c.req.json().catch(() => null)
  const bad = (msg: string) => {
    console.warn(`[Stats] Rejected round from ${server.name}: ${msg}`)
    return c.json({ error: msg }, 400)
  }

  if (!body || typeof body.round_id !== 'string' || !ROUND_ID.test(body.round_id)) return bad('round_id is required')
  const result = label(body.result)
  if (!result) return bad('result is required')
  if (!Array.isArray(body.players) || body.players.length === 0 || body.players.length > 128) return bad('players must be an array of 1-128 entries')
  if (body.deaths !== undefined && (!Array.isArray(body.deaths) || body.deaths.length > 512)) return bad('deaths must be an array of at most 512 entries')
  if (body.revives !== undefined && (!Array.isArray(body.revives) || body.revives.length > 512)) return bad('revives must be an array of at most 512 entries')

  const players: RoundReport['players'] = []
  for (const p of body.players) {
    if (typeof p?.steam_id !== 'string' || !STEAM_ID.test(p.steam_id)) return bad(`invalid player steam_id: ${String(p?.steam_id).slice(0, 24)}`)
    players.push({
      steamId: p.steam_id,
      nick: label(p.nick, 64),
      role: label(p.role),
      team: label(p.team),
      survived: p.survived === true,
      won: p.won === true,
      // The state the round ended in (RFC 14, 4.4); absent from older bridges.
      endRole: label(p.end_role),
      endTeam: label(p.end_team),
    })
  }
  // Deaths are checked against the round's own players: a death for someone who was not in the
  // round is dropped, and a killer who is the victim (suicide) or not in the round gets no kill.
  const inRound = new Set(players.map(p => p.steamId))
  const deaths: RoundReport['deaths'] = []
  let dropped = 0
  for (const d of body.deaths ?? []) {
    if (typeof d?.victim !== 'string' || !STEAM_ID.test(d.victim)) return bad('invalid death victim')
    if (!inRound.has(d.victim)) { dropped++; continue }
    const claimed = typeof d.attacker === 'string' && STEAM_ID.test(d.attacker) ? d.attacker : null
    const attacker = claimed && claimed !== d.victim && inRound.has(claimed) ? claimed : null
    deaths.push({ victim: d.victim, attacker, at: whole(d.at) })
  }
  if (dropped > 0) console.warn(`[Stats] ${server.name}: ${dropped} death(s) for players not in the round were dropped`)

  // Revivals (RFC 14, 4.4): the same rules as deaths. A reviver who is not in the round, or a name
  // with other characters than a class or role name has, is stored as unknown, not refused.
  const revives: NonNullable<RoundReport['revives']> = []
  let droppedRevives = 0
  for (const v of body.revives ?? []) {
    if (typeof v?.victim !== 'string' || !STEAM_ID.test(v.victim)) return bad('invalid revive victim')
    if (!inRound.has(v.victim)) { droppedRevives++; continue }
    const named = (x: unknown) => (typeof x === 'string' && NAME.test(x) ? x : null)
    const reviver = typeof v.reviver === 'string' && STEAM_ID.test(v.reviver) && inRound.has(v.reviver) ? v.reviver : null
    revives.push({ victim: v.victim, reviver, how: named(v.how), why: named(v.why), at: whole(v.at) })
  }
  if (droppedRevives > 0) console.warn(`[Stats] ${server.name}: ${droppedRevives} revival(s) for players not in the round were dropped`)

  const report: RoundReport = {
    roundId: body.round_id,
    map: label(body.map),
    startedAt: label(body.started_at, 40),
    duration: whole(body.duration),
    result,
    players,
    deaths,
    revives,
  }

  const stored = Store.recordRound(server.id, report)
  Store.updateHeartbeat(server.id)
  console.log(
    `[Stats] Round ${report.roundId} from ${server.name}: ${stored ? 'stored' : 'duplicate, ignored'} ` +
    `(map=${report.map}, result=${result}, ${players.length} players, ${deaths.length} deaths, ${report.duration ?? '?'}s)`
  )
  return c.json({ success: true, stored })
})

// The bridge uploads the position track of a round it has already reported (RFC 12, 3.3). Every
// number is checked before anything is stored; a track that does not fit is refused whole.
/** The 429 answer for a caller who is over a limit: Retry-After says how long to wait. */
const tooMany = (c: any, waitSeconds: number, message: string) => {
  c.header('Retry-After', String(waitSeconds))
  return c.json({ error: message }, 429)
}

/**
 * The request's body read as JSON, at most `maxBytes` long (a longer one is never parsed). `body` is null
 * when the text is not JSON, so callers answer both a bad and a missing body the same way.
 */
async function readJson(c: any, maxBytes: number): Promise<{ tooLarge: true } | { tooLarge: false, body: any }> {
  if (Number(c.req.header('content-length') ?? 0) > maxBytes) return { tooLarge: true }
  const text: string = await c.req.text().catch(() => '')
  if (Buffer.byteLength(text) > maxBytes) return { tooLarge: true }
  let body: any = null
  try { body = JSON.parse(text) } catch { /* the caller answers a null body */ }
  return { tooLarge: false, body }
}

export const trackLimiter = new RateLimiter(10, 60_000)

api.post('/v1/track', getServer, async (c) => {
  const server = c.get('server')
  const wait = trackLimiter.hit(server.id)
  if (wait > 0) return tooMany(c, wait, 'Too many tracks uploaded; slow down')
  const read = await readJson(c, MAX_TRACK_BYTES)
  if (read.tooLarge) return c.json({ error: `A track is at most ${MAX_TRACK_BYTES / 1024 / 1024} MB` }, 413)
  const body = read.body
  const bad = (msg: string) => {
    console.warn(`[Track] Rejected track from ${server.name}: ${msg}`)
    return c.json({ error: msg }, 400)
  }
  if (!body || typeof body.round_id !== 'string' || !ROUND_ID.test(body.round_id)) return bad('round_id is required')
  const round = Store.getRoundForTrack(server.id, body.round_id)
  if (!round) return bad('this server has not reported that round')
  if (Store.hasTrack(server.id, body.round_id)) return c.json({ success: true, stored: false })

  const checked = validateTrack(body, { roundId: body.round_id, map: round.map, players: round.players })
  if (!checked.ok) return bad(checked.error)
  const json = JSON.stringify(checked.track)
  const result = Store.recordTrack(server.id, checked.track, json)
  Store.updateHeartbeat(server.id)
  if (result.status === 'too_big') return c.json({ error: `The track is too big: ${result.limit}` }, 413)
  console.log(`[Track] Round ${body.round_id} from ${server.name}: ${result.status} (${checked.track.t.length} ticks, ${checked.track.players.length} players, ${(json.length / 1024).toFixed(0)} KB)`)
  return c.json({ success: true, stored: result.status === 'stored' })
})

// The bridge reports the maps the server has and which it will play (RFC 10), on startup and when
// the map changes. The latest report replaces the previous one. Flags the bridge could not decide
// are null; anything that is not a boolean is stored as unknown instead of being trusted.
const POOL_BASES = ['prefixes', 'gamemode']
const CONFIG_SOURCES = ['merged', 'global', 'file', 'none']
const flag = (v: unknown) => (typeof v === 'boolean' ? v : null)
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null)
const oneOf = (v: unknown, allowed: string[]) => (typeof v === 'string' && allowed.includes(v) ? v : null)

// A server reports its maps a few times per session; this only stops a runaway or hostile client.
export const mapsLimiter = new RateLimiter(6, 60_000)

api.post('/v1/maps', getServer, async (c) => {
  const server = c.get('server')
  const wait = mapsLimiter.hit(server.id)
  if (wait > 0) {
    console.warn(`[Maps] Rate limit hit by ${server.name}; refusing reports for ${wait}s`)
    c.header('Retry-After', String(wait))
    return c.json({ error: 'Too many map reports; slow down' }, 429)
  }
  const body = await c.req.json().catch(() => null)
  const bad = (msg: string) => {
    console.warn(`[Maps] Rejected report from ${server.name}: ${msg}`)
    return c.json({ error: msg }, 400)
  }
  if (!body || !Array.isArray(body.maps) || body.maps.length > 500) return bad('maps must be an array of at most 500 entries')

  const seen = new Set<string>()
  const maps: MapRow[] = []
  for (const m of body.maps) {
    if (typeof m?.name !== 'string' || !NAME.test(m.name)) return bad(`invalid map name: ${String(m?.name).slice(0, 40)}`)
    if (m.size !== null && m.size !== undefined && (typeof m.size !== 'number' || !Number.isFinite(m.size) || m.size < 0)) return bad(`invalid size for ${m.name}`)
    if (m.fingerprint !== null && m.fingerprint !== undefined && (typeof m.fingerprint !== 'string' || !FINGERPRINT.test(m.fingerprint))) return bad(`invalid fingerprint for ${m.name}`)
    if (seen.has(m.name)) continue
    seen.add(m.name)
    maps.push({
      name: m.name,
      size: typeof m.size === 'number' ? Math.round(m.size) : null,
      fingerprint: typeof m.fingerprint === 'string' ? m.fingerprint : null,
      matchesGamemode: flag(m.matchesGamemode), inCycle: flag(m.inCycle), onCooldown: flag(m.onCooldown),
      isCurrent: flag(m.isCurrent), inVotePool: flag(m.inVotePool), votable: flag(m.votable),
    })
  }

  // Workshop IDs are plain digits; anything else is dropped, and the list is capped.
  const mapAddons = Array.isArray(body.mapAddons)
    ? [...new Set<string>(body.mapAddons.filter((id: unknown): id is string => typeof id === 'string' && WSID.test(id)))].slice(0, 300)
    : []

  const vote = body.mapvote && typeof body.mapvote === 'object' ? body.mapvote : {}
  Store.setMaps(server.id, {
    current: text(body.current, 64), next: text(body.next, 64), gamemode: text(body.gamemode, 64), pattern: text(body.pattern, 128),
    poolBasis: oneOf(vote.poolBasis, POOL_BASES), configSource: oneOf(vote.configSource, CONFIG_SOURCES),
    voteAddon: vote.present === true, maps, mapAddons,
  })
  Store.updateHeartbeat(server.id)
  console.log(`[Maps] Report from ${server.name}: ${maps.length} maps (current=${text(body.current, 64)}, pool by ${oneOf(vote.poolBasis, POOL_BASES) ?? 'unknown'})`)
  return c.json({ success: true, stored: maps.length })
})

// Which Workshop addon each role comes from (RFC 15), read by the bridge from the addons' file lists.
// Replaces the server's list; the backend then reads the addons' Workshop pages in the background.
export const roleAddonsLimiter = new RateLimiter(6, 60_000)
const MAX_ROLE_ADDON_ROLES = 500
const MAX_ADDONS_PER_ROLE = 10

api.post('/v1/roleaddons', getServer, async (c) => {
  const server = c.get('server')
  const wait = roleAddonsLimiter.hit(server.id)
  if (wait > 0) return tooMany(c, wait, 'Too many role-addon reports; slow down')
  const read = await readJson(c, 512 * 1024)
  if (read.tooLarge) return c.json({ error: 'the report is too large' }, 413)
  const bad = (msg: string) => {
    console.warn(`[RoleAddons] Rejected report from ${server.name}: ${msg}`)
    return c.json({ error: msg }, 400)
  }
  const roles = read.body?.roles
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return bad('roles must be an object')
  const names = Object.keys(roles)
  if (names.length > MAX_ROLE_ADDON_ROLES) return bad(`at most ${MAX_ROLE_ADDON_ROLES} roles`)

  const rows: { role: string, wsid: string, title: string }[] = []
  for (const role of names) {
    if (!NAME.test(role)) return bad(`invalid role name: ${role.slice(0, 40)}`)
    const list = roles[role]
    if (!Array.isArray(list) || list.length > MAX_ADDONS_PER_ROLE) return bad(`invalid addon list for ${role}`)
    for (const a of list) {
      if (typeof a?.wsid !== 'string' || !WSID.test(a.wsid)) return bad(`invalid Workshop id for ${role}`)
      const title = typeof a.title === 'string' ? a.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : ''
      rows.push({ role, wsid: a.wsid, title })
    }
  }
  Store.setRoleAddons(server.id, rows)
  Store.updateHeartbeat(server.id)
  console.log(`[RoleAddons] Report from ${server.name}: ${names.length} roles in ${new Set(rows.map(r => r.wsid)).size} addons`)
  // Not waited for: the answer does not depend on Steam.
  void refreshWorkshopText(rows.map(r => r.wsid))
  return c.json({ success: true, roles: names.length })
})

// The descriptions the server's admins wrote for their roles (RFC 15), read by the bridge from the data
// file of a role-description addon. Replaces the server's list. Shown before every other description.
export const roleNotesLimiter = new RateLimiter(6, 60_000)
const MAX_NOTE_CHARS = 4000

api.post('/v1/roledescriptions', getServer, async (c) => {
  const server = c.get('server')
  const wait = roleNotesLimiter.hit(server.id)
  if (wait > 0) return tooMany(c, wait, 'Too many description reports; slow down')
  const read = await readJson(c, 512 * 1024)
  if (read.tooLarge) return c.json({ error: 'the report is too large' }, 413)
  const roles = read.body?.roles
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return c.json({ error: 'roles must be an object' }, 400)
  const names = Object.keys(roles)
  if (names.length > MAX_ROLE_ADDON_ROLES) return c.json({ error: `at most ${MAX_ROLE_ADDON_ROLES} roles` }, 400)
  const rows: { role: string, text: string }[] = []
  for (const role of names) {
    if (!NAME.test(role)) return c.json({ error: `invalid role name: ${role.slice(0, 40)}` }, 400)
    if (typeof roles[role] !== 'string') return c.json({ error: `invalid text for ${role}` }, 400)
    const text = roles[role].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_NOTE_CHARS)
    if (text) rows.push({ role, text })
  }
  Store.setRoleNotes(server.id, rows)
  Store.updateHeartbeat(server.id)
  console.log(`[RoleNotes] Report from ${server.name}: ${rows.length} descriptions`)
  return c.json({ success: true, roles: rows.length })
})

// A game vouches for its players (RFC 16, 4): the bridge sends the SteamID64s of the players in the
// game and gets one short-lived key for each, which the client puts into the link it opens. The
// key can be made only with the server's token, so a player cannot make one for somebody else.
export const ingameKeysLimiter = new RateLimiter(6, 60_000)
const MAX_KEY_PLAYERS = 128

api.post('/v1/ingame-keys', getServer, async (c) => {
  const server = c.get('server')
  const wait = ingameKeysLimiter.hit(server.id)
  if (wait > 0) return tooMany(c, wait, 'Too many key requests; slow down')
  const read = await readJson(c, 64 * 1024)
  if (read.tooLarge) return c.json({ error: 'the request is too large' }, 413)
  const players = read.body?.players
  if (!Array.isArray(players) || players.length > MAX_KEY_PLAYERS) return c.json({ error: `players must be a list of at most ${MAX_KEY_PLAYERS} SteamID64s` }, 400)
  if (!players.every((p: unknown) => typeof p === 'string' && STEAM_ID64.test(p))) return c.json({ error: 'players must be SteamID64s' }, 400)
  const now = Date.now()
  // A list, not an object keyed by SteamID64: GMod's util.JSONToTable turns keys that look like numbers into
  // numbers, and a SteamID64 does not fit in one exactly.
  const keys = [...new Set(players as string[])].map(id => ({ steam_id: id, key: makeGameKey(id, now) }))
  return c.json({ success: true, keys, ttl: KEY_TTL_SECONDS })
})

// The bridge uploads a finished floor-plan scan (RFC 10, 4.5). The latest plan per map is kept.
// A real plan is tens of KB; this only stops a runaway client.
export const mapPlanLimiter = new RateLimiter(3, 60_000)

api.post('/v1/mapplan', getServer, async (c) => {
  const server = c.get('server')
  const wait = mapPlanLimiter.hit(server.id)
  if (wait > 0) {
    console.warn(`[Maps] Plan rate limit hit by ${server.name}; refusing uploads for ${wait}s`)
    return tooMany(c, wait, 'Too many plan uploads; slow down')
  }
  const read = await readJson(c, MAX_PLAN_BYTES)
  if (read.tooLarge) return c.json({ error: `plans are limited to ${MAX_PLAN_BYTES} bytes` }, 413)
  const checked = validatePlan(read.body)
  if ('error' in checked) {
    console.warn(`[Maps] Rejected plan from ${server.name}: ${checked.error}`)
    return c.json({ error: checked.error }, 400)
  }

  Store.setMapPlan(server.id, checked.plan)
  Store.updateHeartbeat(server.id)
  console.log(`[Maps] Plan for ${checked.plan.map} from ${server.name}: ${checked.plan.floorCells} floor cells (${checked.plan.crouchFloors} crouch-only), ${checked.plan.nx}x${checked.plan.ny}`)
  return c.json({ success: true, floorCells: checked.plan.floorCells })
})

api.post('/save/:serverId/:role', async (c) => {
  const serverId = c.req.param('serverId')
  const role = c.req.param('role')
  const body = await c.req.parseBody()
  
  console.log(`[API] Saving config for ${role} on ${serverId}: ${Object.keys(body).length} field(s)`)

  const schema = Store.getSchema(serverId, role)
  if (!schema) {
    console.error(`[API] Save failed: No schema found for role ${role} on server ${serverId}`)
    return c.json({ error: 'Role schema not found. Configuration cannot be validated.' }, 400)
  }

  // Build whitelist of allowed convars from the extracted schema
  const allowedKeys = new Set<string>()
  schema.forEach((item: any) => {
    if (item.args) {
      // Only plain identifiers: a name smuggling `;` or a newline must never become a command,
      // even if it sits in a schema stored before ingest started filtering them.
      for (const key of [item.args.convar, item.args.serverConvar]) {
        if (typeof key === 'string' && CONVAR_NAME.test(key)) allowedKeys.add(key)
      }
    }
  })

  // ConVars the server itself reported for this role (random, traitor_button, ...) are
  // editable too, even though the role file does not declare them.
  for (const [name, lv] of Object.entries(Store.getConVarValues(serverId))) {
    if (lv.role === role && lv.present) allowedKeys.add(name)
  }

  // Validate everything first: either all changes are queued or none are.
  const accepted: Array<[string, string]> = []
  const rejected: string[] = []
  for (const [convar, value] of Object.entries(body)) {
    if (!allowedKeys.has(convar)) {
      console.warn(`[API] SECURITY ALERT: Blocked unauthorized config injection attempt for key: ${convar} on role: ${role}`)
      continue
    }

    const clean = normalizeConVarValue(value)
    if (clean === null) {
      console.warn(`[API] SECURITY ALERT: Rejected unsafe value for ${convar} on role: ${role}`)
      rejected.push(convar)
      continue
    }
    accepted.push([convar, clean])
  }

  if (rejected.length > 0) {
    return c.json({ error: `Invalid value for: ${rejected.join(', ')}`, rejected }, 400)
  }

  const changes: string[] = []
  for (const [convar, value] of accepted) {
    Store.stageCommand(serverId, 'convar', formatConVarCommand(convar, value))
    changes.push(`${convar}=${value}`)
  }
  const stagedCount = accepted.length

  if (stagedCount > 0) {
    Store.audit(serverId, c.get('adminId'), 'SAVE_CONFIG', `Role: ${role}, Changes: ${changes.join(', ')}`)
  }

  return c.json({ success: true, commands_staged: stagedCount })
})

/** Who the bridge's token belongs to (RFC 15, 4.5): the server's id, which the public role pages' addresses contain. Nothing else. */
api.get('/v1/whoami', getServer, (c) => c.json({ server_id: c.get('server').id }))

const warnedNoNonce = new Set<string>()
api.post('/v1/poll', getServer, async (c) => {
  const server = c.get('server')
  // Anything that is not a JSON object (null, an array, a string, garbage) counts as an empty
  // poll: the heartbeat and the queued commands must still go through.
  const parsed = await c.req.json().catch(() => null)
  const { active_admins, acked, nonce } = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : ({} as any)

  if (active_admins && Array.isArray(active_admins)) {
    console.log(`[API] Heartbeat with ${active_admins.length} admins from ${server.name} (${server.id})`)
    // TODO: Store active_admins in RFC 5
  } else {
    console.log(`[API] Heartbeat from ${server.name} (${server.id})`)
  }

  Store.updateHeartbeat(server.id)
  const commands = Store.pollCommands(server.id, Array.isArray(acked) ? acked : undefined)
  
  const commandsJson = JSON.stringify(
    commands.map(cmd => {
      let payload = cmd.args
      if (cmd.command === 'data') {
        try {
          payload = JSON.parse(cmd.args)
        } catch (e) {
          console.error('[API] Failed to parse data command args:', cmd.args)
        }
      }
      return {
        id: cmd.id,
        type: cmd.command,
        payload: payload
      }
    })
  )

  // A bridge that sends a nonce gets the answer signed. The signature travels IN the body (as
  // the last key), not in a header: a header did not reach the game server's HTTP callback.
  // The bridge verifies it over the exact bytes of the command list (see SplitSignedBody).
  // The key is the bearer token it just presented (only its hash is stored here).
  if (typeof nonce === 'string' && NONCE.test(nonce)) {
    const token = c.req.header('Authorization')!.slice('Bearer '.length)
    const sig = signResponse(token, nonce, commandsJson)
    return c.body(`{"commands":${commandsJson},"sig":"${sig}"}`, 200, { 'Content-Type': 'application/json' })
  }
  if (!warnedNoNonce.has(server.id)) {
    // An older bridge never sends one; a current bridge should. Said once per server and process.
    warnedNoNonce.add(server.id)
    console.warn(`[API] Poll from ${server.name} has no valid nonce (nonce is ${typeof nonce}, body keys: ${Object.keys(parsed && typeof parsed === 'object' ? parsed : {}).join(',') || 'none'}), so the answer is unsigned`)
  }
  return c.body(`{"commands":${commandsJson}}`, 200, { 'Content-Type': 'application/json' })
})

export default api

// Pairing (RFC 9): the code is the credential, so this endpoint needs no token or session and is
// rate limited instead. Without TRUST_PROXY the client address is unknown (behind a reverse proxy
// it would be the proxy's), so only the global limit applies.
export const pairLimiter = new RateLimiter(5, 60_000)
export const pairGlobalLimiter = new RateLimiter(30, 60_000)
const MAX_PAIR_BODY = 512
const PAIR_FAILED = { error: 'invalid or expired code' }

api.post('/v1/pair', async (c) => {
  c.header('Cache-Control', 'no-store')

  const address = clientAddress(c)
  const wait = Math.max(address ? pairLimiter.hit(address) : 0, pairGlobalLimiter.hit('global'))
  if (wait > 0) {
    console.warn(`[Pairing] Rate limit hit; refusing attempts for ${wait}s`)
    return tooMany(c, wait, 'Too many attempts; try again later')
  }

  const read = await readJson(c, MAX_PAIR_BODY)
  const body = read.tooLarge ? null : read.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string') {
    return c.json(PAIR_FAILED, 400)
  }

  const paired = Store.redeemPairingCode(body.code)
  if (!paired) return c.json(PAIR_FAILED, 400)

  Store.audit(paired.serverId, null, 'PAIR_REDEEMED', address ? `From ${address}` : undefined)
  return c.json({ token: paired.token, server_id: paired.serverId, name: paired.name })
})
