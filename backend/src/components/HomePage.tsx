import { Sections, Shell } from './CaseFile'
import { When, type Ctx } from './kit'
import { isServerOnline } from '../services/ServerUtils'

/** The front door for visitors who are not admins: the servers, whether they are up, and where to read about them (RFC 17). */
export const HomePage = ({ ctx, servers }: { ctx: Ctx, servers: { id: string, name: string, last_seen: string | null }[] }) => (
  <Shell title="TraitorDash" embed={false} viewer={ctx.viewer}>
    <h1 style="font-size:2.4rem;margin-top:1rem">TraitorDash</h1>
    <p class="muted" style="margin:0 0 .6rem">Live TTT2 server network</p>
    {servers.length === 0 && <div class="f"><b>No servers yet</b><span>No server has registered yet.</span></div>}
    <div class="g wide">
      {servers.map(server => {
        const online = isServerOnline(server.last_seen)
        return (
          <div class="f" style={`--c:${online ? '#22c55e' : '#9ca3af'}`}>
            <b>{server.name}</b>
            <span><i class={`pill ${online ? 'ok' : 'mute'}`}>{online ? 'Online' : 'Offline'}</i></span>
            <span>Last heartbeat: {server.last_seen ? <When iso={server.last_seen} now={ctx.now} /> : 'Never'}</span>
            <Sections serverId={server.id} />
          </div>
        )
      })}
    </div>
  </Shell>
)
