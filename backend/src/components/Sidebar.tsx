export const Sidebar = ({ serverId, roles, query = '' }: { serverId: string, roles: any[], query?: string }) => {
  const filteredRoles = query 
    ? roles.filter(r => r.role_name.toLowerCase().includes(query.toLowerCase()))
    : roles

  return (
    <div class="w-64 flex-shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col h-[calc(100vh-65px)] sticky top-[65px]">
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
            href={`/servers/${serverId}/roles/${role.role_name}`}
            class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 transition group flex justify-between items-center"
          >
            <span class="truncate">{role.role_name}</span>
            <span class="text-[10px] text-gray-500 group-hover:text-red-400 transition">→</span>
          </a>
        ))}
      </div>
    </div>
  )
}

export const RoleListPartial = ({ serverId, roles }: { serverId: string, roles: any[] }) => (
  <>
    {roles.map(role => (
      <a 
        href={`/servers/${serverId}/roles/${role.role_name}`}
        class="block px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 transition group flex justify-between items-center"
      >
        <span class="truncate">{role.role_name}</span>
        <span class="text-[10px] text-gray-500 group-hover:text-red-400 transition">→</span>
      </a>
    ))}
  </>
)
