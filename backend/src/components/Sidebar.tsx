type SidebarRole = { role_name: string, enabled?: boolean }

const RoleLink = ({ serverId, role }: { serverId: string, role: SidebarRole }) => (
  <a
    href={`/servers/${serverId}/roles/${role.role_name}/config`}
    class={`ritem${role.enabled === false ? ' off' : ''}`}
    title={role.enabled === false ? 'Disabled on this server' : undefined}
  >
    <span>{role.role_name}</span>
    <span aria-hidden="true">→</span>
  </a>
)

export const Sidebar = ({ serverId, roles, query = '' }: { serverId: string, roles: any[], query?: string }) => {
  const filteredRoles = query
    ? roles.filter(r => r.role_name.toLowerCase().includes(query.toLowerCase()))
    : roles

  // Below 760px the roles live behind a "Roles" bar (a checkbox + label, so it needs no script and
  // cannot flash open); from there up it is the fixed column it always was.
  return (
    <nav class="side" aria-label="Roles">
      <input type="checkbox" id="roles-toggle" class="sro" aria-label="Show roles" />
      <label for="roles-toggle" class="rbar">
        <span>Roles <span class="cv">({roles.length})</span></span>
        <span aria-hidden="true">▾</span>
      </label>
      <div class="rbody">
        <div class="find">
          <input
            type="search"
            name="q"
            placeholder="Search roles..."
            aria-label="Search roles"
            hx-get={`/sidebar/${serverId}`}
            hx-trigger="keyup changed delay:300ms"
            hx-target="#role-list"
            value={query}
          />
        </div>
        <div id="role-list">
          {filteredRoles.map(role => <RoleLink serverId={serverId} role={role} />)}
        </div>
      </div>
    </nav>
  )
}

export const RoleListPartial = ({ serverId, roles }: { serverId: string, roles: any[] }) => (
  <>
    {roles.map(role => <RoleLink serverId={serverId} role={role} />)}
  </>
)
