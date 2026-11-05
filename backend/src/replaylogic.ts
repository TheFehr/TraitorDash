// The parts of the round replay (RFC 12, 3.5) that are not drawing: decoding a stored track,
// finding where a player is at a given time, which level a position is on, which player to select
// first. Plain code, no browser and no three.js, so it can be tested; the viewer (replay.ts) and the
// tests import it.

/** What the backend stores: tick times as differences, per player segments with first-value-then-differences. */
export interface RawSegment { from: number, x: number[], y: number[], z: number[], a: number[], /** How the player moves, for each sample, as bits: 1 crouching, 2 in the air, 4 in water; absent in older tracks. */ s?: number[] }
export interface RawTrack {
  t: number[]
  players: { id: string, segments: RawSegment[] }[]
  deaths: { victim: string, attacker: string | null, t: number, vx: number, vy: number, vz: number, ax: number | null, ay: number | null, az: number | null, weapon: string | null }[]
  /** Revivals and role changes (RFC 14); absent in tracks stored before it. */
  events?: TrackEvent[]
}
export interface TrackEvent { t: number, p: string, k: 'revive' | 'role', role?: string, team?: string, by?: string, how?: string, why?: string }

/** One run of consecutive samples of one player, in Source units and degrees-in-256ths, at real times. */
export interface Segment { t: number[], x: number[], y: number[], z: number[], a: number[], /** As `RawSegment.s`; zeros for a track without it. */ s: number[] }
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

/** A dead player's view sits at the height of their eyes, standing 64 units above the feet and ducking about 28: the least and the most of a rise that is taken for it. */
export const EYE_RISE = { min: 20, max: 100 }

/**
 * The game reports a death after the victim has become a spectator, whose position is at the height of their eyes, and the
 * track's sample at the death time was taken at the same place. On a real server (2026-11-04) 278 of 322 deaths were 64 units
 * above the victim's sample before them, and the rest 24 to 88. The feet are where the victim was one sample earlier: the death
 * and the sample at its time are put back to that height when they are above it by such a rise. The place across is exact.
 */
function correctDeathHeight(segments: Segment[], d: Death): void {
  let prev: number | null = null
  for (const s of segments) {
    if (s.t[0]! >= d.t) break
    let i = s.t.length - 1
    while (i >= 0 && s.t[i]! >= d.t) i--
    if (i >= 0) prev = s.z[i]!
  }
  if (prev === null) return
  const rise = d.at[2] - prev
  if (rise < EYE_RISE.min || rise > EYE_RISE.max) return
  d.at = [d.at[0], d.at[1], prev]
  for (const s of segments) {
    const last = s.t.length - 1
    if (last > 0 && s.t[last] === d.t && s.z[last]! - s.z[last - 1]! >= EYE_RISE.min && s.z[last]! - s.z[last - 1]! <= EYE_RISE.max) s.z[last] = s.z[last - 1]!
  }
}

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
        s: s.s ?? s.x.map(() => 0),
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
  for (const d of deaths) correctDeathHeight(players.get(d.victim) ?? [], d)
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
    // (not findLastIndex: the game's browser, Chrome 86, does not have it; the first sample is at or before ms, so this ends)
    let i = s.t.length - 1
    while (s.t[i]! > ms) i--
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

export { clock } from './format'

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

/**
 * A name that fits a label of `maxW` pixels: the text at the largest font size from `startPx` down to
 * `minPx` that fits, and at the smallest size shortened with an ellipsis if it still does not. `width`
 * measures a text at a font size (the canvas's `measureText`).
 */
export function fitLabel(text: string, width: (s: string, px: number) => number, maxW = 236, startPx = 30, minPx = 18): { text: string, px: number } {
  for (let px = startPx; px >= minPx; px -= 2) if (width(text, px) <= maxW) return { text, px }
  let cut = text
  while (cut.length > 1 && width(cut + '…', minPx) > maxW) cut = cut.slice(0, -1)
  return { text: cut + '…', px: minPx }
}

// ---- how a player moves (RFC 22, stage 3): which clip of the model is shown, and how far into it

/** The bits of `Segment.s`. */
export const MOVE = { crouching: 1, airborne: 2, swimming: 4 }

/** The bits of how the player moves at `ms`: those of the sample at or before it in the segment that holds it; 0 where there is none. */
export function moveAt(segments: Segment[], ms: number): number {
  let best = 0
  for (const s of segments) {
    if (s.t[0]! > ms) break
    if (ms > s.t[s.t.length - 1]!) continue
    let a = 0, b = s.t.length - 1
    while (a < b) { const m = (a + b + 1) >> 1; if (s.t[m]! <= ms) a = m; else b = m - 1 }
    best = s.s[a] ?? 0
  }
  return best
}

/**
 * How fast a player goes at `ms` in units a second across the ground, and in which direction (radians, Source's: 0 along +x,
 * counter-clockwise), from where they were a moment before and after (`window` ms each way, shortened at the ends of a segment).
 */
export function velocityAt(segments: Segment[], ms: number, window = 150): { speed: number, heading: number } {
  const before = poseAt(segments, ms - window) ?? poseAt(segments, ms)
  const after = poseAt(segments, ms + window) ?? poseAt(segments, ms)
  if (!before || !after) return { speed: 0, heading: 0 }
  // the time actually spanned: a pose is null outside the segment, so the end that is missing is `ms` itself
  const t0 = poseAt(segments, ms - window) ? ms - window : ms, t1 = poseAt(segments, ms + window) ? ms + window : ms
  const dt = (t1 - t0) / 1000
  if (dt <= 0) return { speed: 0, heading: 0 }
  const dx = after.x - before.x, dy = after.y - before.y
  return { speed: Math.hypot(dx, dy) / dt, heading: Math.atan2(dy, dx) }
}

/** The eight directions of travel relative to where the player looks, counter-clockwise from straight ahead: forward, forward-left, left, back-left, back, back-right, right, forward-right. */
export const DIRECTIONS = ['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'] as const
export type Gait = 'walk' | 'run' | 'cwalk'
export const GAITS: Gait[] = ['walk', 'run', 'cwalk']
export type ClipName = 'idle' | 'cidle' | `${Gait}_${typeof DIRECTIONS[number]}`
/** The clips of a gait, one for each direction, in the order of `DIRECTIONS`. */
export const gaitClips = (gait: Gait): ClipName[] => DIRECTIONS.map(d => `${gait}_${d}` as ClipName)

/** The two neighbouring directions that a direction of travel (radians relative to where the player looks, 0 ahead, counter-clockwise) lies between, and how far it is towards the second (0 to 1). */
export function sectorOf(rel: number): { a: number, b: number, f: number } {
  const turn = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const x = turn / (Math.PI / 4), a = Math.floor(x) % 8
  return { a, b: (a + 1) % 8, f: x - Math.floor(x) }
}

/**
 * How far along the ground a player has gone by each sample, summed over all their segments (a gap adds nothing). With `strides`
 * (how far each gait's clip for each direction walks in one cycle) it also keeps, for each gait, the cycles gone: a step is divided by
 * the stride of the direction it goes in relative to where the player looks, so the feet keep up when the player turns from walking
 * ahead to stepping aside (a plain distance divided by one stride would jump the cycle at every such change).
 */
export interface Path { t: number[], d: number[], c: Record<Gait, number[]> | null }
export type Strides = Record<Gait, number[]>
export function pathOf(segments: Segment[], strides: Strides | null = null): Path {
  const t: number[] = [], d: number[] = []
  const c: Record<Gait, number[]> | null = strides ? { walk: [], run: [], cwalk: [] } : null
  let at = 0
  const cycles: Record<Gait, number> = { walk: 0, run: 0, cwalk: 0 }
  for (const s of segments) {
    for (let i = 0; i < s.t.length; i++) {
      if (i > 0) {
        const dx = s.x[i]! - s.x[i - 1]!, dy = s.y[i]! - s.y[i - 1]!, step = Math.hypot(dx, dy)
        at += step
        if (strides && step > 0) {
          const look = (((s.a[i]! + s.a[i - 1]!) / 2) / 256) * Math.PI * 2
          const { a, b, f } = sectorOf(Math.atan2(dy, dx) - look)
          for (const g of GAITS) {
            const stride = strides[g][a]! * (1 - f) + strides[g][b]! * f
            if (stride > 0) cycles[g] += step / stride
          }
        }
      }
      t.push(s.t[i]!); d.push(at)
      if (c) for (const g of GAITS) c[g].push(cycles[g])
    }
  }
  return { t, d, c }
}
const along = (t: number[], v: number[], ms: number): number => {
  if (t.length === 0 || ms <= t[0]!) return 0
  if (ms >= t[t.length - 1]!) return v[v.length - 1]!
  let a = 0, b = t.length - 1
  while (a < b) { const m = (a + b + 1) >> 1; if (t[m]! <= ms) a = m; else b = m - 1 }
  const span = t[a + 1]! - t[a]!
  return v[a]! + (v[a + 1]! - v[a]!) * (span > 0 ? (ms - t[a]!) / span : 0)
}
/** The distance gone by `ms`, between the samples as a straight line. */
export const distanceAt = (path: Path, ms: number): number => along(path.t, path.d, ms)
/** The cycles of a gait gone by `ms` (0 for a path made without strides). */
export const cyclesAt = (path: Path, gait: Gait, ms: number): number => (path.c ? along(path.t, path.c[gait], ms) : 0)

/** Every clip a moving model must have. */
export const clipNames = (): ClipName[] => ['idle', 'cidle', ...GAITS.flatMap(gaitClips)]

/** Where the speeds change over from one clip to the next, in units a second (a real round: walking is 120 to 150, running about 200, sprinting 300). */
export const SPEEDS = { still: 12, walk: 45, run: 150, runFull: 190, crouchWalk: 40 }

/**
 * How much of each clip to show, summing to 1: a player standing still is idle, walking and running are blended into each other by
 * speed, and a crouching player has the two crouch clips. A gait is shown in the direction the player goes relative to where they look
 * (`rel`, radians, 0 ahead, counter-clockwise): the two clips either side of it, by how near.
 */
export function clipWeights(speed: number, rel: number, crouching: boolean): Record<ClipName, number> {
  const ramp = (v: number, from: number, to: number) => Math.min(1, Math.max(0, (v - from) / (to - from)))
  const w = { idle: 0, cidle: 0 } as Record<ClipName, number>
  for (const g of GAITS) for (const n of gaitClips(g)) w[n] = 0
  const { a, b, f } = sectorOf(rel)
  const spread = (gait: Gait, amount: number) => { w[gaitClips(gait)[a]!] += amount * (1 - f); w[gaitClips(gait)[b]!] += amount * f }
  if (crouching) {
    const moving = ramp(speed, SPEEDS.still, SPEEDS.crouchWalk)
    spread('cwalk', moving); w.cidle = 1 - moving
    return w
  }
  const walking = ramp(speed, SPEEDS.still, SPEEDS.walk), running = ramp(speed, SPEEDS.run, SPEEDS.runFull)
  w.idle = 1 - walking
  spread('walk', walking * (1 - running))
  spread('run', walking * running)
  return w
}

/** The angle halfway (`f` of the way) from `a` to `b` the short way round, radians. */
export const lerpAngle = (a: number, b: number, f: number) => {
  let d = ((b - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return a + d * f
}

// ---- the follow camera

/** `current` moved towards `target` the way a spring that is not springy does: in `dtMs` it covers `1 - e^(-dt/tau)` of the way, whatever the frame rate. */
export const damp = (current: number, target: number, dtMs: number, tauMs: number) => current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs))
/** The same for an angle in radians, the short way round. */
export const dampAngle = (current: number, target: number, dtMs: number, tauMs: number) => lerpAngle(current, target, 1 - Math.exp(-Math.max(0, dtMs) / tauMs))
