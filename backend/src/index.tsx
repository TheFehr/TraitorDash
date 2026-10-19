import { trackConfig, parseLimit } from './services/tracks'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// Routes & Services
import api from './routes/api'
import auth from './routes/auth'
import { Store, viewLogDays } from './services/Store'
import { buildReplay } from './services/replay'
import { ReplayPage } from './components/ReplayPage'
import { gzipSync } from 'node:zlib'
import { getRolesWithState } from './services/roles'
import { getAdminId, getSession, openSignin, signinUrl, safeNext, type Session } from './middleware/session'
import { gated } from './services/gates'
import { geometryEnabled, kickGeometryQueue, setGeometryFetcher } from './services/mapgeometry'
import { helperAvailable, workshopFetcher } from './services/workshop'
import { sameOrigin } from './middleware/csrf'

// Components
import { Layout } from './components/Layout'
import { ServerTileView } from './components/ServerTileView'
import { AdminDashboard } from './components/AdminDashboard'
import { ServerDashboard } from './components/ServerDashboard'
import { RoleConfigForm } from './components/RoleConfigForm'
import { ServerManager } from './components/ServerManager'
import { Sidebar, RoleListPartial } from './components/Sidebar'
import { checkHealth, sourceHash } from './services/version'
import { StatsDashboard, PlayerStats } from './components/StatsDashboard'
import { MapsDashboard, MapPage } from './components/MapsDashboard'
import { renderPlanSvg, planLevels } from './services/mapplan'
import * as stats from './services/stats'

export const app = new Hono<{ Variables: { session: Session } }>()

// Expired and used pairing codes (RFC 9) are removed on startup and then hourly.
Store.cleanupPairingCodes()
setInterval(() => Store.cleanupPairingCodes(), 60 * 60_000).unref()

// Static Assets
app.use('/public/*', serveStatic({ root: './src' }))
app.use('*', sameOrigin)

// API & Auth Mounting
app.route('/api', api)
app.route('/auth', auth)

/** A signed-in visitor who is not an admin (RFC 13): the header shows their SteamID64 and no admin links. */
const userOf = async (c: any): Promise<string | undefined> => {
  const session = await getSession(c)
  return session && !session.admin ? session.steamId : undefined
}

/**
 * Liveness and identity: which code is running. Unauthenticated on purpose (monitoring and
 * load balancers call it), so it carries no secrets, paths or error details.
 */
app.get('/health', (c) => {
  const health = checkHealth()
  c.header('Cache-Control', 'no-store')
  return c.json(health, health.status === 'ok' ? 200 : 503)
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
    return c.html(
      <Layout user={await userOf(c)} path="/">
        <ServerTileView servers={servers} />
      </Layout>
    )
  }

  return c.html(
    <Layout steamId={steamId as string} path="/">
      <AdminDashboard servers={servers} />
    </Layout>
  )
})

/**
 * Server Management CRUD Page
 */
app.get('/servers', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')
  
  const servers = Store.getServers()
  
  return c.html(
    <Layout steamId={steamId as string} path="/servers">
      <div class="container mx-auto p-4 sm:p-8">
        <ServerManager servers={servers} />
      </div>
    </Layout>
  )
})

/**
 * Specific Server Dashboard (Role List)
 */
app.get('/servers/:serverId', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')

  const roles = getRolesWithState(serverId)

  return c.html(
    <Layout steamId={steamId as string} path="/">
       <div class="flex flex-col md:flex-row">
          <Sidebar serverId={serverId} roles={roles} />
          <div class="flex-1 min-w-0 min-h-[calc(100vh-65px)] bg-gray-900/50">
            <ServerDashboard server={server} roles={roles} />
          </div>
       </div>
    </Layout>
  )
})

/**
 * Round stats: overview, leaderboard, recent rounds. PUBLIC, like the server tiles: it is
 * only what happened in rounds (names and SteamID64s are public on Steam). The rule settings
 * stay admin-only.
 */
app.get('/servers/:serverId/stats', async (c) => {
  const steamId = await getAdminId(c)

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')

  const requested = c.req.query('sort') as stats.SortKey
  const sort = stats.SORTS.includes(requested) ? requested : 'rounds'
  // Hidden switch for checking the bot test scenario: ?bots=1 includes bot-only rounds.
  const opts = { bots: c.req.query('bots') === '1' }

  const recent = stats.getRecentRounds(serverId, opts)
  return c.html(
    <Layout steamId={steamId || undefined} user={await userOf(c)} path="/">
      <StatsDashboard
        server={server}
        overview={stats.getOverview(serverId, opts)}
        roles={stats.getRoleStats(serverId, opts)}
        teams={stats.getTeamStats(serverId, opts)}
        leaders={stats.getLeaderboard(serverId, sort, opts)}
        recent={recent}
        sort={sort}
        bots={opts.bots}
        admin={!!steamId}
        tracks={steamId ? trackInfo(serverId) : undefined}
        replays={replaysFor(serverId, recent, !!(steamId || await userOf(c)))}
      />
    </Layout>
  )
})

/** Which of the recent rounds have a replay, and what the visitor needs to open it (RFC 12, 3.5; RFC 13). */
const replaysFor = (serverId: string, recent: stats.RecentRound[], signedIn: boolean) => ({
  tracked: Store.getTrackedRounds(serverId, recent.map(r => r.roundId)), signedIn, signinOpen: openSignin(),
})

/** What a server keeps of position tracks, for the admin's card (RFC 12, 3.4). */
const trackInfo = (serverId: string) => {
  const cfg = Store.getTrackConfig()
  return { ...Store.getTrackUsage(serverId), limits: Store.getTrackLimits(serverId), ceiling: { count: cfg.maxCount, mb: cfg.maxMb, pinned: cfg.maxPinned } }
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
  return c.redirect(`/servers/${serverId}/stats`)
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
  return c.redirect(safeNext(String(form.next ?? '')) ?? `/servers/${serverId}/stats`)
})

/** The maps the server has and which of them it will play (RFC 10). Public, like the stats. */
app.get('/servers/:serverId/maps', async (c) => {
  const steamId = await getAdminId(c)

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')

  const { state, maps } = Store.getMaps(serverId)
  const user = await userOf(c)
  // The 3D view is for signed-in users (RFC 13); an anonymous visitor is offered it only when sign-in is open.
  const meshes = geometryEnabled() && (steamId || user || openSignin())
    ? new Set([...Store.getGeometryStates(serverId)].filter(([, g]) => g.status === 'parsed').map(([name]) => name))
    : undefined
  return c.html(
    <Layout steamId={steamId || undefined} user={user} path="/">
      <MapsDashboard server={server} state={state} maps={maps} admin={!!steamId} showAll={!!steamId && c.req.query('all') === '1'}
        plans={steamId ? Store.getMapPlans(serverId) : undefined} meshes={meshes} signedIn={!!(steamId || user)} viewLogDays={viewLogDays()} />
    </Layout>
  )
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
  const session = await getSession(c)
  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')
  const name = c.req.param('map')
  if (!session) return c.redirect(openSignin() ? signinUrl(`/servers/${serverId}/maps/${encodeURIComponent(name)}`) : `/servers/${serverId}/maps`)

  const { state, maps } = Store.getMaps(serverId)
  const map = maps.find(m => m.name === name) ?? null
  const grid = Store.getMapPlan(serverId, name)
  if (!map && !grid) return c.redirect(`/servers/${serverId}/maps`)

  const g = Store.getGeometryStates(serverId).get(name)
  if (!session.admin && (!geometryEnabled() || g?.status !== 'parsed')) return c.redirect(`/servers/${serverId}/maps`) // nothing for a plain user to see

  const meta = session.admin ? Store.getMapPlans(serverId).find(p => p.map === name) : undefined
  const plan = meta && grid ? { ...meta, levels: planLevels(JSON.parse(grid)) } : null
  const next = state && state.next && state.next !== state.current ? state.next : null
  return c.html(
    <Layout steamId={session.admin ? session.steamId : undefined} user={session.admin ? undefined : session.steamId} path="/">
      <MapPage server={server} map={map} name={name} next={next} plan={plan} admin={session.admin}
        geometry={geometryEnabled() && map ? geometryProp(serverId, name) : undefined} />
    </Layout>
  )
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
    level = /^\d{1,3}$/.test(asked) ? Number(asked) : 0
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
app.get('/servers/:serverId/maps/:map/mesh.glb', gated('mesh'), async (c) => {
  const serverId = c.req.param('serverId'), map = c.req.param('map')
  const mesh = Store.getMesh(serverId, map)
  if (!mesh) return c.text('Not found', 404)
  Store.logView(serverId, c.get('session').steamId, 'VIEW_MESH', map)
  return c.body(mesh as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'model/gltf-binary',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
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
  const found = buildReplay(serverId, roundId, { bots: c.req.query('bots') === '1' })
  if (!found) return c.json({ error: 'No track for this round' }, 404)
  Store.logView(serverId, c.get('session').steamId, 'VIEW_REPLAY', roundId)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ETag: found.etag,
    'Cache-Control': 'private, max-age=3600',
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

/** One round's replay page (RFC 12, 3.5). For signed-in users; an anonymous visitor is sent to sign-in and back (RFC 13). */
app.get('/servers/:serverId/rounds/:roundId/replay', async (c) => {
  const serverId = c.req.param('serverId'), roundId = c.req.param('roundId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')
  const bots = c.req.query('bots') === '1'
  const query = bots ? '?bots=1' : ''
  const here = `/servers/${serverId}/rounds/${encodeURIComponent(roundId)}/replay${query}`
  const session = await getSession(c)
  if (!session) return c.redirect(openSignin() ? signinUrl(here) : `/servers/${serverId}/stats`)

  const round = stats.getReplayRound(serverId, roundId, { bots })
  if (!round) return c.redirect(`/servers/${serverId}/stats`)
  const track = Store.getTrack(serverId, roundId)
  return c.html(
    <Layout steamId={session.admin ? session.steamId : undefined} user={session.admin ? undefined : session.steamId} path="/">
      <ReplayPage server={server} round={{ id: round.roundId, map: round.map, result: round.result, duration: round.duration }}
        hasTrack={!!track} src={`/servers/${serverId}/rounds/${encodeURIComponent(roundId)}/track.json${query}`}
        viewer={session.steamId} admin={session.admin} pinned={!!track?.meta.pinned} here={here}
        pinnedCount={session.admin ? { used: Store.getTrackUsage(serverId).pinned, max: Store.getTrackConfig().maxPinned } : undefined} />
    </Layout>
  )
})

app.get('/servers/:serverId/players/:playerId', async (c) => {
  const steamId = await getAdminId(c)

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  const player = server && stats.getPlayer(serverId, c.req.param('playerId'))
  if (!server || !player || (stats.isBotId(player.steamId) && c.req.query('bots') !== '1')) return c.redirect(`/servers/${serverId}/stats`)

  return c.html(
    <Layout steamId={steamId || undefined} user={await userOf(c)} path="/">
      <PlayerStats server={server} player={player} admin={!!steamId} />
    </Layout>
  )
})

/**
 * Specific Role Configuration Page
 */
app.get('/servers/:serverId/roles/:roleName', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const roleName = c.req.param('roleName')
  
  const server = Store.getServerById(serverId)
  const schema = Store.getSchema(serverId, roleName)
  const roles = getRolesWithState(serverId)
  
  if (!server || !schema) return c.redirect('/')
  
  return c.html(
    <Layout steamId={steamId as string} path="/">
       <div class="flex flex-col md:flex-row">
          <Sidebar serverId={serverId} roles={roles} />
          <div class="flex-1 min-w-0 p-4 sm:p-8 min-h-[calc(100vh-65px)] bg-gray-900/50">
            <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-8 flex gap-2">
                <a href="/" class="hover:text-white transition">Dashboard</a>
                <span>/</span>
                <a href={`/servers/${serverId}`} class="hover:text-white transition">{server.name}</a>
                <span>/</span>
                <span class="text-red-500">{roleName}</span>
            </nav>
            <RoleConfigForm serverId={serverId} role={roleName} schema={schema} live={Store.getConVarValues(serverId)} />
          </div>
       </div>
    </Layout>
  )
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
  // Views of gated content are kept for VIEW_LOG_DAYS (RFC 13, 6.3): cleaned now and once a day.
  Store.cleanupViewLog()
  setInterval(() => Store.cleanupViewLog(), 24 * 3600 * 1000).unref()
}

export default {
  port,
  hostname: '0.0.0.0',
  // Bun's default is 128MB. The biggest legitimate body is the language-file push.
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: app.fetch
}
