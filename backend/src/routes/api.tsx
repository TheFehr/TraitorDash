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
    const { role_code, role_name, convar_state, data_state, active_admins, md5_hash, force } = body

    if (!role_code) {
      return c.json({ error: 'Missing role_code' }, 400)
    }

    const name = role_name || 'unknown'

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
        return c.json({
          success: true,
          role: name,
          cached: true
        })
      }
    }

    console.log(`[API] Ingesting role: ${name} for server ${server.name} (Size: ${role_code.length} bytes, Force: ${!!force})`)
    const { team, isPolicingRole, baserole, schema } = await Extractor.extractSchema(role_code, convar_state, data_state)

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
      error: err.message
    }, 500)
  }
})

api.post('/save/:serverId/:role', async (c) => {
  const serverId = c.req.param('serverId')
  const role = c.req.param('role')
  const body = await c.req.parseBody()
  
  console.log(`[API] Saving config for ${role} on ${serverId}:`, body)

  const schema = Store.getSchema(serverId, role)
  if (!schema) {
    console.error(`[API] Save failed: No schema found for role ${role} on server ${serverId}`)
    return c.json({ error: 'Role schema not found. Configuration cannot be validated.' }, 400)
  }

  // Build whitelist of allowed convars from the extracted schema
  const allowedKeys = new Set<string>()
  schema.forEach((item: any) => {
    if (item.args) {
      if (item.args.convar) allowedKeys.add(item.args.convar)
      if (item.args.serverConvar) allowedKeys.add(item.args.serverConvar)
    }
  })

  let stagedCount = 0
  for (const [convar, value] of Object.entries(body)) {
    if (!allowedKeys.has(convar)) {
      console.warn(`[API] SECURITY ALERT: Blocked unauthorized config injection attempt for key: ${convar} on role: ${role}`)
      continue
    }

    const finalValue = value === 'on' ? '1' : (value === '' ? '0' : value)
    Store.stageCommand(serverId, 'convar', `${convar} ${finalValue}`)
    stagedCount++
  }

  return c.json({ success: true, commands_staged: stagedCount })
})

api.post('/v1/poll', getServer, async (c) => {
  const server = c.get('server')
  const body = await c.req.json().catch(() => ({}))
  const { active_admins } = body

  if (active_admins && Array.isArray(active_admins)) {
    console.log(`[API] Heartbeat with ${active_admins.length} admins from ${server.name} (${server.id})`)
    // TODO: Store active_admins in RFC 5
  } else {
    console.log(`[API] Heartbeat from ${server.name} (${server.id})`)
  }

  Store.updateHeartbeat(server.id)
  const commands = Store.pollCommands(server.id)
  
  return c.json({
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
        type: cmd.command,
        payload: payload
      }
    })
  })
})

export default api
