import { Heartbeat } from './Heartbeat'
import { SORTS, type SortKey, type LeaderRow, type RecentRound, type WinRow, type PlayerDetail } from '../services/stats'

export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–')

// Green at or above half, red below, grey with nothing to go on.
export const rateClass = (part: number, whole: number) =>
  whole === 0 ? 'text-gray-500' : part / whole >= 0.5 ? 'text-green-400' : 'text-red-400'

export const fmtDuration = (s: number | null) =>
  s === null ? '–' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const SORT_LABELS: Record<SortKey, string> = {
  rounds: 'Rounds', wins: 'Wins', winrate: 'Win %', kills: 'Kills', kd: 'K/D',
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

export const RoundsTable = ({ rounds }: { rounds: RecentRound[] }) => (
  <div class="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="text-[10px] uppercase tracking-widest text-gray-500">
        <tr><th class="text-left p-3">When</th><th class="text-left p-3">Map</th><th class="text-left p-3">Result</th><th class="text-right p-3">Players</th><th class="text-right p-3">Deaths</th><th class="text-right p-3">Length</th></tr>
      </thead>
      <tbody>
        {rounds.map(r => (
          <tr class="border-t border-gray-700">
            <td class="p-3 text-gray-400"><Heartbeat lastSeen={r.receivedAt} /></td>
            <td class="p-3">{r.map ?? '–'}</td>
            <td class="p-3 font-bold">{r.result}</td>
            <td class="p-3 text-right">{r.players}</td>
            <td class="p-3 text-right">{r.deaths}</td>
            <td class="p-3 text-right text-gray-400">{fmtDuration(r.duration)}</td>
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
}

export const StatsDashboard = ({ server, overview, roles, teams, leaders, recent, sort, bots }: StatsDashboardProps) => (
  <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a>
        <span>/</span>
        <span class="text-red-500">Stats</span>
      </nav>
      <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">Round stats</h1>
      <p class="text-gray-400 text-lg">{server.name}</p>
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
          <Card label="Average length" value={fmtDuration(overview.avgDuration)} />
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

        <div class="grid lg:grid-cols-2 gap-6 sm:gap-8">
          <WinTable title="Teams" rows={teams} empty="No team data." />
          <WinTable title="Roles" rows={roles} empty="No role data." />
        </div>

        <section>
          <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400">Leaderboard</h2>
            <div class="flex gap-2 text-xs font-bold">
              {SORTS.map(s => (
                <a href={`/servers/${server.id}/stats?sort=${s}${bots ? '&bots=1' : ''}`}
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
                    <td class="p-3 text-right text-gray-400">{(p.kills / Math.max(p.deaths, 1)).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-3">Recent rounds</h2>
          <RoundsTable rounds={recent} />
        </section>
      </>
    )}
  </div>
)

export const PlayerStats = ({ server, player }: { server: { id: string, name: string }, player: PlayerDetail }) => (
  <div class="p-4 sm:p-8 space-y-8 sm:space-y-10">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        <a href={`/servers/${server.id}`} class="hover:text-white transition">{server.name}</a>
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
      <Card label="K/D" value={(player.kills / Math.max(player.deaths, 1)).toFixed(2)} sub={`${player.deaths} deaths`} />
    </div>

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
                <td class="p-3 font-bold">{r.role ?? '–'}</td>
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
