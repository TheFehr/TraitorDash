import { Heartbeat } from './Heartbeat'
import type { MapRow, MapsState } from '../services/Store'

// RFC 10: what the bridge reported about the server's maps. "Votable" is worked out by the bridge
// from the vote addon's prefixes (or the gamemode's map pattern), the current map and the cooldown
// list; the addon itself does not publish its pool, so the page says where the answer came from.

export const fmtMapSize = (bytes: number | null) => (bytes === null ? '–' : `${Math.round(bytes / 1024 / 1024)} MB`)

const Card = ({ label, value, sub }: { label: string, value: any, sub?: string }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl p-4 sm:p-5">
    <div class="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</div>
    <div class="text-2xl sm:text-3xl font-black mt-1 break-words">{value}</div>
    {sub && <div class="text-xs text-gray-500 mt-1 break-words">{sub}</div>}
  </div>
)

const Badge = ({ children, tone }: { children: any, tone: 'red' | 'green' | 'yellow' | 'gray' }) => {
  const tones = {
    red: 'border-red-500/50 text-red-400', green: 'border-green-500/50 text-green-400',
    yellow: 'border-yellow-500/50 text-yellow-400', gray: 'border-gray-600 text-gray-400',
  }
  return <span class={`inline-block text-[10px] font-black uppercase tracking-widest border rounded px-2 py-0.5 mr-1 ${tones[tone]}`}>{children}</span>
}

// Votable maps first, then the running map, then the rest; each group by name.
const rank = (m: MapRow) => (m.votable === true ? 0 : m.isCurrent ? 1 : 2)
export const sortMaps = (maps: MapRow[]) =>
  [...maps].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

const basisText = (s: MapsState) => {
  if (s.poolBasis === 'prefixes') {
    return `The pool is the maps that start with the vote addon's prefixes (settings: ${s.configSource ?? 'unknown'}), minus the running map and the maps on cooldown.`
  }
  if (s.poolBasis === 'gamemode') {
    return `No vote prefixes are known, so the pool is the maps matching the gamemode's map pattern${s.pattern ? ` (${s.pattern})` : ''}.`
  }
  return 'The pool is unknown: the server reported neither vote prefixes nor a gamemode map pattern.'
}

export interface MapsDashboardProps {
  server: { id: string, name: string }
  state: MapsState | null
  maps: MapRow[]
  /** The rule settings link only makes sense for admins. */
  admin?: boolean
}

export const MapsDashboard = ({ server, state, maps, admin }: MapsDashboardProps) => {
  const known = maps.some(m => m.votable !== null)
  const pool = maps.filter(m => m.inVotePool === true).length
  const votable = maps.filter(m => m.votable === true).length
  return (
    <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
      <header>
        <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
          <a href="/" class="hover:text-white transition">Dashboard</a>
          <span>/</span>
          {admin ? <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a> : <span>{server.name}</span>}
          <span>/</span>
          <span class="text-red-500">Maps</span>
        </nav>
        <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">Maps</h1>
        <p class="text-gray-400 text-lg">{server.name}</p>
      </header>

      {state === null ? (
        <div class="bg-gray-800 border border-gray-700 rounded-xl p-8 text-gray-400">
          No map report yet. The server sends its maps when the bridge starts; if the server is running a recent bridge, this page fills in within a minute.
        </div>
      ) : (
        <>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Card label="Maps on disk" value={maps.length} />
            <Card label="In the vote pool" value={known ? pool : '–'} />
            <Card label="Votable now" value={known ? votable : '–'} />
            <Card label="Running map" value={state.current ?? '–'} sub={state.next ? `Next: ${state.next}` : undefined} />
          </div>

          <section class="space-y-2 text-sm text-gray-400">
            <p>{basisText(state)}</p>
            <p>This list is worked out from what the server reports; the vote addon does not publish its pool, so it can differ from a real vote.</p>
            <p class="text-xs text-gray-500">Reported <Heartbeat lastSeen={state.reportedAt} /></p>
          </section>

          <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-[10px] uppercase tracking-widest text-gray-500">
                <tr><th class="text-left p-3">Map</th><th class="text-left p-3">Status</th><th class="text-right p-3">Size</th></tr>
              </thead>
              <tbody>
                {sortMaps(maps).map(m => (
                  <tr class="border-t border-gray-700">
                    <td class="p-3 font-bold break-all">{m.name}</td>
                    <td class="p-3">
                      {m.isCurrent && <Badge tone="red">Current</Badge>}
                      {m.name === state.next && <Badge tone="yellow">Next</Badge>}
                      {m.votable === true && <Badge tone="green">Votable</Badge>}
                      {m.onCooldown === true && <Badge tone="gray">Cooldown</Badge>}
                      {m.inCycle === true && <Badge tone="gray">In map cycle</Badge>}
                      {m.inVotePool === false && <Badge tone="gray">Not in the pool</Badge>}
                    </td>
                    <td class="p-3 text-right text-gray-400">{fmtMapSize(m.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
