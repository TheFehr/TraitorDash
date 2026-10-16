import db from './Database'

// Read-side queries for the round stats the bridge reports (migration v7).
//
// Bots only exist when the test scenario runs; they carry synthetic IDs starting with this
// prefix and are hidden everywhere unless asked for, so a test never pollutes the leaderboard.
const BOT_PREFIX = '999000'
const NOT_BOT = `rp.steam_id NOT LIKE '${BOT_PREFIX}%'`

/** SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) as an ISO instant, which the <Heartbeat> time element understands. */
export const sqliteToIso = (v: string | null): string | null => (v ? `${v.replace(' ', 'T')}Z` : null)

export interface StatsOptions { bots?: boolean }

const botFilter = (o?: StatsOptions) => (o?.bots ? '1=1' : NOT_BOT)

// A round counts when at least one (non-bot) player took part in it.
const roundHasPlayers = (o?: StatsOptions) => `EXISTS (
  SELECT 1 FROM round_players rp WHERE rp.server_id = r.server_id AND rp.round_id = r.round_id AND ${botFilter(o)}
)`

export interface WinRow { name: string, played: number, wins: number, survived: number }

export function getOverview(serverId: string, o?: StatsOptions) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS rounds, AVG(r.duration) AS avg_duration, MAX(r.received_at) AS last_round
    FROM rounds r WHERE r.server_id = ? AND ${roundHasPlayers(o)}
  `).get(serverId) as any

  const players = db.prepare(`
    SELECT COUNT(DISTINCT rp.steam_id) AS n FROM round_players rp WHERE rp.server_id = ? AND ${botFilter(o)}
  `).get(serverId) as any

  const results = db.prepare(`
    SELECT r.result AS name, COUNT(*) AS n FROM rounds r
    WHERE r.server_id = ? AND ${roundHasPlayers(o)} GROUP BY r.result ORDER BY n DESC
  `).all(serverId) as { name: string, n: number }[]

  return {
    rounds: totals.rounds as number,
    players: players.n as number,
    avgDuration: totals.avg_duration === null ? null : Math.round(totals.avg_duration),
    lastRound: sqliteToIso(totals.last_round),
    results,
  }
}

const winRows = (column: 'role' | 'team', serverId: string, o?: StatsOptions) =>
  db.prepare(`
    SELECT COALESCE(rp.${column}, 'unknown') AS name, COUNT(*) AS played,
           SUM(rp.won) AS wins, SUM(rp.survived) AS survived
    FROM round_players rp WHERE rp.server_id = ? AND ${botFilter(o)}
    GROUP BY name ORDER BY played DESC, name ASC
  `).all(serverId) as WinRow[]

export const getRoleStats = (serverId: string, o?: StatsOptions) => winRows('role', serverId, o)
export const getTeamStats = (serverId: string, o?: StatsOptions) => winRows('team', serverId, o)

export const SORTS = ['rounds', 'wins', 'winrate', 'kills', 'kd'] as const
export type SortKey = (typeof SORTS)[number]

export interface LeaderRow {
  steamId: string, nick: string, rounds: number, wins: number, survived: number, kills: number, deaths: number
}

const nickOf = `(SELECT p2.nick FROM round_players p2 JOIN rounds r2
                 ON r2.server_id = p2.server_id AND r2.round_id = p2.round_id
                 WHERE p2.server_id = rp.server_id AND p2.steam_id = rp.steam_id AND p2.nick IS NOT NULL
                 ORDER BY r2.received_at DESC, r2.rowid DESC LIMIT 1)`

export function getLeaderboard(serverId: string, sort: SortKey = 'rounds', o?: StatsOptions, limit = 50): LeaderRow[] {
  const rows = db.prepare(`
    SELECT rp.steam_id AS steamId, ${nickOf} AS nick, COUNT(*) AS rounds, SUM(rp.won) AS wins,
           SUM(rp.survived) AS survived,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.attacker_steam_id = rp.steam_id) AS kills,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.victim_steam_id = rp.steam_id) AS deaths
    FROM round_players rp WHERE rp.server_id = ? AND ${botFilter(o)}
    GROUP BY rp.steam_id
  `).all(serverId) as any[]

  const rate = (r: LeaderRow) => (r.rounds ? r.wins / r.rounds : 0)
  const kd = (r: LeaderRow) => r.kills / Math.max(r.deaths, 1)
  const by: Record<SortKey, (r: LeaderRow) => number> = {
    rounds: r => r.rounds, wins: r => r.wins, winrate: rate, kills: r => r.kills, kd,
  }
  const key = SORTS.includes(sort) ? sort : 'rounds'
  return rows
    .map(r => ({ ...r, nick: r.nick ?? r.steamId }) as LeaderRow)
    .sort((a, b) => by[key](b) - by[key](a) || b.rounds - a.rounds || a.nick.localeCompare(b.nick))
    .slice(0, limit)
}

export interface RecentRound {
  roundId: string, map: string | null, result: string, duration: number | null,
  receivedAt: string | null, players: number, deaths: number
}

export function getRecentRounds(serverId: string, o?: StatsOptions, limit = 15): RecentRound[] {
  const rows = db.prepare(`
    SELECT r.round_id AS roundId, r.map, r.result, r.duration, r.received_at AS receivedAt,
           (SELECT COUNT(*) FROM round_players rp WHERE rp.server_id = r.server_id AND rp.round_id = r.round_id AND ${botFilter(o)}) AS players,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = r.server_id AND d.round_id = r.round_id) AS deaths
    FROM rounds r WHERE r.server_id = ? AND ${roundHasPlayers(o)}
    ORDER BY r.received_at DESC, r.rowid DESC LIMIT ?
  `).all(serverId, limit) as any[]
  return rows.map(r => ({ ...r, receivedAt: sqliteToIso(r.receivedAt) }))
}

export interface PlayerRound {
  roundId: string, map: string | null, result: string, receivedAt: string | null,
  role: string | null, team: string | null, won: boolean, survived: boolean, kills: number
}
export interface PlayerDetail extends LeaderRow { roles: WinRow[], recent: PlayerRound[] }

export function getPlayer(serverId: string, steamId: string): PlayerDetail | null {
  const row = db.prepare(`
    SELECT rp.steam_id AS steamId, ${nickOf} AS nick, COUNT(*) AS rounds, SUM(rp.won) AS wins, SUM(rp.survived) AS survived,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.attacker_steam_id = rp.steam_id) AS kills,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.victim_steam_id = rp.steam_id) AS deaths
    FROM round_players rp WHERE rp.server_id = ? AND rp.steam_id = ? GROUP BY rp.steam_id
  `).get(serverId, steamId) as any
  if (!row) return null

  const roles = db.prepare(`
    SELECT COALESCE(role, 'unknown') AS name, COUNT(*) AS played, SUM(won) AS wins, SUM(survived) AS survived
    FROM round_players WHERE server_id = ? AND steam_id = ? GROUP BY name ORDER BY played DESC, name ASC
  `).all(serverId, steamId) as WinRow[]

  const recent = db.prepare(`
    SELECT r.round_id AS roundId, r.map, r.result, r.received_at AS receivedAt,
           rp.role, rp.team, rp.won, rp.survived,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = r.server_id AND d.round_id = r.round_id AND d.attacker_steam_id = rp.steam_id) AS kills
    FROM round_players rp JOIN rounds r ON r.server_id = rp.server_id AND r.round_id = rp.round_id
    WHERE rp.server_id = ? AND rp.steam_id = ? ORDER BY r.received_at DESC, r.rowid DESC LIMIT 20
  `).all(serverId, steamId) as any[]

  return {
    ...row,
    nick: row.nick ?? row.steamId,
    roles,
    recent: recent.map(r => ({ ...r, receivedAt: sqliteToIso(r.receivedAt), won: !!r.won, survived: !!r.survived })),
  }
}

export const isBotId = (steamId: string) => steamId.startsWith(BOT_PREFIX)
