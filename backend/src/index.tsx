import { trackConfig, parseLimit } from './services/tracks'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// Routes & Services
import api from './routes/api'
import auth from './routes/auth'
import { Store, viewLogDays } from './services/Store'
import { buildReplay } from './services/replay'
import { refreshAllWorkshopText } from './services/workshopText'
import { ReplayPage } from './components/ReplayPage'
import { VoicePage, VoiceEntryPage, VoiceCodePage } from './components/VoicePage'
import { getVoiceSession, getVoiceSessionVia } from './services/voiceSession'
import { joinToken, roomOf, voiceConfig, voiceHub } from './services/voice'
import { steamNames } from './services/steamNames'
import { gzipSync } from 'node:zlib'
import { getRolesWithState } from './services/roles'
import { getAdminId, getSession, openSignin, signinUrl, safeNext, type Session } from './middleware/session'
import { gated, clientAddress } from './services/gates'
import { RateLimiter } from './services/rateLimit'
import { createHash } from 'node:crypto'
import { buildRoleView, listRoles, parsePlayers, publicRoles, publicRoleSettings, roleColour, KNOWN_ROLE_NAME } from './services/roleview'
import { RoleListPage, RolePage, RoleNotFound } from './components/RolePublic'
import { HomePage } from './components/HomePage'
import { MapsPage, MapFilePage, MapViewPage, nextOf, type KillzonesView } from './components/MapPages'
import { isPid, steamIdOf } from './services/playerIds'
import { renderKillzonesSvg, squaresOf, hottest, storeysOf, baseOfMap, baseOfPlan, rootSizeOf, footprintOfMap, footprintOfPlan, listedStoreys } from './services/killzones'
import { flattened, storeyAt } from './maps/topdown'
import { NAME } from './services/validators'
import { geometryBuilding, geometryEnabled, kickGeometryQueue, setGeometryFetcher, setStockModels, setStockTextures } from './services/mapgeometry'
import { gameContent, gameContentEnabled } from './services/gameContent'
import { isPose, playerModel, setPlayerModelContent } from './services/playermodel'
import { helperAvailable, workshopFetcher } from './services/workshop'
import { sameOrigin } from './middleware/csrf'

// Components
import { AdminHomePage, ServersPage, ServerPage, RoleConfigPage, ViewLogPage, ServerSettingsPage } from './components/AdminPages'
import { RoleListPartial } from './components/Sidebar'
import { checkHealth, features, sourceHash } from './services/version'
import { StatsPage, RoundPage, PlayerPage } from './components/StatsPages'
import { NotFound } from './components/CaseFile'
import { adminOf, link, type Ctx } from './components/kit'
import { ctxOf, isEmbed, limited, respond, pageLimiter, pageHeaders } from './services/pages'
import { renderPlanSvg, planLevels, planFrame } from './services/mapplan'
import * as stats from './services/stats'
import { ROUND_ID, SMALL_INT } from './services/validators'

export const app = new Hono<{ Variables: { session: Session } }>()

// Expired and used pairing codes (RFC 9) are removed on startup and then hourly.
Store.cleanupPairingCodes()
setInterval(() => Store.cleanupPairingCodes(), 60 * 60_000).unref()

// Static Assets
// The scripts carry the version of the code in their address (`?v=`, CaseFile.tsx), so one with a version is kept for a week and is never asked for again;
// without one it is asked for each time. Sent gzipped where the browser accepts it (the map view is about 660 KB, a quarter of that compressed), once per file.
const publicGzip = new Map<string, Uint8Array>()
app.use('/public/*', async (c, next) => {
  await next()
  if (c.res.status !== 200) return
  c.res.headers.set('Cache-Control', c.req.query('v') ? 'public, max-age=604800, immutable' : 'no-cache')
  c.res.headers.set('Vary', 'Accept-Encoding')
  const type = c.res.headers.get('Content-Type') ?? ''
  if (!/\bgzip\b/.test(c.req.header('Accept-Encoding') ?? '') || !/javascript|css|json|svg/.test(type) || c.res.headers.has('Content-Encoding')) return
  const raw = new Uint8Array(await c.res.arrayBuffer())
  const key = `${c.req.path}\u0000${raw.length}\u0000${Bun.hash(raw).toString(36)}`
  let gz = publicGzip.get(key)
  if (!gz) { gz = gzipSync(raw); if (publicGzip.size >= 32) publicGzip.delete(publicGzip.keys().next().value!); publicGzip.set(key, gz) }
  const headers = new Headers(c.res.headers)
  headers.set('Content-Encoding', 'gzip')
  headers.delete('Content-Length')
  c.res = new Response(gz as Uint8Array<ArrayBuffer>, { status: 200, headers })
})
app.use('/public/*', serveStatic({ root: './src' }))
// The role pages' fonts (src/fonts, SIL OFL): public, and a file never changes under its name.
app.use('/fonts/*', async (c, next) => {
  await next()
  if (c.res.status === 200) {
    c.res.headers.set('Cache-Control', 'public, max-age=604800, immutable')
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
  }
})
app.use('/fonts/*', serveStatic({ root: './src' }))
app.use('*', sameOrigin)

// API & Auth Mounting
app.route('/api', api)
app.route('/auth', auth)

/** The server named in the address, with its id; null when there is none (the caller redirects home). */
const serverOf = (c: any) => {
  const serverId: string = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  return server ? { serverId, server } : null
}

/** What the page header needs to know about the viewer: admins get their links, other users their id. */
const identity = (session: { admin: boolean, steamId: string }) =>
  session.admin ? { steamId: session.steamId } : { user: session.steamId }

/** Where an anonymous visitor goes: through sign-in and back to `here` when that is open, else to `fallback`. */
const signinOr = (here: string, fallback: string) => (openSignin() ? signinUrl(here) : fallback)

/** A signed-in visitor who is not an admin (RFC 13): the header shows their SteamID64 and no admin links. */
const userOf = async (c: any): Promise<string | undefined> => {
  const session = await getSession(c)
  return session && !session.admin ? session.steamId : undefined
}

/**
 * Liveness and identity: which code is running. Unauthenticated on purpose (monitoring and
 * load balancers call it), so it carries no secrets, paths or error details.
 */
app.get('/health', async (c) => {
  const health = checkHealth()
  c.header('Cache-Control', 'no-store')
  return c.json({ ...health, features: await features() }, health.status === 'ok' ? 200 : 503)
})

/**
 * Sidebar Partial for HTMX Search
 */
app.get('/sidebar/:serverId', async (c) => {
  if (!(await getAdminId(c))) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId')
  const query = c.req.query('q') || ''
  const roles = getRolesWithState(serverId)
  
  const filteredRoles = query 
    ? roles.filter(r => r.role_name.toLowerCase().includes(query.toLowerCase()))
    : roles

  return c.html(<RoleListPartial serverId={serverId} roles={filteredRoles} />)
})

/**
 * Main Entry Point: Guest Tile View or Admin Dashboard
 */
app.get('/', async (c) => {
  const steamId = await getAdminId(c)
  const servers = Store.getServers()
  
  if (!steamId) {
    const ctx = await ctxOf(c)
    return respond(c, ctx, <HomePage ctx={ctx} servers={servers} />)
  }

  return c.html(<AdminHomePage steamId={steamId as string} servers={servers} />)
})

/**
 * Server Management CRUD Page
 */
app.get('/servers', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')
  
  const servers = Store.getServers()
  
  return c.html(<ServersPage steamId={steamId as string} servers={servers} />)
})

/**
 * Specific Server Dashboard (Role List)
 */
app.get('/servers/:serverId', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found

  const roles = getRolesWithState(serverId)

  return c.html(<ServerPage steamId={steamId as string} server={server} roles={roles} />)
})

/** Who opened which replay or 3D map (RFC 13, 6.3). Admins only. */
app.get('/servers/:serverId/views', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const player = c.req.query('player')
  const what = c.req.query('what')
  const who = player && isPid(player) ? steamIdOf(player) : null
  const action = what === 'replay' ? 'VIEW_REPLAY' as const : what === 'map' ? 'VIEW_MESH' as const : null
  const log = Store.getViews(serverId, { steamId: who ?? undefined, action: action ?? undefined })
  c.header('Cache-Control', 'no-store')
  // With the doctype: without it the browser's quirks mode gives a table the page's pale text colour on the cream card.
  return c.html('<!DOCTYPE html>' + (<ViewLogPage steamId={steamId as string} server={server} now={Date.now()}
    log={{ ...log, days: viewLogDays(), steamId: who, action }} />).toString())
})

/** Role name to `#rrggbb`, for the dots and bars. */
const colourMap = (serverId: string): Record<string, string> =>
  Object.fromEntries(Store.getRoles(serverId).map(r => [String(r.role_name), roleColour(r.color, String(r.team ?? ''))]))

/**
 * Round stats: overview, leaderboard, recent rounds. PUBLIC, like the server tiles: it is
 * only what happened in rounds (names and SteamID64s are public on Steam). The rule settings
 * stay admin-only. The same page serves the website and, with `?embed=1`, the game's window (RFC 16, 17).
 */
app.get('/servers/:serverId/stats', async (c) => {
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const ctx = await ctxOf(c)
  const over = limited(c)
  if (over) return over

  const requested = c.req.query('sort') as stats.SortKey
  const sort = stats.SORTS.includes(requested) ? requested : 'rounds'
  // Hidden switch for checking the bot test scenario: ?bots=1 includes bot-only rounds.
  const opts = { bots: c.req.query('bots') === '1', by: stats.parseBy(c.req.query('by')) }
  const view = ['leaders', 'weapons', 'rounds'].includes(c.req.query('view') ?? '') ? c.req.query('view') as 'leaders' | 'weapons' | 'rounds' : 'overview'
  const weaponSort = stats.parseWeaponSort(c.req.query('sort'))

  // the list of rounds is paged (a page a link, so the in-game browser follows it); the overview keeps its few
  const total = view === 'rounds' ? stats.countRounds(serverId, opts) : 0
  const pages = Math.max(1, Math.ceil(total / ROUNDS_PER_PAGE))
  const pageAsked = SMALL_INT.test(c.req.query('page') ?? '') ? Number(c.req.query('page')) : 1
  const page = Math.min(Math.max(1, pageAsked), pages)
  const recent = view === 'rounds' ? stats.getRecentRounds(serverId, opts, ROUNDS_PER_PAGE, (page - 1) * ROUNDS_PER_PAGE) : stats.getRecentRounds(serverId, opts)
  const admin = adminOf(ctx)
  return respond(c, ctx,
    <StatsPage ctx={ctx} server={server} view={view} sort={sort} bots={opts.bots} by={opts.by}
      overview={stats.getOverview(serverId, opts)} teams={stats.getTeamStats(serverId, opts)} roles={stats.getRoleStats(serverId, opts)}
      paging={view === 'rounds' ? { page, pages, total, perPage: ROUNDS_PER_PAGE } : undefined}
      coverage={stats.getEndStateCoverage(serverId, opts)} leaders={stats.getLeaderboard(serverId, sort, opts)} rounds={recent}
      weapons={view === 'weapons' ? stats.getWeaponStats(serverId, opts, weaponSort) : undefined} weaponSort={weaponSort}
      tracked={Store.getTrackedRounds(serverId, recent.map(r => r.roundId))} tracks={admin ? trackInfo(serverId) : undefined} colours={colourMap(serverId)} />,
    { scripts: admin })
})

const ROUNDS_PER_PAGE = 25

/** What a server keeps of position tracks, for the admin's card (RFC 12, 3.4). */
const trackInfo = (serverId: string) => {
  const cfg = Store.getTrackConfig()
  return { ...Store.getTrackUsage(serverId), botRounds: Store.countBotRounds(serverId), limits: Store.getTrackLimits(serverId), ceiling: { count: cfg.maxCount, mb: cfg.maxMb, pinned: cfg.maxPinned } }
}

/** How many position tracks a server keeps (RFC 12, 3.4). Admins only, audited. */
app.post('/servers/:serverId/tracks/limits', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId')
  if (!Store.getServerById(serverId)) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const cfg = Store.getTrackConfig()
  const count = parseLimit(String(form.count ?? ''), cfg.maxCount, 'The number of tracks')
  const mb = parseLimit(String(form.mb ?? ''), cfg.maxMb, 'The size')
  if (!count.ok) return c.text(count.error, 400)
  if (!mb.ok) return c.text(mb.error, 400)
  Store.setTrackLimits(serverId, count.value, mb.value)
  Store.audit(serverId, steamId, 'TRACK_LIMITS_CHANGED', `count=${count.value ?? 'default'} mb=${mb.value ?? 'default'}`)
  return c.redirect(`/servers/${serverId}/stats?view=rounds`)
})

/** Pins a round's track so the limits never remove it, or unpins it (RFC 12, 3.4). Admins only, audited. */
app.post('/servers/:serverId/rounds/:roundId/pin', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId'), roundId = c.req.param('roundId')
  const form = await c.req.parseBody()
  const pin = form.pin === '1'
  const result = Store.pinTrack(serverId, roundId, pin, steamId)
  if (result === 'none') return c.text('Not found', 404)
  if (result === 'max') return c.text(`This server already has ${Store.getTrackConfig().maxPinned} pinned tracks; unpin one first.`, 409)
  Store.audit(serverId, steamId, pin ? 'TRACK_PINNED' : 'TRACK_UNPINNED', roundId)
  return c.redirect(safeNext(String(form.next ?? '')) ?? `/servers/${serverId}/stats?view=rounds`)
})

/**
 * Deletes a round's replay (`what=replay`: the round stays in the statistics) or the whole round with its
 * replay (`what=round`). Admins only, audited, and a pinned track goes too: asking for it is the decision.
 */
app.post('/servers/:serverId/rounds/:roundId/delete', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId'), roundId = c.req.param('roundId')
  if (!Store.getServerById(serverId)) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const what = form.what
  if (what !== 'replay' && what !== 'round') return c.text('what must be replay or round', 400)
  const done = what === 'replay' ? Store.deleteTrack(serverId, roundId) : Store.deleteRound(serverId, roundId)
  if (!done) return c.text('Not found', 404)
  Store.audit(serverId, steamId, what === 'replay' ? 'TRACK_DELETED' : 'ROUND_DELETED', roundId)
  return c.redirect(`/servers/${serverId}/stats?view=rounds${c.req.query('bots') === '1' ? '&bots=1' : ''}`)
})

/** Deletes the rounds ticked on the stats page (`round`, at most 100), each with its replay. Admins only, audited per round. */
app.post('/servers/:serverId/rounds/delete-selected', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId')
  if (!Store.getServerById(serverId)) return c.text('Not found', 404)
  const form = await c.req.parseBody({ all: true })
  const asked = [form.round].flat().filter((v): v is string => typeof v === 'string')
  if (asked.length === 0) return c.text('No round was selected', 400)
  if (asked.length > 100) return c.text('At most 100 rounds at a time', 400)
  if (!asked.every(id => ROUND_ID.test(id))) return c.text('Invalid round id', 400)
  const gone = Store.deleteRounds(serverId, [...new Set(asked)])
  for (const id of gone) Store.audit(serverId, steamId, 'ROUND_DELETED', id)
  return c.redirect(`/servers/${serverId}/stats?view=rounds${form.bots === '1' ? '&bots=1' : ''}`)
})

/** Deletes every round only test bots played in, with their replays. Admins only, audited. */
app.post('/servers/:serverId/rounds/delete-bots', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  const serverId = c.req.param('serverId')
  if (!Store.getServerById(serverId)) return c.text('Not found', 404)
  const n = Store.deleteBotRounds(serverId)
  Store.audit(serverId, steamId, 'BOT_ROUNDS_DELETED', `${n} rounds`)
  return c.redirect(`/servers/${serverId}/stats?view=rounds`)
})

/** The maps the server has and which of them it will play (RFC 10). Public, like the stats. */
app.get('/servers/:serverId/maps', async (c) => {
  const steamId = await getAdminId(c)

  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const ctx = await ctxOf(c)
  const over = limited(c)
  if (over) return over

  const { state, maps } = Store.getMaps(serverId)
  const admin = adminOf(ctx)
  // The 3D view is for signed-in users (RFC 13); an anonymous visitor is offered it only when sign-in is open.
  const meshes = geometryEnabled() && (ctx.viewer || ctx.signinOpen)
    ? new Set([...Store.getGeometryStates(serverId)].filter(([, g]) => g.status === 'parsed').map(([name]) => name))
    : undefined
  return respond(c, ctx,
    <MapsPage ctx={ctx} server={server} state={state} maps={maps} activity={stats.getMapActivity(serverId)} showAll={admin && c.req.query('all') === '1'}
      plans={admin ? Store.getMapPlans(serverId) : undefined} meshes={meshes} viewLogDays={viewLogDays()}
      progress={admin && geometryEnabled() ? { ...Store.getGeometryProgress(), building: geometryBuilding() } : undefined}
      meshStates={admin && geometryEnabled() ? { states: new Map([...Store.getGeometryStates(serverId)].map(([name, g]) => [name, { status: g.status, version: g.version }])), wanted: Store.wantedMeshVersion(), building: geometryBuilding() } : undefined} />)
})

const geometryProp = (serverId: string, name: string) => {
  const g = Store.getGeometryStates(serverId).get(name)
  return g ? { requested: true, ...g } : { requested: false }
}

/**
 * One map (RFC 10, 4.5). An admin sees its floor plan and the geometry switch; a signed-in user
 * (RFC 13) sees the 3D view, when the map has one; an anonymous visitor is sent to sign-in when
 * sign-in is open, and back to the list when it is not.
 */
app.get('/servers/:serverId/maps/:map', async (c) => {
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const name = c.req.param('map')
  const ctx = await ctxOf(c)
  const file = link(ctx, `/servers/${serverId}/maps/${encodeURIComponent(name)}/rounds`)
  // In the game nobody is sent to the Steam login: without a session the map's rounds page is the answer.
  if (!ctx.viewer) return c.redirect(ctx.embed ? file : signinOr(`/servers/${serverId}/maps/${encodeURIComponent(name)}`, `/servers/${serverId}/maps`))
  const over = limited(c)
  if (over) return over

  const { state, maps } = Store.getMaps(serverId)
  const map = maps.find(m => m.name === name) ?? null
  const grid = Store.getMapPlan(serverId, name)
  if (!map && !grid) return c.redirect(link(ctx, `/servers/${serverId}/maps`))

  const admin = adminOf(ctx)
  const g = Store.getGeometryStates(serverId).get(name)
  if (!admin && (!geometryEnabled() || g?.status !== 'parsed')) return c.redirect(ctx.embed ? file : `/servers/${serverId}/maps`) // nothing for a plain user to see

  const meta = admin ? Store.getMapPlans(serverId).find(p => p.map === name) : undefined
  const plan = meta && grid ? { ...meta, levels: planLevels(JSON.parse(grid)), frame: planFrame(JSON.parse(grid)) } : null
  const hasView = geometryEnabled() && g?.status === 'parsed'
  return respond(c, ctx,
    <MapViewPage ctx={ctx} server={server} map={map} name={name} next={nextOf(state)} plan={plan}
      geometry={geometryEnabled() && map ? geometryProp(serverId, name) : undefined} />,
    { scripts: hasView })
})

/**
 * The killzone picture and its numbers (RFC 21, 4.4). Under the deaths goes the map's own geometry, flattened, for a
 * signed-in visitor (that includes a player in the game, whom the server vouches for, RFC 16; it is logged like a 3D
 * view), else an admin's floor plan, else nothing: an anonymous visitor sees the deaths only. `weapon` and `level` are
 * checked before they are used; one that does not fit is ignored.
 */
async function killzonesOf(serverId: string, map: string, ctx: Ctx, weaponAsked?: string, levelAsked?: string): Promise<KillzonesView> {
  const weapon = weaponAsked && NAME.test(weaponAsked) ? weaponAsked : null
  const k = stats.getKillzones(serverId, map, undefined, weapon)
  const asked = levelAsked !== undefined && SMALL_INT.test(levelAsked) ? Number(levelAsked) : undefined

  // the map's own area decides how coarse the squares start (RFC 21, 11.2); it is only a number, so the mesh is read for it for every visitor
  // and the plan too, but they are drawn only for the visitors that may see them
  const meshAny = geometryEnabled() ? Store.getMesh(serverId, map) : null
  const flatAny = meshAny ? await flattened(meshAny) : null
  const planAny = Store.getMapPlan(serverId, map)
  const gridAny = planAny ? JSON.parse(planAny) : null
  const root = rootSizeOf(flatAny ? footprintOfMap(flatAny) : gridAny ? footprintOfPlan(gridAny) : null)

  const flat = ctx.viewer ? flatAny : null
  const plan = !flat && adminOf(ctx) ? planAny : null
  const grid = plan ? JSON.parse(plan) : null
  const storeys = !flat && grid ? storeysOf(grid) : null

  // the storeys a player can get to (RFC 21, 12): the mesh cuts a storey from every height that has a floor, also a plate under the map
  const listed = flatAny ? listedStoreys(flatAny, stats.getDeathPoints(serverId, map)) : null
  const levelList = flat ? listed! : storeys ? storeys.levels.map((_: unknown, i: number) => i + 1) : undefined
  const level = asked !== undefined && levelList?.includes(asked) ? asked : undefined
  const pick = level === undefined ? undefined
    : flat ? (z: number, x: number, y: number) => storeyAt(flat, x, y, z) === level
    : storeys ? (z: number) => storeys.storeyOf(z) === level - 1 : undefined
  const squares = squaresOf(k.cells, root, pick)
  const base = flat ? baseOfMap(flat, level, listed!) : grid ? baseOfPlan(grid, level) : undefined
  if (flat && ctx.viewer) Store.logView(serverId, ctx.viewer.steamId, 'VIEW_MESH', map)
  return {
    svg: renderKillzonesSvg(squares, map, base), deaths: squares.reduce((n, s) => n + s.n, 0), rounds: k.rounds, hot: hottest(squares), weapons: k.weapons, weapon,
    level, levelList, under: flat ? 'map' : grid ? 'plan' : null,
    sizes: squares.length > 0 ? { min: Math.min(...squares.map(q => q.size)), max: Math.max(...squares.map(q => q.size)) } : null,
  }
}

/** What the rounds on one map say, and the way to its own view (RFC 16, 17). Public, like the stats it is made of. */
app.get('/servers/:serverId/maps/:map/rounds', async (c) => {
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const ctx = await ctxOf(c)
  const over = limited(c)
  if (over) return over
  const name = c.req.param('map')
  const { state, maps } = Store.getMaps(serverId)
  const map = maps.find(m => m.name === name) ?? null
  const activity = stats.getMapActivity(serverId).get(name) ?? null
  if (!map && !activity) return respond(c, ctx, <NotFound what="map" embed={ctx.embed} viewer={ctx.viewer} />, { status: 404 })
  const has3d = geometryEnabled() && Store.getGeometryStates(serverId).get(name)?.status === 'parsed'
  const hasPlan = adminOf(ctx) && Store.getMapPlans(serverId).some(p => p.map === name)
  return respond(c, ctx, <MapFilePage ctx={ctx} server={server} name={name} map={map} state={state} activity={activity} has3d={has3d} hasPlan={hasPlan} viewLogDays={viewLogDays()}
    killzones={await killzonesOf(serverId, name, ctx, c.req.query('weapon'), c.req.query('level'))} />)
})

/** A stored floor plan drawn as a picture (RFC 10, 4.5). Admins only; nothing in it can run or load anything. */
app.get('/servers/:serverId/maps/:map/plan.svg', async (c) => {
  if (!(await getAdminId(c))) return c.text('Unauthorized', 401)
  const map = c.req.param('map')
  const plan = Store.getMapPlan(c.req.param('serverId'), map)
  if (!plan) return c.text('Not found', 404)
  const grid = JSON.parse(plan)
  // ?level=<n> picks one storey (1 is the lowest); without it, every floor is drawn.
  const asked = c.req.query('level')
  let level: number | undefined
  if (asked !== undefined) {
    level = SMALL_INT.test(asked) ? Number(asked) : 0
    if (level < 1 || level > planLevels(grid).length) return c.text('Not found', 404)
  }
  const svg = renderPlanSvg(grid, map, level)
  if (!svg) return c.text('This plan is too large to draw; download the JSON instead.', 422)
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
})

/** A stored floor plan as JSON (RFC 10, 4.5). Admins only. */
app.get('/servers/:serverId/maps/:map/plan.json', async (c) => {
  if (!(await getAdminId(c))) return c.text('Unauthorized', 401)
  const plan = Store.getMapPlan(c.req.param('serverId'), c.req.param('map'))
  if (!plan) return c.text('Not found', 404)
  c.header('Cache-Control', 'no-store')
  return c.body(plan, 200, { 'Content-Type': 'application/json' })
})

/** Exact geometry on or off for one map (RFC 11, 3.1). Admins only; the operator switch must be on. */
app.post('/servers/:serverId/maps/:map/geometry', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.text('Unauthorized', 401)
  if (!geometryEnabled()) return c.text('Not found', 404)
  const serverId = c.req.param('serverId'), name = c.req.param('map')
  const { maps } = Store.getMaps(serverId)
  if (!maps.some(m => m.name === name)) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const on = form.on === '1'
  Store.setGeometryRequested(serverId, name, on, steamId)
  Store.audit(serverId, steamId, on ? 'MAP_GEOMETRY_REQUESTED' : 'MAP_GEOMETRY_WITHDRAWN', name)
  if (on) kickGeometryQueue()
  return c.redirect(`/servers/${serverId}/maps/${encodeURIComponent(name)}`)
})

/**
 * The map's mesh as a GLB (RFC 11, 3.6): for signed-in users (RFC 13), counted per account, and
 * every open is logged once an hour. The body is a binary glTF the page loads into a viewer; it is
 * never rendered as a page.
 */
// The compressed mesh of each recent version, so a large GLB is compressed once and not on every view.
const meshGzip = new Map<string, Uint8Array>()
app.get('/servers/:serverId/maps/:map/mesh.glb', gated('mesh'), async (c) => {
  const serverId = c.req.param('serverId'), map = c.req.param('map')
  const mesh = Store.getMesh(serverId, map)
  if (!mesh) return c.text('Not found', 404)
  Store.logView(serverId, c.get('session').steamId, 'VIEW_MESH', map)
  // The mesh only changes with the map or the code that builds it, so it is kept by the browser and asked for again each time (an ETag answers with a few bytes);
  // private, since it is for signed-in users. The access check and the view log above still run on every view.
  const etag = `"${Bun.hash(mesh).toString(36)}-${mesh.length}"`
  const headers: Record<string, string> = {
    'Content-Type': 'model/gltf-binary',
    ETag: etag,
    'Cache-Control': 'private, no-cache',
    Vary: 'Accept-Encoding, Cookie',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  }
  const given = c.req.header('If-None-Match')
  if (given && given.split(',').map(x => x.trim()).includes(etag)) return c.body(null, 304, headers)
  if (/\bgzip\b/.test(c.req.header('Accept-Encoding') ?? '')) {
    let gz = meshGzip.get(etag)
    if (!gz) {
      gz = gzipSync(mesh)
      if (meshGzip.size >= 8) meshGzip.delete(meshGzip.keys().next().value!)
      meshGzip.set(etag, gz)
    }
    return c.body(gz as Uint8Array<ArrayBuffer>, 200, { ...headers, 'Content-Encoding': 'gzip' })
  }
  return c.body(mesh as Uint8Array<ArrayBuffer>, 200, headers)
})

/**
 * The player model of the replay (RFC 22): one neutral stock model as a GLB, with its walking, running and crouching clips (or, with ?pose=, still). For signed-in users like the map's
 * mesh. 404 when the game's files are not switched on or the model could not be built; the replay then draws its box figure.
 */
app.get('/servers/:serverId/playermodel.glb', gated('mesh'), async (c) => {
  if (!Store.getServerById(c.req.param('serverId'))) return c.text('Not found', 404)
  // Moving by default; `?pose=stand|crouch` is the still model of one pose
  const pose = c.req.query('pose') ?? 'moving'
  if (pose !== 'moving' && !isPose(pose)) return c.text('Not found', 404)
  const glb = await playerModel(pose)
  if (!glb) return c.text('Not found', 404)
  return c.body(glb as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'model/gltf-binary',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'private, max-age=86400',
  })
})

/**
 * The data of one round's replay (RFC 12, 3.5): its players, its track and the best background for
 * its map, as one JSON document. For signed-in users (RFC 13), counted per account, logged once an
 * hour per user and round. A track never changes, so the answer carries an ETag and is cached by
 * the browser (privately: the answer is for a signed-in user); it is sent compressed.
 */
app.get('/servers/:serverId/rounds/:roundId/track.json', gated('track'), async (c) => {
  const serverId = c.req.param('serverId'), roundId = c.req.param('roundId')
  const opts = { bots: c.req.query('bots') === '1' }
  // the storeys the bar offers are the ones a player can get to (RFC 21, 12)
  const map = stats.getReplayRound(serverId, roundId, opts)?.map
  const mesh = map && geometryEnabled() ? Store.getMesh(serverId, map) : null
  const flat = mesh ? await flattened(mesh) : null
  const found = buildReplay(serverId, roundId, opts, flat && map ? listedStoreys(flat, stats.getDeathPoints(serverId, map)) : null)
  if (!found) return c.json({ error: 'No track for this round' }, 404)
  Store.logView(serverId, c.get('session').steamId, 'VIEW_REPLAY', roundId)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ETag: found.etag,
    // asked again each time (an ETag answers with a few bytes): the payload names the player model and so changes with the code, not only with the round
    'Cache-Control': 'private, no-cache',
    Vary: 'Accept-Encoding, Cookie',
    'X-Content-Type-Options': 'nosniff',
  }
  const given = c.req.header('If-None-Match')
  if (given && given.split(',').map(s => s.trim()).includes(found.etag)) return c.body(null, 304, headers)
  const json = JSON.stringify(found.payload)
  if (/\bgzip\b/.test(c.req.header('Accept-Encoding') ?? '')) {
    return c.body(gzipSync(json) as unknown as Uint8Array<ArrayBuffer>, 200, { ...headers, 'Content-Encoding': 'gzip' })
  }
  return c.body(json, 200, headers)
})

/** One round as a file: who played what, how it ended, first blood, and the way to its replay (RFC 16, 17). Public. */
app.get('/servers/:serverId/rounds/:roundId', async (c) => {
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const ctx = await ctxOf(c)
  const over = limited(c)
  if (over) return over
  const roundId = c.req.param('roundId')
  const bots = c.req.query('bots') === '1'
  const round = ROUND_ID.test(roundId) ? stats.getReplayRound(serverId, roundId, { bots }) : null
  if (!round) return respond(c, ctx, <NotFound what="round" embed={ctx.embed} viewer={ctx.viewer} />, { status: 404 })
  return respond(c, ctx, <RoundPage ctx={ctx} server={server} round={round} deaths={stats.getDeathCount(serverId, roundId)} firstBlood={stats.getFirstBlood(serverId, roundId)}
    hasReplay={Store.getTrackedRounds(serverId, [roundId]).has(roundId)} colours={colourMap(serverId)} bots={bots} />)
})

/** One round's replay page (RFC 12, 3.5). For signed-in users; an anonymous visitor is sent to sign-in and back (RFC 13). */
app.get('/servers/:serverId/rounds/:roundId/replay', async (c) => {
  const roundId = c.req.param('roundId')
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  const ctx = await ctxOf(c)
  const bots = c.req.query('bots') === '1'
  const query = bots ? '?bots=1' : ''
  const here = `/servers/${serverId}/rounds/${encodeURIComponent(roundId)}/replay${query}`
  const toStats = link(ctx, `/servers/${serverId}/stats`, { view: ctx.embed ? 'rounds' : undefined })
  // In the game nobody is sent to the Steam login: without a session the round's own page is the answer.
  if (!ctx.viewer) return c.redirect(ctx.embed ? link(ctx, `/servers/${serverId}/rounds/${encodeURIComponent(roundId)}`) : signinOr(here, toStats))
  const over = limited(c)
  if (over) return over

  const round = stats.getReplayRound(serverId, roundId, { bots })
  if (!round) return c.redirect(toStats)
  const track = Store.getTrack(serverId, roundId)
  return respond(c, ctx,
    <ReplayPage ctx={ctx} server={server} round={{ id: round.roundId, map: round.map, result: round.result, duration: round.duration }}
      hasTrack={!!track} src={`/servers/${serverId}/rounds/${encodeURIComponent(roundId)}/track.json${query}`}
      pinned={!!track?.meta.pinned} here={here} bots={bots} counts={{ players: round.players.length, deaths: stats.getDeathCount(serverId, roundId) }}
      pinnedCount={adminOf(ctx) ? { used: Store.getTrackUsage(serverId).pinned, max: Store.getTrackConfig().maxPinned } : undefined} />,
    { scripts: !!track })
})

/**
 * The short address (RFC 31, 10): a code typed here goes to the voice page of the server that issued it (POST /auth/voice-code). Nothing
 * here names a server, so nothing says whether one exists or has voice; without a media server the dashboard has no codes at all.
 */
app.get('/voice', async (c) => {
  const ctx = await ctxOf(c)
  if (!voiceConfig() || ctx.embed) return c.redirect('/')
  const over = limited(c)
  if (over) return over
  return respond(c, ctx, <VoiceCodePage ctx={ctx} failed={c.req.query('code') === 'failed'} />, { noStore: true })
})

/** The voice page (RFC 27): signed-in users only; in the game nobody is sent to the Steam login. */
app.get('/servers/:serverId/voice', async (c) => {
  const found = serverOf(c)
  if (!found) return c.redirect('/')
  const { serverId, server } = found
  // The real session, the game's, or the voice cookie a code from the game gave (RFC 31): this page and its two data routes are the only readers of that cookie.
  const via = await getVoiceSessionVia(c)
  const ctx = await ctxOf(c, via)
  const here = `/servers/${serverId}/voice`
  const cfg = voiceConfig()
  if (!ctx.viewer) {
    // Nobody is sent to Steam from here: the code form is the answer, with the Steam sign-in as the other way in. Without a media server there is nothing to join.
    if (!cfg || ctx.embed) return c.redirect(signinOr(here, `/servers/${serverId}/stats`))
    const over = limited(c)
    if (over) return over
    return respond(c, ctx, <VoiceEntryPage ctx={ctx} server={server} failed={c.req.query('code') === 'failed'} signin={signinUrl(here)} />, { noStore: true })
  }
  const over = limited(c)
  if (over) return over
  // The page may reach the media server and nothing else besides this site (the policy of every page names what it may connect to), and may
  // compile WebAssembly (the noise filter, RNNoise); no other page may.
  return respond(c, ctx, <VoicePage ctx={ctx} server={server} enabled={!!cfg} forget={via.viaCookie} />, { scripts: !!cfg, wasm: !!cfg, connect: cfg ? [cfg.url, cfg.url.replace(/^ws/i, 'http')] : [], noStore: true })
})

// What the room shows for each player follows what the dashboard knows (RFC 28): the game's nick, a round's, Steam's. Only players who are on the voice chat are asked about.
voiceHub.setNameResolver((serverId, id) => voiceHub.nameOf(serverId, id) ?? Store.getNick(serverId, id) ?? steamNames.names([id]).get(id) ?? null)

export const voiceTokenLimiter = new RateLimiter(20, 60_000)

/** A token to join the server's voice room as the signed-in player (their SteamID64 is their name there, which is how the rules find them). */
app.post('/servers/:serverId/voice/token', async (c) => {
  const session = await getVoiceSession(c)
  if (!session) return c.json({ error: 'Sign-in required', signin: '/auth/steam' }, 401)
  const serverId = c.req.param('serverId')
  if (!Store.getServerById(serverId)) return c.json({ error: 'Not found' }, 404)
  const cfg = voiceConfig()
  if (!cfg) return c.json({ error: 'Voice chat is not set up' }, 503)
  if (voiceTokenLimiter.hit(session.steamId) > 0) return c.json({ error: 'Too many requests; slow down' }, 429)
  voiceHub.watch(serverId)
  return c.json({ url: cfg.url, token: joinToken(cfg, roomOf(serverId), session.steamId, (voiceHub.nameOf(serverId, session.steamId) ?? Store.getNick(serverId, session.steamId) ?? steamNames.names([session.steamId]).get(session.steamId) ?? session.steamId).slice(0, 64)) })
})

export const voicePeopleLimiter = new RateLimiter(60, 60_000)

/** Who is on the server's voice chat now (RFC 27, 7): for the count and the names the page shows before a player has joined. Not who is alive. */
app.get('/servers/:serverId/voice/people', async (c) => {
  const session = await getVoiceSession(c)
  if (!session) return c.json({ error: 'Sign-in required', signin: '/auth/steam' }, 401)
  const serverId = c.req.param('serverId')
  if (!Store.getServerById(serverId)) return c.json({ error: 'Not found' }, 404)
  if (!voiceConfig()) return c.json({ error: 'Voice chat is not set up' }, 503)
  if (voicePeopleLimiter.hit(session.steamId) > 0) return c.json({ error: 'Too many requests; slow down' }, 429)
  const list = await voiceHub.people(serverId)
  c.header('Cache-Control', 'no-store')
  // The order of RFC 28, 2: what the media server holds (fixed when the person joined), the game now, the last round, Steam, the SteamID64.
  // Steam is asked (in the background) only for the people on this list that the first ones do not know.
  const known = list.map(p => p.name && p.name !== p.id ? p.name : voiceHub.nameOf(serverId, p.id) ?? Store.getNick(serverId, p.id))
  const fromSteam = steamNames.names(list.filter((_, i) => known[i] === null).map(p => p.id))
  return c.json({ people: list.map((p, i) => ({ id: p.id, name: (known[i] ?? fromSteam.get(p.id) ?? p.id).slice(0, 64) })) })
})

app.get('/servers/:serverId/players/:playerId', async (c) => {
  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  const by = stats.parseBy(c.req.query('by'))
  const asked = c.req.param('playerId')
  const steamId = isPid(asked) ? steamIdOf(asked) : null
  const player = server && steamId && stats.getPlayer(serverId, steamId, { by })
  const bots = c.req.query('bots') === '1'
  const ctx = await ctxOf(c)
  if (!server || !player || (stats.isBotId(player.steamId) && !bots)) return c.redirect(link(ctx, `/servers/${serverId}/stats`))
  const over = limited(c)
  if (over) return over
  return respond(c, ctx, <PlayerPage ctx={ctx} server={server} player={player} by={by} bots={bots} weapons={stats.getPlayerWeapons(serverId, player.steamId)} />)
})

/**
 * The public, read-only role pages (RFC 15). Script-free, with a strict Content-Security-Policy,
 * limited per client address, and answered from a small cache that is keyed by what the page is
 * built from, so a flood of identical requests costs a lookup and a change shows at once.
 */
export const resetRolePages = () => { pageLimiter.reset(); rolePageCache.clear() }
const rolePageCache = new Map<string, string>()
const ROLE_PAGE_CACHE_MAX = 500
const ROLE_PAGE_HEADERS = pageHeaders()

async function rolePage(c: any, kind: 'list' | 'role') {
  const session = await getSession(c)
  const admin = !!session?.admin
  if (!publicRoles() && !admin) return c.redirect('/')

  const address = clientAddress(c)
  const wait = address ? pageLimiter.hit(address) : 0
  if (wait > 0) {
    c.header('Retry-After', String(wait))
    return c.text('Too many requests; slow down', 429, ROLE_PAGE_HEADERS)
  }

  const serverId = c.req.param('serverId')
  const embed = ['1', 'true'].includes(c.req.query('embed') ?? '')
  // The header says who is signed in. The game's window (embed) has no header, so its page stays the same for everyone.
  const viewer = !embed && session ? { steamId: session.steamId, admin: session.admin } : null
  const server = Store.getServerById(serverId)
  const roleName = kind === 'role' ? c.req.param('roleName') : ''
  const missing = !server || (kind === 'role' && (!KNOWN_ROLE_NAME.test(roleName) || !Store.getRoles(serverId).some(r => r.role_name === roleName)))
  const headers: Record<string, string> = { ...ROLE_PAGE_HEADERS }
  if (embed) headers['X-Robots-Tag'] = 'noindex'
  if (missing) {
    headers['Cache-Control'] = 'no-store'
    return c.html('<!DOCTYPE html>' + (<RoleNotFound embed={embed} viewer={viewer} />).toString(), 404, headers)
  }

  const showAdmin = admin && !embed
  const query = kind === 'list' ? (c.req.query('q') ?? '').slice(0, 64) : ''
  const players = parsePlayers(c.req.query('players'))
  const key = [serverId, kind, roleName, query, players, embed, showAdmin, viewer ? viewer.steamId : '', publicRoleSettings(), Store.getRoleDataVersion(serverId)].join('\u0000')
  const etag = 'W/"' + createHash('sha1').update(key).digest('hex').slice(0, 20) + '"'
  // The page differs for an admin (the edit link) and for anyone signed in (the header), so those are not shared; the
  // one for a visitor who is not signed in is, and a shared cache must not hand it to someone who is.
  headers['Cache-Control'] = showAdmin || viewer ? 'private, max-age=0, must-revalidate' : 'public, max-age=60'
  headers.Vary = 'Cookie'
  headers.ETag = etag
  const given = c.req.header('If-None-Match')
  if (given && given.split(',').map((x: string) => x.trim()).includes(etag)) return c.body(null, 304, headers)

  let html = rolePageCache.get(key)
  if (html === undefined) {
    const srv = { id: server!.id, name: server!.name }
    const view = kind === 'role' ? buildRoleView(serverId, roleName) : null
    const page = kind === 'list'
      ? <RoleListPage server={srv} roles={listRoles(serverId, query)} query={query} embed={embed} admin={showAdmin} viewer={viewer} players={players} />
      : <RolePage server={srv} role={view!} embed={embed} admin={showAdmin} viewer={viewer} players={players} />
    html = '<!DOCTYPE html>' + page.toString()
    if (rolePageCache.size >= ROLE_PAGE_CACHE_MAX) rolePageCache.delete(rolePageCache.keys().next().value!)
    rolePageCache.set(key, html)
  }
  return c.html(html, 200, headers)
}

app.get('/servers/:serverId/roles', (c) => rolePage(c, 'list'))
app.get('/servers/:serverId/roles/:roleName', (c) => rolePage(c, 'role'))

/**
 * Specific Role Configuration Page (admin). It used to be at the role's own address, which is the
 * read-only page now (RFC 15).
 */
app.get('/servers/:serverId/roles/:roleName/config', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const roleName = c.req.param('roleName')
  
  const server = Store.getServerById(serverId)
  const schema = Store.getSchema(serverId, roleName)
  const roles = getRolesWithState(serverId)
  
  if (!server || !schema) return c.redirect('/')
  
  return c.html(<RoleConfigPage steamId={steamId as string} server={server} roleName={roleName} roles={roles} schema={schema} live={Store.getConVarValues(serverId)} onlineAdmins={Store.getOnlineAdmins(serverId)} />)
})

// The settings of a server (RFC 23): the bridge's own and the dashboard's, on one page. Admins only.
app.get('/servers/:serverId/settings', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')
  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')
  const got = Store.getBridgeSettings(serverId)
  c.header('Cache-Control', 'no-store')
  return c.html(<ServerSettingsPage steamId={steamId as string} server={server} roles={getRolesWithState(serverId)} storage={trackInfo(serverId)} mapCooldown={Store.getMapCooldown(serverId)}
    state={{ reportedAt: got?.reportedAt ?? null, values: got?.values ?? {}, pending: Store.pendingBridgeSettings(serverId) }} onlineAdmins={Store.getOnlineAdmins(serverId)} />)
})
// The page was the bridge's settings alone at first: its old address goes to the page that has them all.
app.get('/servers/:serverId/bridge', async (c) => {
  if (!(await getAdminId(c))) return c.redirect('/')
  return c.redirect(`/servers/${c.req.param('serverId')}/settings`, 301)
})

// Pelican hands the allocated port over as SERVER_PORT.
const port = Number(process.env.SERVER_PORT || process.env.PORT) || 3000

// The Pelican egg marks the server as "running" when it sees this exact line (see
// pelican/egg-traitordash.json). Bun's own "Started development server" message is only
// printed in development mode, so with NODE_ENV=production the panel would wait forever.
export const STARTUP_LOG_LINE = '[TraitorDash] Listening on port'

// The server itself starts once this module has finished loading (default export below),
// so the line is logged right after, and only when run as the program (not by the tests).
if (import.meta.main) {
  setTimeout(() => console.log(`${STARTUP_LOG_LINE} ${port} (source ${sourceHash()})`), 0)
  if (geometryEnabled()) {
    setGeometryFetcher(workshopFetcher())
    if (gameContentEnabled()) {
      const content = gameContent()
      setStockModels(content.models)
      setStockTextures(content.textures)
      setPlayerModelContent(content)
      console.log(`[Geometry] The game's own models are fetched on demand into ${content.root}.`)
    }
    helperAvailable().then(ok => console.log(ok
      ? '[Geometry] Exact map geometry is on.'
      : '[Geometry] MAP_GEOMETRY=1, but the download helper (DepotDownloader) was not found; requested maps will fail. Set DEPOTDOWNLOADER_PATH.'))
  }
  Store.resetStaleGeometry()
  kickGeometryQueue()
  try { Store.setTrackConfig(trackConfig()) } catch (e) {
    console.error(`[Track] ${(e as Error).message}`)
    process.exit(1)
  }
  Store.enforceAllTrackLimits()
  // Voice chat (RFC 27): the loop that keeps the media server's subscriptions in step with the round. Idle until a player joins.
  if (voiceConfig()) {
    voiceHub.start()
    console.log('[Voice] Voice chat is on.')
  }
  // Views of gated content are kept for VIEW_LOG_DAYS (RFC 13, 6.3): cleaned now and once a day.
  Store.cleanupViewLog()
  setInterval(() => Store.cleanupViewLog(), 24 * 3600 * 1000).unref()
  // The Workshop pages of the roles' addons (RFC 15): read soon after start, then daily; never in the way of the start.
  setTimeout(() => { void refreshAllWorkshopText() }, 5000).unref()
  setInterval(() => { void refreshAllWorkshopText() }, 24 * 3600 * 1000).unref()
}

export default {
  port,
  hostname: '0.0.0.0',
  // Bun's default is 128MB. The biggest legitimate body is the language-file push.
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: app.fetch
}
