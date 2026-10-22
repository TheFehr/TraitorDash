import { isServerOnline } from '../services/ServerUtils'
import { Heartbeat } from './Heartbeat'

type NewToken = { serverId: string, token: string }
/** `token` is set only for a server that was just created: it is offered for provisioning tools, under a disclosure. */
type Pairing = { serverId: string, command: string, token?: string }

export const ServerManager = ({ servers, newToken, pairing }: { servers: any[], newToken?: NewToken, pairing?: Pairing }) => {
  return (
    <div id="server-manager">
      {pairing && (
        <div class="call ok" x-data="{ copied: false }">
          <h3>Connect a server</h3>
          <p>
            Run this in the game server's console (or RCON). It works once and for 10 minutes, and replaces that server's token.
          </p>
          <div class="copy">
            <code class="code">{pairing.command}</code>
            <button
              type="button"
              class="ab main"
              x-on:click={`navigator.clipboard.writeText(${JSON.stringify(pairing.command)}); copied = true; setTimeout(() => copied = false, 2000)`}
            >
              <span x-show="!copied">Copy</span>
              <span x-show="copied" x-cloak="true">Copied</span>
            </button>
          </div>
          {pairing.token && (
            <details>
              <summary>Advanced / provisioning</summary>
              <p>
                For tools that write the configuration themselves: this server's API token. It is shown once and stored only as a hash.
                Using the command above instead is the easier way, and pairing replaces it.
              </p>
              <code class="code" style="display:block;margin-top:.5rem;background:#14110e;border:1px solid #3a342a;padding:.6rem .8rem;word-break:break-all;user-select:all;font-size:.85rem">{pairing.token}</code>
            </details>
          )}
        </div>
      )}

      {newToken && (
        <div class="call wait" x-data="{ copied: false }">
          <h3>New API token</h3>
          <p>
            Copy it now. It is stored only as a hash, so it cannot be shown again. Lose it and you have to regenerate.
          </p>
          <div class="copy">
            <code class="code">{newToken.token}</code>
            <button
              type="button"
              class="ab main"
              x-on:click={`navigator.clipboard.writeText('${newToken.token}'); copied = true; setTimeout(() => copied = false, 2000)`}
            >
              <span x-show="!copied">Copy</span>
              <span x-show="copied" x-cloak="true">Copied</span>
            </button>
          </div>
        </div>
      )}

      <section class="pn" style="--c:#e9b44c">
        <h2 class="ft">Manage servers</h2>
        <div class="scrollx">
          <table class="data">
            <thead>
              <tr>
                <th>Server name</th>
                <th>ID</th>
                <th>Status</th>
                <th>Last heartbeat</th>
                <th class="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map(server => {
                const isOnline = isServerOnline(server.last_seen)
                const tone = isOnline ? 'ok' : server.last_seen ? 'mute' : 'wait'
                return (
                  <tr>
                    <td><strong>{server.name}</strong></td>
                    <td class="cv">{server.id}</td>
                    <td>
                      <span class={tone === 'ok' ? 'ok-t' : tone === 'wait' ? 'wait-t' : 'muted'}>
                        <i class={`dot ${tone === 'ok' ? 'on' : tone === 'wait' ? 'wait' : ''}`}></i>
                        {isOnline ? 'Online' : server.last_seen ? 'Offline' : 'Waiting for the first connection'}
                      </span>
                    </td>
                    <td class="muted"><Heartbeat lastSeen={server.last_seen} /></td>
                    <td class="r">
                      <button
                        hx-post={`/api/servers/${server.id}/pairing-code`}
                        hx-confirm={isOnline ? `${server.name} is online. Pairing replaces its token, and it stops working until it is paired. Continue?` : undefined}
                        hx-target="#server-manager"
                        hx-swap="outerHTML"
                        class="ab go"
                      >
                        Connect
                      </button>{' '}
                      <button
                        hx-post={`/api/servers/${server.id}/regenerate-token`}
                        hx-confirm={`Regenerate the token for ${server.name}? The current token stops working immediately.`}
                        hx-target="#server-manager"
                        hx-swap="outerHTML"
                        class="ab"
                      >
                        Regen token
                      </button>{' '}
                      <button
                        hx-delete={`/api/servers/${server.id}`}
                        hx-confirm={`Are you sure you want to delete ${server.name}?`}
                        hx-target="#server-manager"
                        hx-swap="outerHTML"
                        class="ab danger"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section class="pn" style="--c:#a78bfa">
        <h2 class="ft">Add new server</h2>
        <form hx-post="/api/servers" hx-target="#server-manager" hx-swap="outerHTML" class="add">
          <input type="text" class="dk" name="name" placeholder="Server Name (e.g. TTT2 West #1)" aria-label="Server name" required />
          <button type="submit" class="ab main">Create server</button>
        </form>
      </section>
    </div>
  )
}
