import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { getCookie } from 'hono/cookie'

// Routes & Services
import api from './routes/api'
import auth from './routes/auth'
import { Store } from './services/Store'

// Components
import { Layout } from './components/Layout'
import { ServerTileView } from './components/ServerTileView'
import { AdminDashboard } from './components/AdminDashboard'
import { ServerDashboard } from './components/ServerDashboard'
import { RoleConfigForm } from './components/RoleConfigForm'
import { ServerManager } from './components/ServerManager'
import { Sidebar, RoleListPartial } from './components/Sidebar'

const app = new Hono()

// Static Assets
app.use('/public/*', serveStatic({ root: './src' }))

// API & Auth Mounting
app.route('/api', api)
app.route('/auth', auth)

/**
 * Sidebar Partial for HTMX Search
 */
app.get('/sidebar/:serverId', (c) => {
  const serverId = c.req.param('serverId')
  const query = c.req.query('q') || ''
  const roles = Store.getRoles(serverId)
  
  const filteredRoles = query 
    ? roles.filter(r => r.role_name.toLowerCase().includes(query.toLowerCase()))
    : roles

  return c.html(<RoleListPartial serverId={serverId} roles={filteredRoles} />)
})

/**
 * Main Entry Point: Guest Tile View or Admin Dashboard
 */
app.get('/', (c) => {
  const steamId = getCookie(c, 'steam_id')
  const servers = Store.getServers()
  
  if (!steamId) {
    return c.html(
      <Layout path="/">
        <ServerTileView servers={servers} />
      </Layout>
    )
  }

  return c.html(
    <Layout steamId={steamId} path="/">
      <AdminDashboard servers={servers} />
    </Layout>
  )
})

/**
 * Server Management CRUD Page
 */
app.get('/servers', (c) => {
  const steamId = getCookie(c, 'steam_id')
  if (!steamId) return c.redirect('/')
  
  const servers = Store.getServers()
  
  return c.html(
    <Layout steamId={steamId} path="/servers">
      <div class="container mx-auto p-8">
        <ServerManager servers={servers} />
      </div>
    </Layout>
  )
})

/**
 * Specific Server Dashboard (Role List)
 */
app.get('/servers/:serverId', (c) => {
  const steamId = getCookie(c, 'steam_id')
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const server = Store.getServerById(serverId)
  if (!server) return c.redirect('/')

  const roles = Store.getRoles(serverId)

  return c.html(
    <Layout steamId={steamId} path="/">
       <div class="flex">
          <Sidebar serverId={serverId} roles={roles} />
          <div class="flex-1 min-h-[calc(100vh-65px)] bg-gray-900/50">
            <ServerDashboard server={server} roles={roles} />
          </div>
       </div>
    </Layout>
  )
})

/**
 * Specific Role Configuration Page
 */
app.get('/servers/:serverId/roles/:roleName', (c) => {
  const steamId = getCookie(c, 'steam_id')
  if (!steamId) return c.redirect('/')

  const serverId = c.req.param('serverId')
  const roleName = c.req.param('roleName')
  
  const server = Store.getServerById(serverId)
  const schema = Store.getSchema(serverId, roleName)
  const roles = Store.getRoles(serverId)
  
  if (!server || !schema) return c.redirect('/')
  
  return c.html(
    <Layout steamId={steamId} path="/">
       <div class="flex">
          <Sidebar serverId={serverId} roles={roles} />
          <div class="flex-1 p-8 min-h-[calc(100vh-65px)] bg-gray-900/50">
            <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-8 flex gap-2">
                <a href="/" class="hover:text-white transition">Dashboard</a>
                <span>/</span>
                <a href={`/servers/${serverId}`} class="hover:text-white transition">{server.name}</a>
                <span>/</span>
                <span class="text-red-500">{roleName}</span>
            </nav>
            <RoleConfigForm serverId={serverId} role={roleName} schema={schema} />
          </div>
       </div>
    </Layout>
  )
})

export default {
  port: 3000,
  hostname: '0.0.0.0',
  fetch: app.fetch
}
