export const ServerTileView = ({ servers }: { servers: any[] }) => {
  return (
    <div class="container mx-auto p-8">
      <header class="mb-12 text-center">
        <h1 class="text-6xl font-black mb-4 bg-gradient-to-r from-red-500 to-orange-400 bg-clip-text text-transparent">
          TraitorDash
        </h1>
        <p class="text-2xl text-gray-400">Live TTT2 Server Network</p>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {servers.map(server => {
          const isOnline = server.last_seen && (new Date().getTime() - new Date(server.last_seen).getTime()) < 30000
          
          return (
            <div class="bg-gray-800 rounded-2xl p-8 border border-gray-700 shadow-2xl hover:border-red-500/50 transition-all duration-300 group">
              <div class="flex justify-between items-start mb-6">
                <div class={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest ${isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
                  {isOnline ? '● Online' : '○ Offline'}
                </div>
                <span class="text-3xl grayscale group-hover:grayscale-0 transition">🎮</span>
              </div>
              
              <h3 class="text-2xl font-bold mb-2 group-hover:text-red-400 transition">{server.name}</h3>
              <p class="text-gray-500 text-sm mb-6 font-mono">{server.id}</p>
              
              <div class="pt-6 border-t border-gray-700 mt-auto">
                <p class="text-xs text-gray-500 uppercase font-bold mb-2">Last Heartbeat</p>
                <p class="text-sm text-gray-300">
                  {server.last_seen ? new Date(server.last_seen + 'Z').toLocaleString() : 'Never'}
                </p>
              </div>
            </div>
          )
        })}

        {servers.length === 0 && (
          <div class="col-span-full py-20 text-center bg-gray-800/20 rounded-3xl border-2 border-dashed border-gray-700">
             <p class="text-gray-500 text-xl italic">No servers have registered yet.</p>
          </div>
        )}
      </div>
      
      <div class="mt-20 text-center">
        <p class="text-gray-500 mb-4">Are you a server administrator?</p>
        <a href="/auth/steam" class="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-6 py-3 rounded-xl font-bold transition">
           <img src="https://community.cloudflare.steamstatic.com/public/images/signinthroughsteam/sits_01.png" alt="Login" class="h-6" />
        </a>
      </div>
    </div>
  )
}
