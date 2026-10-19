/**
 * Position tracks of rounds (RFC 12): what the bridge uploads, how it is checked, and how much of
 * it an instance and a server keep. Nothing here touches the database; Store does that.
 */

export const MAX_TRACK_BYTES = 8 * 1024 * 1024
export const MAX_TICKS = 20_000
export const MAX_TRACK_PLAYERS = 128
export const MAX_TRACK_DEATHS = 512
export const MAX_SEGMENTS_PER_PLAYER = 64

const STEAM_ID = /^\d{5,20}$/
const MAP_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const FINGERPRINT = /^[0-9a-f]{64}$/

/** Positions are whole numbers of 8 units: Source maps reach +-16384 units, so +-2048 here; this leaves room. */
const POS_MAX = 4096
const POS_STEP_MAX = 2 * POS_MAX
const TICK_STEP_MAX = 60_000 // a tick is at most a minute after the last
const TIME_MAX = 6 * 60 * 60 * 1000 // a round of at most six hours, in ms

export interface TrackSegment { from: number, x: number[], y: number[], z: number[], a: number[] }
export interface TrackPlayer { id: string, segments: TrackSegment[] }
export interface TrackDeath {
  victim: string, attacker: string | null, t: number
  vx: number, vy: number, vz: number
  ax: number | null, ay: number | null, az: number | null
  weapon: string | null
}
export interface Track {
  roundId: string
  map: string
  fingerprint: string | null
  truncated: boolean
  degraded: boolean
  /** Tick times in ms since the round began, as differences. */
  t: number[]
  players: TrackPlayer[]
  deaths: TrackDeath[]
}

export type TrackCheck = { ok: true, track: Track } | { ok: false, error: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** `v` as an array of at most `max` integers (and at least `min`), each within [lo, hi]; null if it is not. */
function ints(v: unknown, min: number, max: number, lo: number, hi: number): number[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null
  for (const n of v) if (!isInt(n) || n < lo || n > hi) return null
  return v as number[]
}

/** Rebuilds absolute values from a first value and differences, all of which must stay within [lo, hi]. */
function rebuilds(diffs: number[], lo: number, hi: number): boolean {
  let at = 0
  for (const d of diffs) { at += d; if (at < lo || at > hi) return false }
  return true
}

/**
 * Checks an uploaded track against the round it claims to belong to. `players` are the round's own
 * players and `map` its map (null when the round did not say). Everything is strict: a track that
 * does not fit is refused whole, because a half-trusted track would draw a wrong replay.
 */
export function validateTrack(body: unknown, round: { roundId: string, map: string | null, players: ReadonlySet<string> }): TrackCheck {
  const no = (error: string): TrackCheck => ({ ok: false, error })
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('the body must be an object')
  if (b.round_id !== round.roundId) return no('round_id does not match the round')
  if (typeof b.map !== 'string' || !MAP_NAME.test(b.map)) return no('map is required')
  if (round.map && b.map !== round.map) return no('map does not match the round')
  if (b.fingerprint !== undefined && b.fingerprint !== null && (typeof b.fingerprint !== 'string' || !FINGERPRINT.test(b.fingerprint))) return no('fingerprint must be 64 hex characters')
  for (const flag of ['truncated', 'degraded'] as const) if (b[flag] !== undefined && typeof b[flag] !== 'boolean') return no(`${flag} must be true or false`)

  const t = ints(b.t, 1, MAX_TICKS, 0, TICK_STEP_MAX)
  if (!t) return no(`t must be 1-${MAX_TICKS} whole numbers, each a step of at most ${TICK_STEP_MAX} ms`)
  if (t.reduce((a, n) => a + n, 0) > TIME_MAX) return no('the track is longer than six hours')

  if (!Array.isArray(b.players) || b.players.length === 0 || b.players.length > MAX_TRACK_PLAYERS) return no(`players must be 1-${MAX_TRACK_PLAYERS} entries`)
  const seen = new Set<string>()
  const players: TrackPlayer[] = []
  for (const p of b.players as Record<string, unknown>[]) {
    if (!p || typeof p.id !== 'string' || !STEAM_ID.test(p.id)) return no('a player has an invalid id')
    if (!round.players.has(p.id)) return no(`player ${p.id.slice(0, 24)} was not in the round`)
    if (seen.has(p.id)) return no(`player ${p.id} appears twice`)
    seen.add(p.id)
    if (!Array.isArray(p.segments) || p.segments.length > MAX_SEGMENTS_PER_PLAYER) return no(`segments must be at most ${MAX_SEGMENTS_PER_PLAYER} entries`)
    const segments: TrackSegment[] = []
    let next = 0 // the first tick index the next segment may start at
    for (const s of p.segments as Record<string, unknown>[]) {
      if (!s || !isInt(s.from) || s.from < next || s.from >= t.length) return no('a segment starts out of order, overlaps the one before or starts past the last tick')
      const x = ints(s.x, 1, t.length - s.from, -POS_STEP_MAX, POS_STEP_MAX)
      if (!x) return no('a segment has an invalid x')
      const y = ints(s.y, x.length, x.length, -POS_STEP_MAX, POS_STEP_MAX)
      const z = ints(s.z, x.length, x.length, -POS_STEP_MAX, POS_STEP_MAX)
      const a = ints(s.a, x.length, x.length, -255, 255)
      if (!y || !z || !a) return no('the arrays of a segment must be whole numbers in range and of the same length')
      if (!rebuilds(x, -POS_MAX, POS_MAX) || !rebuilds(y, -POS_MAX, POS_MAX) || !rebuilds(z, -POS_MAX, POS_MAX)) return no('a position is outside the map')
      if (!rebuilds(a, 0, 255)) return no('a view angle is outside 0-255')
      segments.push({ from: s.from, x, y, z, a })
      next = s.from + x.length
    }
    players.push({ id: p.id, segments })
  }

  const deaths: TrackDeath[] = []
  if (b.deaths !== undefined) {
    if (!Array.isArray(b.deaths) || b.deaths.length > MAX_TRACK_DEATHS) return no(`deaths must be at most ${MAX_TRACK_DEATHS} entries`)
    for (const d of b.deaths as Record<string, unknown>[]) {
      if (!d || typeof d.victim !== 'string' || !round.players.has(d.victim)) return no('a death names a victim who was not in the round')
      const hasAttacker = d.attacker !== undefined && d.attacker !== null
      if (hasAttacker && (typeof d.attacker !== 'string' || !round.players.has(d.attacker))) return no('a death names an attacker who was not in the round')
      if (!isInt(d.t) || d.t < 0 || d.t > TIME_MAX) return no('a death has an invalid time')
      const at = (k: string) => (isInt(d[k]) && Math.abs(d[k] as number) <= POS_MAX ? (d[k] as number) : null)
      const vx = at('vx'), vy = at('vy'), vz = at('vz')
      if (vx === null || vy === null || vz === null) return no('a death has an invalid position')
      let ax: number | null = null, ay: number | null = null, az: number | null = null
      if (hasAttacker) {
        ax = at('ax'); ay = at('ay'); az = at('az')
        if (ax === null || ay === null || az === null) return no('a death has an invalid attacker position')
      }
      const weapon = typeof d.weapon === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(d.weapon) ? d.weapon : null
      deaths.push({ victim: d.victim as string, attacker: hasAttacker ? (d.attacker as string) : null, t: d.t, vx, vy, vz, ax, ay, az, weapon })
    }
  }

  return { ok: true, track: {
    roundId: round.roundId, map: b.map, fingerprint: typeof b.fingerprint === 'string' ? b.fingerprint : null,
    truncated: b.truncated === true, degraded: b.degraded === true, t, players, deaths,
  } }
}

/** What an instance keeps, and the ceilings no server may go past (RFC 12, 3.4). */
export interface TrackConfig { keepCount: number, keepMb: number, maxCount: number, maxMb: number, maxPinned: number }

export const TRACK_DEFAULTS: TrackConfig = { keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 50 }

/** The configuration from the environment; throws with a message that says what to fix. */
export function trackConfig(env: Record<string, string | undefined> = process.env): TrackConfig {
  const read = (name: string, fallback: number) => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number, not "${raw}"`)
    return Number(raw.trim())
  }
  const c: TrackConfig = {
    keepCount: read('TRACKS_KEEP_COUNT', TRACK_DEFAULTS.keepCount),
    keepMb: read('TRACKS_KEEP_MB', TRACK_DEFAULTS.keepMb),
    maxCount: read('TRACKS_MAX_COUNT', TRACK_DEFAULTS.maxCount),
    maxMb: read('TRACKS_MAX_MB', TRACK_DEFAULTS.maxMb),
    maxPinned: read('TRACKS_MAX_PINNED', TRACK_DEFAULTS.maxPinned),
  }
  if (c.keepCount > c.maxCount) throw new Error(`TRACKS_KEEP_COUNT (${c.keepCount}) is above TRACKS_MAX_COUNT (${c.maxCount})`)
  if (c.keepMb > c.maxMb) throw new Error(`TRACKS_KEEP_MB (${c.keepMb}) is above TRACKS_MAX_MB (${c.maxMb})`)
  return c
}

/** The limits a server has: its own override within the ceiling, else the instance default. */
export function effectiveLimits(cfg: TrackConfig, own: { count: number | null, mb: number | null }): { count: number, mb: number } {
  return { count: Math.min(own.count ?? cfg.keepCount, cfg.maxCount), mb: Math.min(own.mb ?? cfg.keepMb, cfg.maxMb) }
}

/** A per-server value from a form: empty means "use the default" (null); a bad or too large one is an error. */
export function parseLimit(raw: string, ceiling: number, what: string): { ok: true, value: number | null } | { ok: false, error: string } {
  const v = raw.trim()
  if (v === '') return { ok: true, value: null }
  if (!/^\d+$/.test(v)) return { ok: false, error: `${what} must be a whole number` }
  const n = Number(v)
  if (n > ceiling) return { ok: false, error: `${what} cannot be more than ${ceiling} on this instance` }
  return { ok: true, value: n }
}
