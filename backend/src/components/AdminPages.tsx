import { Shell } from './CaseFile'
import { Crumbs } from './kit'
import { AdminDashboard } from './AdminDashboard'
import { ServerDashboard } from './ServerDashboard'
import { ServerManager } from './ServerManager'
import { RoleConfigForm } from './RoleConfigForm'
import { Sidebar } from './Sidebar'
import type { LiveConVar } from '../services/Store'

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

export const RoleConfigPage = ({ steamId, server, roleName, roles, schema, live }: {
  steamId: string, server: { id: string, name: string }, roleName: string, roles: any[], schema: any[], live: Record<string, LiveConVar>
}) => (
  <Admin title={`Configure ${roleName}`} steamId={steamId}>
    <div class="lay">
      <Sidebar serverId={server.id} roles={roles} />
      <div>
        <Crumbs>
          <a href="/">Dashboard</a> / <a href={`/servers/${server.id}`}>{server.name}</a> / {roleName}
          {' · '}<a href={`/servers/${server.id}/roles/${encodeURIComponent(roleName)}`}>Public page</a>
        </Crumbs>
        <RoleConfigForm serverId={server.id} role={roleName} schema={schema} live={live} />
      </div>
    </div>
  </Admin>
)
