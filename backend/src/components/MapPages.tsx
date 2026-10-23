import { Sections, Shell } from './CaseFile'
import { Bar, Crumbs, ServerName, Num, When, Who, adminOf, link, teamHex, type Ctx } from './kit'
import { signinUrl } from '../middleware/session'
import { duration, mapSize } from '../format'
import { teamLabel } from '../teamColours'
import { prettyMap } from '../mapName'
import { heightColour, type Level } from '../services/mapplan'
import type { MapActivity } from '../services/stats'
import type { MapPlanMeta, MapRow, MapsState } from '../services/Store'
import type { GeometryInfo } from '../services/mapgeometry'

// Maps (RFC 10, 11, 16, 17): the list of the maps the server can play, one map with what its rounds
// say, and a map's own view: the 3D view for a signed-in visitor, the floor plan for an admin. The same
// pages on the website and in the game's window.

const here = (serverId: string) => `/servers/${serverId}`
const mapPath = (serverId: string, name: string) => `${here(serverId)}/maps/${encodeURIComponent(name)}`

// The maps a player can meet: the vote pool, running map and votable ones first.
const rank = (m: MapRow) => (m.votable === true ? 0 : m.isCurrent ? 1 : 2)

/** The maps the page lists: those the vote can offer, plus any the bridge could not classify; an admin may ask for all. */
export const listedMaps = (maps: MapRow[], all = false): MapRow[] =>
  (all ? maps : maps.filter(m => m.inVotePool !== false)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

/** With an empty map cycle the engine names the running map as the next one; the vote decides, so that is no information. */
export const nextOf = (state: MapsState | null): string | null => (state && state.next && state.next !== state.current ? state.next : null)

/** A plan scanned for another version of the map than the one the server runs now. */
export const planOutdated = (plan: { fingerprint: string | null }, m: MapRow | undefined) =>
  !!(plan.fingerprint && m?.fingerprint && plan.fingerprint !== m.fingerprint)

const basisText = (s: MapsState) => {
  if (s.poolBasis === 'prefixes') {
    return `The pool is the maps that start with the vote addon's prefixes (settings: ${s.configSource ?? 'unknown'}), minus the running map and the maps on cooldown.`
  }
  if (s.poolBasis === 'gamemode') {
    return `No vote prefixes are known, so the pool is the maps matching the gamemode's map pattern${s.pattern ? ` (${s.pattern})` : ''}.`
  }
  return 'The pool is unknown: the server reported neither vote prefixes nor a gamemode map pattern.'
}

const Pills = ({ m, next }: { m: MapRow, next: string | null }) => (
  <>
    {m.isCurrent && <i class="pill ok">Current</i>}
    {m.name === next && <i class="pill wait">Next</i>}
    {m.votable === true && <i class="pill ok">Votable</i>}
    {m.onCooldown === true && <i class="pill mute">Cooldown</i>}
    {m.inCycle === true && <i class="pill mute">In map cycle</i>}
    {m.inVotePool === false && <i class="pill mute">Not in the pool</i>}
  </>
)

const tabColour = (m: MapRow | null | undefined) => (m?.votable === true ? '#22c55e' : m?.isCurrent ? '#e9b44c' : '#9ca3af')

const Split = ({ results, rounds }: { results: { name: string, n: number }[], rounds: number }) => (
  <div class="split" aria-hidden="true">
    {results.map(r => <i style={`--c:${teamHex(r.name)};width:${(r.n / rounds) * 100}%`}></i>)}
  </div>
)

export interface MapsPageProps {
  ctx: Ctx
  server: { id: string, name: string }
  state: MapsState | null
  maps: MapRow[]
  activity: Map<string, MapActivity>
  /** An admin's opt-in (?all=1) to list the maps outside the vote pool; never honoured for guests. */
  showAll?: boolean
  /** Which maps have a stored floor plan (RFC 10, 4.5); given to admins only. */
  plans?: MapPlanMeta[]
  /** The maps that have a 3D view (RFC 11), when the visitor may be offered it (RFC 13). */
  meshes?: Set<string>
  /** How many days a 3D view is logged (RFC 13, 6.3); 0 means it is not. */
  viewLogDays?: number
}

export const MapsPage = ({ ctx, server, state, maps, activity, showAll, plans, meshes, viewLogDays = 0 }: MapsPageProps) => {
  const id = server.id
  const admin = adminOf(ctx)
  const next = nextOf(state)
  const outside = maps.filter(m => m.inVotePool === false).length
  const listed = listedMaps([...maps], admin && !!showAll)
  const known = maps.some(m => m.votable !== null)
  return (
    <Shell title={`Maps | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer}>
      <Crumbs><ServerName ctx={ctx} server={server} /></Crumbs>
      <h1>Map files</h1>
      {!ctx.embed && <Sections serverId={id} current="maps" />}
      {state === null || maps.length === 0
        ? <div class="f"><h2 class="ft">No maps yet</h2><span>The server sends its maps when the bridge starts; this page fills in within a minute of that.</span></div>
        : (
          <>
            <div class="nums">
              {admin && <Num label="Maps on disk" value={maps.length} />}
              <Num label="In the vote pool" value={known ? maps.filter(m => m.inVotePool === true).length : '–'} />
              <Num label="Votable now" value={known ? maps.filter(m => m.votable === true).length : '–'} />
              <Num label="Running map" value={state.current ? prettyMap(state.current) : '–'} />
            </div>
            <div class="g">
              {listed.map(m => {
                const a = activity.get(m.name)
                const plan = plans?.find(p => p.map === m.name)
                return (
                  <div class="f card" style={`--c:${tabColour(m)}`}>
                    <h2 class="ft"><a href={link(ctx, `${mapPath(id, m.name)}/rounds`)}>{prettyMap(m.name)}</a></h2>
                    <span class="file">{m.name}</span>
                    <span><Pills m={m} next={next} />{admin && <i class="pill mute">{mapSize(m.size)}</i>}</span>
                    {a
                      ? <><Split results={a.results} rounds={a.rounds} /><span>{a.rounds} {a.rounds === 1 ? 'round' : 'rounds'} · last <When iso={a.lastRound} now={ctx.now} /></span></>
                      : <span class="dim">Not played yet</span>}
                    {/* An admin's 3D view and floor plan are one page: one pill, not two that lead to the same place */}
                    {admin && plan && meshes?.has(m.name) && ctx.viewer
                      ? <span><a data-3d class="pill ok" href={link(ctx, mapPath(id, m.name))}>3D · Floor plan</a>{planOutdated(plan, m) && <i class="pill wait">Outdated</i>}</span>
                      : <>
                        {admin && plan && <span><a class="pill ok" href={mapPath(id, m.name)}>Floor plan</a>{planOutdated(plan, m) && <i class="pill wait">Outdated</i>}</span>}
                        {meshes?.has(m.name) && (ctx.viewer
                          ? <span><a data-3d class="pill ok" href={link(ctx, mapPath(id, m.name))}>3D</a></span>
                          : ctx.signinOpen && !ctx.embed
                            ? <span><a data-3d-signin class="pill mute" href={signinUrl(mapPath(id, m.name))}>3D: sign in</a></span>
                            : <span><i data-3d-locked class="pill mute">3D: sign in</i></span>)}
                      </>}
                  </div>
                )
              })}
            </div>
            {admin && outside > 0 && (
              <p class="foot">
                {showAll
                  ? <a href={link(ctx, `${here(id)}/maps`)}>Hide maps outside the pool</a>
                  : <a href={link(ctx, `${here(id)}/maps`, { all: true })}>Show {outside} {outside === 1 ? 'map' : 'maps'} outside the pool</a>}
              </p>
            )}
            <p class="foot">The maps the vote can offer.{ctx.embed ? '' : ' '}{!ctx.embed && basisText(state)}</p>
            {!ctx.embed && <p class="foot">This list is worked out from what the server reports; the vote addon does not publish its pool, so it can differ from a real vote.</p>}
            {!ctx.embed && <p class="foot">Reported <When iso={state.reportedAt} now={ctx.now} />.</p>}
            {!admin && meshes && meshes.size > 0 && (
              <p data-3d-note class="foot">
                The 3D views are for signed-in visitors: any Steam account can sign in.
                {viewLogDays ? ` Opening one is logged with your SteamID64 for ${viewLogDays} days.` : ''}
              </p>
            )}
          </>
        )}
      <Who ctx={ctx} />
    </Shell>
  )
}

export interface MapFileProps {
  ctx: Ctx
  server: { id: string, name: string }
  name: string
  map: MapRow | null
  state: MapsState | null
  activity: MapActivity | null
  /** The map has a 3D view. */
  has3d: boolean
  /** An admin's map may also have a floor plan. */
  hasPlan?: boolean
  viewLogDays?: number
}

/** What the rounds on one map say, and the way to its own view. */
export const MapFilePage = ({ ctx, server, name, map, state, activity, has3d, hasPlan, viewLogDays = 0 }: MapFileProps) => {
  const id = server.id
  const admin = adminOf(ctx)
  const next = nextOf(state)
  const view = link(ctx, mapPath(id, name))
  return (
    <Shell title={`${name} | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer}>
      <Crumbs><a href={link(ctx, `${here(id)}/maps`)}>All maps</a> / {prettyMap(name)}</Crumbs>
      {!ctx.embed && <Sections serverId={id} current="maps" />}
      <div class="f big" style={`--c:${tabColour(map)}`}>
        <h1>{prettyMap(name)}</h1>
        <p class="file" style="margin:.2rem 0 0">{name}</p>
        {map && <p style="margin:.5rem 0 0"><Pills m={map} next={next} />{admin && <i class="pill mute">{mapSize(map.size)}</i>}</p>}
        {!map && <p class="none">Not in the server's latest map list.</p>}
        {activity ? (
          <>
            <h2>Rounds on this map</h2>
            <dl class="ledger">
              <div><dt>Played</dt><dd>{activity.rounds}</dd></div>
              <div><dt>Average round</dt><dd>{duration(activity.avgDuration)}</dd></div>
              <div><dt>Last round</dt><dd><When iso={activity.lastRound} now={ctx.now} /></dd></div>
            </dl>
            <h2>Who wins here</h2>
            {activity.results.slice(0, 5).map(r => <Bar label={teamLabel(r.name)} part={r.n} whole={activity.rounds} colour={teamHex(r.name)} />)}
          </>
        ) : <p class="none">No round has been played on this map yet.</p>}
        {has3d && (
          <p style="margin:1rem 0 0">
            {ctx.viewer
              ? <><a class="btn" href={view}>View in 3D</a>{viewLogDays > 0 && <span class="dim" style="margin-left:.6rem">Opening it is logged with your SteamID64 for {viewLogDays} days.</span>}</>
              : ctx.signinOpen && !ctx.embed
                ? <a class="btn" href={signinUrl(mapPath(id, name))}>Sign in to view in 3D</a>
                : <span class="dim">This map has a 3D view. It opens for signed-in visitors.</span>}
          </p>
        )}
        {admin && (
          <p style="margin:1rem 0 0"><a class="btn" href={view}>{hasPlan ? 'Floor plan and settings' : 'Settings'}</a></p>
        )}
        {!admin && <p class="foot dark">The floor plan is on the website, for admins.</p>}
      </div>
      <Who ctx={ctx} />
    </Shell>
  )
}

/** The scale of the pictures as a CSS gradient, from the same colours the pictures use. */
export const SCALE = `linear-gradient(to right, ${[0, 1, 2, 3, 4, 5, 6].map(i => heightColour(i / 6)).join(', ')})`

/** What the colours and marks in the floor-plan pictures mean. */
export const PlanLegend = ({ cells }: { cells: number[] }) => (
  <div class="f" style="--c:#9ca3af" data-legend="plans">
    <h2 class="ft">How to read these pictures</h2>
    <div class="scale" style={`background:${SCALE}`}></div>
    <div class="ends"><span>lowest floor of the level</span><span>highest floor of the level</span></div>
    <p>Each picture is one level and has its own scale, drawn at the bottom of the picture. Stairs and ramps show as a gradient.</p>
    <p><i class="sw" style={`background:${heightColour(0.5)};opacity:.4`}><i class="wd"></i></i><strong>Crouch-only</strong>: a floor you can only reach by crouching or crawling (vents, crawl spaces).</p>
    <p><i class="sw" style="background:#111;border:1px solid #444"></i> <strong>No floor a player can reach</strong> from a spawn point on this level: walls, voids, other levels, or never scanned.</p>
    <p class="dim">North is up. One square is one grid cell of {cells.join(' / ')} units. A spot with floors on several levels shows in each of them.</p>
  </div>
)

export interface MapViewProps {
  ctx: Ctx
  server: { id: string, name: string }
  map: MapRow | null
  name: string
  next: string | null
  plan: (MapPlanMeta & { levels: Level[] }) | null
  /** Exact geometry (RFC 11); undefined when the operator has not switched the feature on. */
  geometry?: { requested: boolean, status?: string, detail?: string | null, info?: GeometryInfo | null }
}

const GEOMETRY_LABEL: Record<string, string> = { queued: 'Queued', fetching: 'Fetching', parsed: 'Parsed', failed: 'Failed', unknown: 'Unknown' }

/** One map's own page: the geometry switch and the floor plan for an admin, the 3D view for a signed-in visitor. */
export const MapViewPage = ({ ctx, server, map, name, next, plan, geometry }: MapViewProps) => {
  const id = server.id
  const admin = adminOf(ctx)
  const hasView = geometry?.status === 'parsed' && !!geometry.info
  return (
    <Shell title={`${name} | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer} scripts={hasView ? ['/public/mapview.js'] : []}>
      <Crumbs><a href={link(ctx, `${here(id)}/maps`)}>All maps</a> / <a href={link(ctx, `${mapPath(id, name)}/rounds`)}>{prettyMap(name)}</a></Crumbs>
      {!ctx.embed && <Sections serverId={id} current="maps" />}
      <h1>{prettyMap(name)}</h1>
      <p class="file" style="margin:.1rem 0 .3rem">{name}</p>
      <p style="margin:.2rem 0 0">
        {map ? <><Pills m={map} next={next} /><span class="muted">{admin ? mapSize(map.size) : ''}</span></> : <span class="muted">Not in the server's latest map list.</span>}
      </p>

      {admin && geometry && (
        <div class="f" style="--c:#9ca3af;margin-top:1.2rem">
          <h2 class="ft">Exact geometry</h2>
          {!geometry.requested
            ? <p>Off. Turning it on makes the backend fetch this map's file from the Steam Workshop once and keep a simplified 3D mesh of its floors and walls. The file itself is deleted afterwards.</p>
            : (
              <p>
                <i class={`pill ${geometry.status === 'parsed' ? 'ok' : geometry.status === 'failed' ? 'wait' : 'mute'}`}>{GEOMETRY_LABEL[geometry.status ?? 'queued'] ?? 'Unknown'}</i>
                {geometry.status === 'parsed' && geometry.info && <span>{geometry.info.triangles} triangles, {geometry.info.levels} {geometry.info.levels === 1 ? 'level' : 'levels'}{geometry.info.water ? ', water' : ''}{geometry.info.props?.placed ? `, ${geometry.info.props.placed} props` : ''}</span>}
                {geometry.status === 'parsed' && geometry.info?.props?.cards ? <span class="dim"> {geometry.info.props.cards} {geometry.info.props.cards === 1 ? 'model has' : 'models have'} flat texture cards (trees, clouds), which are left out.</span> : null}
                {geometry.status === 'parsed' && geometry.info?.props?.unavailable ? <span class="dim"> {geometry.info.props.unavailable} {geometry.info.props.unavailable === 1 ? 'model belongs' : 'models belong'} to the game, not the map, and {geometry.info.props.unavailable === 1 ? 'is' : 'are'} not drawn.</span> : null}
                {geometry.status === 'parsed' && geometry.detail && <span class="dim"> {geometry.detail}</span>}
                {geometry.status === 'failed' && geometry.detail && <span class="dim"> {geometry.detail}</span>}
                {geometry.status === 'unknown' && <span class="dim"> The server has not reported a fingerprint for this map.</span>}
              </p>
            )}
          <form method="post" action={`${mapPath(id, name)}/geometry`} class="inline">
            <input type="hidden" name="on" value={geometry.requested ? '0' : '1'} />
            <button type="submit" class="btn">{geometry.requested ? 'Turn off' : 'Turn on'}</button>
          </form>
        </div>
      )}

      {hasView && geometry?.info && (
        <div class="f" style="--c:#22c55e;margin-top:1.2rem">
          <h2 class="ft">3D view</h2>
          <div data-mapview data-src={`${mapPath(id, name)}/mesh.glb`}>
            <div class="view">
              <canvas aria-label={`3D view of ${name}`}></canvas>
              <p data-status>This view needs JavaScript.</p>
            </div>
            <div class="tools">
              <span role="group" aria-label="Levels shown">
                <span class="cap">Up to level</span>
                {Array.from({ length: geometry.info.levels }, (_, i) => i + 1).map(n => <button type="button" data-level={n} aria-pressed="false" class="tog">{n}</button>)}
                <button type="button" data-level="all" aria-pressed="true" class="tog">All</button>
              </span>
              <span role="group" aria-label="View">
                <button type="button" data-view="orbit" class="tog">3D</button>
                <button type="button" data-view="top" class="tog">From above</button>
              </span>
              <span role="group" aria-label="Colour">
                <span class="cap">Colour</span>
                <button type="button" data-colour="plain" aria-pressed="true" class="tog">Plain</button>
                <button type="button" data-colour="height" aria-pressed="false" class="tog">Height</button>
                <button type="button" data-colour="levels" aria-pressed="false" class="tog">Levels</button>
              </span>
              <label><input type="checkbox" data-walls checked /> Walls</label>
              {geometry.info.water ? <label><input type="checkbox" data-water checked /> Water</label> : null}
              {geometry.info.props?.placed ? <label><input type="checkbox" data-props checked /> Props</label> : null}
              {geometry.info.props?.foliage ? <label><input type="checkbox" data-foliage checked /> Glass and leaves</label> : null}
            </div>
            <p class="foot dark">Drag to turn, scroll or pinch to zoom, right-drag to move. A simplified map (no doors or glass): it shows the layout, not what a player could see. Colour: Plain shows the form, Height tints by height, Levels gives each storey its own colour, lowest green.</p>
          </div>
        </div>
      )}

      {admin && (
        <div style="margin-top:1.2rem">
          <h2>Floor plan</h2>
          {plan === null ? (
            <div class="f" style="--c:#9ca3af">
              No floor plan yet. Run <code>traitordash_mapscan</code> in the server console while this map is running; the result appears here within a few seconds.
            </div>
          ) : (
            <>
              <p class="foot" style="margin:0 0 .6rem">
                {plan.floorCells} floor cells, {plan.crouchFloors} crouch-only {planOutdated(plan, map ?? undefined) && <i class="pill wait">Outdated</i>} scanned <When iso={plan.scannedAt} now={ctx.now} />
                {' · '}<a href={`${mapPath(id, name)}/plan.svg`}>All floors</a> · <a href={`${mapPath(id, name)}/plan.json`}>JSON</a>
              </p>
              <PlanLegend cells={[plan.cell]} />
              <div class="plans">
                {plan.levels.map(l => (
                  <figure>
                    <a href={`${mapPath(id, name)}/plan.svg?level=${l.index}`}>
                      <img loading="lazy" alt={`Floor plan of ${name}, level ${l.index}`} src={`${mapPath(id, name)}/plan.svg?level=${l.index}`} />
                    </a>
                    <figcaption>Level {l.index} of {plan.levels.length}: {l.lo === l.hi ? l.lo : `${l.lo} to ${l.hi}`} units, {l.cells} floor cells</figcaption>
                  </figure>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <Who ctx={ctx} />
    </Shell>
  )
}
