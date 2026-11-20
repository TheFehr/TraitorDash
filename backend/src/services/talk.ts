import { Store } from './Store'

// Who spoke, and when, on the dashboard's voice page (RFC 26, 4c.5). Only times and SteamID64s: never audio, never text.
//
// The path: each player's voice page posts the spans in which its own microphone gate was open (`POST /servers/:id/voice/talk`). The
// log below keeps them in memory, in the backend's clock, per server and player. It also keeps the round "windows" it sees in the
// bridge's voice state (the time `phase: 'active'` arrived and the time the phase left it), because the voice state carries no round id.
// When the round report arrives, the round is matched to the window of about its length (`claim`), and a few seconds later (the last
// spans of a round come after it) the spans inside the window are written, relative to the window's start, to `round_talk`.

export const TALK = {
  /** At most this many spans in one request. */
  maxPerRequest: 50,
  /** A span is at least 1 ms and at most 10 minutes long. */
  minSpanMs: 1,
  maxSpanMs: 10 * 60_000,
  /** A span may end this far in the server's future (clock skew, the post's travel) and at most this far in its past. */
  futureMs: 5_000,
  pastMs: 10 * 60_000,
  /** The body of a request is at most this many bytes. */
  maxBodyBytes: 4096,
  /** Spans this far apart or closer are one; a span shorter than `shortMs` after merging is dropped (a click of the gate, not speech). */
  mergeGapMs: 600,
  shortMs: 200,
  /** What one round keeps: per player, and in all (ten players). */
  perPlayer: 1024,
  perRound: 10_240,
  /** The longest round: a span or a window beyond it is not kept (a round never runs six hours). */
  maxRoundMs: 6 * 60 * 60_000,
  /** What the log holds in memory per player, and how many players per server. */
  memoryPerPlayer: 2048,
  memoryPlayers: 64,
  /** A window and its spans are forgotten this long after they ended. */
  forgetMs: 30 * 60_000,
  /** How many windows are kept per server. */
  windows: 8,
  /** The round's length and its window's may differ by this much (the report counts whole seconds; the two clocks are the bridge's and the dashboard's). */
  matchMs: 15_000,
  /** The report of a round comes this long after the window closed at most. */
  claimWithinMs: 10 * 60_000,
  /** How long after the report the spans are written (the last ones of a round arrive after it). Tests set it to 0. */
  graceMs: 8_000,
}

export type Span = [number, number]
export interface TalkSpan { p: string, from: number, to: number }

const STEAM_ID64 = /^\d{17}$/
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A request's body: `{ now, spans: [{ from, to }] }` with times in the browser's own clock (`Date.now()`). `now` is the browser's clock at
 * the moment it sent the request: the difference to the server's `now` is the skew, which is taken off every span (the error left is the
 * travel of the request). Returns the spans in the server's clock, with the ones that are not credible dropped, or the reason the body is
 * refused (too many spans, not the right shape).
 */
export function cleanTalkBody(body: unknown, serverNow: number): { spans: Span[], dropped: number } | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'The body must be an object.'
  const b = body as { now?: unknown, spans?: unknown }
  if (!Array.isArray(b.spans)) return 'spans must be a list.'
  if (b.spans.length > TALK.maxPerRequest) return `At most ${TALK.maxPerRequest} spans in a request.`
  const skew = isNum(b.now) ? serverNow - b.now : 0
  const spans: Span[] = []
  let dropped = 0
  for (const s of b.spans) {
    const from = (s as { from?: unknown } | null)?.from, to = (s as { to?: unknown } | null)?.to
    if (!isNum(from) || !isNum(to) || !(from < to)) { dropped++; continue }
    const len = to - from
    const a = from + skew, e = to + skew
    if (len < TALK.minSpanMs || len > TALK.maxSpanMs || e > serverNow + TALK.futureMs || e < serverNow - TALK.pastMs) { dropped++; continue }
    spans.push([Math.round(a), Math.round(e)])
  }
  return { spans, dropped }
}

/** Sorts the spans and joins the ones that overlap or are at most `gap` ms apart. */
export function mergeSpans(spans: Span[], gap: number): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s[0] - last[1] <= gap) { if (s[1] > last[1]) last[1] = s[1] } else out.push([s[0], s[1]])
  }
  return out
}

/**
 * What is read back and sent out: only `{ p, from, to }` of players of the round (`players`), whole milliseconds, 0 <= from < to <= the longest
 * round, per player and in all at most the caps, in order of time. Anything else is dropped, never repaired.
 */
export function cleanTalk(list: unknown, players: Set<string>): TalkSpan[] {
  if (!Array.isArray(list)) return []
  const out: TalkSpan[] = []
  const per = new Map<string, number>()
  for (const s of list) {
    const p = s?.p, from = s?.from, to = s?.to
    if (typeof p !== 'string' || !players.has(p) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || !(from < to) || to > TALK.maxRoundMs) continue
    const n = per.get(p) ?? 0
    if (n >= TALK.perPlayer || out.length >= TALK.perRound) continue
    per.set(p, n + 1)
    out.push({ p, from, to })
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
}

export interface TalkWindow {
  from: number
  /** null while the round is on. */
  to: number | null
  /** Whether the server's setting was on when the round began: a round that began with it off is never recorded, whatever happens to it later. */
  enabled: boolean
  /** The round report has been matched to this window, or its spans have been written. */
  claimed: boolean
  done: boolean
}

export class TalkLog {
  private windows = new Map<string, TalkWindow[]>()
  private spans = new Map<string, Map<string, Span[]>>()

  constructor(private now: () => number = Date.now) {}

  /** The bridge's voice state arrived (the backend's clock `at`): a round begins when the phase becomes 'active' and ends when it stops being. */
  phase(serverId: string, phase: 'prep' | 'active' | 'over', enabled: boolean, at: number = this.now()) {
    const list = this.windows.get(serverId) ?? []
    const open = list[list.length - 1]
    if (phase === 'active') {
      if (open && open.to === null) return
      list.push({ from: at, to: null, enabled, claimed: false, done: false })
      while (list.length > TALK.windows) list.shift()
      this.windows.set(serverId, list)
    } else if (open && open.to === null) open.to = at
    this.prune(serverId, at)
  }

  /** The window the log keeps now for the server, newest last (for tests). */
  windowsOf(serverId: string): TalkWindow[] { return this.windows.get(serverId) ?? [] }

  private prune(serverId: string, now: number) {
    const list = this.windows.get(serverId)
    if (list) {
      const keep = list.filter(w => w.to === null || now - w.to <= TALK.forgetMs)
      if (keep.length !== list.length) this.windows.set(serverId, keep)
    }
    const players = this.spans.get(serverId)
    // a span is forgotten after half an hour, unless it lies in a round that has not been written yet (a long round keeps all of its spans)
    const live = (this.windows.get(serverId) ?? []).filter(w => !w.done)
    if (players) for (const [id, l] of players) {
      const fresh = l.filter(s => now - s[1] <= TALK.forgetMs || live.some(w => s[1] > w.from && s[0] < (w.to ?? Infinity)))
      if (fresh.length === 0) players.delete(id); else if (fresh.length !== l.length) players.set(id, fresh)
    }
  }

  /**
   * Keeps spans of one player (the backend's clock). Only what overlaps a round that is on, or one that ended and has not been written
   * yet, and that began with the setting on, is kept: talk in the lobby is not recorded at all. Returns how many were kept.
   */
  add(serverId: string, steamId: string, spans: Span[], now: number = this.now()): number {
    if (!STEAM_ID64.test(steamId)) return 0
    const live = (this.windows.get(serverId) ?? []).filter(w => w.enabled && !w.done)
    if (live.length === 0) return 0
    const mine = spans.filter(s => live.some(w => s[1] > w.from && s[0] < (w.to ?? Infinity)))
    if (mine.length === 0) return 0
    const players = this.spans.get(serverId) ?? new Map<string, Span[]>()
    if (!players.has(steamId) && players.size >= TALK.memoryPlayers) return 0
    const have = players.get(steamId) ?? []
    have.push(...mine)
    if (have.length > TALK.memoryPerPlayer) have.splice(0, have.length - TALK.memoryPerPlayer)
    players.set(steamId, have)
    this.spans.set(serverId, players)
    this.prune(serverId, now)
    return mine.length
  }

  /**
   * The round just reported, `duration` seconds long: the window of about that length that is not claimed yet and ended (or is still on)
   * within ten minutes. The one that fits best wins. null when there is none, or when it began with the setting off.
   */
  claim(serverId: string, durationSeconds: number | null, now: number = this.now()): TalkWindow | null {
    if (durationSeconds === null) return null
    let best: TalkWindow | null = null, gap = Infinity
    for (const w of this.windows.get(serverId) ?? []) {
      if (w.claimed || (w.to !== null && now - w.to > TALK.claimWithinMs)) continue
      const end = w.to ?? now
      const g = Math.abs(end - w.from - durationSeconds * 1000)
      if (g <= TALK.matchMs && g < gap) { best = w; gap = g }
    }
    if (!best) return null
    best.claimed = true
    if (best.to === null) best.to = now // the state that ends the round has not arrived yet: the report is its end
    if (!best.enabled) { best.done = true; return null }
    return best
  }

  /** The window's spans for the players of the round, relative to the window's start, clipped to it, merged, short ones out, capped. */
  collect(serverId: string, w: TalkWindow, players: Set<string>): TalkSpan[] {
    const end = w.to ?? this.now()
    const out: TalkSpan[] = []
    for (const [id, list] of this.spans.get(serverId) ?? []) {
      if (!players.has(id)) continue
      const inside: Span[] = []
      for (const s of list) {
        const a = Math.max(s[0], w.from), e = Math.min(s[1], end)
        if (e > a) inside.push([a - w.from, e - w.from])
      }
      for (const [a, e] of mergeSpans(inside, TALK.mergeGapMs)) if (e - a >= TALK.shortMs) out.push({ p: id, from: Math.round(a), to: Math.round(e) })
    }
    return cleanTalk(out, players)
  }

  /** The window is over and written: its spans leave the memory. */
  finish(serverId: string, w: TalkWindow) {
    w.done = true
    const end = w.to ?? this.now()
    const players = this.spans.get(serverId)
    if (!players) return
    for (const [id, list] of players) {
      const rest = list.filter(s => s[1] > end) // what was said after the round belongs to no round that is kept
      if (rest.length === 0) players.delete(id); else players.set(id, rest)
    }
  }

  /** For tests. */
  held(serverId: string, steamId: string): Span[] { return this.spans.get(serverId)?.get(steamId) ?? [] }
  reset() { this.windows.clear(); this.spans.clear() }
}

/** The one log of this process. */
export const talkLog = new TalkLog()

/** Whether the server's own setting `traitordash_track_voice` is on, as its bridge last reported it; a server that never reported has it off. */
export const talkEnabled = (serverId: string): boolean => Store.getBridgeSettings(serverId)?.values.traitordash_track_voice?.value === '1'

/**
 * A round was reported (RFC 26, 4c.5): match it to its window now, write what was said in it after a short wait. Resolves with what was
 * written (the number of spans), 0 when nothing was. Never throws: a failure here must not cost the round.
 */
export function attachTalk(serverId: string, roundId: string, durationSeconds: number | null, players: Set<string>, graceMs: number = TALK.graceMs): Promise<number> {
  let w: TalkWindow | null = null
  try { w = talkLog.claim(serverId, durationSeconds) } catch { return Promise.resolve(0) }
  if (!w) return Promise.resolve(0)
  const claimed = w
  return new Promise<number>((resolve) => {
    const write = () => {
      try {
        const list = talkEnabled(serverId) ? talkLog.collect(serverId, claimed, players) : []
        talkLog.finish(serverId, claimed)
        if (list.length > 0) Store.recordTalk(serverId, roundId, list)
        resolve(list.length)
      } catch (err) {
        console.warn(`[Talk] could not store the speaking spans of ${roundId}: ${(err as Error).message}`)
        resolve(0)
      }
    }
    if (graceMs <= 0) write(); else setTimeout(write, graceMs).unref?.()
  })
}
