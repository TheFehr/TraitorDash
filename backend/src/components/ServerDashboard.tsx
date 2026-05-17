export const ServerDashboard = ({ server, roles }: { server: any, roles: any[] }) => {
  const isOnline = server.last_seen && (new Date().getTime() - new Date(server.last_seen + 'Z').getTime()) < 30000

  // Group roles by team
  const groups = roles.reduce((acc: any, role: any) => {
    let teamKey = role.team || 'unknown'
    
    // Force grouping for detective variants
    if (role.is_policing === 1 || role.baserole === 2 || role.role_name === 'detective') {
      teamKey = 'detectives'
    }

    if (!acc[teamKey]) acc[teamKey] = []
    acc[teamKey].push(role.role_name)
    return acc
  }, {})

  const teamColors: any = {
    traitors: 'border-red-500/30 text-red-500',
    innocents: 'border-green-500/30 text-green-500',
    detectives: 'border-blue-500/30 text-blue-500',
    necromancers: 'border-purple-500/30 text-purple-500',
    jackals: 'border-orange-500/30 text-orange-500',
    infecteds: 'border-teal-500/30 text-teal-500',
    nones: 'border-gray-500/30 text-gray-500',
    unknown: 'border-gray-500/30 text-gray-500'
  }

  const teamLabels: any = {
    traitors: 'Traitors',
    innocents: 'Innocents',
    detectives: 'Detectives',
    necromancers: 'Necromancers',
    jackals: 'Jackals',
    infecteds: 'Infected',
    nones: 'Neutral / Other',
    unknown: 'Uncategorized'
  }

  // Define sort order
  const order = ['innocents', 'traitors', 'detectives', 'necromancers', 'jackals', 'infecteds', 'nones', 'unknown']
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    return order.indexOf(a[0]) - order.indexOf(b[0])
  })

  return (
    <div class="container mx-auto p-8">
      <header class="mb-12 flex items-center justify-between">
        <div>
          <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
            <a href="/" class="hover:text-white transition">Dashboard</a>
            <span>/</span>
            <span class="text-red-500">{server.name}</span>
          </nav>
          <h1 class="text-5xl font-black mb-2">{server.name}</h1>
          <p class="text-gray-400 text-lg">Server Role Registry</p>
        </div>
        <div class={`px-4 py-2 rounded-xl border ${isOnline ? 'border-green-500/50 bg-green-500/10 text-green-400' : 'border-gray-700 bg-gray-800 text-gray-500'} flex items-center gap-3 shadow-xl`}>
           <div class={`w-3 h-3 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-700'}`}></div>
           <span class="font-black uppercase text-sm tracking-tighter">{isOnline ? 'System Online' : 'System Dead'}</span>
        </div>
      </header>

      <div class="space-y-12">
        {sortedGroups.length === 0 ? (
          <div class="p-20 bg-gray-800/20 rounded-3xl border-2 border-dashed border-gray-700 text-center shadow-inner">
             <div class="text-6xl mb-6 opacity-20 italic font-black">Empty</div>
             <h3 class="text-xl font-bold text-gray-500">No roles detected for this node.</h3>
             <p class="text-gray-600 mt-2">Ensure the TraitorLink bridge is running on the game server.</p>
          </div>
        ) : (
          sortedGroups.map(([team, roleList]: [string, any]) => (
            <section class="space-y-6">
              <div class="flex items-center gap-4">
                <h2 class={`text-2xl font-black uppercase tracking-tighter px-4 py-1 rounded-lg border bg-gray-800/50 ${teamColors[team] || teamColors.unknown}`}>
                  {teamLabels[team] || team}
                </h2>
                <div class="h-px flex-1 bg-gray-700/50"></div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {roleList.map((roleName: string) => (
                  <a href={`/servers/${server.id}/roles/${roleName}`} class="bg-gray-800 rounded-xl p-6 border border-gray-700 hover:border-red-500 transition group flex justify-between items-center shadow-lg hover:shadow-red-500/10">
                    <span class="text-xl font-bold group-hover:text-red-400 transition">{roleName}</span>
                    <span class="text-red-500 opacity-0 group-hover:opacity-100 transition font-black uppercase text-xs">Configure →</span>
                  </a>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
