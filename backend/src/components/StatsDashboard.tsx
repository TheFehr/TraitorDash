import { signinUrl } from '../middleware/session'
import { duration, kd, mb, pct } from '../format'
import { Heartbeat } from './Heartbeat'
import { SORTS, type SortKey, type LeaderRow, type RecentRound, type WinRow, type PlayerDetail } from '../services/stats'
import { LINK_BTN, TAB_OFF, TAB_ON } from '../ui'


// Green at or above half, red below, grey with nothing to go on.
export const rateClass = (part: number, whole: number) =>
  whole === 0 ? 'text-gray-500' : part / whole >= 0.5 ? 'text-green-400' : 'text-red-400'


const SORT_LABELS: Record<SortKey, string> = {
  rounds: 'Rounds', wins: 'Wins', winrate: 'Win %', kills: 'Kills', kd: 'K/D',
}

/** The "as played" / "as dealt" switch of the role and team tables (RFC 14, 4.5); the link keeps the other query parameters. */
export const ByToggle = ({ path, by, params = '', coverage }: { path: string, by: 'start' | 'end', params?: string, coverage?: { withEnd: number, total: number } }) => {
  const link = (v: 'start' | 'end') => `${path}?${params}by=${v}`
  const on = TAB_ON, off = TAB_OFF
  return (
    <div class="flex flex-wrap items-center gap-3 text-xs font-bold">
      <span class="text-gray-500 uppercase tracking-widest font-black">Roles and teams</span>
      <a href={link('end')} class={`px-3 py-1 rounded-lg ${by === 'end' ? on : off}`}>As played</a>
      <a href={link('start')} class={`px-3 py-1 rounded-lg ${by === 'start' ? on : off}`}>As dealt</a>
      {coverage && coverage.total > coverage.withEnd && (
        <span class="text-gray-500 font-normal">{coverage.total - coverage.withEnd} of {coverage.total} entries have no end state (earlier rounds) and count as dealt.</span>
      )}
    </div>
  )
}

const Card = ({ label, value, sub }: { label: string, value: any, sub?: string }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl p-4 sm:p-5">
    <div class="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</div>
    <div class="text-2xl sm:text-3xl font-black mt-1">{value}</div>
    {sub && <div class="text-xs text-gray-500 mt-1">{sub}</div>}
  </div>
)

export const WinTable = ({ title, rows, empty }: { title: string, rows: WinRow[], empty: string }) => (
  <section>
    <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">{title}</h2>
    {rows.length === 0 ? <p class="text-gray-500 text-sm">{empty}</p> : (
      <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-[10px] uppercase tracking-widest text-gray-500">
            <tr><th class="text-left p-3">Name</th><th class="text-right p-3">Played</th><th class="text-right p-3">Win %</th><th class="text-right p-3">Survived</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr class="border-t border-gray-700">
                <td class="p-3 font-bold">{r.name}</td>
                <td class="p-3 text-right">{r.played}</td>
                <td class="p-3 text-right">
                  <span class={`font-bold ${rateClass(r.wins, r.played)}`}>{pct(r.wins, r.played)}</span>
                  <span class="text-gray-500 text-xs ml-1">({r.wins})</span>
                </td>
                <td class="p-3 text-right text-gray-400">{pct(r.survived, r.played)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
)

/**
 * The recent rounds. A round with a stored track has a replay (RFC 12): the link goes to it for a
 * signed-in visitor, and to sign-in (and back) for anyone else, so it says what it needs.
 */
export const RoundsTable = ({ rounds, serverId, tracks, signedIn, signinOpen, bots }: { rounds: RecentRound[], serverId?: string, tracks?: Map<string, { pinned: boolean }>, signedIn?: boolean, signinOpen?: boolean, bots?: boolean }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="text-[10px] uppercase tracking-widest text-gray-500">
        <tr><th class="text-left p-3">When</th><th class="text-left p-3">Map</th><th class="text-left p-3">Result</th><th class="text-right p-3">Players</th><th class="text-right p-3">Deaths</th><th class="text-right p-3">Length</th>{tracks && tracks.size > 0 && <th class="text-right p-3">Replay</th>}</tr>
      </thead>
      <tbody>
        {rounds.map(r => (
          <tr class="border-t border-gray-700">
            <td class="p-3 text-gray-400"><Heartbeat lastSeen={r.receivedAt} /></td>
            <td class="p-3">{r.map ?? '–'}</td>
            <td class="p-3 font-bold">{r.result}</td>
            <td class="p-3 text-right">{r.players}</td>
            <td class="p-3 text-right">{r.deaths}</td>
            <td class="p-3 text-right text-gray-400">{duration(r.duration)}</td>
            {tracks && tracks.size > 0 && (
              <td class="p-3 text-right">
                {tracks.has(r.roundId) && serverId && (() => {
                  const path = `/servers/${serverId}/rounds/${encodeURIComponent(r.roundId)}/replay${bots ? '?bots=1' : ''}`
                  return signedIn
                    ? <a data-replay-link class="text-red-400 hover:text-red-300 underline" href={path}>Replay</a>
                    : signinOpen
                      ? <a data-replay-signin class="text-gray-400 hover:text-white underline" href={signinUrl(path)}>Replay (sign in)</a>
                      : <span data-replay-locked class="text-gray-500">Replay (admins)</span>
                })()}
                {tracks.get(r.roundId)?.pinned && <span class="ml-1 text-yellow-400" title="Pinned">📌</span>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export interface StatsDashboardProps {
  server: { id: string, name: string }
  overview: { rounds: number, players: number, avgDuration: number | null, lastRound: string | null, results: { name: string, n: number }[] }
  roles: WinRow[]
  teams: WinRow[]
  leaders: LeaderRow[]
  recent: RecentRound[]
  sort: SortKey
  bots?: boolean
  /** Whether the role and team tables show the state at the end of the round or as dealt (RFC 14, 4.5). */
  by?: 'start' | 'end'
  coverage?: { withEnd: number, total: number }
  /** The role settings link only makes sense for admins; guests see the stats alone. */
  admin?: boolean
  /** What the server keeps of position tracks and how much is used (RFC 12, 3.4); shown to admins. */
  tracks?: TracksInfo
  /** Which recent rounds have a replay (RFC 12) and what the visitor needs to open it (RFC 13). */
  replays?: { tracked: Map<string, { pinned: boolean }>, signedIn: boolean, signinOpen: boolean }
}

export interface TracksInfo {
  count: number, bytes: number, pinned: number
  limits: { count: number, mb: number, own: { count: number | null, mb: number | null } }
  ceiling: { count: number, mb: number, pinned: number }
}


/** The retention limits of a server's position tracks, how much room is used, and where to change them. */
export const TracksCard = ({ serverId, t }: { serverId: string, t: TracksInfo }) => (
  <section data-tracks class="bg-gray-800/50 border border-gray-700 rounded-2xl p-4 sm:p-6">
    <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Position tracks</h2>
    <p data-tracks-usage class="text-gray-300 mb-4">
      {t.count} {t.count === 1 ? 'track' : 'tracks'}, {mb(t.bytes)} MB used of {t.limits.count} tracks / {t.limits.mb} MB
      {t.pinned > 0 && <span class="text-gray-400"> ({t.pinned} pinned, kept regardless; at most {t.ceiling.pinned})</span>}
    </p>
    <form method="post" action={`/servers/${serverId}/tracks/limits`} class="flex flex-wrap items-end gap-4">
      <label class="text-xs font-bold text-gray-400 uppercase tracking-widest">
        Keep at most N tracks
        <input name="count" inputmode="numeric" value={t.limits.own.count ?? ''} placeholder={t.limits.own.count === null ? `default (${t.limits.count})` : 'default'}
          class="block mt-1 w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white normal-case tracking-normal" />
      </label>
      <label class="text-xs font-bold text-gray-400 uppercase tracking-widest">
        ... at most M MB
        <input name="mb" inputmode="numeric" value={t.limits.own.mb ?? ''} placeholder={t.limits.own.mb === null ? `default (${t.limits.mb})` : 'default'}
          class="block mt-1 w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white normal-case tracking-normal" />
      </label>
      <button type="submit" class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold text-white transition">Save</button>
    </form>
    <p class="mt-3 text-xs text-gray-500">
      Empty uses the default. At most {t.ceiling.count} tracks and {t.ceiling.mb} MB on this instance. 0 stores nothing: the game server still uploads, the dashboard discards.
      Pinned tracks are never removed by these limits.
    </p>
  </section>
)

export const StatsDashboard = ({ server, overview, roles, teams, leaders, recent, sort, bots, by = 'end', coverage, admin, tracks, replays }: StatsDashboardProps) => (
  <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        {admin ? <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a> : <span>{server.name}</span>}
        <span>/</span>
        <span class="text-red-500">Stats</span>
      </nav>
      <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">Round stats</h1>
      <p class="text-gray-400 text-lg">{server.name}</p>
      {admin && tracks && <div class="mt-6"><TracksCard serverId={server.id} t={tracks} /></div>}
      <a href={`/servers/${server.id}/maps`} class={`${LINK_BTN} mt-4`}>
        🗺 Maps
      </a>
      {bots && <p class="mt-2 text-xs font-black uppercase tracking-widest text-yellow-400">Including bot test rounds</p>}
    </header>

    {overview.rounds === 0 ? (
      <div class="bg-gray-800 border border-gray-700 rounded-xl p-8 text-gray-400">
        No rounds recorded yet. Stats appear here after the first full round is played on this server.
      </div>
    ) : (
      <>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <Card label="Rounds" value={overview.rounds} />
          <Card label="Players" value={overview.players} />
          <Card label="Average length" value={duration(overview.avgDuration)} />
          <Card label="Last round" value={<Heartbeat lastSeen={overview.lastRound} class="text-base" />} />
        </div>

        <section>
          <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Round results</h2>
          <div class="flex flex-wrap gap-3">
            {overview.results.map(r => (
              <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
                <span class="font-black">{r.name}</span>
                <span class="text-gray-400 ml-2">{r.n} <span class="text-xs">({pct(r.n, overview.rounds)})</span></span>
              </div>
            ))}
          </div>
        </section>

        <ByToggle path={`/servers/${server.id}/stats`} by={by} params={`${bots ? 'bots=1&' : ''}${sort !== 'rounds' ? `sort=${sort}&` : ''}`} coverage={coverage} />
        <div class="grid lg:grid-cols-2 gap-6 sm:gap-8">
          <WinTable title="Teams" rows={teams} empty="No team data." />
          <WinTable title="Roles" rows={roles} empty="No role data." />
        </div>

        <section>
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400">Leaderboard</h2>
            <div class="flex gap-2 text-xs font-bold">
              {SORTS.map(s => (
                <a href={`/servers/${server.id}/stats?sort=${s}${bots ? '&bots=1' : ''}${by === 'start' ? '&by=start' : ''}`}
                   class={`px-3 py-1.5 rounded-lg border transition ${s === sort ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
                  {SORT_LABELS[s]}
                </a>
              ))}
            </div>
          </div>
          <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th class="text-left p-3">#</th><th class="text-left p-3">Player</th>
                  <th class="text-right p-3">Rounds</th><th class="text-right p-3">Wins</th><th class="text-right p-3">Win %</th>
                  <th class="text-right p-3">Kills</th><th class="text-right p-3">Deaths</th><th class="text-right p-3">K/D</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((p, i) => (
                  <tr class="border-t border-gray-700">
                    <td class="p-3 text-gray-500">{i + 1}</td>
                    <td class="p-3 font-bold"><a class="hover:text-red-400 transition" href={`/servers/${server.id}/players/${p.steamId}${bots ? '?bots=1' : ''}`}>{p.nick}</a></td>
                    <td class="p-3 text-right">{p.rounds}</td>
                    <td class="p-3 text-right">{p.wins}</td>
                    <td class={`p-3 text-right font-bold ${rateClass(p.wins, p.rounds)}`}>{pct(p.wins, p.rounds)}</td>
                    <td class="p-3 text-right">{p.kills}</td>
                    <td class="p-3 text-right">{p.deaths}</td>
                    <td class="p-3 text-right text-gray-400">{kd(p.kills, p.deaths)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Recent rounds</h2>
          <RoundsTable rounds={recent} serverId={server.id} tracks={replays?.tracked} signedIn={replays?.signedIn} signinOpen={replays?.signinOpen} bots={bots} />
        </section>
      </>
    )}
  </div>
)

export const PlayerStats = ({ server, player, admin, by = 'end', bots }: { server: { id: string, name: string }, player: PlayerDetail, admin?: boolean, by?: 'start' | 'end', bots?: boolean }) => (
  <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        {admin ? <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a> : <span>{server.name}</span>}
        <span>/</span>
        <a href={`/servers/${server.id}/stats`} class="hover:text-white transition">Stats</a>
        <span>/</span>
        <span class="text-red-500">{player.nick}</span>
      </nav>
      <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">{player.nick}</h1>
      <p class="text-gray-500 font-mono text-sm">{player.steamId}</p>
    </header>

    <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
      <Card label="Rounds" value={player.rounds} />
      <Card label="Win rate" value={pct(player.wins, player.rounds)} sub={`${player.wins} wins`} />
      <Card label="Survived" value={pct(player.survived, player.rounds)} />
      <Card label="Kills" value={player.kills} />
      <Card label="K/D" value={kd(player.kills, player.deaths)} sub={`${player.deaths} deaths`} />
    </div>

    {(player.revived > 0 || player.revivals > 0) && (
      <div class="grid grid-cols-2 gap-4 max-w-md">
        <Card label="Times revived" value={player.revived} />
        <Card label="Revivals done" value={player.revivals} />
      </div>
    )}

    <ByToggle path={`/servers/${server.id}/players/${player.steamId}`} by={by} params={bots ? 'bots=1&' : ''} />
    <WinTable title="By role" rows={player.roles} empty="No role data." />

    <section>
      <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Recent rounds</h2>
      <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-[10px] uppercase tracking-widest text-gray-500">
            <tr><th class="text-left p-3">When</th><th class="text-left p-3">Map</th><th class="text-left p-3">Role</th><th class="text-left p-3">Result</th><th class="text-right p-3">Kills</th><th class="text-right p-3">Outcome</th></tr>
          </thead>
          <tbody>
            {player.recent.map(r => (
              <tr class="border-t border-gray-700">
                <td class="p-3 text-gray-400"><Heartbeat lastSeen={r.receivedAt} /></td>
                <td class="p-3">{r.map ?? '–'}</td>
                <td class="p-3 font-bold">
                  {r.endRole && r.endRole !== r.role ? r.endRole : (r.role ?? '–')}
                  {r.endRole && r.role && r.endRole !== r.role && <span class="text-gray-500 text-xs font-normal ml-1">(was {r.role})</span>}
                </td>
                <td class="p-3">{r.result}</td>
                <td class="p-3 text-right">{r.kills}</td>
                <td class="p-3 text-right">
                  <span class={r.won ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>{r.won ? 'Won' : 'Lost'}</span>
                  <span class="text-gray-500 text-xs ml-1">{r.survived ? 'survived' : 'died'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  </div>
)
