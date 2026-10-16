import { isServerOnline } from '../services/ServerUtils'
import { Heartbeat } from './Heartbeat'

type NewToken = { serverId: string, token: string }

export const ServerManager = ({ servers, newToken }: { servers: any[], newToken?: NewToken }) => {
  return (
    <div id="server-manager" class="space-y-8">
      {newToken && (
        <div class="bg-yellow-500/10 border border-yellow-500/50 rounded-xl p-6" x-data="{ copied: false }">
          <h3 class="text-lg font-bold text-yellow-400 mb-1">New API token</h3>
          <p class="text-sm text-gray-300 mb-4">
            Copy it now. It is stored only as a hash, so it cannot be shown again. Lose it and you have to regenerate.
          </p>
          <div class="flex items-center gap-3">
            <code class="flex-1 bg-gray-900 rounded-lg px-4 py-3 font-mono text-sm break-all select-all">{newToken.token}</code>
            <button
              type="button"
              class="px-4 py-3 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-gray-900 font-bold transition"
              x-on:click={`navigator.clipboard.writeText('${newToken.token}'); copied = true; setTimeout(() => copied = false, 2000)`}
            >
              <span x-show="!copied">Copy</span>
              <span x-show="copied" x-cloak="true">Copied</span>
            </button>
          </div>
        </div>
      )}

      <div class="bg-gray-800 rounded-xl p-8 border border-gray-700">
        <h2 class="text-2xl font-bold mb-6">Manage Servers</h2>

        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="text-gray-500 uppercase text-xs font-bold border-b border-gray-700">
                <th class="pb-4 px-4">Server Name</th>
                <th class="pb-4 px-4">ID</th>
                <th class="pb-4 px-4">Status</th>
                <th class="pb-4 px-4">Last heartbeat</th>
                <th class="pb-4 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-700">
              {servers.map(server => {
                const isOnline = isServerOnline(server.last_seen)
                return (
                  <tr class="group hover:bg-gray-700/30 transition">
                    <td class="py-4 px-4 font-medium">{server.name}</td>
                    <td class="py-4 px-4 font-mono text-xs text-gray-500">{server.id}</td>
                    <td class="py-4 px-4">
                      <span class={`flex items-center gap-2 ${isOnline ? 'text-green-400' : 'text-gray-500'}`}>
                        <div class={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-700'}`}></div>
                        {isOnline ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td class="py-4 px-4 text-sm text-gray-400"><Heartbeat lastSeen={server.last_seen} /></td>
                    <td class="py-4 px-4 text-right whitespace-nowrap">
                      <button
                        hx-post={`/api/servers/${server.id}/regenerate-token`}
                        hx-confirm={`Regenerate the token for ${server.name}? The current token stops working immediately.`}
                        hx-target="#server-manager"
                        hx-swap="outerHTML"
                        class="mr-3 px-3 py-1.5 rounded-lg border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 text-xs font-bold uppercase tracking-wider transition"
                      >
                        Regen token
                      </button>
                      <button
                        hx-delete={`/api/servers/${server.id}`}
                        hx-confirm={`Are you sure you want to delete ${server.name}?`}
                        hx-target="#server-manager"
                        hx-swap="outerHTML"
                        class="text-red-500 hover:text-red-400 text-xs font-bold uppercase tracking-wider"
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
        <form hx-post="/api/servers" hx-target="#server-manager" hx-swap="outerHTML" class="flex gap-4">
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
