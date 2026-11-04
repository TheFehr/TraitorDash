import db from './Database'
import { BOT_ID_PREFIX } from './validators'

// Read-side queries for the round stats the bridge reports (migration v7).
//
// Bots only exist when the test scenario runs; they carry synthetic IDs starting with this
// prefix and are hidden everywhere unless asked for, so a test never pollutes the leaderboard.
const BOT_PREFIX = BOT_ID_PREFIX
const NOT_BOT = `rp.steam_id NOT LIKE '${BOT_PREFIX}%'`

/** SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) as an ISO instant, which the <Heartbeat> time element understands. */
export const sqliteToIso = (v: string | null): string | null => (v ? `${v.replace(' ', 'T')}Z` : null)

/**
 * `bots` includes bot-only rounds. `by` picks the state the role and team tables group by
 * (RFC 14, 4.5): `end`, the default, is the role and team a player finished the round with ("as
 * played"); `start` is the state they were dealt. A round reported before the end state existed has
 * none, and counts as dealt in both.
 */
export interface StatsOptions { bots?: boolean, by?: 'start' | 'end' }

export const BY_VALUES = ['start', 'end'] as const
export const parseBy = (v: string | undefined | null): 'start' | 'end' => (v === 'start' ? 'start' : 'end')

const stateColumn = (column: 'role' | 'team', o?: StatsOptions) =>
  o?.by === 'start' ? `rp.${column}` : `COALESCE(rp.end_${column}, rp.${column})`

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
    SELECT COALESCE(${stateColumn(column, o)}, 'unknown') AS name, COUNT(*) AS played,
           SUM(rp.won) AS wins, SUM(rp.survived) AS survived
    FROM round_players rp WHERE rp.server_id = ? AND ${botFilter(o)}
    GROUP BY name ORDER BY played DESC, name ASC
  `).all(serverId) as WinRow[]

export const getRoleStats = (serverId: string, o?: StatsOptions) => winRows('role', serverId, o)
export const getTeamStats = (serverId: string, o?: StatsOptions) => winRows('team', serverId, o)

/** How many player rows have an end state, out of all of them: the "as played" tables are only as complete as this. */
export function getEndStateCoverage(serverId: string, o?: StatsOptions): { withEnd: number, total: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN rp.end_role IS NOT NULL OR rp.end_team IS NOT NULL THEN 1 ELSE 0 END), 0) AS withEnd
    FROM round_players rp WHERE rp.server_id = ? AND ${botFilter(o)}
  `).get(serverId) as { total: number, withEnd: number }
  return { withEnd: row.withEnd, total: row.total }
}

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
  role: string | null, team: string | null, endRole: string | null, endTeam: string | null,
  won: boolean, survived: boolean, kills: number
}
export interface PlayerDetail extends LeaderRow {
  roles: WinRow[], recent: PlayerRound[]
  /** Times this player was brought back, and times they brought someone back (a known reviver; RFC 14, 4.5). */
  revived: number, revivals: number
}

export function getPlayer(serverId: string, steamId: string, o?: StatsOptions): PlayerDetail | null {
  const row = db.prepare(`
    SELECT rp.steam_id AS steamId, ${nickOf} AS nick, COUNT(*) AS rounds, SUM(rp.won) AS wins, SUM(rp.survived) AS survived,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.attacker_steam_id = rp.steam_id) AS kills,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = rp.server_id AND d.victim_steam_id = rp.steam_id) AS deaths
    FROM round_players rp WHERE rp.server_id = ? AND rp.steam_id = ? GROUP BY rp.steam_id
  `).get(serverId, steamId) as any
  if (!row) return null

  const roles = db.prepare(`
    SELECT COALESCE(${stateColumn('role', o)}, 'unknown') AS name, COUNT(*) AS played, SUM(rp.won) AS wins, SUM(rp.survived) AS survived
    FROM round_players rp WHERE rp.server_id = ? AND rp.steam_id = ? GROUP BY name ORDER BY played DESC, name ASC
  `).all(serverId, steamId) as WinRow[]

  const recent = db.prepare(`
    SELECT r.round_id AS roundId, r.map, r.result, r.received_at AS receivedAt,
           rp.role, rp.team, rp.end_role AS endRole, rp.end_team AS endTeam, rp.won, rp.survived,
           (SELECT COUNT(*) FROM deaths d WHERE d.server_id = r.server_id AND d.round_id = r.round_id AND d.attacker_steam_id = rp.steam_id) AS kills
    FROM round_players rp JOIN rounds r ON r.server_id = rp.server_id AND r.round_id = rp.round_id
    WHERE rp.server_id = ? AND rp.steam_id = ? ORDER BY r.received_at DESC, r.rowid DESC LIMIT 20
  `).all(serverId, steamId) as any[]

  return {
    ...row,
    nick: row.nick ?? row.steamId,
    revived: (db.prepare('SELECT COUNT(*) AS n FROM round_revives WHERE server_id = ? AND victim = ?').get(serverId, steamId) as { n: number }).n,
    revivals: (db.prepare('SELECT COUNT(*) AS n FROM round_revives WHERE server_id = ? AND reviver = ? AND victim != reviver').get(serverId, steamId) as { n: number }).n,
    roles,
    recent: recent.map(r => ({ ...r, receivedAt: sqliteToIso(r.receivedAt), won: !!r.won, survived: !!r.survived })),
  }
}

export const isBotId = (steamId: string) => steamId.startsWith(BOT_PREFIX)


export interface ReplayRound {
  roundId: string, map: string | null, result: string, duration: number | null, startedAt: string | null
  /** `role` and `team` are as dealt; `endRole` and `endTeam` are where the player ended (null for rounds from before RFC 14). */
  players: { id: string, nick: string | null, role: string | null, team: string | null, endRole: string | null, endTeam: string | null, won: boolean, survived: boolean }[]
  revives: RoundRevive[]
}

/**
 * A round as the replay shows it (RFC 12, 3.5): its header and its players. null when the server
 * has no such round, or when it is a bot-only test round and `bots` was not asked for, as in the stats.
 */
export function getReplayRound(serverId: string, roundId: string, o?: StatsOptions): ReplayRound | null {
  const r = db.prepare(`
    SELECT r.round_id AS roundId, r.map, r.result, r.duration, r.started_at AS startedAt
    FROM rounds r WHERE r.server_id = ? AND r.round_id = ? AND ${roundHasPlayers(o)}
  `).get(serverId, roundId) as any
  if (!r) return null
  const players = db.prepare(`
    SELECT rp.steam_id AS id, rp.nick, rp.role, rp.team, rp.end_role AS endRole, rp.end_team AS endTeam, rp.won, rp.survived
    FROM round_players rp WHERE rp.server_id = ? AND rp.round_id = ? AND ${botFilter(o)} ORDER BY rp.rowid
  `).all(serverId, roundId) as any[]
  const ids = new Set(players.map(p => p.id))
  const revives = getRevives(serverId, roundId).filter(v => ids.has(v.victim))
  return { ...r, players: players.map(p => ({ ...p, won: !!p.won, survived: !!p.survived })), revives }
}

export interface RoundRevive { victim: string, reviver: string | null, how: string | null, why: string | null, at: number | null }

/** The revivals of one round, in the order they were reported (RFC 14, 4.4). */
export const getRevives = (serverId: string, roundId: string): RoundRevive[] =>
  db.prepare('SELECT victim, reviver, how, why, at_seconds AS at FROM round_revives WHERE server_id = ? AND round_id = ? ORDER BY id ASC').all(serverId, roundId) as RoundRevive[]

export interface FirstBlood { at: number | null, victim: string, killer: string | null }

/** The first death of a round: the earliest by time into the round, else the first reported. Names are the players' nicks. */
export function getFirstBlood(serverId: string, roundId: string): FirstBlood | null {
  const d = db.prepare(`
    SELECT at_seconds AS at, victim_steam_id AS victim, attacker_steam_id AS killer FROM deaths
    WHERE server_id = ? AND round_id = ? ORDER BY at_seconds IS NULL, at_seconds ASC, id ASC LIMIT 1
  `).get(serverId, roundId) as { at: number | null, victim: string, killer: string | null } | null
  if (!d) return null
  const nick = (id: string | null) => {
    if (!id) return null
    const row = db.prepare('SELECT nick FROM round_players WHERE server_id = ? AND round_id = ? AND steam_id = ?').get(serverId, roundId, id) as { nick: string | null } | null
    return row?.nick ?? id
  }
  return { at: d.at, victim: nick(d.victim)!, killer: nick(d.killer) }
}

export interface MapActivity { rounds: number, avgDuration: number | null, lastRound: string | null, results: { name: string, n: number }[] }

/** What the rounds say about each map: how many were played, how long they take, when the last one was, who won. */
export function getMapActivity(serverId: string, o?: StatsOptions): Map<string, MapActivity> {
  const rows = db.prepare(`
    SELECT r.map AS map, r.result AS result, COUNT(*) AS n, SUM(r.duration) AS secs, COUNT(r.duration) AS timed, MAX(r.received_at) AS last
    FROM rounds r WHERE r.server_id = ? AND r.map IS NOT NULL AND ${roundHasPlayers(o)} GROUP BY r.map, r.result
  `).all(serverId) as { map: string, result: string, n: number, secs: number | null, timed: number, last: string | null }[]
  const out = new Map<string, MapActivity & { secs: number, timed: number }>()
  for (const r of rows) {
    const m = out.get(r.map) ?? { rounds: 0, avgDuration: null, lastRound: null, results: [], secs: 0, timed: 0 }
    m.rounds += r.n; m.secs += r.secs ?? 0; m.timed += r.timed
    if (r.last && (!m.lastRound || r.last > m.lastRound)) m.lastRound = r.last
    m.results.push({ name: r.result, n: r.n })
    out.set(r.map, m)
  }
  const done = new Map<string, MapActivity>()
  for (const [k, m] of out) {
    done.set(k, { rounds: m.rounds, avgDuration: m.timed ? Math.round(m.secs / m.timed) : null, lastRound: sqliteToIso(m.lastRound), results: m.results.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)) })
  }
  return done
}

export const getDeathCount = (serverId: string, roundId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM deaths WHERE server_id = ? AND round_id = ?').get(serverId, roundId) as { n: number }).n

// ---- weapons and killzones (RFC 21) ---------------------------------------------------------------------------

export interface WeaponRow {
  weapon: string
  /** Damage to other teams' players, and to one's own team (kept apart; only the first is ranked). */
  damage: number, friendlyDamage: number, hits: number
  kills: number, deaths: number, players: number, rounds: number
}
export const WEAPON_SORTS = ['damage', 'kills', 'hits'] as const
export type WeaponSort = (typeof WEAPON_SORTS)[number]
export const parseWeaponSort = (v: string | undefined | null): WeaponSort => (WEAPON_SORTS as readonly string[]).includes(v ?? '') ? (v as WeaponSort) : 'damage'

const notBotCol = (col: string, o?: StatsOptions) => (o?.bots ? '1=1' : `${col} NOT LIKE '${BOT_PREFIX}%'`)

/** Rows of two queries, put together by weapon. */
function mergeWeapons(damage: any[], kills: any[], deaths: any[]): Map<string, WeaponRow> {
  const by = new Map<string, WeaponRow>()
  const row = (w: string) => {
    let r = by.get(w)
    if (!r) by.set(w, r = { weapon: w, damage: 0, friendlyDamage: 0, hits: 0, kills: 0, deaths: 0, players: 0, rounds: 0 })
    return r
  }
  for (const d of damage) { const r = row(d.weapon); r.damage = d.damage ?? 0; r.friendlyDamage = d.friendly ?? 0; r.hits = d.hits ?? 0; r.players = d.players; r.rounds = d.rounds }
  for (const k of kills) row(k.weapon).kills = k.n
  for (const d of deaths) row(d.weapon).deaths = d.n
  return by
}

export interface WeaponStats {
  rows: WeaponRow[]
  /** Damage to other teams, summed over every weapon (what the shares are of). */
  totalDamage: number
  /** How many rounds have weapon data, and how many rounds there are. */
  rounds: { withData: number, total: number }
}

/** Damage, hits, kills and deaths for each weapon the server has seen (RFC 21, 4.3), most first. */
export function getWeaponStats(serverId: string, o?: StatsOptions, sort: WeaponSort = 'damage', limit = 50): WeaponStats {
  const damage = db.prepare(`
    SELECT rd.weapon AS weapon, SUM(CASE WHEN rd.friendly = 0 THEN rd.damage END) AS damage, SUM(CASE WHEN rd.friendly = 1 THEN rd.damage END) AS friendly,
           SUM(CASE WHEN rd.friendly = 0 THEN rd.hits END) AS hits, COUNT(DISTINCT rd.steam_id) AS players, COUNT(DISTINCT rd.round_id) AS rounds
    FROM round_damage rd WHERE rd.server_id = ? AND ${notBotCol('rd.steam_id', o)} GROUP BY rd.weapon
  `).all(serverId)
  const kills = db.prepare(`
    SELECT d.weapon AS weapon, COUNT(*) AS n FROM deaths d
    WHERE d.server_id = ? AND d.weapon IS NOT NULL AND d.attacker_steam_id IS NOT NULL AND ${notBotCol('d.attacker_steam_id', o)} GROUP BY d.weapon
  `).all(serverId)
  const deaths = db.prepare(`
    SELECT d.weapon AS weapon, COUNT(*) AS n FROM deaths d
    WHERE d.server_id = ? AND d.weapon IS NOT NULL AND ${notBotCol('d.victim_steam_id', o)} GROUP BY d.weapon
  `).all(serverId)
  const all = [...mergeWeapons(damage, kills, deaths).values()]
  const key = (r: WeaponRow) => (sort === 'kills' ? r.kills : sort === 'hits' ? r.hits : r.damage)
  all.sort((a, b) => key(b) - key(a) || b.damage - a.damage || b.kills - a.kills || a.weapon.localeCompare(b.weapon))
  const withData = (db.prepare(`
    SELECT COUNT(*) AS n FROM rounds r WHERE r.server_id = ? AND ${roundHasPlayers(o)} AND (
      EXISTS (SELECT 1 FROM round_damage rd WHERE rd.server_id = r.server_id AND rd.round_id = r.round_id)
      OR EXISTS (SELECT 1 FROM deaths d WHERE d.server_id = r.server_id AND d.round_id = r.round_id AND d.weapon IS NOT NULL))
  `).get(serverId) as { n: number }).n
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM rounds r WHERE r.server_id = ? AND ${roundHasPlayers(o)}`).get(serverId) as { n: number }).n
  return { rows: all.slice(0, limit), totalDamage: all.reduce((n, r) => n + r.damage, 0), rounds: { withData, total } }
}

/** The same for one player: damage and kills with each weapon, and how often it killed them. */
export function getPlayerWeapons(serverId: string, steamId: string, limit = 30): WeaponRow[] {
  const damage = db.prepare(`
    SELECT rd.weapon AS weapon, SUM(CASE WHEN rd.friendly = 0 THEN rd.damage END) AS damage, SUM(CASE WHEN rd.friendly = 1 THEN rd.damage END) AS friendly,
           SUM(CASE WHEN rd.friendly = 0 THEN rd.hits END) AS hits, 1 AS players, COUNT(DISTINCT rd.round_id) AS rounds
    FROM round_damage rd WHERE rd.server_id = ? AND rd.steam_id = ? GROUP BY rd.weapon
  `).all(serverId, steamId)
  const kills = db.prepare(`
    SELECT d.weapon AS weapon, COUNT(*) AS n FROM deaths d WHERE d.server_id = ? AND d.weapon IS NOT NULL AND d.attacker_steam_id = ? GROUP BY d.weapon
  `).all(serverId, steamId)
  const deaths = db.prepare(`
    SELECT d.weapon AS weapon, COUNT(*) AS n FROM deaths d WHERE d.server_id = ? AND d.weapon IS NOT NULL AND d.victim_steam_id = ? GROUP BY d.weapon
  `).all(serverId, steamId)
  return [...mergeWeapons(damage, kills, deaths).values()]
    .sort((a, b) => b.damage - a.damage || b.kills - a.kills || b.deaths - a.deaths || a.weapon.localeCompare(b.weapon))
    .slice(0, limit)
}

/** The size of a killzone square, in world units (RFC 21, 4.4). */
export const KILLZONE_CELL = 128
/** The height bands the deaths are kept in, finer than the squares so a storey can be told from the next. */
export const KILLZONE_BAND = 32

export interface Killzones {
  /** Deaths summed by square (`bx`, `by`: the position divided by KILLZONE_CELL, rounded down) and by height band (`bz`, in KILLZONE_BAND units). */
  cells: { bx: number, by: number, bz: number, n: number }[]
  deaths: number, rounds: number
  /** The weapons that killed on this map, most first, for the filter links. */
  weapons: { weapon: string, n: number }[]
}

/** Where the victims died on one map (RFC 21, 4.4), with the position known; `weapon` limits it to one weapon. */
export function getKillzones(serverId: string, map: string, o?: StatsOptions, weapon?: string | null): Killzones {
  const floor = (col: string, size: number) => `((${col} - (((${col} % ${size}) + ${size}) % ${size})) / ${size})`
  const base = `FROM deaths d JOIN rounds r ON r.server_id = d.server_id AND r.round_id = d.round_id
    WHERE d.server_id = ? AND r.map = ? AND d.x IS NOT NULL AND ${notBotCol('d.victim_steam_id', o)}`
  const cells = db.prepare(`
    SELECT ${floor('d.x', KILLZONE_CELL)} AS bx, ${floor('d.y', KILLZONE_CELL)} AS by, ${floor('d.z', KILLZONE_BAND)} AS bz, COUNT(*) AS n ${base} ${weapon ? 'AND d.weapon = ?' : ''}
    GROUP BY bx, by, bz
  `).all(...(weapon ? [serverId, map, weapon] : [serverId, map])) as Killzones['cells']
  const totals = db.prepare(`SELECT COUNT(*) AS deaths, COUNT(DISTINCT d.round_id) AS rounds ${base} ${weapon ? 'AND d.weapon = ?' : ''}`)
    .get(...(weapon ? [serverId, map, weapon] : [serverId, map])) as { deaths: number, rounds: number }
  const weapons = db.prepare(`SELECT COALESCE(d.weapon, '') AS weapon, COUNT(*) AS n ${base} AND d.weapon IS NOT NULL GROUP BY d.weapon ORDER BY n DESC, d.weapon LIMIT 30`)
    .all(serverId, map) as Killzones['weapons']
  return { cells, ...totals, weapons }
}
