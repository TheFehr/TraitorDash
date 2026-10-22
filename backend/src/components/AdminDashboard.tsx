import { isServerOnline } from '../services/ServerUtils'
import { Heartbeat } from './Heartbeat'

export const AdminDashboard = ({ servers }: { servers: any[] }) => (
  <>
    <h1>Admin dashboard</h1>
    <p class="muted">Select a server to manage its roles and settings.</p>
    <div class="tiles">
      {servers.map(server => {
        const isOnline = isServerOnline(server.last_seen)
        return (
          <a href={`/servers/${server.id}`} class="pn" style={`--c:${isOnline ? '#4ade80' : '#6b6455'}`}>
            <h2 class="ft">{server.name}</h2>
            <p><span class={`pill ${isOnline ? 'ok' : 'mute'}`}>{isOnline ? '● Live' : '○ Dead'}</span></p>
            <p class="cv">{server.id}</p>
            <p class="muted">Last heartbeat: <Heartbeat lastSeen={server.last_seen} /></p>
            <p class="go">Manage server →</p>
          </a>
        )
      })}
      {servers.length === 0 && (
        <a href="/servers" class="pn" style="--c:#6b6455">
          <h2 class="ft">Connect a server</h2>
          <p class="muted">No server is connected yet. Add one and pair it from here.</p>
        </a>
      )}
    </div>
  </>
)
