export const AdminDashboard = ({ servers }: { servers: any[] }) => {
  return (
    <div class="container mx-auto p-8">
      <header class="mb-12">
        <h1 class="text-5xl font-black mb-4 italic tracking-tighter">Admin Dashboard</h1>
        <p class="text-gray-400 text-xl">Select a node to manage its roles and configurations.</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {servers.map(server => {
          const isOnline = server.last_seen && (new Date().getTime() - new Date(server.last_seen + 'Z').getTime()) < 30000
          return (
            <a href={`/servers/${server.id}`} class="bg-gray-800 rounded-2xl p-8 border border-gray-700 hover:border-red-500 transition group flex flex-col justify-between shadow-2xl">
              <div>
                <div class="flex justify-between items-center mb-4">
                  <span class={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
                    {isOnline ? '● Live' : '○ Dead'}
                  </span>
                  <span class="text-xl opacity-50 group-hover:opacity-100 transition">⚙️</span>
                </div>
                <h3 class="text-2xl font-bold group-hover:text-red-400 transition mb-1">{server.name}</h3>
                <p class="text-gray-500 text-xs font-mono mb-4">{server.id}</p>
              </div>
              <div class="pt-4 border-t border-gray-700 flex justify-between items-center text-sm font-bold text-gray-400 uppercase tracking-tighter">
                 <span>Manage Node</span>
                 <span class="text-red-500">→</span>
              </div>
            </a>
          )
        })}
        
        {servers.length === 0 && (
          <a href="/servers" class="bg-gray-800/30 rounded-2xl p-8 border-2 border-dashed border-gray-700 flex flex-col items-center justify-center text-center hover:bg-gray-800/50 transition">
            <div class="text-3xl mb-2">➕</div>
            <p class="text-gray-500 font-bold uppercase text-xs tracking-widest">Connect First Server</p>
          </a>
        )}
      </div>
    </div>
  )
}
