import { Hono } from 'hono'
import { Extractor } from '../services/Extractor'
import { Store } from '../services/Store'
import { ServerManager } from '../components/ServerManager'

type Variables = {
  server: {
    id: string
    name: string
    api_token: string
    last_seen: string | null
  }
}

const api = new Hono<{ Variables: Variables }>()

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

api.get('/servers', async (c) => {
  const servers = Store.getServers()
  return c.html(<ServerManager servers={servers} />)
})

api.post('/servers', async (c) => {
  const { name } = await c.req.parseBody()
  if (name && typeof name === 'string') {
    Store.addServer(name)
  }
  const servers = Store.getServers()
  return c.html(<ServerManager servers={servers} />)
})

api.delete('/servers/:id', async (c) => {
  const id = c.req.param('id')
  Store.deleteServer(id)
  const servers = Store.getServers()
  return c.html(<ServerManager servers={servers} />)
})

api.post('/ingest', getServer, async (c) => {
  try {
    const server = c.get('server')
    const body = await c.req.json()
    const { role_code, role_name, convar_state } = body

    if (!role_code) {
      return c.json({ error: 'Missing role_code' }, 400)
    }

    const name = role_name || 'unknown'
    console.log(`[API] Ingesting role: ${name} for server ${server.name} (Size: ${role_code.length} bytes)`)
    const { team, isPolicingRole, baserole, schema } = await Extractor.extractSchema(role_code, convar_state)

    // Save to database via Store
    Store.saveSchema(server.id, name, team, isPolicingRole, baserole, schema)

    return c.json({
      success: true,
      role: name,
      team: team,
      isPolicingRole,
      baserole,
      schema: schema
    })
  } catch (err: any) {
    console.error('[API] Extraction failed:', err)
    return c.json({
      success: false,
      error: err.message
    }, 500)
  }
})

api.post('/save/:serverId/:role', async (c) => {
  const serverId = c.req.param('serverId')
  const role = c.req.param('role')
  const body = await c.req.parseBody()
  
  console.log(`[API] Saving config for ${role} on ${serverId}:`, body)

  for (const [convar, value] of Object.entries(body)) {
    const finalValue = value === 'on' ? '1' : (value === '' ? '0' : value)
    Store.stageCommand(serverId, 'convar', `${convar} ${finalValue}`)
  }

  return c.json({ success: true })
})

api.get('/v1/poll', getServer, async (c) => {
  const server = c.get('server')
  console.log(`[API] Heartbeat from ${server.name} (${server.id})`)
  Store.updateHeartbeat(server.id)
  const commands = Store.pollCommands(server.id)
  
  return c.json({
    commands: commands.map(cmd => ({
      type: cmd.command,
      payload: cmd.args
    }))
  })
})

export default api
