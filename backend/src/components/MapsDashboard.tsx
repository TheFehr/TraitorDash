import { Heartbeat } from './Heartbeat'
import type { MapRow, MapsState, MapPlanMeta } from '../services/Store'
import { heightColour, type Level } from '../services/mapplan'

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

// The scale of the pictures as a CSS gradient, from the same colours the pictures use.
const SCALE = `linear-gradient(to right, ${[0, 1, 2, 3, 4, 5, 6].map(i => heightColour(i / 6)).join(', ')})`

const Swatch = ({ style, dot }: { style: string, dot?: boolean }) => (
  <span class="relative inline-block w-5 h-5 rounded-sm shrink-0 align-middle" style={style}>
    {dot && <span class="absolute left-0.5 top-0.5 w-1 h-1 bg-white"></span>}
  </span>
)

/** What the colours and marks in the floor-plan pictures mean. */
const PlanLegend = ({ cells }: { cells: number[] }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4 text-sm text-gray-300 space-y-3" data-legend="plans">
    <h3 class="text-xs font-black uppercase tracking-widest text-gray-400">How to read these pictures</h3>
    <div>
      <div class="h-3 rounded" style={`background:${SCALE}`}></div>
      <div class="flex justify-between text-xs text-gray-400 mt-1"><span>lowest floor of the level</span><span>highest floor of the level</span></div>
      <p class="text-xs text-gray-500 mt-1">Each picture is one level and has its own scale: the exact heights are under it. Stairs and ramps show as a gradient.</p>
    </div>
    <ul class="space-y-2">
      <li class="flex items-center gap-3"><Swatch style={`background:${heightColour(0.5)};opacity:.4`} dot /> <span><b>Crouch-only</b>: a floor you can only reach by crouching or crawling (vents, crawl spaces).</span></li>
      <li class="flex items-center gap-3"><Swatch style="background:#111;border:1px solid #444" /> <span><b>No floor a player can reach</b> from a spawn point on this level: walls, voids, other levels, or never scanned.</span></li>
    </ul>
    <p class="text-xs text-gray-500">North is up. One square is one grid cell of {cells.join(' / ')} units. A spot with floors on several levels shows in each of them.</p>
  </div>
)

export interface MapsDashboardProps {
  server: { id: string, name: string }
  state: MapsState | null
  maps: MapRow[]
  /** Admins also see the file sizes and how many maps are on disk, and may ask for the maps outside the pool. */
  admin?: boolean
  /** The stored floor plans (RFC 10, 4.5); only listed for admins. */
  plans?: (MapPlanMeta & { levels: Level[] })[]
  /** An admin's opt-in (?all=1) to list the maps outside the vote pool; never honoured for guests. */
  showAll?: boolean
}

export const MapsDashboard = ({ server, state, maps, admin, showAll, plans }: MapsDashboardProps) => {
  // Players only care about the maps the vote can offer. A map the bridge could not classify is shown.
  const outside = maps.filter(m => m.inVotePool === false).length
  const listed = admin && showAll ? maps : maps.filter(m => m.inVotePool !== false)
  const known = maps.some(m => m.votable !== null)
  // With an empty map cycle the engine names the running map as the next one; the vote decides, so that is no information.
  const next = state && state.next && state.next !== state.current ? state.next : null
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
          <div class={`grid grid-cols-2 gap-3 sm:gap-4 ${admin ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            {admin && <Card label="Maps on disk" value={maps.length} />}
            <Card label="In the vote pool" value={known ? pool : '–'} />
            <Card label="Votable now" value={known ? votable : '–'} />
            <Card label="Running map" value={state.current ?? '–'} sub={next ? `Next: ${next}` : undefined} />
          </div>

          <section class="space-y-2 text-sm text-gray-400">
            <p>{basisText(state)}</p>
            <p>This list is worked out from what the server reports; the vote addon does not publish its pool, so it can differ from a real vote.</p>
            <p class="text-xs text-gray-500">Reported <Heartbeat lastSeen={state.reportedAt} /></p>
          </section>

          {admin && outside > 0 && (
            <p class="text-sm">
              {showAll
                ? <a href={`/servers/${server.id}/maps`} class="text-gray-400 hover:text-white underline">Hide maps outside the pool</a>
                : <a href={`/servers/${server.id}/maps?all=1`} class="text-gray-400 hover:text-white underline">Show {outside} {outside === 1 ? 'map' : 'maps'} outside the pool</a>}
            </p>
          )}

          <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-[10px] uppercase tracking-widest text-gray-500">
                <tr><th class="text-left p-3">Map</th><th class="text-left p-3">Status</th>{admin && <th class="text-right p-3">Size</th>}</tr>
              </thead>
              <tbody>
                {sortMaps(listed).map(m => (
                  <tr class="border-t border-gray-700">
                    <td class="p-3 font-bold break-all">{m.name}</td>
                    <td class="p-3">
                      {m.isCurrent && <Badge tone="red">Current</Badge>}
                      {m.name === next && <Badge tone="yellow">Next</Badge>}
                      {m.votable === true && <Badge tone="green">Votable</Badge>}
                      {m.onCooldown === true && <Badge tone="gray">Cooldown</Badge>}
                      {m.inCycle === true && <Badge tone="gray">In map cycle</Badge>}
                      {m.inVotePool === false && <Badge tone="gray">Not in the pool</Badge>}
                    </td>
                    {admin && <td class="p-3 text-right text-gray-400">{fmtMapSize(m.size)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {admin && plans && plans.length > 0 && (
            <section>
              <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Floor plans</h2>
              <PlanLegend cells={[...new Set(plans.map(p => p.cell))]} />
              <ul class="bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700">
                {plans.map(p => {
                  const known = maps.find(m => m.name === p.map)
                  const outdated = !!(p.fingerprint && known?.fingerprint && p.fingerprint !== known.fingerprint)
                  return (
                    <li class="p-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span class="font-bold break-all">{p.map} {outdated && <Badge tone="yellow">Outdated</Badge>}</span>
                      <span class="text-sm text-gray-400">{p.floorCells} floor cells, {p.crouchFloors} crouch-only</span>
                      <span class="text-xs text-gray-500">scanned <Heartbeat lastSeen={p.scannedAt} /></span>
                      <span class="ml-auto text-sm space-x-3">
                        <a class="text-gray-400 hover:text-white underline" href={`/servers/${server.id}/maps/${p.map}/plan.svg`}>All floors</a>
                        <a class="text-gray-400 hover:text-white underline" href={`/servers/${server.id}/maps/${p.map}/plan.json`}>JSON</a>
                      </span>
                      <div class="basis-full grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {p.levels.map(l => (
                          <figure class="space-y-1">
                            <a href={`/servers/${server.id}/maps/${p.map}/plan.svg?level=${l.index}`}>
                              <img class="w-full max-h-[60vh] object-contain rounded-lg bg-gray-900" loading="lazy" alt={`Floor plan of ${p.map}, level ${l.index}`}
                                   src={`/servers/${server.id}/maps/${p.map}/plan.svg?level=${l.index}`} />
                            </a>
                            <div class="h-1.5 rounded" style={`background:${SCALE}`} data-scale={`${p.map} ${l.index} ${l.lo} ${l.hi}`}></div>
                            <figcaption class="text-xs text-gray-400 flex justify-between gap-2">
                              <span>{l.lo}</span>
                              <span class="text-center">Level {l.index} of {p.levels.length}, {l.cells} floor cells</span>
                              <span>{l.hi}</span>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
