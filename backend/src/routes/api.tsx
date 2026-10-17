import { Hono } from 'hono'
import { Extractor } from '../services/Extractor'
import { Store, type LiveConVarEntry, type RoundReport } from '../services/Store'
import { ServerManager } from '../components/ServerManager'
import { requireSession } from '../middleware/session'
import { normalizeConVarValue, formatConVarCommand } from '../services/convars'
import { RateLimiter } from '../services/rateLimit'
import { NONCE, SIGNATURE_HEADER, signResponse } from '../services/signing'

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
const serverManager = (c: any, newToken?: { serverId: string, token: string }) => {
  c.header('Cache-Control', 'no-store')
  return c.html(<ServerManager servers={Store.getServers()} newToken={newToken} />)
}

api.get('/servers', async (c) => serverManager(c))

api.post('/servers', async (c) => {
  const { name } = await c.req.parseBody()
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) return serverManager(c)

  const { id, token } = Store.addServer(trimmed)
  Store.audit(id, c.get('adminId'), 'CREATE_SERVER', `Name: ${trimmed}`)
  return serverManager(c, { serverId: id, token })
})

api.post('/servers/:id/regenerate-token', async (c) => {
  const id = c.req.param('id')
  const token = Store.regenerateToken(id)
  if (!token) return c.json({ error: 'Server not found' }, 404)

  Store.audit(id, c.get('adminId'), 'REGEN_TOKEN')
  return serverManager(c, { serverId: id, token })
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
    const { team, isPolicingRole, baserole } = extracted
    const { schema, dropped } = dropUnsafeConVars(extracted.schema)
    if (dropped.length > 0) {
      console.warn(`[API] SECURITY ALERT: ${name} on ${server.name} declared ConVar names that are not plain identifiers; dropped: ${JSON.stringify(dropped)}`)
    }

    // Save to database via Store
    Store.saveSchema(server.id, name, team, isPolicingRole, baserole, schema, md5_hash)

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
const LANG_NAME = /^[A-Za-z0-9_.-]{1,64}$/
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
    if (!LANG_NAME.test(name) || typeof content !== 'string' || content.length > 1_000_000) {
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
const STEAM_ID = /^\d{5,20}$/
const ROUND_ID = /^[A-Za-z0-9-]{8,64}$/
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

  const report: RoundReport = {
    roundId: body.round_id,
    map: label(body.map),
    startedAt: label(body.started_at, 40),
    duration: whole(body.duration),
    result,
    players,
    deaths,
  }

  const stored = Store.recordRound(server.id, report)
  Store.updateHeartbeat(server.id)
  console.log(
    `[Stats] Round ${report.roundId} from ${server.name}: ${stored ? 'stored' : 'duplicate, ignored'} ` +
    `(map=${report.map}, result=${result}, ${players.length} players, ${deaths.length} deaths, ${report.duration ?? '?'}s)`
  )
  return c.json({ success: true, stored })
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
  
  const body = JSON.stringify({
    commands: commands.map(cmd => {
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
  })

  // A bridge that sends a nonce gets a signature it can verify before applying anything.
  // The key is the bearer token it just presented (only its hash is stored here).
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (typeof nonce === 'string' && NONCE.test(nonce)) {
    const token = c.req.header('Authorization')!.slice('Bearer '.length)
    headers[SIGNATURE_HEADER] = signResponse(token, nonce, body)
  } else if (!warnedNoNonce.has(server.id)) {
    // An older bridge never sends one; a current bridge should. Said once per server and process.
    warnedNoNonce.add(server.id)
    console.warn(`[API] Poll from ${server.name} has no valid nonce (nonce is ${typeof nonce}, body keys: ${Object.keys(parsed && typeof parsed === 'object' ? parsed : {}).join(',') || 'none'}), so the answer is unsigned`)
  }
  return c.body(body, 200, headers)
})

export default api
