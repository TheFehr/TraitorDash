export const Sidebar = ({ serverId, roles, query = '' }: { serverId: string, roles: any[], query?: string }) => {
  const filteredRoles = query 
    ? roles.filter(r => r.role_name.toLowerCase().includes(query.toLowerCase()))
    : roles

  // Below md the roles live behind a "Roles" bar (a checkbox + label, so it needs no script and
  // cannot flash open); from md up it is the fixed column it always was.
  return (
    <div class="w-full md:w-64 md:flex-shrink-0 bg-gray-800 border-b md:border-b-0 md:border-r border-gray-700 flex flex-col md:h-[calc(100vh-65px)] md:sticky md:top-[65px]">
      <input type="checkbox" id="roles-toggle" class="peer sr-only" aria-label="Show roles" />
      <label for="roles-toggle" class="md:hidden flex items-center justify-between px-4 py-3 cursor-pointer select-none text-sm font-black uppercase tracking-widest text-gray-300 peer-focus-visible:ring-2 peer-focus-visible:ring-red-500">
        <span>Roles <span class="text-gray-500 font-mono normal-case">({roles.length})</span></span>
        <span class="text-gray-500">▾</span>
      </label>
      <div class="hidden peer-checked:flex md:flex flex-col flex-1 min-h-0 max-h-[60vh] md:max-h-none">
        <div class="p-4 border-b border-gray-700">
          <input 
            type="text" 
            name="q"
            placeholder="Search roles..." 
            class="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 outline-none"
            hx-get={`/sidebar/${serverId}`}
            hx-trigger="keyup changed delay:300ms"
            hx-target="#role-list"
            value={query}
          />
        </div>
        <div id="role-list" class="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredRoles.map(role => (
            <a 
              href={`/servers/${serverId}/roles/${role.role_name}/config`}
              class={`block px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 transition group flex justify-between items-center ${role.enabled === false ? 'opacity-50' : ''}`}
              title={role.enabled === false ? 'Disabled on this server' : undefined}
            >
              <span class="truncate">{role.role_name}</span>
              <span class="text-[10px] text-gray-500 group-hover:text-red-400 transition">→</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

export const RoleListPartial = ({ serverId, roles }: { serverId: string, roles: any[] }) => (
  <>
    {roles.map(role => (
      <a 
        href={`/servers/${serverId}/roles/${role.role_name}/config`}
        class={`block px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 transition group flex justify-between items-center ${role.enabled === false ? 'opacity-50' : ''}`}
        title={role.enabled === false ? 'Disabled on this server' : undefined}
      >
        <span class="truncate">{role.role_name}</span>
        <span class="text-[10px] text-gray-500 group-hover:text-red-400 transition">→</span>
      </a>
    ))}
  </>
)
