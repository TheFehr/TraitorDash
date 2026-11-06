import { Shell } from './CaseFile'
import { Crumbs } from './kit'
import { AdminDashboard } from './AdminDashboard'
import { ServerDashboard } from './ServerDashboard'
import { ServerManager } from './ServerManager'
import { RoleConfigForm } from './RoleConfigForm'
import { Sidebar } from './Sidebar'
import { ServerSettingsForm, type BridgeSettingsState } from './ServerSettingsForm'
import type { TracksInfo } from './StatsPages'
import type { LiveConVar } from '../services/Store'
import { When } from './kit'
import { prettyMap } from '../mapName'

// The admin pages (RFC 17, stage 2): the shell of the public pages with the admin stylesheet and the
// htmx/Alpine bundle. What each page shows stays in its own component; this file only puts them in the shell.

const Admin = ({ title, steamId, children }: { title: string, steamId: string, children: any }) => (
  <Shell title={`${title} | TraitorDash`} embed={false} viewer={{ steamId, admin: true }} admin>
    {children}
  </Shell>
)

export const AdminHomePage = ({ steamId, servers }: { steamId: string, servers: any[] }) => (
  <Admin title="Admin dashboard" steamId={steamId}><AdminDashboard servers={servers} /></Admin>
)

export const ServersPage = ({ steamId, servers }: { steamId: string, servers: any[] }) => (
  <Admin title="Servers" steamId={steamId}>
    <Crumbs><a href="/">Dashboard</a> / Servers</Crumbs>
    <h1>Servers</h1>
    <ServerManager servers={servers} />
  </Admin>
)

export const ServerPage = ({ steamId, server, roles }: { steamId: string, server: any, roles: any[] }) => (
  <Admin title={server.name} steamId={steamId}>
    <div class="lay">
      <Sidebar serverId={server.id} roles={roles} />
      <div><ServerDashboard server={server} roles={roles} /></div>
    </div>
  </Admin>
)

/** RFC 2, 4: shown on the pages that edit a server while an admin is in the game, whose changes there win over an edit made here. */
export const OnlineAdminsNotice = ({ admins }: { admins?: string[] }) => admins && admins.length > 0 ? (
  <div class="call wait" role="status">
    <h3>{admins.length === 1 ? 'An admin is in the game' : 'Admins are in the game'}</h3>
    Attention: {admins.length === 1 ? 'admin' : 'admins'} {admins.join(', ')} {admins.length === 1 ? 'is' : 'are'} online. In-game changes take priority and may overwrite web-based edits.
  </div>
) : null

export const RoleConfigPage = ({ steamId, server, roleName, roles, schema, live, onlineAdmins }: {
  steamId: string, server: { id: string, name: string }, roleName: string, roles: any[], schema: any[], live: Record<string, LiveConVar>, onlineAdmins?: string[]
}) => (
  <Admin title={`Configure ${roleName}`} steamId={steamId}>
    <div class="lay">
      <Sidebar serverId={server.id} roles={roles} />
      <div>
        <Crumbs>
          <a href="/">Dashboard</a> / <a href={`/servers/${server.id}`}>{server.name}</a> / {roleName}
          {' · '}<a href={`/servers/${server.id}/roles/${encodeURIComponent(roleName)}`}>Public page</a>
        </Crumbs>
        <OnlineAdminsNotice admins={onlineAdmins} />
        <RoleConfigForm serverId={server.id} role={roleName} schema={schema} live={live} />
      </div>
    </div>
  </Admin>
)

/** The settings of a server (RFC 23): the bridge's own and the dashboard's, on one page, for admins. */
export const ServerSettingsPage = ({ steamId, server, roles, state, storage, onlineAdmins }: { steamId: string, server: { id: string, name: string }, roles: any[], state: BridgeSettingsState, storage: TracksInfo, onlineAdmins?: string[] }) => (
  <Admin title={`Settings | ${server.name}`} steamId={steamId}>
    <div class="lay">
      <Sidebar serverId={server.id} roles={roles} />
      <div>
        <Crumbs><a href="/">Dashboard</a> / <a href={`/servers/${server.id}`}>{server.name}</a> / Settings</Crumbs>
        <OnlineAdminsNotice admins={onlineAdmins} />
        <ServerSettingsForm serverId={server.id} state={state} storage={storage} />
      </div>
    </div>
  </Admin>
)

export interface ViewLog {
  accounts: { steamId: string, views: number, things: number, last: string }[]
  rows: { steamId: string, action: 'VIEW_REPLAY' | 'VIEW_MESH', what: string, timestamp: string }[]
  days: number
  steamId: string | null
  action: 'VIEW_REPLAY' | 'VIEW_MESH' | null
}

const iso = (v: string) => `${v.replace(' ', 'T')}Z`

/** Who opened which replay or 3D map (RFC 13, 6.3), for admins: the accounts by how much they opened, then the newest views. */
export const ViewLogPage = ({ steamId, server, log, now }: { steamId: string, server: { id: string, name: string }, log: ViewLog, now?: number }) => {
  const base = `/servers/${server.id}/views`
  const to = (p: { player?: string | null, action?: string | null }) => {
    const q = new URLSearchParams()
    if (p.player) q.set('player', p.player)
    if (p.action) q.set('what', p.action)
    return q.size ? `${base}?${q}` : base
  }
  return (
    <Admin title={`View log | ${server.name}`} steamId={steamId}>
      <Crumbs><a href="/">Dashboard</a> / <a href={`/servers/${server.id}`}>{server.name}</a> / View log</Crumbs>
      <h1>View log</h1>
      <p class="muted">Who opened a replay or a 3D map. A repeat of the same thing within an hour is one row. {log.days > 0 ? `Rows are kept for ${log.days} days.` : 'The log is switched off.'}</p>
      <div class="bar" style="margin:.8rem 0">
        <span>Show</span>
        <a class={log.action === null ? 'on' : ''} href={to({ player: log.steamId })}>All</a>
        <a class={log.action === 'VIEW_REPLAY' ? 'on' : ''} href={to({ player: log.steamId, action: 'replay' })}>Replays</a>
        <a class={log.action === 'VIEW_MESH' ? 'on' : ''} href={to({ player: log.steamId, action: 'map' })}>3D maps</a>
        {log.steamId && <a href={to({ action: log.action === 'VIEW_REPLAY' ? 'replay' : log.action === 'VIEW_MESH' ? 'map' : null })}>All accounts ✕</a>}
      </div>
      {log.rows.length === 0 && (
        <p class="none" data-no-views>Nobody has opened a replay or a 3D map{log.steamId || log.action ? ' with this filter' : ''}{log.days > 0 ? '' : ' (the log is off)'}.</p>
      )}
      {(log.rows.length > 0 || log.accounts.length > 0) && (
        <>
          <div class="f c-blue mt1">
            <h2 class="ft">Accounts</h2>
            <div class="scrollx">
              <table class="log" data-view-accounts>
                <tr><th>Account</th><th class="r">Views</th><th class="r">Different</th><th style="padding-left:1.2rem">Last</th></tr>
                {log.accounts.map(a => (
                  <tr>
                    <td><a href={to({ player: a.steamId, action: log.action === 'VIEW_REPLAY' ? 'replay' : log.action === 'VIEW_MESH' ? 'map' : null })}>{a.steamId}</a></td>
                    <td class="r">{a.views}</td><td class="r">{a.things}</td>
                    <td style="padding-left:1.2rem"><When iso={iso(a.last)} now={now} /></td>
                  </tr>
                ))}
              </table>
            </div>
          </div>
          {log.rows.length > 0 && <div class="f c-red mt1">
            <h2 class="ft">Newest views</h2>
            <div class="scrollx">
              <table class="log" data-view-rows>
                <tr><th>When</th><th>Account</th><th>Opened</th></tr>
                {log.rows.map(r => (
                  <tr>
                    <td><When iso={iso(r.timestamp)} now={now} /></td>
                    <td><a href={`/servers/${server.id}/players/${r.steamId}`}>{r.steamId}</a></td>
                    <td>{r.action === 'VIEW_REPLAY'
                      ? <>Replay of <a href={`/servers/${server.id}/rounds/${encodeURIComponent(r.what)}`}>{r.what}</a></>
                      : <>3D map <a href={`/servers/${server.id}/maps/${encodeURIComponent(r.what)}`} title={r.what}>{prettyMap(r.what)}</a></>}</td>
                  </tr>
                ))}
              </table>
            </div>
          </div>}
        </>
      )}
    </Admin>
  )
}
