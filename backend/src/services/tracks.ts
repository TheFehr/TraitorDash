import { FINGERPRINT, NAME, STEAM_ID } from './validators'
/**
 * Position tracks of rounds (RFC 12): what the bridge uploads, how it is checked, and how much of
 * it an instance and a server keep. Nothing here touches the database; Store does that.
 */

export const MAX_TRACK_BYTES = 8 * 1024 * 1024
/** The most ticks a track may have: the ceiling of the bridge's `traitordash_track_max_ticks` (RFC 12, 3.2; RFC 23). */
export const MAX_TICKS = 100_000
export const MAX_TRACK_PLAYERS = 128
export const MAX_TRACK_DEATHS = 512
export const MAX_SEGMENTS_PER_PLAYER = 64
/**
 * The sum of the bridge's caps of each kind: revive 1024, role 1024, say 1024, buy 512, found 256, pickup 256, drop 256 (4352), hurt 2048 (RFC 26, 4a), heal 512 (RFC 26, 4b)
 * and, of stage C package C1 (4c), wpick 512, wdrop 512, c4 128, dna 128 and tbtn 256 (1536): 8448; of package C2 hold 1024, credits 512, karma 512 and spec 512 (2560): 11008.
 * A safety limit of the backend, kept equal to what the bridge can send.
 */
export const MAX_TRACK_EVENTS = 11_008
/** The most characters of a traitor button's text, and of a `tbtn` event's `n` (RFC 26, 4c). */
export const MAX_TBTN_CHARS = 40
/** Credits are sent by the game as UInt(8): a `credits` event's `c` is 0 to 255 and its change `d` is -255 to 255 (not 0) (RFC 26, 4c, C2). */
export const MAX_CREDITS = 255
/** A `karma` event's change `d` is -1000 to 1000 (not 0) and the karma after it `c` 0 to 1000 (the bridge cuts what the server's maximum allows beyond that). */
export const MAX_KARMA = 1000
/** The word of a `credits` event's reason `w`, and of a `karma` event's: lower-case letters only (the bridge sends one of its own short lists). */
const REASON_WORD = /^[a-z]{1,20}$/
/** What a `c4` event's `st` can be: the charge was armed, defused, a wire was cut wrong (it explodes), or it exploded. */
export const C4_STATES: ReadonlySet<string> = new Set(['plant', 'defuse', 'fail', 'boom'])
/** Health in a track: a sample, the most of a player, an event's `h`; TTT2 roles can have more than 100 (RFC 26, 4a). */
export const MAX_HP = 1000
/** The most damage one `hurt` event holds (a merged event of many hits). */
export const MAX_HURT_DAMAGE = 10_000
const HURT_CAUSE = /^[A-Za-z0-9_.-]{1,40}$/
const PROP_MODEL_NAME = /^[a-z0-9_-]{1,40}$/ // the file name of a possessed prop's model, without folders or extension (RFC 26, 4c.x)
/** The words a `heal` event's source `w` may be besides the class of a weapon or entity: no player is the healer in them, so a heal with one of them cannot name the healed as the healer (RFC 26, 4b). */
export const HEAL_CAUSE_WORDS: ReadonlySet<string> = new Set(['regen', 'revive', 'other'])
/** Where a body lay and which way it was turned, the points of it (RFC 24). */
export const MAX_TRACK_BODIES = 4096
export const MAX_SAY_CHARS = 200
/** Parts that move, their keyframes and the inputs that reach them (RFC 20, 4.3 to 4.5). */
export const MAX_TRACK_PARTS = 256
export const MAX_KEYS_PER_PART = 4000
export const MAX_TRACK_KEYS = 50_000
export const MAX_TRACK_INPUTS = 1024
/** Props, doors that are props, and weapons on the floor, as things that move (RFC 20, stage 4; RFC 24, stage 4). */
export const MAX_TRACK_THINGS = 256
export const MAX_KEYS_PER_THING = 2000
export const MAX_THING_KEYS = 30_000
export const THING_CLASSES: ReadonlySet<string> = new Set(['prop_physics', 'prop_physics_multiplayer', 'prop_door_rotating'])
const WEAPON_CLASS = /^weapon_[A-Za-z0-9_]{1,56}$/
const MODEL_PATH = /^[A-Za-z0-9_./-]{1,128}$/
/** The classes of RFC 18 that are drawn as parts that can move, and the inputs that are recorded when they reach one. */
export const PART_CLASSES: ReadonlySet<string> = new Set(['func_door', 'func_door_rotating', 'func_movelinear', 'func_rotating', 'func_tracktrain', 'func_physbox', 'func_physbox_multiplayer'])
export const PART_INPUTS: ReadonlySet<string> = new Set(['open', 'close', 'toggle', 'lock', 'unlock', 'use', 'setposition', 'startforward', 'startbackward', 'stop', 'reverse', 'start'])

/** A weapon class, a role or team name, a revival reason: letters, digits, underscore, dot and hyphen. */

/** Positions are whole numbers of 8 units: Source maps reach +-16384 units, so +-2048 here; this leaves room. */
const POS_MAX = 4096
const POS_STEP_MAX = 2 * POS_MAX
const TICK_STEP_MAX = 60_000 // a tick is at most a minute after the last
const TIME_MAX = 6 * 60 * 60 * 1000 // a round of at most six hours, in ms
const PART_POS_MAX = 32768 // a part's position, in whole units (the map reaches +-16384)
const PART_POS_STEP = 2 * PART_POS_MAX
const BODY_ANGLE_MAX = 720 // quarter degrees, -720 to 719
const PART_ANGLE_MAX = 1440 // quarter degrees; the bridge writes -720 to 719, the room is for the sums
const PART_ANGLE_STEP = 2 * PART_ANGLE_MAX

/** `s` (absent in tracks from an older game server): for each sample how the player moves, as bits: 1 crouching, 2 in the air, 4 in water. */
export interface TrackSegment { from: number, x: number[], y: number[], z: number[], a: number[], s?: number[], hp?: number[] }
/** `mh`: the most health the player had (the scale of a health bar), absent in a track from before RFC 26, stage B. */
export interface TrackPlayer { id: string, mh?: number, segments: TrackSegment[] }
export interface TrackDeath {
  victim: string, attacker: string | null, t: number
  vx: number, vy: number, vz: number
  ax: number | null, ay: number | null, az: number | null
  weapon: string | null
}
/** A revival or a change of role or team during the round (RFC 14, 4.3). */
export interface TrackEvent {
  /** Milliseconds since the round began. */
  t: number
  /** The player it happened to. */
  p: string
  k: 'revive' | 'role' | 'say' | 'buy' | 'found' | 'pickup' | 'drop' | 'hurt' | 'heal' | 'wpick' | 'wdrop' | 'c4' | 'dna' | 'tbtn' | 'hold' | 'credits' | 'karma' | 'spec'
  /** `role` events: the settled role and team. */
  role?: string
  team?: string
  /** `revive` events: the reviver (a player in the round), the weapon class and the reason key; absent when unknown. */
  by?: string
  how?: string
  why?: string
  /** `say` events: the line (at most 200 characters) and who could read it: everybody, a team, or the dead. */
  text?: string
  ch?: 'all' | 'team' | 'dead'
  /** `buy` events: the class of the weapon or item, and whether it is a passive item. */
  item?: string
  it?: boolean
  /** `found`, `pickup` and `drop` events: whose body it was, when that player was in the round. */
  of?: string
  /** `hurt` events (`p` is the victim): the attacker when a player of the round did it, the cause (a weapon or entity class, or a damage type), the damage taken and the victim's health after. `heal` events (`p` is the healed player) use the same fields: `a` the healer, `w` the source (a weapon or entity class, or regen, revive, other), `d` the health gained and `h` the health after. */
  a?: string
  w?: string
  d?: number
  h?: number
  /** `credits` and `karma` events: the amount after the change. */
  c?: number
  /** `hold` events: `w` the class of the weapon the player holds from now on. `credits` events: `d` the change (not 0), `c` the credits after, `w` the reason word. `karma` events: the same for karma (`d`, `c`, `w`). `spec` events: `of` the player the dead player watches from now on, none for nobody (RFC 26, 4c, C2); or, instead of `of`, the prop they possess: `pr` its class, `pm` the file name of its model, `ti` its number in `things` (4c.x). */
  pr?: string
  pm?: string
  ti?: number
  /** `wpick`, `wdrop`: `w` is the weapon class; `dna`: `w` the class of what the sample came from, `of` whose DNA it was (RFC 26, 4c, C1). */
  /** `c4` events: `st` what happened (C4_STATES), `of` (defuse and fail) the player who armed it, `s` (plant) the timer in seconds, `x y z` where the charge was. `tbtn` events: `n` the button's text, `x y z` its place. Units / 8, absolute. */
  st?: 'plant' | 'defuse' | 'fail' | 'boom'
  s?: number
  n?: string
  x?: number
  y?: number
  z?: number
}
/**
 * One point of a body's path (RFC 24): the player it belonged to, the time in ms, the position of the ragdoll in units / 8 (absolute) and its
 * turn in quarter degrees (pitch `pt`, yaw `w`, roll `r`, -720 to 719).
 */
export interface TrackBody { p: string, t: number, x: number, y: number, z: number, pt: number, w: number, r: number }
/**
 * One part that moves, as its keyframes (RFC 20, 4.3). `e` is the number the track gives this entity (one for each entity, so two entities that
 * share a model are two parts), `m` the number of its model in the map file, which is the name of its node in the mesh. `k` is the tick index
 * of each keyframe (the first absolute, then differences); positions are whole units and angles quarter degrees (pitch `p`, yaw `w`, roll `r`),
 * the first value absolute and then differences, as the players' segments are.
 */
export interface TrackPart { e: number, m: number, c: string, n?: string, k: number[], x: number[], y: number[], z: number[], p: number[], w: number[], r: number[] }
/** What was asked of a part, and by whom (RFC 20, 4.4): `v` says whether it came as an input to the entity or as a player's use. */
export interface TrackInput { t: number, e: number, i: string, v: 'input' | 'use', by?: string }
/**
 * One prop, prop door or weapon that moved (RFC 20, 4.8). `e` is its number in the track, `c` its class, `mdl` its model file, `b` the bounds of the model
 * as [min x, y, z, max x, y, z] in whole units, `id` its number in the map file when the map made it. `k` is the tick index of each keyframe, the pose arrays
 * as for parts. `g` is the tick at which it was gone (removed, or taken into a hand); absent when it stayed to the end.
 */
export interface TrackThing { e: number, c: string, mdl: string, b: number[], id?: number, g?: number, k: number[], x: number[], y: number[], z: number[], p: number[], w: number[], r: number[] }
export interface Track {
  roundId: string
  map: string
  fingerprint: string | null
  /** Milliseconds from the first sample to the round's start: the preparation before it (RFC 12, 3.7). 0 when the recording began with the round. */
  begin?: number
  truncated: boolean
  degraded: boolean
  /** Tick times in ms since the round began, as differences. */
  t: number[]
  players: TrackPlayer[]
  deaths: TrackDeath[]
  events: TrackEvent[]
  /** Absent in a track from before RFC 24 and in one where no body moved. */
  bodies?: TrackBody[]
  /** Absent in a track recorded without parts (and in every track from before RFC 20). */
  parts?: TrackPart[]
  inputs?: TrackInput[]
  /** Absent in a track without them (RFC 20, stage 4). */
  things?: TrackThing[]
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
  if (typeof b.map !== 'string' || !NAME.test(b.map)) return no('map is required')
  if (round.map && b.map !== round.map) return no('map does not match the round')
  if (b.fingerprint !== undefined && b.fingerprint !== null && (typeof b.fingerprint !== 'string' || !FINGERPRINT.test(b.fingerprint))) return no('fingerprint must be 64 hex characters')
  for (const flag of ['truncated', 'degraded'] as const) if (b[flag] !== undefined && typeof b[flag] !== 'boolean') return no(`${flag} must be true or false`)

  const t = ints(b.t, 1, MAX_TICKS, 0, TICK_STEP_MAX)
  if (!t) return no(`t must be 1-${MAX_TICKS} whole numbers, each a step of at most ${TICK_STEP_MAX} ms`)
  const total = t.reduce((a, n) => a + n, 0)
  if (total > TIME_MAX) return no('the track is longer than six hours')
  if (b.begin !== undefined && (!isInt(b.begin) || b.begin < 0 || b.begin > total)) return no('begin must be a whole number of ms from 0 to the length of the track')

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
      let moves: number[] | undefined
      if (s.s !== undefined) {
        const m = ints(s.s, x.length, x.length, 0, 7)
        if (!m) return no('s must be whole numbers from 0 to 7, as many as there are positions')
        moves = m
      }
      let hp: number[] | undefined
      if (s.hp !== undefined) {
        const h = ints(s.hp, x.length, x.length, -MAX_HP, MAX_HP)
        if (!h || !rebuilds(h, 0, MAX_HP)) return no(`hp must be whole numbers, as many as there are positions, that add up to a health from 0 to ${MAX_HP}`)
        hp = h
      }
      segments.push({ from: s.from, x, y, z, a, ...(moves ? { s: moves } : {}), ...(hp ? { hp } : {}) })
      next = s.from + x.length
    }
    if (p.mh !== undefined && (!isInt(p.mh) || p.mh < 1 || p.mh > MAX_HP)) return no(`mh must be a whole number from 1 to ${MAX_HP}`)
    players.push({ id: p.id, ...(p.mh !== undefined ? { mh: p.mh as number } : {}), segments })
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
      const weapon = typeof d.weapon === 'string' && NAME.test(d.weapon) ? d.weapon : null
      deaths.push({ victim: d.victim as string, attacker: hasAttacker ? (d.attacker as string) : null, t: d.t, vx, vy, vz, ax, ay, az, weapon })
    }
  }

  // Revivals and role changes (RFC 14, 4.3). Optional: tracks from before it, and bridges that send none, have no events.
  const events: TrackEvent[] = []
  const possessed: TrackEvent[] = [] // the spec events that name a thing: checked once the things are known
  if (b.events !== undefined) {
    if (!Array.isArray(b.events) || b.events.length > MAX_TRACK_EVENTS) return no(`events must be at most ${MAX_TRACK_EVENTS} entries`)
    let last = 0
    for (const e of b.events as Record<string, unknown>[]) {
      if (!e || typeof e !== 'object') return no('an event must be an object')
      if (typeof e.p !== 'string' || !round.players.has(e.p)) return no('an event names a player who was not in the round')
      if (!isInt(e.t) || e.t < 0 || e.t > TIME_MAX) return no('an event has an invalid time')
      if (e.t < last) return no('events must be in time order')
      last = e.t
      const named = (v: unknown) => typeof v === 'string' && NAME.test(v)
      /** x, y and z of an event as one place: all three whole numbers inside the map, or none of them (undefined); anything else is false. */
      const place = (o: Record<string, unknown>): { x: number, y: number, z: number } | undefined | false => {
        if (o.x === undefined && o.y === undefined && o.z === undefined) return undefined
        for (const v of [o.x, o.y, o.z]) if (!isInt(v) || Math.abs(v) > POS_MAX) return false
        return { x: o.x as number, y: o.y as number, z: o.z as number }
      }
      if (e.k === 'role') {
        if (!named(e.role) || !named(e.team)) return no('a role event needs a role and a team')
        if (e.by !== undefined || e.how !== undefined || e.why !== undefined) return no('a role event cannot carry reviver fields')
        events.push({ t: e.t, p: e.p, k: 'role', role: e.role as string, team: e.team as string })
      } else if (e.k === 'revive') {
        if (e.role !== undefined || e.team !== undefined) return no('a revive event cannot carry a role or team')
        for (const f of ['how', 'why'] as const) if (e[f] !== undefined && !named(e[f])) return no(`a revive event has an invalid ${f}`)
        if (e.by !== undefined && (typeof e.by !== 'string' || !round.players.has(e.by))) return no('a revive event names a reviver who was not in the round')
        const ev: TrackEvent = { t: e.t, p: e.p, k: 'revive' }
        if (e.by !== undefined) ev.by = e.by as string
        if (e.how !== undefined) ev.how = e.how as string
        if (e.why !== undefined) ev.why = e.why as string
        events.push(ev)
      } else if (e.k === 'say') {
        if (typeof e.text !== 'string' || e.text.length === 0 || [...e.text].length > MAX_SAY_CHARS) return no(`a say event needs a line of 1 to ${MAX_SAY_CHARS} characters`)
        if (/[\u0000-\u001f\u007f]/.test(e.text)) return no('a say event cannot hold control characters')
        if (e.ch !== 'all' && e.ch !== 'team' && e.ch !== 'dead') return no('a say event needs a channel: all, team or dead')
        events.push({ t: e.t, p: e.p, k: 'say', text: e.text, ch: e.ch })
      } else if (e.k === 'buy') {
        if (!named(e.item)) return no('a buy event needs the class of what was bought')
        if (e.it !== undefined && e.it !== true) return no('a buy event has an invalid item flag')
        events.push({ t: e.t, p: e.p, k: 'buy', item: e.item as string, ...(e.it ? { it: true } : {}) })
      } else if (e.k === 'found' || e.k === 'pickup' || e.k === 'drop') {
        if (e.of !== undefined && (typeof e.of !== 'string' || !round.players.has(e.of))) return no(`a ${e.k} event names a body of a player who was not in the round`)
        events.push({ t: e.t, p: e.p, k: e.k, ...(e.of !== undefined ? { of: e.of as string } : {}) })
      } else if (e.k === 'hurt') {
        if (e.a !== undefined && (typeof e.a !== 'string' || !round.players.has(e.a) || e.a === e.p)) return no('a hurt event names an attacker who was not in the round, or the victim as the attacker')
        if (typeof e.w !== 'string' || !HURT_CAUSE.test(e.w)) return no('a hurt event needs a cause: letters, digits, _ . and -, at most 40')
        if (!isInt(e.d) || e.d < 1 || e.d > MAX_HURT_DAMAGE) return no(`a hurt event needs damage from 1 to ${MAX_HURT_DAMAGE}`)
        if (!isInt(e.h) || e.h < 0 || e.h > MAX_HP) return no(`a hurt event needs the health after it, from 0 to ${MAX_HP}`)
        events.push({ t: e.t, p: e.p, k: 'hurt', ...(e.a !== undefined ? { a: e.a as string } : {}), w: e.w, d: e.d, h: e.h })
      } else if (e.k === 'heal') {
        if (typeof e.w !== 'string' || !HURT_CAUSE.test(e.w)) return no('a heal event needs a source: letters, digits, _ . and -, at most 40')
        if (e.a !== undefined && (typeof e.a !== 'string' || !round.players.has(e.a))) return no('a heal event names a healer who was not in the round')
        const healer = e.a !== undefined && !(e.a === e.p && HEAL_CAUSE_WORDS.has(e.w)) ? (e.a as string) : undefined // oneself as the healer only for a weapon or an entity; for regen, revive and other the healer is dropped
        if (!isInt(e.d) || e.d < 1 || e.d > MAX_HURT_DAMAGE) return no(`a heal event needs the health gained from 1 to ${MAX_HURT_DAMAGE}`)
        if (!isInt(e.h) || e.h < 1 || e.h > MAX_HP) return no(`a heal event needs the health after it, from 1 to ${MAX_HP}`)
        events.push({ t: e.t, p: e.p, k: 'heal', ...(healer !== undefined ? { a: healer } : {}), w: e.w, d: e.d, h: e.h })
      } else if (e.k === 'wpick' || e.k === 'wdrop') {
        if (typeof e.w !== 'string' || !HURT_CAUSE.test(e.w)) return no(`a ${e.k} event needs the weapon class: letters, digits, _ . and -, at most 40`)
        events.push({ t: e.t, p: e.p, k: e.k, w: e.w })
      } else if (e.k === 'c4') {
        if (typeof e.st !== 'string' || !C4_STATES.has(e.st)) return no('a c4 event needs st: plant, defuse, fail or boom')
        const st = e.st as 'plant' | 'defuse' | 'fail' | 'boom'
        if (st === 'defuse' || st === 'fail') {
          if (e.of !== undefined && (typeof e.of !== 'string' || !round.players.has(e.of))) return no('a c4 event names an owner who was not in the round')
        }
        if (st === 'plant' && e.s !== undefined && (!isInt(e.s) || e.s < 1 || e.s > 3600)) return no('a c4 plant needs a timer of 1 to 3600 seconds')
        const at = place(e)
        if (at === false) return no('a c4 event has an invalid place: x, y and z are all given or none, whole numbers of units / 8 inside the map')
        events.push({ t: e.t, p: e.p, k: 'c4', st, ...(st !== 'plant' && st !== 'boom' && e.of !== undefined ? { of: e.of as string } : {}), ...(st === 'plant' && e.s !== undefined ? { s: e.s as number } : {}), ...(at ?? {}) })
      } else if (e.k === 'dna') {
        if (e.of !== undefined && (typeof e.of !== 'string' || !round.players.has(e.of))) return no('a dna event names a player who was not in the round')
        if (e.w !== undefined && (typeof e.w !== 'string' || !HURT_CAUSE.test(e.w))) return no('a dna event has an invalid source class')
        events.push({ t: e.t, p: e.p, k: 'dna', ...(e.of !== undefined ? { of: e.of as string } : {}), ...(e.w !== undefined ? { w: e.w as string } : {}) })
      } else if (e.k === 'tbtn') {
        if (e.n !== undefined && (typeof e.n !== 'string' || e.n.length === 0 || [...e.n].length > MAX_TBTN_CHARS || /[\u0000-\u001f\u007f]/.test(e.n))) return no(`a tbtn event needs text of 1 to ${MAX_TBTN_CHARS} characters with no control characters, or none`)
        const at = place(e)
        if (at === false) return no('a tbtn event has an invalid place: x, y and z are all given or none, whole numbers of units / 8 inside the map')
        events.push({ t: e.t, p: e.p, k: 'tbtn', ...(e.n !== undefined ? { n: e.n as string } : {}), ...(at ?? {}) })
      } else if (e.k === 'hold') {
        if (typeof e.w !== 'string' || !HURT_CAUSE.test(e.w)) return no('a hold event needs the weapon class: letters, digits, _ . and -, at most 40')
        events.push({ t: e.t, p: e.p, k: 'hold', w: e.w })
      } else if (e.k === 'credits' || e.k === 'karma') {
        const top = e.k === 'credits' ? MAX_CREDITS : MAX_KARMA
        if (!isInt(e.d) || e.d === 0 || Math.abs(e.d) > top) return no(`a ${e.k} event needs a change that is not 0, from -${top} to ${top}`)
        if (!isInt(e.c) || e.c < 0 || e.c > top) return no(`a ${e.k} event needs the amount after it, from 0 to ${top}`)
        if (typeof e.w !== 'string' || !REASON_WORD.test(e.w)) return no(`a ${e.k} event needs a reason: lower-case letters, at most 20`)
        events.push({ t: e.t, p: e.p, k: e.k, d: e.d, c: e.c, w: e.w })
      } else if (e.k === 'spec') {
        if (e.of !== undefined && (typeof e.of !== 'string' || !round.players.has(e.of) || e.of === e.p)) return no('a spec event names a player who was not in the round, or the watcher themselves')
        // A possessed prop (RFC 26, 4c.x): its class `pr`, the file name of its model `pm` and the number of the thing it is `ti`; never together with `of`.
        if (e.pr === undefined && (e.pm !== undefined || e.ti !== undefined)) return no('a spec event has a prop model or thing without a prop class')
        if (e.pr !== undefined) {
          if (e.of !== undefined) return no('a spec event watches a player or possesses a prop, not both')
          if (typeof e.pr !== 'string' || !HURT_CAUSE.test(e.pr)) return no('a spec event needs the prop class: letters, digits, _ . and -, at most 40')
          if (e.pm !== undefined && (typeof e.pm !== 'string' || !PROP_MODEL_NAME.test(e.pm))) return no('a spec event needs the prop model as a lower-case name: letters, digits, _ and -, at most 40')
          if (e.ti !== undefined && (!isInt(e.ti) || e.ti < 1 || e.ti > 65535)) return no('a spec event needs the number of a thing, from 1 to 65535')
        }
        const ev: TrackEvent = { t: e.t, p: e.p, k: 'spec', ...(e.of !== undefined ? { of: e.of as string } : {}), ...(e.pr !== undefined ? { pr: e.pr as string } : {}), ...(e.pm !== undefined ? { pm: e.pm as string } : {}), ...(e.ti !== undefined ? { ti: e.ti as number } : {}) }
        if (e.ti !== undefined) possessed.push(ev)
        events.push(ev)
      } else return no('an event has an unknown kind')
    }
  }

  // Where the bodies lay (RFC 24, 4.4). Optional, in time order, absolute values, at most MAX_TRACK_BODIES.
  const bodies: TrackBody[] = []
  if (b.bodies !== undefined) {
    if (!Array.isArray(b.bodies) || b.bodies.length > MAX_TRACK_BODIES) return no(`bodies must be at most ${MAX_TRACK_BODIES} entries`)
    let last = 0
    for (const n of b.bodies as Record<string, unknown>[]) {
      if (!n || typeof n !== 'object') return no('a body point must be an object')
      if (typeof n.p !== 'string' || !round.players.has(n.p)) return no('a body point names a player who was not in the round')
      if (!isInt(n.t) || n.t < 0 || n.t > TIME_MAX) return no('a body point has an invalid time')
      if (n.t < last) return no('body points must be in time order')
      last = n.t
      const pos = (k: string) => (isInt(n[k]) && Math.abs(n[k] as number) <= POS_MAX ? (n[k] as number) : null)
      const ang = (k: string) => (isInt(n[k]) && (n[k] as number) >= -BODY_ANGLE_MAX && (n[k] as number) < BODY_ANGLE_MAX ? (n[k] as number) : null)
      const x = pos('x'), y = pos('y'), z = pos('z'), pt = ang('pt'), w = ang('w'), r = ang('r')
      if (x === null || y === null || z === null) return no('a body point has an invalid position')
      if (pt === null || w === null || r === null) return no('a body point has an invalid turn')
      bodies.push({ p: n.p, t: n.t, x, y, z, pt, w, r })
    }
  }

  // Parts that move and the inputs that reach them (RFC 20, 4.5). Optional: a bridge without them sends neither.
  const parts: TrackPart[] = []
  if (b.parts !== undefined) {
    if (!Array.isArray(b.parts) || b.parts.length > MAX_TRACK_PARTS) return no(`parts must be at most ${MAX_TRACK_PARTS} entries`)
    const ids = new Set<number>()
    let keys = 0
    for (const q of b.parts as Record<string, unknown>[]) {
      if (!q || typeof q !== 'object') return no('a part must be an object')
      if (!isInt(q.e) || q.e < 1 || q.e > 65535 || ids.has(q.e)) return no('a part needs its own whole number e from 1 to 65535')
      ids.add(q.e)
      if (!isInt(q.m) || q.m < 1 || q.m > 65535) return no('a part needs a model number m from 1 to 65535')
      if (typeof q.c !== 'string' || !PART_CLASSES.has(q.c)) return no('a part has a class that is not one that moves')
      if (q.n !== undefined && (typeof q.n !== 'string' || !NAME.test(q.n))) return no('a part has an invalid name')
      const k = ints(q.k, 1, MAX_KEYS_PER_PART, 0, t.length - 1)
      if (!k) return no(`a part needs 1-${MAX_KEYS_PER_PART} keyframes, each a tick of the track`)
      for (let i = 1; i < k.length; i++) if (k[i]! < 1) return no('the keyframes of a part must come in order, one at most for each tick')
      if (!rebuilds(k, 0, t.length - 1)) return no('a keyframe is past the last tick')
      const x = ints(q.x, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const y = ints(q.y, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const z = ints(q.z, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const p = ints(q.p, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      const w = ints(q.w, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      const r = ints(q.r, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      if (!x || !y || !z || !p || !w || !r) return no('the arrays of a part must be whole numbers in range and of the same length')
      if (!rebuilds(x, -PART_POS_MAX, PART_POS_MAX) || !rebuilds(y, -PART_POS_MAX, PART_POS_MAX) || !rebuilds(z, -PART_POS_MAX, PART_POS_MAX)) return no('a part is outside the map')
      if (!rebuilds(p, -PART_ANGLE_MAX, PART_ANGLE_MAX) || !rebuilds(w, -PART_ANGLE_MAX, PART_ANGLE_MAX) || !rebuilds(r, -PART_ANGLE_MAX, PART_ANGLE_MAX)) return no('an angle of a part is out of range')
      keys += k.length
      if (keys > MAX_TRACK_KEYS) return no(`the parts have more than ${MAX_TRACK_KEYS} keyframes in all`)
      parts.push(q.n !== undefined ? { e: q.e, m: q.m, c: q.c, n: q.n, k, x, y, z, p, w, r } : { e: q.e, m: q.m, c: q.c, k, x, y, z, p, w, r })
    }
  }
  // Props, prop doors and weapons that moved (RFC 20, 4.8). Optional: only the bridge with traitordash_track_props on sends them.
  const things: TrackThing[] = []
  if (b.things !== undefined) {
    if (!Array.isArray(b.things) || b.things.length > MAX_TRACK_THINGS) return no(`things must be at most ${MAX_TRACK_THINGS} entries`)
    const ids = new Set<number>()
    let keys = 0
    for (const q of b.things as Record<string, unknown>[]) {
      if (!q || typeof q !== 'object') return no('a thing must be an object')
      if (!isInt(q.e) || q.e < 1 || q.e > 65535 || ids.has(q.e)) return no('a thing needs its own whole number e from 1 to 65535')
      ids.add(q.e)
      if (typeof q.c !== 'string' || !(THING_CLASSES.has(q.c) || WEAPON_CLASS.test(q.c))) return no('a thing has a class that is not recorded')
      if (typeof q.mdl !== 'string' || !MODEL_PATH.test(q.mdl) || q.mdl.includes('..')) return no('a thing needs a model path')
      const bounds = ints(q.b, 6, 6, -POS_MAX, POS_MAX)
      if (!bounds || bounds[0]! > bounds[3]! || bounds[1]! > bounds[4]! || bounds[2]! > bounds[5]!) return no('a thing needs bounds as six whole numbers, the least first')
      if (q.id !== undefined && (!isInt(q.id) || q.id < 0 || q.id > 2_147_483_647)) return no('a thing has an invalid map id')
      const k = ints(q.k, 1, MAX_KEYS_PER_THING, 0, t.length - 1)
      if (!k) return no(`a thing needs 1-${MAX_KEYS_PER_THING} keyframes, each a tick of the track`)
      for (let i = 1; i < k.length; i++) if (k[i]! < 1) return no('the keyframes of a thing must come in order, one at most for each tick')
      if (!rebuilds(k, 0, t.length - 1)) return no('a keyframe is past the last tick')
      const x = ints(q.x, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const y = ints(q.y, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const z = ints(q.z, k.length, k.length, -PART_POS_STEP, PART_POS_STEP)
      const p = ints(q.p, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      const w = ints(q.w, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      const r = ints(q.r, k.length, k.length, -PART_ANGLE_STEP, PART_ANGLE_STEP)
      if (!x || !y || !z || !p || !w || !r) return no('the arrays of a thing must be whole numbers in range and of the same length')
      if (!rebuilds(x, -PART_POS_MAX, PART_POS_MAX) || !rebuilds(y, -PART_POS_MAX, PART_POS_MAX) || !rebuilds(z, -PART_POS_MAX, PART_POS_MAX)) return no('a thing is outside the map')
      if (!rebuilds(p, -PART_ANGLE_MAX, PART_ANGLE_MAX) || !rebuilds(w, -PART_ANGLE_MAX, PART_ANGLE_MAX) || !rebuilds(r, -PART_ANGLE_MAX, PART_ANGLE_MAX)) return no('an angle of a thing is out of range')
      const lastKey = k.reduce((a, n) => a + n, 0)
      if (q.g !== undefined && (!isInt(q.g) || q.g < lastKey || q.g > t.length - 1)) return no('a thing is gone before its last keyframe or after the last tick')
      keys += k.length
      if (keys > MAX_THING_KEYS) return no(`the things have more than ${MAX_THING_KEYS} keyframes in all`)
      things.push({ e: q.e, c: q.c, mdl: q.mdl, b: bounds, ...(q.id !== undefined ? { id: q.id as number } : {}), ...(q.g !== undefined ? { g: q.g as number } : {}), k, x, y, z, p, w, r })
    }
  }
  for (const ev of possessed) if (!things.some(q => q.e === ev.ti)) return no('a spec event names a thing that is not in the track')
  const inputs: TrackInput[] = []
  if (b.inputs !== undefined) {
    if (!Array.isArray(b.inputs) || b.inputs.length > MAX_TRACK_INPUTS) return no(`inputs must be at most ${MAX_TRACK_INPUTS} entries`)
    const known = new Set(parts.map(q => q.e))
    let last = 0
    for (const n of b.inputs as Record<string, unknown>[]) {
      if (!n || typeof n !== 'object') return no('an input must be an object')
      if (!isInt(n.t) || n.t < 0 || n.t > TIME_MAX) return no('an input has an invalid time')
      if (n.t < last) return no('inputs must be in time order')
      last = n.t
      if (!isInt(n.e) || !known.has(n.e)) return no('an input names a part that is not in the track')
      if (typeof n.i !== 'string' || !PART_INPUTS.has(n.i)) return no('an input has a name that is not recorded')
      if (n.v !== 'input' && n.v !== 'use') return no('an input says whether it came as an input or a use')
      if (n.by !== undefined && (typeof n.by !== 'string' || !round.players.has(n.by))) return no('an input names a player who was not in the round')
      const v: 'input' | 'use' = n.v
      inputs.push(n.by !== undefined ? { t: n.t, e: n.e, i: n.i, v, by: n.by as string } : { t: n.t, e: n.e, i: n.i, v })
    }
  }

  return { ok: true, track: {
    roundId: round.roundId, map: b.map, fingerprint: typeof b.fingerprint === 'string' ? b.fingerprint : null,
    truncated: b.truncated === true, degraded: b.degraded === true, t, players, deaths, events,
    ...(bodies.length > 0 ? { bodies } : {}), ...(typeof b.begin === 'number' && b.begin > 0 ? { begin: b.begin } : {}), ...(parts.length > 0 ? { parts } : {}), ...(things.length > 0 ? { things } : {}), ...(inputs.length > 0 ? { inputs } : {}),
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
