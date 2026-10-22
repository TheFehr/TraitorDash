import { Shell } from './CaseFile'
import { ago, clock, duration, kd, pct } from '../format'
import { hex, teamColour, teamLabel } from '../teamColours'
import type { FirstBlood, LeaderRow, MapActivity, RecentRound, ReplayRound, SortKey, WinRow } from '../services/stats'
import type { MapRow, MapsState } from '../services/Store'

// The Round stats and Maps pages as the game shows them (RFC 16): the case-file look of the role
// guide, no site header, no admin controls, no script. Every link keeps `embed=1`, so the player
// never leaves the panel. What is only for signed-in visitors (replays, the 3D view) is offered to a visitor with a session, which
// the game can vouch for (RFC 16, 4); floor plans stay admin-only and are on the website.

const here = (serverId: string) => `/servers/${serverId}`
const emb = (extra = '') => `?embed=1${extra}`

/** A team's colour as `#rrggbb`. */
const teamHex = (team: string | null) => hex(teamColour(team))

/** The result of a round as a small tag. */
const Result = ({ result }: { result: string }) => <i class="res" style={`--c:${teamHex(result)}`}>{teamLabel(result)}</i>

const Crumbs = ({ children }: { children: any }) => <div class="crumbs">{children}</div>

/** Who the page takes the visitor for: said on every page, so a missing session is visible. */
const Who = ({ viewer }: { viewer?: string | null }) => (
  <p class="foot" data-viewer>{viewer ? `Signed in as ${viewer}.` : 'Not signed in.'}</p>
)

type View = 'overview' | 'leaders' | 'rounds'
const VIEWS: { key: View, label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'leaders', label: 'Leaderboard' }, { key: 'rounds', label: 'Rounds' },
]

const ViewTabs = ({ serverId, current }: { serverId: string, current: View }) => (
  <nav class="sections" aria-label="Round stats">
    {VIEWS.map(v => v.key === current
      ? <span aria-current="page">{v.label}</span>
      : <a href={`${here(serverId)}/stats${emb(v.key === 'overview' ? '' : `&view=${v.key}`)}`}>{v.label}</a>)}
  </nav>
)

/** Roles with enough rounds to say something, best win rate first. */
export const bestRoles = (roles: WinRow[], minPlayed = 3, limit = 4): WinRow[] =>
  roles.filter(r => r.played >= minPlayed && r.name !== 'unknown')
    .sort((a, b) => b.wins / b.played - a.wins / a.played || b.played - a.played || a.name.localeCompare(b.name))
    .slice(0, limit)

const Bar = ({ label, part, whole, colour }: { label: string, part: number, whole: number, colour: string }) => {
  const share = whole > 0 ? Math.round((part / whole) * 100) : 0
  return (
    <div class="win"><span>{label}</span><s><i style={`--c:${colour};width:${share}%`}></i></s><em>{share}%</em></div>
  )
}

export interface GameStatsProps {
  server: { id: string, name: string }
  view: View
  overview: { rounds: number, players: number, avgDuration: number | null, lastRound: string | null, results: { name: string, n: number }[] }
  roles: WinRow[]
  leaders: LeaderRow[]
  sort: SortKey
  rounds: RecentRound[]
  /** Rounds that have a stored replay. */
  tracked: Map<string, unknown>
  /** Whether this visitor may open replays. */
  canReplay: boolean
  /** Role name to `#rrggbb`. */
  colours: Record<string, string>
  viewer?: string | null
  now?: number
}

const SORT_LABELS: Record<SortKey, string> = { rounds: 'Rounds', wins: 'Wins', winrate: 'Win %', kills: 'Kills', kd: 'K/D' }

export const GameStatsPage = (p: GameStatsProps) => {
  const id = p.server.id
  const now = p.now ?? Date.now()
  return (
    <Shell title={`Round stats | ${p.server.name}`} embed={true}>
      <Crumbs>{p.server.name}</Crumbs>
      <h1>Round stats</h1>
      <ViewTabs serverId={id} current={p.view} />

      {p.overview.rounds === 0 && <div class="f"><b>No rounds yet</b><span>The first finished round shows up here.</span></div>}

      {p.overview.rounds > 0 && p.view === 'overview' && (
        <>
          <div class="nums">
            <div class="f"><div class="num">{p.overview.rounds}</div><div class="cap">Rounds</div></div>
            <div class="f"><div class="num">{p.overview.players}</div><div class="cap">Players</div></div>
            <div class="f"><div class="num">{duration(p.overview.avgDuration)}</div><div class="cap">Average round</div></div>
            <div class="f"><div class="num">{ago(p.overview.lastRound, now)}</div><div class="cap">Last round</div></div>
          </div>
          <div class="pair">
            <div class="f" style="--c:#22c55e">
              <b>Who wins</b>
              {p.overview.results.slice(0, 5).map(r => <Bar label={teamLabel(r.name)} part={r.n} whole={p.overview.rounds} colour={teamHex(r.name)} />)}
            </div>
            <div class="f" style="--c:#dc2626">
              <b>Best roles</b>
              {bestRoles(p.roles).length === 0
                ? <span>Not enough rounds yet.</span>
                : bestRoles(p.roles).map(r => <Bar label={r.name} part={r.wins} whole={r.played} colour={p.colours[r.name] ?? '#9ca3af'} />)}
              <span class="dim">Win rate, from 3 rounds on.</span>
            </div>
          </div>
        </>
      )}

      {p.overview.rounds > 0 && p.view === 'leaders' && (
        <>
          <div class="bar">
            <span>Sort</span>
            {(Object.keys(SORT_LABELS) as SortKey[]).map(k =>
              <a class={k === p.sort ? 'on' : ''} href={`${here(id)}/stats${emb(`&view=leaders&sort=${k}`)}`}>{SORT_LABELS[k]}</a>)}
          </div>
          <div class="f" style="--c:#dc2626;margin-top:1rem">
            <table class="log">
              <tr><th>#</th><th>Player</th><th class="r">Rounds</th><th class="r">Win %</th><th class="r">K/D</th></tr>
              {p.leaders.slice(0, 10).map((l, i) => (
                <tr><td>{i + 1}</td><td>{l.nick}</td><td class="r">{l.rounds}</td><td class="r">{pct(l.wins, l.rounds)}</td><td class="r">{kd(l.kills, l.deaths)}</td></tr>
              ))}
            </table>
          </div>
        </>
      )}

      {p.overview.rounds > 0 && p.view === 'rounds' && (
        <>
          <div class="f" style="--c:#dc2626;margin-top:1rem">
            <table class="log">
              <tr><th>When</th><th>Map</th><th>Result</th><th class="r">Players</th><th class="r">Length</th>{p.tracked.size > 0 && <th class="r">Replay</th>}</tr>
              {p.rounds.map(r => (
                <tr>
                  <td><a href={`${here(id)}/rounds/${encodeURIComponent(r.roundId)}${emb()}`}>{ago(r.receivedAt, now)}</a></td>
                  <td>{r.map ?? '–'}</td>
                  <td><Result result={r.result} /></td>
                  <td class="r">{r.players}</td>
                  <td class="r">{duration(r.duration)}</td>
                  {p.tracked.size > 0 && (
                    <td class="r">
                      {p.tracked.has(r.roundId)
                        ? p.canReplay
                          ? <a class="tape" href={`${here(id)}/rounds/${encodeURIComponent(r.roundId)}/replay${emb()}`}>▶ Replay</a>
                          : <i class="tape off">Replay</i>
                        : <span class="dim">–</span>}
                    </td>
                  )}
                </tr>
              ))}
            </table>
          </div>
          <p class="foot">The latest {p.rounds.length} rounds. Open a round to see who played what.</p>
        </>
      )}
      <Who viewer={p.viewer} />
    </Shell>
  )
}

export interface GameRoundProps {
  server: { id: string, name: string }
  round: ReplayRound
  deaths: number
  firstBlood: FirstBlood | null
  hasReplay: boolean
  canReplay: boolean
  colours: Record<string, string>
  viewer?: string | null
  /** How many days a 3D view is logged (RFC 13); said next to the replay. */
  now?: number
}

/** The roles a round ended with, as "role, how many", the most common first. */
export const roleCounts = (players: ReplayRound['players']): { name: string, n: number }[] => {
  const counts = new Map<string, number>()
  for (const pl of players) {
    const name = pl.endRole ?? pl.role ?? 'unknown'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
}

const bloodText = (b: FirstBlood) => {
  const when = b.at === null ? '' : `${clock(b.at * 1000)} · `
  return b.killer && b.killer !== b.victim ? `${when}${b.killer} → ${b.victim}` : `${when}${b.victim}`
}

export const GameRoundPage = ({ server, round, deaths, firstBlood, hasReplay, canReplay, colours, viewer, now }: GameRoundProps) => {
  const id = server.id
  return (
    <Shell title={`${round.map ?? 'Round'} | ${server.name}`} embed={true}>
      <Crumbs><a href={`${here(id)}/stats${emb('&view=rounds')}`}>Rounds</a> / {ago(round.startedAt, now)}</Crumbs>
      <div class="f big" style={`--c:${teamHex(round.result)}`}>
        <div class="stamp" style={`--c:${teamHex(round.result)}`}>{teamLabel(round.result)}</div>
        <h1>{round.map ?? 'Unknown map'}</h1>
        <h2>The round</h2>
        <dl class="ledger">
          <div><dt>Length</dt><dd>{duration(round.duration)}</dd></div>
          <div><dt>Players</dt><dd>{round.players.length}</dd></div>
          <div><dt>Deaths</dt><dd>{deaths}</dd></div>
          {firstBlood && <div><dt>First blood</dt><dd>{bloodText(firstBlood)}</dd></div>}
        </dl>
        <h2>Roles in the round</h2>
        <div class="dots">
          {roleCounts(round.players).map(r => (
            <span><i style={`--c:${colours[r.name] ?? '#9ca3af'}`}></i>{r.name}{r.n > 1 ? ` ×${r.n}` : ''}</span>
          ))}
        </div>
        {hasReplay && (
          <p style="margin:1rem 0 0">
            {canReplay
              ? <a class="btn" href={`${here(id)}/rounds/${encodeURIComponent(round.roundId)}/replay${emb()}`}>▶ Watch the replay</a>
              : <span class="dim">This round has a replay. It opens for signed-in visitors.</span>}
          </p>
        )}
      </div>
      <Who viewer={viewer} />
    </Shell>
  )
}

export interface GameMapsProps {
  server: { id: string, name: string }
  state: MapsState | null
  maps: MapRow[]
  activity: Map<string, MapActivity>
  viewer?: string | null
  now?: number
}

// The maps a player can meet: the vote pool, running map and votable ones first.
const rank = (m: MapRow) => (m.votable === true ? 0 : m.isCurrent ? 1 : 2)

/** The maps the page lists: those the vote can offer, plus any the bridge could not classify. */
export const listedMaps = (maps: MapRow[]): MapRow[] =>
  maps.filter(m => m.inVotePool !== false).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

const Pills = ({ m, next }: { m: MapRow, next: string | null }) => (
  <>
    {m.isCurrent && <i class="pill ok">Current</i>}
    {m.name === next && <i class="pill wait">Next</i>}
    {m.votable === true && <i class="pill ok">Votable</i>}
    {m.onCooldown === true && <i class="pill mute">Cooldown</i>}
  </>
)

const nextOf = (state: MapsState | null) => (state && state.next && state.next !== state.current ? state.next : null)

const Split = ({ results, rounds }: { results: { name: string, n: number }[], rounds: number }) => (
  <div class="split" aria-hidden="true">
    {results.map(r => <i style={`--c:${teamHex(r.name)};width:${(r.n / rounds) * 100}%`}></i>)}
  </div>
)

export const GameMapsPage = ({ server, state, maps, activity, viewer, now }: GameMapsProps) => {
  const id = server.id
  const next = nextOf(state)
  const listed = listedMaps(maps)
  return (
    <Shell title={`Maps | ${server.name}`} embed={true}>
      <Crumbs>{server.name}</Crumbs>
      <h1>Map files</h1>
      {state === null || listed.length === 0
        ? <div class="f"><b>No maps yet</b><span>The server has not reported its maps.</span></div>
        : (
          <div class="g">
            {listed.map(m => {
              const a = activity.get(m.name)
              return (
                <a class="f" style={`--c:${m.votable === true ? '#22c55e' : m.isCurrent ? '#e9b44c' : '#9ca3af'}`} href={`${here(id)}/maps/${encodeURIComponent(m.name)}/rounds${emb()}`}>
                  <b>{m.name}</b>
                  <span><Pills m={m} next={next} /></span>
                  {a
                    ? <><Split results={a.results} rounds={a.rounds} /><span>{a.rounds} {a.rounds === 1 ? 'round' : 'rounds'} · last {ago(a.lastRound, now)}</span></>
                    : <span class="dim">Not played yet</span>}
                </a>
              )
            })}
          </div>
        )}
      <p class="foot">The maps the vote can offer.</p>
      <Who viewer={viewer} />
    </Shell>
  )
}

export interface GameMapProps {
  server: { id: string, name: string }
  name: string
  map: MapRow | null
  state: MapsState | null
  activity: MapActivity | null
  /** The map has a 3D view, and whether this visitor may open it. */
  has3d: boolean
  signedIn: boolean
  viewer?: string | null
  /** How many days a 3D view is logged with the viewer's SteamID64 (RFC 13); 0 means it is not. */
  viewLogDays?: number
  now?: number
}

export const GameMapPage = ({ server, name, map, state, activity, has3d, signedIn, viewer, viewLogDays = 0, now }: GameMapProps) => {
  const id = server.id
  const next = nextOf(state)
  return (
    <Shell title={`${name} | ${server.name}`} embed={true}>
      <Crumbs><a href={`${here(id)}/maps${emb()}`}>All maps</a> / {name}</Crumbs>
      <div class="f big" style={`--c:${map?.votable === true ? '#22c55e' : map?.isCurrent ? '#e9b44c' : '#9ca3af'}`}>
        <h1>{name}</h1>
        {map && <p style="margin:.5rem 0 0"><Pills m={map} next={next} />{map.inVotePool === false && <i class="pill mute">Not in the pool</i>}</p>}
        {activity ? (
          <>
            <h2>Rounds on this map</h2>
            <dl class="ledger">
              <div><dt>Played</dt><dd>{activity.rounds}</dd></div>
              <div><dt>Average round</dt><dd>{duration(activity.avgDuration)}</dd></div>
              <div><dt>Last round</dt><dd>{ago(activity.lastRound, now)}</dd></div>
            </dl>
            <h2>Who wins here</h2>
            {activity.results.slice(0, 5).map(r => <Bar label={teamLabel(r.name)} part={r.n} whole={activity.rounds} colour={teamHex(r.name)} />)}
          </>
        ) : <p class="none">No round has been played on this map yet.</p>}
        {has3d && (
          <p style="margin:1rem 0 0">
            {signedIn
              ? <><a class="btn" href={`${here(id)}/maps/${encodeURIComponent(name)}${emb()}`}>View in 3D</a>{viewLogDays > 0 && <span class="dim" style="margin-left:.6rem">Opening it is logged with your SteamID64 for {viewLogDays} days.</span>}</>
              : <span class="dim">This map has a 3D view. It opens for signed-in visitors.</span>}
          </p>
        )}
        <p class="foot" style="color:#6b6350">The floor plan is on the website, for admins.</p>
      </div>
      <Who viewer={viewer} />
    </Shell>
  )
}

export const GameNotFound = ({ what }: { what: string }) => (
  <Shell title="Not found" embed={true}>
    <h1>Not found</h1>
    <p class="muted">There is no such {what}.</p>
  </Shell>
)
