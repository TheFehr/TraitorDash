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

export const Badge = ({ children, tone }: { children: any, tone: 'red' | 'green' | 'yellow' | 'gray' }) => {
  const tones = {
    red: 'border-red-500/50 text-red-400', green: 'border-green-500/50 text-green-400',
    yellow: 'border-yellow-500/50 text-yellow-400', gray: 'border-gray-600 text-gray-400',
  }
  return <span class={`inline-block text-[10px] font-black uppercase tracking-widest border rounded px-2 py-0.5 mr-1 ${tones[tone]}`}>{children}</span>
}

/** The marks of a map's status, as in the list and on the map's own page. */
export const StatusBadges = ({ m, next }: { m: MapRow, next: string | null }) => (
  <>
    {m.isCurrent && <Badge tone="red">Current</Badge>}
    {m.name === next && <Badge tone="yellow">Next</Badge>}
    {m.votable === true && <Badge tone="green">Votable</Badge>}
    {m.onCooldown === true && <Badge tone="gray">Cooldown</Badge>}
    {m.inCycle === true && <Badge tone="gray">In map cycle</Badge>}
    {m.inVotePool === false && <Badge tone="gray">Not in the pool</Badge>}
  </>
)

/** A plan scanned for another version of the map than the one the server runs now. */
export const planOutdated = (plan: { fingerprint: string | null }, m: MapRow | undefined) =>
  !!(plan.fingerprint && m?.fingerprint && plan.fingerprint !== m.fingerprint)

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
export const SCALE = `linear-gradient(to right, ${[0, 1, 2, 3, 4, 5, 6].map(i => heightColour(i / 6)).join(', ')})`

const Swatch = ({ style, dot }: { style: string, dot?: boolean }) => (
  <span class="relative inline-block w-5 h-5 rounded-sm shrink-0 align-middle" style={style}>
    {dot && <span class="absolute left-0.5 top-0.5 w-1 h-1 bg-white"></span>}
  </span>
)

/** What the colours and marks in the floor-plan pictures mean. */
export const PlanLegend = ({ cells }: { cells: number[] }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4 text-sm text-gray-300 space-y-3" data-legend="plans">
    <h3 class="text-xs font-black uppercase tracking-widest text-gray-400">How to read these pictures</h3>
    <div>
      <div class="h-3 rounded" style={`background:${SCALE}`}></div>
      <div class="flex justify-between text-xs text-gray-400 mt-1"><span>lowest floor of the level</span><span>highest floor of the level</span></div>
      <p class="text-xs text-gray-500 mt-1">Each picture is one level and has its own scale, drawn at the bottom of the picture. Stairs and ramps show as a gradient.</p>
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
  /** Which maps have a stored floor plan (RFC 10, 4.5); only given to admins, who get a mark and a link to the map's page. */
  plans?: MapPlanMeta[]
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
                    <td class="p-3 font-bold break-all">
                      {admin ? <a class="hover:text-red-400 transition" href={`/servers/${server.id}/maps/${m.name}`}>{m.name}</a> : m.name}
                    </td>
                    <td class="p-3">
                      <StatusBadges m={m} next={next} />
                      {admin && plans?.some(p => p.map === m.name) && (
                        <a href={`/servers/${server.id}/maps/${m.name}`}><Badge tone="green">Floor plan</Badge></a>
                      )}
                      {admin && plans?.some(p => p.map === m.name && planOutdated(p, m)) && <Badge tone="yellow">Outdated</Badge>}
                    </td>
                    {admin && <td class="p-3 text-right text-gray-400">{fmtMapSize(m.size)}</td>}
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

export interface MapPageProps {
  server: { id: string, name: string }
  /** The map as the server reported it, or null when it only has a plan left. */
  map: MapRow | null
  name: string
  next: string | null
  plan: (MapPlanMeta & { levels: Level[] }) | null
  /** Exact geometry (RFC 11); undefined when the operator has not switched the feature on. */
  geometry?: { requested: boolean, status?: string, detail?: string | null, info?: { vertices: number, triangles: number, levels: number } | null }
}

const MV_BTN = 'px-3 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-white aria-pressed:bg-red-600 aria-pressed:border-red-500 aria-pressed:text-white transition'

const GeometryBadge = ({ status }: { status: string }) => {
  const tone = status === 'parsed' ? 'green' : status === 'failed' ? 'red' : 'yellow'
  const label = { queued: 'Queued', fetching: 'Fetching', parsed: 'Parsed', failed: 'Failed', unknown: 'Unknown' }[status] ?? 'Unknown'
  return <Badge tone={tone}>{label}</Badge>
}

/** One map: its status, and its floor plan, a picture per level (RFC 10, 4.5). Admins only. */
export const MapPage = ({ server, map, name, next, plan, geometry }: MapPageProps) => (
  <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex flex-wrap gap-x-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a>
        <span>/</span>
        <a href={`/servers/${server.id}/maps`} class="hover:text-white transition">Maps</a>
        <span>/</span>
        <span class="text-red-500 break-all">{name}</span>
      </nav>
      <h1 class="text-3xl sm:text-5xl font-black mb-3 break-all">{name}</h1>
      <div class="flex flex-wrap items-center gap-y-2 text-sm text-gray-400">
        {map ? <><StatusBadges m={map} next={next} /><span class="ml-2">{fmtMapSize(map.size)}</span></> : <span>Not in the server's latest map list.</span>}
      </div>
    </header>

    {geometry && (
      <section>
        <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Exact geometry</h2>
        <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 space-y-3 text-sm text-gray-300">
          {!geometry.requested ? (
            <p>Off. Turning it on makes the backend fetch this map's file from the Steam Workshop once and keep a simplified 3D mesh of its floors and walls. The file itself is deleted afterwards.</p>
          ) : (
            <p class="flex flex-wrap items-center gap-2">
              <GeometryBadge status={geometry.status ?? 'queued'} />
              {geometry.status === 'parsed' && geometry.info && <span>{geometry.info.triangles} triangles, {geometry.info.levels} {geometry.info.levels === 1 ? 'level' : 'levels'}</span>}
              {geometry.status === 'failed' && geometry.detail && <span class="text-gray-400">{geometry.detail}</span>}
              {geometry.status === 'unknown' && <span class="text-gray-400">The server has not reported a fingerprint for this map.</span>}
            </p>
          )}
          <form method="post" action={`/servers/${server.id}/maps/${encodeURIComponent(name)}/geometry`} class="flex flex-wrap gap-3">
            <input type="hidden" name="on" value={geometry.requested ? '0' : '1'} />
            <button type="submit" class="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-bold transition">{geometry.requested ? 'Turn off' : 'Turn on'}</button>
            {geometry.status === 'parsed' && <a class="px-4 py-2 rounded-lg text-gray-300 hover:text-white underline" href={`/servers/${server.id}/maps/${encodeURIComponent(name)}/mesh.glb`}>Download GLB</a>}
          </form>
        </div>
      </section>
    )}

    {geometry?.status === 'parsed' && geometry.info && (
      <section>
        <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">3D view</h2>
        <div data-mapview data-src={`/servers/${server.id}/maps/${encodeURIComponent(name)}/mesh.glb`} class="space-y-3">
          <div class="relative">
            <canvas class="block w-full h-[60vh] rounded-xl bg-gray-900 touch-none" aria-label={`3D view of ${name}`}></canvas>
            <p data-status class="absolute inset-0 grid place-items-center text-sm text-gray-400 pointer-events-none">This view needs JavaScript.</p>
          </div>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Levels shown">
              <span class="text-xs font-black uppercase tracking-widest text-gray-500 mr-2">Up to level</span>
              {Array.from({ length: geometry.info.levels }, (_, i) => i + 1).map(n => (
                <button type="button" data-level={n} aria-pressed="false" class={MV_BTN}>{n}</button>
              ))}
              <button type="button" data-level="all" aria-pressed="true" class={MV_BTN}>All</button>
            </div>
            <div class="flex items-center gap-1" role="group" aria-label="View">
              <button type="button" data-view="orbit" class={MV_BTN}>3D</button>
              <button type="button" data-view="top" class={MV_BTN}>From above</button>
            </div>
            <label class="flex items-center gap-2 text-gray-300"><input type="checkbox" data-walls checked /> Walls</label>
          </div>
          <p class="text-xs text-gray-500">Drag to turn, scroll or pinch to zoom, right-drag to move. Floors are coloured by level, lowest green. A simplified map (no doors, glass or props): it shows the layout, not what a player could see.</p>
        </div>
        <script defer src="/public/mapview.js"></script>
      </section>
    )}

    <section>
      <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Floor plan</h2>
      {plan === null ? (
        <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 text-gray-400 text-sm">
          No floor plan yet. Run <code class="text-gray-200">traitordash_mapscan</code> in the server console while this map is running; the result appears here within a few seconds.
        </div>
      ) : (
        <>
          <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-4">
            <span class="text-gray-300">{plan.floorCells} floor cells, {plan.crouchFloors} crouch-only</span>
            {planOutdated(plan, map ?? undefined) && <Badge tone="yellow">Outdated</Badge>}
            <span class="text-xs text-gray-500">scanned <Heartbeat lastSeen={plan.scannedAt} /></span>
            <span class="ml-auto text-sm space-x-3">
              <a class="text-gray-400 hover:text-white underline" href={`/servers/${server.id}/maps/${name}/plan.svg`}>All floors</a>
              <a class="text-gray-400 hover:text-white underline" href={`/servers/${server.id}/maps/${name}/plan.json`}>JSON</a>
            </span>
          </div>
          <PlanLegend cells={[plan.cell]} />
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {plan.levels.map(l => (
              <figure class="space-y-1">
                <a href={`/servers/${server.id}/maps/${name}/plan.svg?level=${l.index}`}>
                  <img class="w-full max-h-[60vh] object-contain rounded-lg bg-gray-900" loading="lazy" alt={`Floor plan of ${name}, level ${l.index}`}
                       src={`/servers/${server.id}/maps/${name}/plan.svg?level=${l.index}`} />
                </a>
                <figcaption class="text-xs text-gray-400">
                  Level {l.index} of {plan.levels.length}: {l.lo === l.hi ? l.lo : `${l.lo} to ${l.hi}`} units, {l.cells} floor cells
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </section>
  </div>
)
