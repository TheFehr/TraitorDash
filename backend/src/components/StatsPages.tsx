import { Sections, Shell } from './CaseFile'
import { Bar, Crumbs, Num, ServerName, Pills, Result, Tabs, When, WinTable, Who, adminOf, link, qs, rateClass, teamHex, type Ctx } from './kit'
import { signinUrl } from '../middleware/session'
import { clock, duration, kd, mb, pct } from '../format'
import { teamLabel } from '../teamColours'
import { prettyMap } from '../mapName'
import { SORTS, WEAPON_SORTS, type FirstBlood, type LeaderRow, type PlayerDetail, type RecentRound, type ReplayRound, type SortKey, type WeaponRow, type WeaponSort, type WeaponStats, type WinRow } from '../services/stats'
import { weaponName } from '../weaponName'

// Round stats, one round and one player (RFC 16, RFC 17): the same pages on the website and in the
// game's window. What differs is `ctx`: the website has a header and, for an admin, the controls that
// change things; the window has neither.

const here = (serverId: string) => `/servers/${serverId}`

/** The parameters every link on a stats page carries on: the hidden bot switch and the state roles are grouped by. */
interface Keep { bots?: boolean, by?: 'start' | 'end' }
const keep = (k: Keep) => ({ bots: k.bots, by: k.by === 'start' ? 'start' : undefined })

type View = 'overview' | 'leaders' | 'weapons' | 'rounds'
const VIEWS: { key: View, label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'leaders', label: 'Leaderboard' }, { key: 'weapons', label: 'Weapons' }, { key: 'rounds', label: 'Rounds' },
]

const WEAPON_SORT_LABELS: Record<WeaponSort, string> = { damage: 'Damage', kills: 'Kills', hits: 'Hits' }

const SORT_LABELS: Record<SortKey, string> = { rounds: 'Rounds', wins: 'Wins', winrate: 'Win %', kills: 'Kills', kd: 'K/D' }

/** Roles with enough rounds to say something, best win rate first. */
export const bestRoles = (roles: WinRow[], minPlayed = 3, limit = 4): WinRow[] =>
  roles.filter(r => r.played >= minPlayed && r.name !== 'unknown')
    .sort((a, b) => b.wins / b.played - a.wins / a.played || b.played - a.played || a.name.localeCompare(b.name))
    .slice(0, limit)

/** The "as played" / "as dealt" switch of the role and team tables (RFC 14, 4.5). */
export const ByToggle = ({ ctx, path, by, params = {}, coverage }: { ctx: Ctx, path: string, by: 'start' | 'end', params?: Record<string, string | number | boolean | undefined>, coverage?: { withEnd: number, total: number } }) => (
  <>
    <Pills label="Roles and teams" current={by} items={[
      { key: 'end', label: 'As played', href: link(ctx, path, { ...params, by: undefined }) },
      { key: 'start', label: 'As dealt', href: link(ctx, path, { ...params, by: 'start' }) },
    ]} />
    {coverage && coverage.total > coverage.withEnd && (
      <p class="foot">{coverage.total - coverage.withEnd} of {coverage.total} entries have no end state (earlier rounds) and count as dealt.</p>
    )}
  </>
)

export interface TracksInfo {
  count: number, bytes: number, pinned: number
  limits: { count: number, mb: number, own: { count: number | null, mb: number | null } }
  ceiling: { count: number, mb: number, pinned: number }
  /** Rounds only test bots played in. */
  botRounds: number
}

/** How much room the position tracks use and where their limits are changed: on the settings page (RFC 12, 3.4; RFC 23). Admins only. */
export const TracksSummary = ({ serverId, t }: { serverId: string, t: TracksInfo }) => (
  <p data-tracks-summary class="foot mt1" style="margin-bottom:0">
    Replays: {t.count} {t.count === 1 ? 'track' : 'tracks'}, {mb(t.bytes)} MB used of {t.limits.count} tracks / {t.limits.mb} MB
    {t.pinned > 0 && <> ({t.pinned} pinned, kept regardless)</>}. <a href={`/servers/${serverId}/settings#replay-storage`}>Change the limits in Settings</a>
    {t.botRounds > 0 && <>, where the {t.botRounds} test {t.botRounds === 1 ? 'round' : 'rounds'} played only by bots can be deleted</>}.
  </p>
)

/** The replay cell of a round: a link for a visitor who may open it, else what they need to. */
const ReplayCell = ({ ctx, serverId, roundId, bots }: { ctx: Ctx, serverId: string, roundId: string, bots?: boolean }) => {
  const path = `${here(serverId)}/rounds/${encodeURIComponent(roundId)}/replay`
  if (ctx.viewer) return <a data-replay-link class="tape" href={link(ctx, path, { bots })}>▶ Replay</a>
  if (ctx.signinOpen && !ctx.embed) return <a data-replay-signin class="tape off" href={signinUrl(path + qs({ bots }))}>Replay (sign in)</a>
  return <i data-replay-locked class="tape off">{ctx.embed ? 'Replay' : 'Replay (admins)'}</i>
}

export interface StatsPageProps {
  ctx: Ctx
  server: { id: string, name: string }
  view: View
  sort: SortKey
  bots?: boolean
  by?: 'start' | 'end'
  overview: { rounds: number, players: number, avgDuration: number | null, lastRound: string | null, results: { name: string, n: number }[] }
  teams: WinRow[]
  roles: WinRow[]
  coverage?: { withEnd: number, total: number }
  leaders: LeaderRow[]
  /** The Weapons tab (RFC 21) and how it is sorted. */
  weapons?: WeaponStats
  weaponSort?: WeaponSort
  rounds: RecentRound[]
  /** Which page of the list of rounds this is (the rounds view only). */
  paging?: { page: number, pages: number, total: number, perPage: number }
  /** Rounds that have a stored replay, and whether one is pinned. */
  tracked: Map<string, { pinned: boolean }>
  /** What the server keeps of position tracks; for admins. */
  tracks?: TracksInfo
  /** Role name to `#rrggbb`. */
  colours: Record<string, string>
}

export const StatsPage = (p: StatsPageProps) => {
  const { ctx, server } = p
  const id = server.id
  const admin = adminOf(ctx)
  const k = keep({ bots: p.bots, by: p.by })
  const path = `${here(id)}/stats`
  const tab = (view: View) => link(ctx, path, { ...k, view: view === 'overview' ? undefined : view, sort: view === 'leaders' && p.sort !== 'rounds' ? p.sort : undefined })
  return (
    <Shell title={`Round stats | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer} scripts={admin ? ['/public/confirm.js'] : []}>
      <Crumbs><ServerName ctx={ctx} server={server} /></Crumbs>
      <h1>Round stats</h1>
      {!ctx.embed && <Sections serverId={id} current="stats" admin={adminOf(ctx)} />}
      {p.bots && <p class="foot" style="color:#e9b44c">Including bot test rounds</p>}
      <Tabs label="Round stats" current={p.view} items={VIEWS.map(v => ({ key: v.key, label: v.label, href: tab(v.key) }))} />

      {p.overview.rounds === 0 && <div class="f"><h2 class="ft">No rounds yet</h2><span>Stats appear here after the first full round is played on this server.</span></div>}
      {/* the card of the tracks is where the rounds are, and where there are no rounds yet to open it from (test rounds by bots only) */}
      {admin && p.tracks && (p.view === 'rounds' || p.overview.rounds === 0) && <TracksSummary serverId={id} t={p.tracks} />}

      {p.overview.rounds > 0 && p.view === 'overview' && (
        <>
          <div class="nums">
            <Num label="Rounds" value={p.overview.rounds} />
            <Num label="Players" value={p.overview.players} />
            <Num label="Average round" value={duration(p.overview.avgDuration)} />
            <Num label="Last round" value={<When iso={p.overview.lastRound} now={ctx.now} />} />
          </div>
          <div class="pair">
            <div class="f c-green">
              <h2 class="ft">Who wins</h2>
              {p.overview.results.slice(0, 8).map(r => <Bar label={teamLabel(r.name)} part={r.n} whole={p.overview.rounds} colour={teamHex(r.name, ctx)} title={`${r.n} of ${p.overview.rounds} rounds`} />)}
            </div>
            <div class="f c-red">
              <h2 class="ft">Best roles</h2>
              {bestRoles(p.roles).length === 0
                ? <span>Not enough rounds yet.</span>
                : bestRoles(p.roles).map(r => <Bar label={r.name} part={r.wins} whole={r.played} colour={p.colours[r.name] ?? '#9ca3af'} />)}
              <span class="dim">Win rate, from 3 rounds on.</span>
            </div>
          </div>
          <ByToggle ctx={ctx} path={path} by={p.by ?? 'end'} params={{ bots: p.bots }} coverage={p.coverage} />
          <div class="pair">
            <WinTable title="Teams" rows={p.teams} empty="No team data." />
            <WinTable title="Roles" rows={p.roles} empty="No role data." />
          </div>
        </>
      )}

      {p.overview.rounds > 0 && p.view === 'leaders' && (
        <>
          <Pills label="Sort" current={p.sort} items={SORTS.map(s => ({ key: s, label: SORT_LABELS[s], href: link(ctx, path, { ...k, view: 'leaders', sort: s === 'rounds' ? undefined : s }) }))} />
          <div class="f c-red mt1">
            <div class="scrollx">
              <table class="log">
                <tr><th>#</th><th>Player</th><th class="r">Rounds</th><th class="r">Wins</th><th class="r">Win %</th><th class="r">Kills</th><th class="r">Deaths</th><th class="r">K/D</th></tr>
                {p.leaders.map((l, i) => (
                  <tr>
                    <td class="dim">{i + 1}</td>
                    <td><a href={link(ctx, `${here(id)}/players/${l.steamId}`, { bots: p.bots })}>{l.nick}</a></td>
                    <td class="r">{l.rounds}</td><td class="r">{l.wins}</td>
                    <td class="r"><span class={rateClass(l.wins, l.rounds)}>{pct(l.wins, l.rounds)}</span></td>
                    <td class="r">{l.kills}</td><td class="r">{l.deaths}</td><td class="r dim">{kd(l.kills, l.deaths)}</td>
                  </tr>
                ))}
              </table>
            </div>
          </div>
        </>
      )}

      {p.overview.rounds > 0 && p.view === 'weapons' && p.weapons && (
        <>
          <Pills label="Sort" current={p.weaponSort ?? 'damage'} items={WEAPON_SORTS.map(s => ({ key: s, label: WEAPON_SORT_LABELS[s], href: link(ctx, path, { ...k, view: 'weapons', sort: s === 'damage' ? undefined : s }) }))} />
          <WeaponTable ctx={ctx} serverId={id} stats={p.weapons} />
        </>
      )}

      {p.overview.rounds > 0 && p.view === 'rounds' && (
        <>
          <RoundsTable ctx={ctx} serverId={id} rounds={p.rounds} tracked={p.tracked} bots={p.bots} />
          {p.paging && p.paging.pages > 1 && (
            <div class="bar mt6" data-rounds-pages><span>Page</span>
              {p.paging.page > 1 && <a href={link(ctx, path, { ...k, view: 'rounds', page: p.paging.page - 1 > 1 ? p.paging.page - 1 : undefined })} rel="prev">Newer</a>}
              <span class="on">{p.paging.page} of {p.paging.pages}</span>
              {p.paging.page < p.paging.pages && <a href={link(ctx, path, { ...k, view: 'rounds', page: p.paging.page + 1 })} rel="next">Older</a>}
            </div>
          )}
          <p class="foot">
            {p.paging && p.paging.total > p.rounds.length
              ? <>Rounds {(p.paging.page - 1) * p.paging.perPage + 1} to {(p.paging.page - 1) * p.paging.perPage + p.rounds.length} of {p.paging.total}, the newest first.</>
              : <>The latest {p.rounds.length} rounds.</>} Open a round to see who played what.
          </p>
        </>
      )}
      <Who ctx={ctx} />
    </Shell>
  )
}

const dmg = (n: number) => n.toLocaleString('en-US')
const perHit = (damage: number, hits: number) => (hits > 0 ? (damage / hits).toFixed(1) : '–')

/** The Weapons tab: what each weapon did on this server (RFC 21, 4.3). A table and a bar, no script. */
export const WeaponTable = ({ stats, serverId, ctx }: { stats: WeaponStats, serverId: string, ctx: Ctx }) => {
  const { rows, totalDamage, rounds } = stats
  if (rows.length === 0) {
    return <div class="f c-gray" data-no-weapons><h2 class="ft">No weapon data yet</h2><span>Weapons are counted from the rounds reported by an updated game server. {rounds.total} {rounds.total === 1 ? 'round has' : 'rounds have'} been played so far.</span></div>
  }
  const top = Math.max(1, ...rows.map(r => r.damage))
  return (
    <>
      <div class="f c-red mt1" data-weapons>
        <h2 class="ft">Most damage by weapon</h2>
        <div class="scrollx">
          <table class="log">
            <tr><th>Weapon</th><th class="r">Damage</th><th class="r">Share</th><th></th><th class="r">Hits</th><th class="r">Per hit</th><th class="r">Kills</th><th class="r">Deaths</th><th class="r">Players</th><th class="r">Friendly damage</th></tr>
            {rows.map(r => (
              <tr data-weapon={r.weapon}>
                <td title={r.weapon}>{weaponName(r.weapon)}</td>
                <td class="r">{dmg(r.damage)}</td>
                <td class="r dim">{pct(r.damage, totalDamage)}</td>
                <td style="width:20%"><span style={`display:block;height:.55rem;background:#dc2626;width:${Math.round((r.damage / top) * 100)}%`}></span></td>
                <td class="r">{dmg(r.hits)}</td>
                <td class="r dim">{perHit(r.damage, r.hits)}</td>
                <td class="r">{r.kills}</td>
                <td class="r">{r.deaths}</td>
                <td class="r">{r.players}</td>
                <td class="r dim">{r.friendlyDamage > 0 ? dmg(r.friendlyDamage) : '–'}</td>
              </tr>
            ))}
          </table>
        </div>
      </div>
      <p class="foot">From {rounds.withData} of {rounds.total} rounds: weapons are recorded since the game server was updated. Damage is what the game reported for hits on other players, with each hit capped at the victim's health; damage to a player's own team is kept apart. Kills and deaths count what the weapon did, a fall or a trap is the world.</p>
    </>
  )
}

/** A player's weapons (RFC 21, 4.3). */
export const PlayerWeapons = ({ rows }: { rows: WeaponRow[] }) => (
  <div class="f c-red mt12" data-player-weapons>
    <h2 class="ft">Weapons</h2>
    <div class="scrollx">
      <table class="log">
        <tr><th>Weapon</th><th class="r">Damage</th><th class="r">Hits</th><th class="r">Per hit</th><th class="r">Kills</th><th class="r">Died to it</th><th class="r">Rounds</th></tr>
        {rows.map(r => (
          <tr data-weapon={r.weapon}>
            <td title={r.weapon}>{weaponName(r.weapon)}</td>
            <td class="r">{dmg(r.damage)}</td><td class="r">{dmg(r.hits)}</td><td class="r dim">{perHit(r.damage, r.hits)}</td>
            <td class="r">{r.kills}</td><td class="r">{r.deaths}</td><td class="r dim">{r.rounds || '–'}</td>
          </tr>
        ))}
      </table>
    </div>
  </div>
)

/** The latest rounds. An admin can tick rounds and delete them with their replays (RFC 12). */
export const RoundsTable = ({ ctx, serverId, rounds, tracked, bots }: { ctx: Ctx, serverId: string, rounds: RecentRound[], tracked: Map<string, { pinned: boolean }>, bots?: boolean }) => {
  const admin = adminOf(ctx)
  const pick = admin && rounds.length > 0
  const withTapes = tracked.size > 0
  const table = (
    <div class="f c-red mt1">
      <div class="scrollx">
        <table class="log">
          <tr>{pick && <th></th>}<th>When</th><th>Map</th><th>Result</th><th class="r">Players</th><th class="r">Deaths</th><th class="r">Length</th>{withTapes && <th class="r">Replay</th>}</tr>
          {rounds.map(r => (
            <tr>
              {pick && <td><input type="checkbox" name="round" value={r.roundId} aria-label={`Select the round of ${r.receivedAt}`} /></td>}
              <td><a href={link(ctx, `${here(serverId)}/rounds/${encodeURIComponent(r.roundId)}`, { bots })}><When iso={r.receivedAt} now={ctx.now} /></a></td>
              <td title={r.map ?? undefined}>{r.map ? prettyMap(r.map) : '–'}</td>
              <td><Result result={r.result} ctx={ctx} /></td>
              <td class="r">{r.players}</td>
              <td class="r">{r.deaths}</td>
              <td class="r">{duration(r.duration)}</td>
              {withTapes && (
                <td class="r">
                  {tracked.has(r.roundId) ? <ReplayCell ctx={ctx} serverId={serverId} roundId={r.roundId} bots={bots} /> : <span class="dim">–</span>}
                  {tracked.get(r.roundId)?.pinned && <span title="Pinned"> 📌</span>}
                </td>
              )}
            </tr>
          ))}
        </table>
      </div>
    </div>
  )
  if (!pick) return table
  return (
    <form method="post" action={`${here(serverId)}/rounds/delete-selected`} data-delete-selected
      data-confirm="Delete the selected rounds with their replays? They leave the statistics too. This cannot be undone.">
      {bots && <input type="hidden" name="bots" value="1" />}
      {table}
      <p style="margin:.8rem 0 0"><button type="submit" class="btn danger">Delete selected rounds</button> <span class="dim">Tick the rounds first.</span></p>
    </form>
  )
}

export interface RoundPageProps {
  ctx: Ctx
  server: { id: string, name: string }
  round: ReplayRound
  deaths: number
  firstBlood: FirstBlood | null
  hasReplay: boolean
  colours: Record<string, string>
  bots?: boolean
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

export const RoundPage = ({ ctx, server, round, deaths, firstBlood, hasReplay, colours, bots }: RoundPageProps) => {
  const id = server.id
  const replayPath = `${here(id)}/rounds/${encodeURIComponent(round.roundId)}/replay`
  return (
    <Shell title={`${round.map ?? 'Round'} | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer}>
      <Crumbs><a href={link(ctx, `${here(id)}/stats`, { view: 'rounds', bots })}>Rounds</a> / <When iso={round.startedAt} now={ctx.now} /></Crumbs>
      {!ctx.embed && <Sections serverId={id} admin={adminOf(ctx)} />}
      <div class="f big" style={`--c:${teamHex(round.result, ctx)}`}>
        <div class="stamp" style={`--c:${teamHex(round.result, ctx)}`}>{teamLabel(round.result)}</div>
        <h1>{round.map ? prettyMap(round.map) : 'Unknown map'}</h1>
        {round.map && <p class="file" style="margin:.2rem 0 0">{round.map}</p>}
        <h2>The round</h2>
        <dl class="ledger">
          <div><dt>Length</dt><dd>{duration(round.duration)}</dd></div>
          <div><dt>Players</dt><dd>{round.players.length}</dd></div>
          <div><dt>Deaths</dt><dd>{deaths}</dd></div>
          {firstBlood && <div><dt>First blood</dt><dd>{bloodText(firstBlood)}</dd></div>}
        </dl>
        <h2>Players</h2>
        <div class="scrollx">
          <table class="log">
            <tr><th>Player</th><th>Role</th><th>Result</th></tr>
            {round.players.map(pl => {
              const role = pl.endRole ?? pl.role
              return (
                <tr>
                  <td><a href={link(ctx, `${here(id)}/players/${pl.id}`, { bots })}>{pl.nick ?? pl.id}</a></td>
                  <td><span class="dots"><span><i style={`--c:${colours[role ?? ''] ?? '#9ca3af'}`}></i>{role ?? '–'}</span></span>{pl.endRole && pl.role && pl.endRole !== pl.role && <span class="dim"> (was {pl.role})</span>}</td>
                  <td><span class={pl.won ? 'good' : 'bad'}>{pl.won ? 'Won' : 'Lost'}</span> <span class="dim">{pl.survived ? 'survived' : 'died'}</span></td>
                </tr>
              )
            })}
          </table>
        </div>
        {hasReplay && (
          <p style="margin:1rem 0 0">
            {ctx.viewer
              ? <a class="btn" href={link(ctx, replayPath, { bots })}>▶ Watch the replay</a>
              : ctx.signinOpen && !ctx.embed
                ? <a class="btn" href={signinUrl(replayPath + qs({ bots }))}>Sign in to watch the replay</a>
                : <span class="dim">This round has a replay. It opens for signed-in visitors.</span>}
          </p>
        )}
      </div>
      <Who ctx={ctx} />
    </Shell>
  )
}

export interface PlayerPageProps {
  ctx: Ctx
  server: { id: string, name: string }
  player: PlayerDetail
  by?: 'start' | 'end'
  bots?: boolean
  /** What the player did with each weapon (RFC 21); none when the server has no weapon data for them. */
  weapons?: WeaponRow[]
}

export const PlayerPage = ({ ctx, server, player, by = 'end', bots, weapons }: PlayerPageProps) => {
  const id = server.id
  const path = `${here(id)}/players/${player.steamId}`
  return (
    <Shell title={`${player.nick} | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer}>
      <Crumbs><ServerName ctx={ctx} server={server} /> / <a href={link(ctx, `${here(id)}/stats`, { view: 'leaders', bots })}>Round stats</a></Crumbs>
      <h1>{player.nick}</h1>
      <p class="muted m0">{player.steamId}</p>
      {!ctx.embed && <Sections serverId={id} admin={adminOf(ctx)} />}
      <div class="nums">
        <Num label="Rounds" value={player.rounds} />
        <Num label="Win rate" value={pct(player.wins, player.rounds)} />
        <Num label="Survived" value={pct(player.survived, player.rounds)} />
        <Num label="Kills" value={player.kills} />
        <Num label="K/D" value={kd(player.kills, player.deaths)} />
        {(player.revived > 0 || player.revivals > 0) && <Num label="Times revived" value={player.revived} />}
        {(player.revived > 0 || player.revivals > 0) && <Num label="Revivals done" value={player.revivals} />}
      </div>
      <ByToggle ctx={ctx} path={path} by={by} params={{ bots }} />
      <div class="pair"><WinTable title="By role" rows={player.roles} empty="No role data." /></div>
      {weapons && weapons.length > 0 && <PlayerWeapons rows={weapons} />}
      <div class="f c-red mt12">
        <h2 class="ft">Recent rounds</h2>
        <div class="scrollx">
          <table class="log">
            <tr><th>When</th><th>Map</th><th>Role</th><th>Result</th><th class="r">Kills</th><th class="r">Outcome</th></tr>
            {player.recent.map(r => (
              <tr>
                <td><a href={link(ctx, `${here(id)}/rounds/${encodeURIComponent(r.roundId)}`, { bots })}><When iso={r.receivedAt} now={ctx.now} /></a></td>
                <td title={r.map ?? undefined}>{r.map ? prettyMap(r.map) : '–'}</td>
                <td>{r.endRole && r.endRole !== r.role ? r.endRole : (r.role ?? '–')}{r.endRole && r.role && r.endRole !== r.role && <span class="dim"> (was {r.role})</span>}</td>
                <td>{r.result}</td>
                <td class="r">{r.kills}</td>
                <td class="r"><span class={r.won ? 'good' : 'bad'}>{r.won ? 'Won' : 'Lost'}</span> <span class="dim">{r.survived ? 'survived' : 'died'}</span></td>
              </tr>
            ))}
          </table>
        </div>
      </div>
      <Who ctx={ctx} />
    </Shell>
  )
}
