export const ServerManager = ({ servers }: { servers: any[] }) => {
  return (
    <div class="space-y-8">
      <div class="bg-gray-800 rounded-xl p-8 border border-gray-700">
        <h2 class="text-2xl font-bold mb-6">Manage Servers</h2>
        
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="text-gray-500 uppercase text-xs font-bold border-b border-gray-700">
                <th class="pb-4 px-4">Server Name</th>
                <th class="pb-4 px-4">Status</th>
                <th class="pb-4 px-4">API Token (Secret)</th>
                <th class="pb-4 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-700">
              {servers.map(server => {
                 const isOnline = server.last_seen && (new Date().getTime() - new Date(server.last_seen + 'Z').getTime()) < 30000
                 return (
                  <tr class="group hover:bg-gray-700/30 transition">
                    <td class="py-4 px-4 font-medium">{server.name}</td>
                    <td class="py-4 px-4">
                      <span class={`flex items-center gap-2 ${isOnline ? 'text-green-400' : 'text-gray-500'}`}>
                        <div class={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-700'}`}></div>
                        {isOnline ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td class="py-4 px-4 font-mono text-sm text-gray-400">
                      <div class="flex items-center gap-2" x-data="{ copied: false }">
                        <span>{server.api_token}</span>
                        <button 
                          class="text-gray-600 hover:text-white transition relative flex items-center" 
                          title="Copy Token"
                          x-on:click={`navigator.clipboard.writeText('${server.api_token}'); copied = true; setTimeout(() => copied = false, 2000)`}
                        >
                          <span x-show="!copied">📋</span>
                          <span x-show="copied" x-cloak="true" class="text-green-500 text-xs font-bold animate-bounce">✓</span>
                          <div 
                            x-show="copied" 
                            x-cloak="true"
                            x-transition="true"
                            class="absolute -top-8 left-1/2 -translate-x-1/2 bg-green-500 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap"
                          >
                            Copied!
                          </div>
                        </button>
                      </div>
                    </td>
                    <td class="py-4 px-4 text-right">
                      <button 
                        hx-delete={`/api/servers/${server.id}`}
                        hx-confirm={`Are you sure you want to delete ${server.name}?`}
                        hx-target="#config-area"
                        class="text-red-500 hover:text-red-400 font-bold"
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
      </div>

      <div class="bg-gray-800 rounded-xl p-8 border border-gray-700">
        <h3 class="text-xl font-bold mb-4">Add New Server</h3>
        <form hx-post="/api/servers" hx-target="#config-area" class="flex gap-4">
          <input 
            type="text" 
            name="name" 
            placeholder="Server Name (e.g. TTT2 West #1)"
            class="flex-1 bg-gray-700 border border-gray-600 rounded-lg p-3 text-white focus:ring-2 focus:ring-red-500 outline-none"
            required
          />
          <button type="submit" class="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-lg font-bold transition">
            Create Server
          </button>
        </form>
      </div>
    </div>
  )
}
