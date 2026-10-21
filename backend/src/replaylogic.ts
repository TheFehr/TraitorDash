// The parts of the round replay (RFC 12, 3.5) that are not drawing: decoding a stored track,
// finding where a player is at a given time, which level a position is on, which player to select
// first. Plain code, no browser and no three.js, so it can be tested; the viewer (replay.ts) and the
// tests import it.

/** What the backend stores: tick times as differences, per player segments with first-value-then-differences. */
export interface RawSegment { from: number, x: number[], y: number[], z: number[], a: number[] }
export interface RawTrack {
  t: number[]
  players: { id: string, segments: RawSegment[] }[]
  deaths: { victim: string, attacker: string | null, t: number, vx: number, vy: number, vz: number, ax: number | null, ay: number | null, az: number | null, weapon: string | null }[]
  /** Revivals and role changes (RFC 14); absent in tracks stored before it. */
  events?: TrackEvent[]
}
export interface TrackEvent { t: number, p: string, k: 'revive' | 'role', role?: string, team?: string, by?: string, how?: string, why?: string }

/** One run of consecutive samples of one player, in Source units and degrees-in-256ths, at real times. */
export interface Segment { t: number[], x: number[], y: number[], z: number[], a: number[] }
export interface Decoded {
  /** Times in ms since the round began, for every tick. */
  times: number[]
  /** The last tick's time: how long the track is. */
  length: number
  players: Map<string, Segment[]>
  deaths: Death[]
  /** In time order; empty for a track without any. */
  events: TrackEvent[]
}
export interface Death { victim: string, attacker: string | null, t: number, at: [number, number, number], from: [number, number, number] | null, weapon: string | null }

/** Positions are stored in whole numbers of 8 units. */
export const UNITS = 8

const cumulative = (diffs: number[]) => { let at = 0; return diffs.map(d => (at += d)) }

/** Rebuilds absolute times and positions from the stored differences. */
export function decodeTrack(raw: RawTrack): Decoded {
  const times = cumulative(raw.t)
  const players = new Map<string, Segment[]>()
  for (const p of raw.players) {
    const segs: Segment[] = []
    for (const s of p.segments) {
      const n = s.x.length
      segs.push({
        t: times.slice(s.from, s.from + n),
        x: cumulative(s.x).map(v => v * UNITS), y: cumulative(s.y).map(v => v * UNITS), z: cumulative(s.z).map(v => v * UNITS),
        a: cumulative(s.a),
      })
    }
    players.set(p.id, segs)
  }
  const deaths: Death[] = raw.deaths.map(d => ({
    victim: d.victim, attacker: d.attacker, t: d.t,
    at: [d.vx * UNITS, d.vy * UNITS, d.vz * UNITS],
    from: d.attacker !== null && d.ax !== null && d.ay !== null && d.az !== null ? [d.ax * UNITS, d.ay * UNITS, d.az * UNITS] : null,
    weapon: d.weapon,
  }))
  deaths.sort((a, b) => a.t - b.t)
  const events = [...(raw.events ?? [])].sort((a, b) => a.t - b.t)
  return { times, length: times.length ? times[times.length - 1]! : 0, players, deaths, events }
}

export interface Pose { x: number, y: number, z: number, /** Heading in 256ths of a turn, 0-255. */ yaw: number }

/** The shortest way round a 256-step circle from `a` to `b`, as a fraction `f` of the way. */
export const lerpYaw = (a: number, b: number, f: number) => {
  let d = ((b - a) % 256 + 256) % 256
  if (d > 128) d -= 256
  return (((a + d * f) % 256) + 256) % 256
}

/**
 * Where a player is at time `ms`: interpolated between the two samples around it by their real
 * times. null when the player has no sample there: before their first, after their last, or in a
 * gap between two segments (a skipped tick, a death and a revival). A gap is a gap, never a
 * straight line across it.
 */
export function poseAt(segments: Segment[], ms: number): Pose | null {
  // The segment that contains ms (they are in time order and do not overlap).
  let lo = 0, hi = segments.length - 1, seg: Segment | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]!
    if (ms < s.t[0]!) hi = mid - 1
    else if (ms > s.t[s.t.length - 1]!) lo = mid + 1
    else { seg = s; break }
  }
  if (!seg) return null
  // The last sample with a time at or before ms.
  let a = 0, b = seg.t.length - 1
  while (a < b) { const m = (a + b + 1) >> 1; if (seg.t[m]! <= ms) a = m; else b = m - 1 }
  if (a === seg.t.length - 1) return { x: seg.x[a]!, y: seg.y[a]!, z: seg.z[a]!, yaw: seg.a[a]! }
  const span = seg.t[a + 1]! - seg.t[a]!
  const f = span > 0 ? (ms - seg.t[a]!) / span : 0
  return {
    x: seg.x[a]! + (seg.x[a + 1]! - seg.x[a]!) * f, y: seg.y[a]! + (seg.y[a + 1]! - seg.y[a]!) * f, z: seg.z[a]! + (seg.z[a + 1]! - seg.z[a]!) * f,
    yaw: lerpYaw(seg.a[a]!, seg.a[a + 1]!, f),
  }
}

/** The last pose of a player at or before `ms` (a trail's end, or where to put a body); null before their first sample. */
export function lastPoseAt(segments: Segment[], ms: number): Pose | null {
  let best: Pose | null = null
  for (const s of segments) {
    if (s.t[0]! > ms) break
    const i = s.t[s.t.length - 1]! <= ms ? s.t.length - 1 : s.t.findLastIndex(t => t <= ms)
    best = { x: s.x[i]!, y: s.y[i]!, z: s.z[i]!, yaw: s.a[i]! }
  }
  return best
}

/** The path a player took during [from, to] ms, as flat x,y,z triples (the samples inside, and the interpolated ends). */
export function trailBetween(segments: Segment[], from: number, to: number): number[] {
  const out: number[] = []
  for (const s of segments) {
    if (s.t[s.t.length - 1]! < from || s.t[0]! > to) continue
    const start = poseAt([s], Math.max(from, s.t[0]!))
    if (start) out.push(start.x, start.y, start.z)
    for (let i = 0; i < s.t.length; i++) if (s.t[i]! > Math.max(from, s.t[0]!) && s.t[i]! < Math.min(to, s.t[s.t.length - 1]!)) out.push(s.x[i]!, s.y[i]!, s.z[i]!)
    const end = poseAt([s], Math.min(to, s.t[s.t.length - 1]!))
    if (end) out.push(end.x, end.y, end.z)
  }
  return out
}

export interface LevelRange { index: number, lo: number, hi: number }

/**
 * The level a height is on: the one whose floors reach it, else the nearest. Where two ranges
 * both reach it (stairs between storeys) the one whose middle is nearer wins; ties go to the lower.
 * 0 when there are no levels.
 */
export function levelOf(levels: LevelRange[], z: number): number {
  let best = 0, bestGap = Infinity, bestMid = Infinity
  for (const l of levels) {
    const gap = z < l.lo ? l.lo - z : z > l.hi ? z - l.hi : 0
    const mid = Math.abs((l.lo + l.hi) / 2 - z)
    if (gap < bestGap || (gap === bestGap && mid < bestMid)) { best = l.index; bestGap = gap; bestMid = mid }
  }
  return best
}

export type BackgroundKind = 'mesh' | 'plan' | 'none'

/** The best background there is: the map's 3D mesh, else its floor plan as tiles, else nothing (3.5). */
export const chooseBackground = (have: { mesh: boolean, plan: boolean }): BackgroundKind => (have.mesh ? 'mesh' : have.plan ? 'plan' : 'none')

/** Whether a mesh or plan made for one version of a map matches the version the round ran on. Unknown is not a mismatch. */
export const versionMismatch = (trackFingerprint: string | null, backgroundFingerprint: string | null) =>
  trackFingerprint !== null && backgroundFingerprint !== null && trackFingerprint !== backgroundFingerprint

/**
 * Who is selected when the replay opens: the signed-in visitor's own player if they took part,
 * else the victim of the round's first death, else the first player in the list; null when there are none.
 * A SteamID64 that is not in the round selects nobody by mistake.
 */
export function defaultSelection(playerIds: string[], viewerId: string | null, deaths: { victim: string, t: number }[]): string | null {
  if (viewerId && playerIds.includes(viewerId)) return viewerId
  const first = [...deaths].sort((a, b) => a.t - b.t).find(d => playerIds.includes(d.victim))
  if (first) return first.victim
  return playerIds[0] ?? null
}

export { teamColour, roleColour, playerColour } from './teamColours'

/** "m:ss" for a time in ms. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A player's role and team at time `ms`: the ones they started with, then each role event up to
 * then (RFC 14, 4.6). `was` lists the earlier roles, oldest first, without repeats of the current one.
 */
export function stateAt(start: { role: string | null, team: string | null }, events: TrackEvent[], player: string, ms: number): { role: string | null, team: string | null, was: string[] } {
  let role = start.role, team = start.team
  const was: string[] = []
  for (const e of events) {
    if (e.t > ms) break
    if (e.k !== 'role' || e.p !== player) continue
    if (role !== null && role !== e.role && !was.includes(role)) was.push(role)
    role = e.role ?? role
    team = e.team ?? team
  }
  return { role, team, was: was.filter(r => r !== role) }
}

/** The death a player is lying dead from at `ms`: their latest death by then, unless a revival came after it. null when alive. */
export function currentDeath(deaths: Death[], events: TrackEvent[], player: string, ms: number): Death | null {
  let death: Death | null = null
  for (const d of deaths) if (d.victim === player && d.t <= ms && (!death || d.t >= death.t)) death = d
  if (!death) return null
  const d = death
  return events.some(e => e.k === 'revive' && e.p === player && e.t >= d.t && e.t <= ms) ? null : death
}

/** How far before a revival the killer's death may be to be mentioned (RFC 14, 4.4). */
export const KILLER_WINDOW_MS = 30000

/**
 * "They came back N seconds after their killer died": the player who last killed the revived one
 * died in the 30 seconds before the revival. A sequence of recorded events, not a claimed cause.
 */
export function killerDiedBefore(deaths: Death[], revive: { t: number, p: string }): { killer: string, seconds: number } | null {
  let own: Death | null = null
  for (const d of deaths) if (d.victim === revive.p && d.t <= revive.t && (!own || d.t >= own.t)) own = d
  if (!own || !own.attacker) return null
  const killer = own.attacker
  let theirs: Death | null = null
  for (const d of deaths) if (d.victim === killer && d.t >= own.t && d.t <= revive.t && (!theirs || d.t >= theirs.t)) theirs = d
  if (!theirs || revive.t - theirs.t > KILLER_WINDOW_MS) return null
  return { killer, seconds: Math.round((revive.t - theirs.t) / 1000) }
}

/** A readable name for what revived someone: "Defibrillator", "role: haunter", or "source unknown". */
export function reviveSource(how: string | null | undefined): string {
  if (!how) return 'source unknown'
  if (how.startsWith('role:')) return 'role: ' + how.slice(5)
  const name = how.replace(/^weapon_ttt2?_/, '').replace(/^weapon_/, '').replace(/_/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Where a revived player reappears: their first sample at or after the revival, within 3 s; null when there is none. */
export function revivePose(segments: Segment[], t: number): Pose | null {
  for (const s of segments) {
    const i = s.t.findIndex(x => x >= t)
    if (i >= 0 && s.t[i]! - t <= 3000) return { x: s.x[i]!, y: s.y[i]!, z: s.z[i]!, yaw: s.a[i]! }
  }
  return null
}
