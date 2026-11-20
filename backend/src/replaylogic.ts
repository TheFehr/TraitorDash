// The parts of the round replay (RFC 12, 3.5) that are not drawing: decoding a stored track,
// finding where a player is at a given time, which level a position is on, which player to select
// first. Plain code, no browser and no three.js, so it can be tested; the viewer (replay.ts) and the
// tests import it.

import { weaponName, creditReason, karmaReason } from './weaponName'

/** What the backend stores: tick times as differences, per player segments with first-value-then-differences. */
export interface RawSegment { from: number, x: number[], y: number[], z: number[], a: number[], /** How the player moves, for each sample, as bits: 1 crouching, 2 in the air, 4 in water; absent in older tracks. */ s?: number[], /** Health of each sample, delta coded (RFC 26, 4a); absent in tracks from before it. */ hp?: number[], /** View pitch of each sample in quarter degrees, delta coded, positive looking down (RFC 39, 3.1); absent in tracks from before it. */ ap?: number[] }
export interface RawTrack {
  /** ms from the first sample to the round's start: the preparation recorded before it (RFC 12, 3.7); absent when there is none. */
  begin?: number
  t: number[]
  players: { id: string, /** The most health the player had; absent in older tracks. */ mh?: number, /** The eye height standing and crouching, whole units (RFC 39, 3.2); absent in older tracks. */ eh?: number, ed?: number, segments: RawSegment[] }[]
  /** The world model path of each weapon class held in the round (RFC 39, 3.4); absent in older tracks. */
  wm?: Record<string, string>
  deaths: { victim: string, attacker: string | null, t: number, vx: number, vy: number, vz: number, ax: number | null, ay: number | null, az: number | null, weapon: string | null }[]
  /** Revivals and role changes (RFC 14); absent in tracks stored before it. */
  events?: TrackEvent[]
  /** Where bodies lay (RFC 24); absent in tracks from before it. */
  /** Props, prop doors and weapons that moved (RFC 20, 4.8); absent in tracks without them. */
  things?: RawThing[]
  bodies?: { p: string, t: number, x: number, y: number, z: number, pt: number, w: number, r: number }[]
  /** Who spoke on the dashboard's voice page, in ms since the round's start (RFC 26, 4c.5): added by the backend when it serves the track; absent when nothing was recorded. */
  talk?: { p: string, from: number, to: number }[]
}
export interface RawThing { e: number, c: string, mdl: string, b: number[], id?: number, g?: number, k: number[], x: number[], y: number[], z: number[], p: number[], w: number[], r: number[] }
/** A thing that moved, decoded: keyframes at real times, positions in units and angles in degrees; `from` is when it first shows, `until` when it is gone (Infinity when it stayed). */
export interface Thing { e: number, c: string, model: string, bounds: number[], mapId: number | null, from: number, until: number, t: number[], x: number[], y: number[], z: number[], pitch: number[], yaw: number[], roll: number[] }
export interface TrackEvent {
  t: number, p: string, k: 'revive' | 'role' | 'say' | 'buy' | 'found' | 'pickup' | 'drop' | 'hurt' | 'heal' | 'wpick' | 'wdrop' | 'c4' | 'dna' | 'tbtn' | 'hold' | 'credits' | 'karma' | 'spec' | 'shots', role?: string, team?: string, by?: string, how?: string, why?: string
  /** say: the line and who could read it; buy: the class and whether it is a passive item; found, pickup, drop: whose body (RFC 26, RFC 24) */
  text?: string, ch?: 'all' | 'team' | 'dead', item?: string, it?: boolean, of?: string
  /** hurt (`p` is the victim): the attacker when a player of the round did it, the cause (a weapon or entity class, or a damage type), the damage and the victim's health after (RFC 26, 4a); heal (`p` is the healed player): the healer when a player of the round, the source (a class, or regen, revive, other), the health gained and the health after (RFC 26, 4b) */
  a?: string, w?: string, d?: number, h?: number
  /** wpick, wdrop (RFC 26, 4c, C1): `w` the weapon class; dna: `w` what the sample came from, `of` whose DNA. c4: `st` plant, defuse, fail (a wrong wire) or boom, `of` the owner of the charge (defuse, fail), `s` the timer in seconds (plant); tbtn: `n` the button's text. c4 and tbtn: `x y z` the place in units / 8. */
  st?: 'plant' | 'defuse' | 'fail' | 'boom', s?: number, n?: string | number, x?: number, y?: number, z?: number
  /** hold (RFC 26, 4c, C2): `w` the weapon in hand from now on. credits, karma: `d` the change, `c` the amount after, `w` the reason word. spec: `of` the player a dead player watches from now on, none for nobody; `pr`, `pm` and `ti` instead of `of`: the prop they possess (its class, the name of its model, its number in the track's things). */
  c?: number
  pr?: string, pm?: string, ti?: number
}

/** One run of consecutive samples of one player, in Source units and degrees-in-256ths, at real times. */
export interface Segment { t: number[], x: number[], y: number[], z: number[], a: number[], /** As `RawSegment.s`; zeros for a track without it. */ s: number[], /** The health at each sample, absolute; absent for a track without it. */ hp?: number[], /** The view pitch at each sample in degrees, positive looking down (RFC 39); absent for a track without it. */ ap?: number[] }
export interface Decoded {
  /** Times in ms since the round began, for every tick. */
  times: number[]
  /** The last tick's time: how long the round is. Times are counted from the round's start, so the preparation before it has negative times. */
  length: number
  /** The first sample's time: 0, or minus the preparation that was recorded. */
  start: number
  players: Map<string, Segment[]>
  deaths: Death[]
  /** In time order; empty for a track without any. */
  events: TrackEvent[]
  /** The path of each player's body, in time order (RFC 24); empty for a track without any. */
  bodies: Map<string, BodyPoint[]>
  /** Things that moved (RFC 20, 4.8); empty for a track without any. */
  things: Thing[]
  /** The most health each player had, where the track says (RFC 26, 4a). */
  maxHealth: Map<string, number>
  /** The eye height above the feet of each player, standing and crouching, where the track says (RFC 39, 3.2); use `eyeHeights` for the defaults. */
  eyes: Map<string, { stand: number, duck: number }>
  /** The world model path of each weapon class held in the round (RFC 39, 3.4); empty for a track without them. */
  weaponModels: Map<string, string>
  /** The `hurt` events of each victim, in time order: what the health between two samples was. */
  hurts: Map<string, TrackEvent[]>
  /** The polled and detoured events of each player in time order (RFC 26, 4c, C2): the weapon in hand, credits, karma, the target of a dead player. */
  polled: Polled
  /** Each player's speaking spans as [from, to) in ms since the round's start, in order and not overlapping (RFC 26, 4c.5); empty when none were recorded. */
  talk: Map<string, [number, number][]>
}
/** `hold`, `credits`, `karma` and `spec` events by player. */
export interface Polled { hold: Map<string, TrackEvent[]>, credits: Map<string, TrackEvent[]>, karma: Map<string, TrackEvent[]>, spec: Map<string, TrackEvent[]> }
/** One point of a body's path: ms, position in units, and the turn in degrees. */
export interface BodyPoint { t: number, at: [number, number, number], pitch: number, yaw: number, roll: number }
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
  const begin = raw.begin ?? 0
  const times = cumulative(raw.t).map(v => v - begin) // the round's start is 0; the preparation before it is negative
  const players = new Map<string, Segment[]>()
  const maxHealth = new Map<string, number>()
  const eyes = new Map<string, { stand: number, duck: number }>()
  for (const p of raw.players) {
    const segs: Segment[] = []
    for (const s of p.segments) {
      const n = s.x.length
      segs.push({
        t: times.slice(s.from, s.from + n),
        x: cumulative(s.x).map(v => v * UNITS), y: cumulative(s.y).map(v => v * UNITS), z: cumulative(s.z).map(v => v * UNITS),
        a: cumulative(s.a),
        s: s.s ?? s.x.map(() => 0),
        ...(s.hp && s.hp.length === n ? { hp: cumulative(s.hp) } : {}),
        ...(s.ap && s.ap.length === n ? { ap: cumulative(s.ap).map(v => v / 4) } : {}),
      })
    }
    players.set(p.id, segs)
    if (typeof p.mh === 'number' && p.mh >= 1) maxHealth.set(p.id, p.mh)
    if ((typeof p.eh === 'number' && p.eh >= 1) || (typeof p.ed === 'number' && p.ed >= 1)) eyes.set(p.id, { stand: typeof p.eh === 'number' && p.eh >= 1 ? p.eh : EYE_STAND, duck: typeof p.ed === 'number' && p.ed >= 1 ? p.ed : EYE_DUCK })
  }
  const deaths: Death[] = raw.deaths.map(d => ({
    victim: d.victim, attacker: d.attacker, t: d.t - begin,
    at: [d.vx * UNITS, d.vy * UNITS, d.vz * UNITS],
    from: d.attacker !== null && d.ax !== null && d.ay !== null && d.az !== null ? [d.ax * UNITS, d.ay * UNITS, d.az * UNITS] : null,
    weapon: d.weapon,
  }))
  deaths.sort((a, b) => a.t - b.t)
  for (const d of deaths) correctDeathHeight(players.get(d.victim) ?? [], d)
  const events = (raw.events ?? []).map(e => ({ ...e, t: e.t - begin })).sort((a, b) => a.t - b.t)
  const hurts = new Map<string, TrackEvent[]>()
  for (const e of events) if (e.k === 'hurt') { const l = hurts.get(e.p) ?? []; l.push(e); hurts.set(e.p, l) }
  const polled: Polled = { hold: new Map(), credits: new Map(), karma: new Map(), spec: new Map() }
  for (const e of events) if (e.k === 'hold' || e.k === 'credits' || e.k === 'karma' || e.k === 'spec') { const m = polled[e.k]; const l = m.get(e.p) ?? []; l.push(e); m.set(e.p, l) }
  const bodies = new Map<string, BodyPoint[]>()
  for (const b of [...(raw.bodies ?? [])].sort((a, c) => a.t - c.t)) {
    const list = bodies.get(b.p) ?? []
    list.push({ t: b.t - begin, at: [b.x * UNITS, b.y * UNITS, b.z * UNITS], pitch: b.pt / 4, yaw: b.w / 4, roll: b.r / 4 })
    bodies.set(b.p, list)
  }
  const things: Thing[] = (raw.things ?? []).map(q => {
    const ticks = cumulative(q.k)
    const t = ticks.map(i => times[i] ?? times[times.length - 1] ?? 0)
    return {
      e: q.e, c: q.c, model: q.mdl, bounds: q.b, mapId: q.id ?? null, from: t[0]!, until: q.g === undefined ? Infinity : times[q.g] ?? Infinity,
      t, x: cumulative(q.x), y: cumulative(q.y), z: cumulative(q.z), pitch: cumulative(q.p).map(a => a / 4), yaw: cumulative(q.w).map(a => a / 4), roll: cumulative(q.r).map(a => a / 4),
    }
  })
  const talk = new Map<string, [number, number][]>()
  for (const s of raw.talk ?? []) {
    if (typeof s?.p !== 'string' || !Number.isFinite(s.from) || !Number.isFinite(s.to) || !(s.from < s.to)) continue
    const l = talk.get(s.p) ?? []
    l.push([s.from, s.to]); talk.set(s.p, l)
  }
  for (const [p, l] of talk) { // in order, and one where they touch or overlap, so a lookup by bisection is sure
    l.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const merged: [number, number][] = []
    for (const s of l) { const last = merged[merged.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([s[0], s[1]]) }
    talk.set(p, merged)
  }
  return { times, length: times.length ? times[times.length - 1]! : 0, start: times.length ? times[0]! : 0, players, deaths, events, bodies, things, maxHealth, eyes, weaponModels: new Map(Object.entries(raw.wm ?? {})), hurts, polled, talk }
}

/**
 * Whether a player is speaking on the dashboard's voice page at `t` ms into the round (RFC 26, 4c.5): inside a span, the start included and the
 * end not. `spans` is the player's list from `decodeTrack`; a player with none, or a track without any, is not speaking.
 */
export function isTalking(spans: readonly (readonly [number, number])[] | undefined, t: number): boolean {
  if (!spans || spans.length === 0) return false
  let lo = 0, hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = spans[mid]!
    if (t < s[0]) hi = mid - 1
    else if (t >= s[1]) lo = mid + 1
    else return true
  }
  return false
}

/** Health that makes a bar: from 0 (nothing) up to what the player can have. Colours of the three steps of the bar: green, amber, red. */
export const HEALTH_COLOURS = { good: '#22c55e', hurt: '#f59e0b', low: '#ef4444' }
/** The colour of a health bar by the fraction of the most health: green from 60 %, amber from 30 %, red below. */
export function healthColour(fraction: number): string {
  return fraction >= 0.6 ? HEALTH_COLOURS.good : fraction >= 0.3 ? HEALTH_COLOURS.hurt : HEALTH_COLOURS.low
}

/**
 * A player's health at time `ms` (RFC 26, 4a): the value of the last sample at or before it, and a `hurt` event of the player after that sample
 * says what it was since (the sample comes up to a second after the blow). null when the player has no sample there (before, after, in a gap, a
 * dead player) or the track has no health for the segment.
 */
export function healthAt(segments: Segment[], hurts: TrackEvent[] | undefined, ms: number): number | null {
  let lo = 0, hi = segments.length - 1, seg: Segment | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]!
    if (ms < s.t[0]!) hi = mid - 1
    else if (ms > s.t[s.t.length - 1]!) lo = mid + 1
    else { seg = s; break }
  }
  if (!seg || !seg.hp) return null
  let a = 0, b = seg.t.length - 1
  while (a < b) { const m = (a + b + 1) >> 1; if (seg.t[m]! <= ms) a = m; else b = m - 1 }
  let v = seg.hp[a]!
  if (hurts && hurts.length > 0) {
    let i = 0, j = hurts.length - 1 // the last hurt event at or before ms
    while (i < j) { const m = (i + j + 1) >> 1; if (hurts[m]!.t <= ms) i = m; else j = m - 1 }
    const e = hurts[i]!
    if (e.t <= ms && e.t > seg.t[a]! && typeof e.h === 'number') v = e.h
  }
  return v
}

export interface Pose { x: number, y: number, z: number, /** Heading in 256ths of a turn, 0-255. */ yaw: number }

/** The shortest way round a 256-step circle from `a` to `b`, as a fraction `f` of the way. */
export const lerpYaw = (a: number, b: number, f: number) => {
  let d = ((b - a) % 256 + 256) % 256
  if (d > 128) d -= 256
  return (((a + d * f) % 256) + 256) % 256
}

/**
 * The slope of a curve through samples (t, v) at sample `i`, for a monotone cubic (Fritsch and Carlson's PCHIP): the harmonic mean of the
 * two slopes round it where they point the same way (the curve is steepest where it should be and has no overshoot), 0 at a turning point,
 * and the slope of the one interval at the ends. `t` may be unevenly spaced, as ours is (the interval grows when nothing happens).
 */
function slopeAt(t: number[], v: (i: number) => number, i: number): number {
  const n = t.length
  const d = (j: number) => { const h = t[j + 1]! - t[j]!; return h > 0 ? (v(j + 1) - v(j)) / h : 0 }
  if (i <= 0) return n > 1 ? d(0) : 0
  if (i >= n - 1) return d(n - 2)
  const d0 = d(i - 1), d1 = d(i)
  if (d0 * d1 <= 0) return 0
  const h0 = t[i]! - t[i - 1]!, h1 = t[i + 1]! - t[i]!
  const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0
  return (w0 + w1) / (w0 / d0 + w1 / d1)
}

/** The value at fraction `f` of the interval from sample `a` to `a + 1` of a cubic through them with the given slopes (per ms) at both ends. */
function hermite(p0: number, p1: number, m0: number, m1: number, span: number, f: number): number {
  const f2 = f * f, f3 = f2 * f
  return (2 * f3 - 3 * f2 + 1) * p0 + (f3 - 2 * f2 + f) * span * m0 + (-2 * f3 + 3 * f2) * p1 + (f3 - f2) * span * m1
}

/** The eye height above the feet when the track does not say (the game's defaults, RFC 39, 3.2): standing and crouching. */
export const EYE_STAND = 64
export const EYE_DUCK = 28
/** The player's eye height standing and crouching: from the track where it says, else the defaults. */
export const eyeHeights = (eyes: Map<string, { stand: number, duck: number }>, id: string): { stand: number, duck: number } => eyes.get(id) ?? { stand: EYE_STAND, duck: EYE_DUCK }

/**
 * The view pitch of a player at time `ms` in degrees, positive looking down (RFC 39, 3.1): on the same kind of smooth curve as the position, so that a look
 * up or down is a curve and not a step every 180 ms. null when the track has no pitch for the player there (an older track, a gap between segments, before
 * the first or after the last sample); the caller then looks level.
 */
export function pitchAt(segments: Segment[], ms: number): number | null {
  let lo = 0, hi = segments.length - 1, seg: Segment | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]!
    if (ms < s.t[0]!) hi = mid - 1
    else if (ms > s.t[s.t.length - 1]!) lo = mid + 1
    else { seg = s; break }
  }
  if (!seg || !seg.ap) return null
  const ap = seg.ap, t = seg.t
  let a = 0, b = t.length - 1
  while (a < b) { const m = (a + b + 1) >> 1; if (t[m]! <= ms) a = m; else b = m - 1 }
  if (a === t.length - 1) return ap[a]!
  const span = t[a + 1]! - t[a]!
  if (!(span > 0)) return ap[a]!
  const v = hermite(ap[a]!, ap[a + 1]!, slopeAt(t, i => ap[i]!, a), slopeAt(t, i => ap[i]!, a + 1), span, (ms - t[a]!) / span)
  return Math.min(Math.max(v, -90), 90)
}

/**
 * Where a player is at time `ms`: on a smooth curve through the samples around it, at their real times. The position moves the way a
 * player does, without the change of speed and direction at every sample that straight lines have (5 of them a second at the default
 * rate, which made the replay look like it stuttered); the curve passes exactly through each sample and never goes beyond the samples on
 * either side of it, so it cannot cut a corner through a wall further than the player's own steps did. The view direction is smoothed the
 * same way, turning the short way round. null when the player has no sample there: before their first, after their last, or in a gap
 * between two segments (a skipped tick, a death and a revival). A gap is a gap, never a curve across it.
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
  if (!(span > 0)) return { x: seg.x[a]!, y: seg.y[a]!, z: seg.z[a]!, yaw: seg.a[a]! }
  const f = (ms - seg.t[a]!) / span
  const t = seg.t
  const along = (v: number[]) => hermite(v[a]!, v[a + 1]!, slopeAt(t, i => v[i]!, a), slopeAt(t, i => v[i]!, a + 1), span, f)
  // the view direction as one continuous angle (each step the short way round) so that a turn across 0 is not a spin
  const yaw0 = seg.a[a]!
  const unwrapped = (i: number): number => {
    let y = yaw0
    if (i > a) for (let j = a; j < i; j++) { let d = ((seg.a[j + 1]! - seg.a[j]!) % 256 + 256) % 256; if (d > 128) d -= 256; y += d }
    else for (let j = a; j > i; j--) { let d = ((seg.a[j]! - seg.a[j - 1]!) % 256 + 256) % 256; if (d > 128) d -= 256; y -= d }
    return y
  }
  // slopes need the neighbours of a and a + 1: the unwrapped angle is built from a, so it is the same series for all of them
  const yawSeries = (i: number) => unwrapped(Math.min(Math.max(i, 0), t.length - 1))
  const yaw = hermite(yawSeries(a), yawSeries(a + 1), slopeAt(t, yawSeries, a), slopeAt(t, yawSeries, a + 1), span, f)
  return { x: along(seg.x), y: along(seg.y), z: along(seg.z), yaw: ((yaw % 256) + 256) % 256 }
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

/** No cut: far above any map. */
export const NO_CUT = 1e9

/**
 * The height of the plane that cuts the map away above the chosen level (Source's z), so a level can be looked into from above: a little above its floors.
 * None (NO_CUT) for "all" and for a level that is not in the list.
 */
export function cutHeight(levels: LevelRange[], upTo: number | 'all', above = 128): number {
  if (upTo === 'all') return NO_CUT
  const top = levels.find(l => l.index === upTo)
  return top ? top.hi + above : NO_CUT
}

/**
 * The level the map is shown up to. The levels above the one chosen are hidden, which is a cutaway for looking into a building from outside (the orbit and
 * top cameras). The follow camera stands inside the map, and hiding the levels above the player there takes the tops off the walls and leaves props floating in a
 * black void (seen on `ttt_cape_town_revamped`, `ttt_yucatan`, `ttt_lttp_kakariko_a5_fixed`, `ttt_airbus_b3` and `ttt_pwp_v4`, 2026-11-06): while the follow camera
 * follows the player's level, nothing is hidden, and what is between the camera and the player is cut away by the hole of the follow camera instead (RFC 34, followHole.ts). A level the viewer
 * picked on the level bar is kept in every camera.
 */
export const shownLevels = (upTo: number | 'all', followLevel: boolean, camera: 'orbit' | 'top' | 'follow'): number | 'all' =>
  camera === 'follow' && followLevel ? 'all' : upTo

/** How long the level the cut follows stays after the player is found on a lower one, so stairs and a jump at a boundary do not make it flicker. */
export const LEVEL_HOLD_MS = 400
export interface LevelHold { level: number, lower: number, since: number, at: number }

/**
 * The level the cut follows: a higher level at once (a player who has climbed is never hidden by a cut that is one level too low), a lower one only when the
 * player has been found on it for `holdMs` in a row (on stairs, or jumping at the boundary, the height crosses the line again and again). The state starts over
 * for the first call, a jump back in time and a jump of more than 1.5 s forward (a seek), where the level is the raw one.
 */
export function holdLevel(state: LevelHold | null, raw: number, ms: number, holdMs = LEVEL_HOLD_MS): LevelHold {
  if (!state || state.level === 0 || ms < state.at || ms - state.at > 1500 || raw === 0) return { level: raw, lower: -1, since: ms, at: ms }
  if (raw >= state.level) return { level: raw, lower: -1, since: ms, at: ms }
  if (state.lower !== raw) return { level: state.level, lower: raw, since: ms, at: ms }
  if (ms - state.since >= holdMs) return { level: raw, lower: -1, since: ms, at: ms }
  return { ...state, at: ms }
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

/** Two points further apart than this are not drawn between (RFC 24, 4.5): a gap is not interpolated through. */
export const BODY_GAP_MS = 1500

/** The shortest way round from `a` to `b` in degrees, as a fraction `f`. */
const lerpDeg = (a: number, b: number, f: number) => {
  let d = ((b - a) % 360 + 540) % 360 - 180
  if (d === -180) d = 180
  return a + d * f
}

const wrap180 = (d: number) => ((d % 360) + 540) % 360 - 180

/**
 * Where a body is at `ms` (RFC 24, 4.4): the last recorded point at or before `ms` that is not before the death, else the death position.
 * Between two points no more than BODY_GAP_MS apart the position is drawn between them. `turn` is how far the body has turned about the
 * vertical since its first point, in degrees (0 without points): the ragdoll's own yaw has no fixed relation to the drawn figure, its change does.
 */
export function bodyAt(points: BodyPoint[] | undefined, death: Death, ms: number): { at: [number, number, number], turn: number, moved: boolean } {
  let last = -1, first = -1
  for (let i = 0; i < (points?.length ?? 0); i++) {
    const q = points![i]!
    if (q.t < death.t) continue
    if (first < 0) first = i
    if (q.t <= ms) last = i
    else break
  }
  if (!points || last < 0) return { at: death.at, turn: 0, moved: false }
  const a = points[last]!, base = points[first]!
  const next = points[last + 1]
  if (next && next.t > ms && next.t - a.t <= BODY_GAP_MS) {
    const f = (ms - a.t) / (next.t - a.t)
    return {
      at: [a.at[0] + (next.at[0] - a.at[0]) * f, a.at[1] + (next.at[1] - a.at[1]) * f, a.at[2] + (next.at[2] - a.at[2]) * f],
      turn: wrap180(lerpDeg(a.yaw, next.yaw, f) - base.yaw), moved: true,
    }
  }
  return { at: a.at, turn: wrap180(a.yaw - base.yaw), moved: true }
}

/**
 * Where a thing is at `ms` and how it is turned, in degrees, or null when it is not there: before its first keyframe, and from the tick it was gone
 * (RFC 20, 4.8). Between two keyframes the pose is drawn between them; a turn goes the short way round.
 */
export function thingAt(th: Thing, ms: number): { at: [number, number, number], pitch: number, yaw: number, roll: number } | null {
  if (ms < th.from || ms >= th.until) return null
  let i = 0
  while (i + 1 < th.t.length && th.t[i + 1]! <= ms) i++
  const j = Math.min(i + 1, th.t.length - 1)
  const f = j > i && th.t[j]! > th.t[i]! ? (ms - th.t[i]!) / (th.t[j]! - th.t[i]!) : 0
  const mix = (a: number[]) => a[i]! + (a[j]! - a[i]!) * f
  return { at: [mix(th.x), mix(th.y), mix(th.z)], pitch: lerpDeg(th.pitch[i]!, th.pitch[j]!, f), yaw: lerpDeg(th.yaw[i]!, th.yaw[j]!, f), roll: lerpDeg(th.roll[i]!, th.roll[j]!, f) }
}

/** How far a prop of the map may be from the place a thing started at, in units, to be taken for the same prop (RFC 20, 4.8). */
export const PROP_MATCH_UNITS = 2

/**
 * Which of the map's prop nodes (`places`, in Source units) are the props that moved in this round: for each thing of a physics prop, the nearest
 * unused place within PROP_MATCH_UNITS of where the thing started. The mesh keeps every prop as a node of its own, but not which entity it is;
 * the entity stood where the map put it, so the place is the join. Returns the indexes of `places`.
 */
export function movedProps(things: Thing[], places: { x: number, y: number, z: number }[]): number[] {
  const taken = new Set<number>()
  for (const th of things) {
    if (!th.c.startsWith('prop_physics') || th.t.length === 0) continue
    let best = -1, bestD = PROP_MATCH_UNITS
    places.forEach((q, i) => {
      if (taken.has(i)) return
      const d = Math.hypot(q.x - th.x[0]!, q.y - th.y[0]!, q.z - th.z[0]!)
      if (d <= bestD) { best = i; bestD = d }
    })
    if (best >= 0) taken.add(best)
  }
  return [...taken]
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

/** What a health bar shows: the health, the most it is measured against and the fraction of the bar. null when there is nothing to draw (no data, or a player with no health left). */
export function healthBar(hp: number | null, max: number | undefined): { hp: number, max: number, fraction: number } | null {
  if (hp === null || !(hp > 0)) return null
  const top = max !== undefined && max >= 1 ? Math.max(max, hp) : Math.max(100, hp) // a track without the most health is measured against 100; more health than that is a full bar
  return { hp, max: top, fraction: Math.min(1, hp / top) }
}

type Nick = (id: string) => string
/** A damage line with the names: "TheFehr hurt Tonda: 22 (MAC10), 78 left"; damage with no player behind it (a fall, fire) is "Tonda took 15 (Falling), 61 left". */
export function hurtText(e: TrackEvent, nick: Nick): string {
  const how = `${e.d} (${weaponName(e.w)}), ${e.h} left`
  return e.a ? `${nick(e.a)} hurt ${nick(e.p)}: ${how}` : `${nick(e.p)} took ${how}`
}
/** The source of a heal as a name for a person: null when the bridge did not know it ("other"), else the display name of the class ("Health station") or word. */
export function healSource(w: string | undefined): string | null {
  return !w || w === 'other' ? null : weaponName(w)
}
/** A heal line with the names: "Tonda healed +25 by Health station, 77 left"; by a player "Tonda healed +25 by Scip.MLP (Surgeryknife), 77 left"; by oneself "Tonda healed themselves +25 (Surgeryknife), 77 left". The source is left out when unknown. */
export function healText(e: TrackEvent, nick: Nick): string {
  const src = healSource(e.w)
  const tail = `${e.h} left`
  if (e.a === e.p) return `${nick(e.p)} healed themselves +${e.d}${src ? ` (${src})` : ''}, ${tail}`
  if (e.a) return `${nick(e.p)} healed +${e.d} by ${nick(e.a)}${src ? ` (${src})` : ''}, ${tail}`
  return `${nick(e.p)} healed +${e.d}${src ? ` by ${src}` : ''}, ${tail}`
}
/** The same for the list of one player, who is the healed ("healed +25 by Health station, 77 left") or the healer ("healed Tonda +25 (Surgeryknife), 77 left"). */
export function healOwnText(e: TrackEvent, nick: Nick, who: string): string {
  const src = healSource(e.w)
  const tail = `${e.h} left`
  if (e.a === e.p) return `healed themselves +${e.d}${src ? ` (${src})` : ''}, ${tail}`
  if (e.a === who) return `healed ${nick(e.p)} +${e.d}${src ? ` (${src})` : ''}, ${tail}`
  return `healed +${e.d}${e.a ? ` by ${nick(e.a)}${src ? ` (${src})` : ''}` : src ? ` by ${src}` : ''}, ${tail}`
}
/** What a player took, dealt and was healed over the round, as sums of the `hurt` and `heal` events ("healed" is health they gained, from anybody), and the shots they fired (the sum of the `n` of their `shots` events, RFC 26, 4c, C3). */
export function damageTotals(events: TrackEvent[], who: string): { took: number, dealt: number, healed: number, shots: number } {
  let took = 0, dealt = 0, healed = 0, shots = 0
  for (const e of events) {
    if (e.k === 'shots') { if (e.p === who && typeof e.n === 'number' && e.n > 0) shots += e.n; continue }
    if (typeof e.d !== 'number') continue
    if (e.k === 'hurt') { if (e.p === who) took += e.d; if (e.a === who) dealt += e.d }
    else if (e.k === 'heal' && e.p === who) healed += e.d
  }
  return { took, dealt, healed, shots }
}
/** The shots a player fired over the round by weapon class, the most first (then by class), for the totals line's tooltip. */
export function shotsByWeapon(events: TrackEvent[], who: string): { w: string, n: number }[] {
  const by = new Map<string, number>()
  for (const e of events) if (e.k === 'shots' && e.p === who && typeof e.n === 'number' && e.n > 0 && e.w) by.set(e.w, (by.get(e.w) ?? 0) + e.n)
  return [...by].map(([w, n]) => ({ w, n })).sort((a, b) => b.n - a.n || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0))
}
/** "Shots: Pistol 20, Shotgun 17" for the tooltip of the totals line, or nothing when the player fired none. */
export function shotsTitle(list: { w: string, n: number }[]): string {
  return list.length ? `Shots: ${list.map(s => `${weaponName(s.w)} ${s.n}`).join(', ')}` : ''
}
/** The line under the selected player's health: "Took 48, dealt 22, healed 40, shot 37", or nothing when the track has no damage, heals or shots for them. */
export function totalsText(t: { took: number, dealt: number, healed: number, shots?: number }): string {
  const parts: string[] = []
  if (t.took > 0) parts.push(`took ${t.took}`)
  if (t.dealt > 0) parts.push(`dealt ${t.dealt}`)
  if (t.healed > 0) parts.push(`healed ${t.healed}`)
  if (t.shots !== undefined && t.shots > 0) parts.push(`shot ${t.shots}`)
  return parts.length ? parts.join(', ').replace(/^./, c => c.toUpperCase()) : ''
}
/** The same for the list of one player, who is the victim (`who` is `e.p`: "took 22 from Tonda (MAC10), 78 left") or the attacker ("hurt Tonda: 22 (MAC10), 78 left"). */
export function hurtOwnText(e: TrackEvent, nick: Nick, who: string): string {
  if (e.a === who) return `hurt ${nick(e.p)}: ${e.d} (${weaponName(e.w)}), ${e.h} left`
  return `took ${e.d}${e.a ? ' from ' + nick(e.a) : ''} (${weaponName(e.w)}), ${e.h} left`
}

// ---- Weapons, C4, DNA scans and traitor buttons (RFC 26, 4c, C1)

/** Pickups and drops: "Tonda picked up Shotgun". The class goes through the display-name helper of the statistics pages; the class stays in the tooltip. */
export function equipText(e: TrackEvent, nick: Nick): string {
  return `${nick(e.p)} ${equipOwnText(e)}`
}
/** The same without the name, for the list of the player. */
export function equipOwnText(e: TrackEvent): string {
  return `${e.k === 'wdrop' ? 'dropped' : 'picked up'} ${weaponName(e.w)}`
}

/** What a C4 event says about the charge's owner: "Tonda's C4", or "a C4" when the track does not know whose it was. */
const charge = (owner: string | undefined, nick: Nick) => (owner ? `${nick(owner)}'s C4` : 'a C4')
/** C4 lines: "Tonda armed a C4 (45 s)", "Scip.MLP defused the C4 of Tonda", "Scip.MLP cut the wrong wire of Tonda's C4", "Tonda's C4 exploded". */
export function c4Text(e: TrackEvent, nick: Nick): string {
  switch (e.st) {
    case 'plant': return `${nick(e.p)} armed a C4${e.s ? ` (${e.s} s)` : ''}`
    case 'defuse': return `${nick(e.p)} defused ${e.of ? `the C4 of ${nick(e.of)}` : 'a C4'}`
    case 'fail': return `${nick(e.p)} cut the wrong wire of ${charge(e.of, nick)}`
    default: return `${charge(e.p, nick)} exploded`
  }
}
/** The same in the list of one player (`who`): the one who acted, or the owner of the charge when that is another player. */
export function c4OwnText(e: TrackEvent, nick: Nick, who: string): string {
  if (e.p === who) {
    switch (e.st) {
      case 'plant': return `armed a C4${e.s ? ` (${e.s} s)` : ''}`
      case 'defuse': return `defused ${e.of ? (e.of === who ? 'their own C4' : `the C4 of ${nick(e.of)}`) : 'a C4'}`
      case 'fail': return `cut the wrong wire of ${e.of ? (e.of === who ? 'their own C4' : `${nick(e.of)}'s C4`) : 'a C4'}`
      default: return 'had a C4 explode'
    }
  }
  return e.st === 'defuse' ? `had a C4 defused by ${nick(e.p)}` : `had ${nick(e.p)} cut the wrong wire of their C4`
}
/** "from a body" for a ragdoll, "from an object" for anything else (the class is in the line's tooltip); nothing when the bridge did not say. */
const dnaFrom = (w: string | undefined) => (!w ? '' : w === 'prop_ragdoll' ? ' from a body' : ' from an object')
/** "Tonda took the DNA of Scip.MLP from a body"; without the owner of the DNA "Tonda took a DNA sample from a body". */
export function dnaText(e: TrackEvent, nick: Nick): string {
  return `${nick(e.p)} ${dnaOwnText(e, nick, e.p)}`
}
/** In the list of the scanner's owner, or of the player whose DNA it was ("had their DNA taken by Tonda from a body"). */
export function dnaOwnText(e: TrackEvent, nick: Nick, who: string): string {
  if (e.p !== who && e.of === who) return `had their DNA taken by ${nick(e.p)}${dnaFrom(e.w)}`
  return `took ${e.of ? (e.of === e.p ? 'their own DNA' : `the DNA of ${nick(e.of)}`) : 'a DNA sample'}${dnaFrom(e.w)}`
}
/** "Tonda used a traitor button (Open the vent)"; the text is the mapper's and is left out when the map gave none. */
export function tbtnText(e: TrackEvent, nick: Nick): string {
  return `${nick(e.p)} ${tbtnOwnText(e)}`
}
export function tbtnOwnText(e: TrackEvent): string {
  return `used a traitor button${e.n ? ` (${e.n})` : ''}`
}

// ---- The weapon in hand, credits, karma and whom a dead player watches (RFC 26, 4c, C2)

/** The last of a player's events (in time order) at or before `ms`, or null. */
export function lastEventAt(list: TrackEvent[] | undefined, ms: number): TrackEvent | null {
  if (!list || list.length === 0 || list[0]!.t > ms) return null
  let i = 0, j = list.length - 1
  while (i < j) { const m = (i + j + 1) >> 1; if (list[m]!.t <= ms) i = m; else j = m - 1 }
  return list[i]!
}
/** The class of the weapon a living player holds at `ms` (the last `hold` at or before it), or null: nothing recorded yet, or the player is dead (the bridge forgets the hand at a death). */
export function holdAt(list: TrackEvent[] | undefined, ms: number, dead: boolean): string | null {
  return dead ? null : lastEventAt(list, ms)?.w ?? null
}
/**
 * A living player's credits at `ms`: the credits after the last change at or before it; before the first change what they had at the start, which is the first
 * change's amount less its change (the bridge records no event for the start). null when the track has no change of theirs, or the player is dead.
 */
export function creditsAt(list: TrackEvent[] | undefined, ms: number, dead: boolean): number | null {
  if (dead || !list || list.length === 0) return null
  const e = lastEventAt(list, ms)
  if (e) return typeof e.c === 'number' ? e.c : null
  const first = list[0]!
  return typeof first.c === 'number' && typeof first.d === 'number' ? Math.min(Math.max(first.c - first.d, 0), 255) : null
}
/** A player's karma at `ms`: the karma after the last change at or before it, or null before the first (karma is cut at the server's maximum, so the start cannot be worked out). */
export function karmaAt(list: TrackEvent[] | undefined, ms: number): number | null {
  const e = lastEventAt(list, ms)
  return e && typeof e.c === 'number' ? e.c : null
}
/** What a dead player watches at `ms`: the last `spec` event since their death (`diedAt`), at or before the time; null for a living player (diedAt null) and when there is none yet or the last is from an earlier death. */
export function watchEventAt(list: TrackEvent[] | undefined, ms: number, diedAt: number | null): TrackEvent | null {
  if (diedAt === null) return null
  const e = lastEventAt(list, ms)
  return e && e.t >= diedAt ? e : null
}
/** Whom a dead player watches at `ms`: the player of the last `spec` event (see watchEventAt); null for nobody, a prop, and an event without a player. */
export function watchingAt(list: TrackEvent[] | undefined, ms: number, diedAt: number | null): string | null {
  return watchEventAt(list, ms, diedAt)?.of ?? null
}
/** A possessed prop as a person reads it: "a prop (oildrum001)", or "a prop" when the bridge could not name its model (RFC 26, 4c.x). */
export const propLabel = (e: TrackEvent) => (e.pm ? `a prop (${e.pm})` : 'a prop')
export const holdingText = (w: string) => `Holding ${weaponName(w)}`
export const creditsLine = (c: number) => `Credits ${c}`
export const karmaLine = (c: number) => `Karma ${c}`
export const watchingText = (name: string) => `Watching ${name}`
/** The panel line for a `spec` event: "Watching Scip.MLP", "Possessing a prop (oildrum001)", nothing for nobody or no event. */
export const watchLine = (e: TrackEvent | null, nick: (id: string) => string) => (!e ? '' : e.of ? watchingText(nick(e.of)) : e.pr ? `Possessing ${propLabel(e)}` : '')
/** A signed change as the lists write it: "+1", "-40". */
const signed = (d: number) => (d > 0 ? `+${d}` : String(d))
/** "credits +1 (kill), 3 left", "credits -1 (bought), 2 left"; the reason is left out when the bridge did not know it ("other"). */
export function creditsOwnText(e: TrackEvent): string {
  const why = creditReason(e.w)
  return `credits ${signed(e.d ?? 0)}${why ? ` (${why})` : ''}, ${e.c} left`
}
/** "karma -40 (team damage), 960 left". */
export function karmaOwnText(e: TrackEvent): string {
  const why = karmaReason(e.w)
  return `karma ${signed(e.d ?? 0)}${why ? ` (${why})` : ''}, ${e.c} left`
}
/** "watches Scip.MLP", "possesses a prop (oildrum001)", "watches nobody" (roaming, a body, or nothing). */
export function specOwnText(e: TrackEvent, nick: (id: string) => string): string {
  return e.of ? `watches ${nick(e.of)}` : e.pr ? `possesses ${propLabel(e)}` : 'watches nobody'
}

/** The events that are lines of the feed besides chat, shop and bodies, damage and healing: equipment (weapons, C4, DNA, buttons). */
export const EQUIPMENT_KINDS: ReadonlySet<string> = new Set(['wpick', 'wdrop', 'c4', 'dna', 'tbtn'])
/** The two events within which a purchase and the pickup of what was bought are one fact, in ms (RFC 26, 4c.7). */
export const BUY_PICKUP_MS = 1500
/**
 * The pickups the feed does not show because the purchase line already says it: a `wpick` with a `buy` of the same player, for the same class, at most
 * BUY_PICKUP_MS before or after it. The bridge still records them and the player's own list shows them; only the feed hides them.
 */
export function hiddenPickups(events: TrackEvent[]): Set<TrackEvent> {
  const buys = new Map<string, TrackEvent[]>()
  for (const e of events) if (e.k === 'buy' && e.item) { const l = buys.get(e.p) ?? []; l.push(e); buys.set(e.p, l) }
  const hidden = new Set<TrackEvent>()
  for (const e of events) {
    if (e.k !== 'wpick' || !e.w) continue
    if ((buys.get(e.p) ?? []).some(b => b.item!.slice(0, 40) === e.w && Math.abs(b.t - e.t) <= BUY_PICKUP_MS)) hidden.add(e)
  }
  return hidden
}

/** The marks of the time bar: deaths are drawn by the page, then these. Only revivals, role changes and C4 (a mark for every shot, button or weapon would bury the deaths). */
export function timeMark(e: TrackEvent): { cls: string, mark: string } | null {
  if (e.k === 'revive') return { cls: 'tick-revive', mark: 'revive' }
  if (e.k === 'role') return { cls: 'tick-role', mark: 'role' }
  if (e.k === 'c4') return e.st === 'plant' ? { cls: 'tick-c4plant', mark: 'c4plant' } : e.st === 'boom' ? { cls: 'tick-c4boom', mark: 'c4boom' } : { cls: 'tick-c4defuse', mark: 'c4defuse' } // a wrong wire takes the defuse colour
  return null
}
/** The colours of the C4 marks on the time bar, against the page's dark ground (3 : 1 in a test). */
export const C4_COLOURS = { plant: '#fb923c', defuse: '#38bdf8', boom: '#fde047' }

/** A charge that was armed where the bridge could find it, from the arming to the first defuse, wrong wire or explosion of that charge. Place in Source units. */
export interface C4Charge { owner: string, x: number, y: number, z: number, from: number, until: number }
/**
 * The charges with a place and how long each lasted (RFC 26, 4c.7). An end (a defuse or a wrong wire, with `of` the owner; an explosion, with `p` the owner) takes
 * the open charge of that owner that has the same place; with no place on the end, the owner's only open charge; with several and no place, none (it cannot be told).
 * A wrong wire ends the marker at once, though the charge explodes a moment later; that explosion then finds nothing open and is only a line.
 */
export function c4Charges(events: TrackEvent[]): C4Charge[] {
  const all: C4Charge[] = []
  let open: C4Charge[] = []
  const same = (c: C4Charge, e: TrackEvent) => e.x !== undefined && e.y !== undefined && e.z !== undefined && c.x === e.x * UNITS && c.y === e.y * UNITS && c.z === e.z * UNITS
  for (const e of events) {
    if (e.k !== 'c4') continue
    if (e.st === 'plant') {
      if (e.x === undefined || e.y === undefined || e.z === undefined) continue
      const c = { owner: e.p, x: e.x * UNITS, y: e.y * UNITS, z: e.z * UNITS, from: e.t, until: Infinity }
      all.push(c); open.push(c)
      continue
    }
    const owner = e.st === 'boom' ? e.p : e.of
    const mine = open.filter(c => owner === undefined || c.owner === owner)
    const placed = mine.filter(c => same(c, e))
    const pick = e.x !== undefined ? placed[0] : mine.length === 1 ? mine[0] : undefined
    if (pick) { pick.until = e.t; open = open.filter(c => c !== pick) }
  }
  return all
}
/** The charges that are there at `ms`: armed at or before it and not yet ended. */
export const c4At = (charges: C4Charge[], ms: number): C4Charge[] => charges.filter(c => ms >= c.from && ms < c.until)
