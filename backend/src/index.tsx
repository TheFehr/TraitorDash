import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// Routes & Services
import api from './routes/api'
import auth from './routes/auth'
import { Store } from './services/Store'
import { getRolesWithState } from './services/roles'
import { getAdminId } from './middleware/session'

// Components
import { Layout } from './components/Layout'
import { ServerTileView } from './components/ServerTileView'
import { AdminDashboard } from './components/AdminDashboard'
import { ServerDashboard } from './components/ServerDashboard'
import { RoleConfigForm } from './components/RoleConfigForm'
import { ServerManager } from './components/ServerManager'
import { Sidebar, RoleListPartial } from './components/Sidebar'
import { StatsDashboard, PlayerStats } from './components/StatsDashboard'
import * as stats from './services/stats'

const app = new Hono()

// Static Assets
app.use('/public/*', serveStatic({ root: './src' }))

// API & Auth Mounting
app.route('/api', api)
app.route('/auth', auth)

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
      <Layout path="/">
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
 * Round stats: overview, leaderboard, recent rounds. Admin-only: it shows SteamIDs.
 */
app.get('/servers/:serverId/stats', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')

  const requested = c.req.query('sort') as stats.SortKey
  const sort = stats.SORTS.includes(requested) ? requested : 'rounds'
  // Hidden switch for checking the bot test scenario: ?bots=1 includes bot-only rounds.
  const opts = { bots: c.req.query('bots') === '1' }

  return c.html(
    <Layout steamId={steamId as string} path="/">
      <StatsDashboard
        server={server}
        overview={stats.getOverview(serverId, opts)}
        roles={stats.getRoleStats(serverId, opts)}
        teams={stats.getTeamStats(serverId, opts)}
        leaders={stats.getLeaderboard(serverId, sort, opts)}
        recent={stats.getRecentRounds(serverId, opts)}
        sort={sort}
        bots={opts.bots}
      />
    </Layout>
  )
})

app.get('/servers/:serverId/players/:playerId', async (c) => {
  const steamId = await getAdminId(c)
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  const player = server && stats.getPlayer(serverId, c.req.param('playerId'))
  if (!server || !player || (stats.isBotId(player.steamId) && c.req.query('bots') !== '1')) return c.redirect(`/servers/${serverId}/stats`)

  return c.html(
    <Layout steamId={steamId as string} path="/">
      <PlayerStats server={server} player={player} />
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
  setTimeout(() => console.log(`${STARTUP_LOG_LINE} ${port}`), 0)
}

export default {
  port,
  hostname: '0.0.0.0',
  // Bun's default is 128MB. The biggest legitimate body is the language-file push.
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: app.fetch
}
