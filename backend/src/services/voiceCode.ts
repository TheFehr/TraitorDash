import { randomInt } from 'node:crypto'

// Joining voice without a Steam sign-in (RFC 31): the game shows a player a short code (`!voice`), the player types it
// on the voice page in their own browser. The codes live in memory only: a restart loses them, which only means "ask
// for a new one".

/** Digits 2 to 9 and the consonants without L: no 0 O 1 I, and no vowel, so a code never spells a word. 28 characters. */
export const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 6
export const CODE_TTL_MS = 5 * 60_000
/** One new code per player in this time. */
export const PLAYER_WAIT_MS = 10_000
/** Live codes at most; the oldest goes first. A server has about ten players, so this is never reached by honest use. */
export const MAX_CODES = 300
/** After this many failed entries in a minute, entry (the right code too) waits. */
export const MAX_FAILURES_PER_WINDOW = 60
export const FAILURE_WINDOW_MS = 60_000

/** What the voice page says after a code that did not work: the same for a wrong, a used and an expired one. */
export const VOICE_CODE_FAILED = 'That code did not work. Say !voice in the game for a new one.'

/** `K7F3QX` as `K7F-3QX`. */
export const showCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`

/** What a person typed, as a code: upper case, spaces and dashes removed. Anything that cannot be a code is null. */
export const normaliseCode = (input: unknown): string | null => {
  if (typeof input !== 'string' || input.length > 40) return null
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null
  return code
}

const makeCode = (): string => {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

export class VoiceCodes {
  private byCode = new Map<string, { steamId: string, serverId: string, expires: number }>()
  private byPlayer = new Map<string, string>()
  private lastIssued = new Map<string, number>()
  private failures: { start: number, count: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  reset() { this.byCode.clear(); this.byPlayer.clear(); this.lastIssued.clear(); this.failures = null }
  get size() { return this.byCode.size }

  private drop(code: string) {
    const e = this.byCode.get(code)
    if (!e) return
    this.byCode.delete(code)
    if (this.byPlayer.get(e.steamId) === code) this.byPlayer.delete(e.steamId)
  }

  /** Removes what has expired (run on every call, so the maps cannot grow without anyone asking). */
  private sweep() {
    const t = this.now()
    for (const [code, e] of this.byCode) if (e.expires <= t) this.drop(code)
    for (const [id, at] of this.lastIssued) if (t - at >= PLAYER_WAIT_MS) this.lastIssued.delete(id)
  }

  /** A new code for the player, tied to the server that asked (it replaces their earlier one), or the seconds to wait when they asked a moment ago. */
  issue(steamId: string, serverId: string): { code: string } | { wait: number } {
    this.sweep()
    const t = this.now()
    const last = this.lastIssued.get(steamId)
    if (last !== undefined && t - last < PLAYER_WAIT_MS) return { wait: Math.max(1, Math.ceil((last + PLAYER_WAIT_MS - t) / 1000)) }
    const old = this.byPlayer.get(steamId)
    if (old) this.drop(old)
    let code = makeCode()
    while (this.byCode.has(code)) code = makeCode()
    while (this.byCode.size >= MAX_CODES) this.drop(this.byCode.keys().next().value as string)
    this.byCode.set(code, { steamId, serverId, expires: t + CODE_TTL_MS })
    this.byPlayer.set(steamId, code)
    this.lastIssued.set(steamId, t)
    return { code }
  }

  /** The player a typed code belongs to and the server that issued it; the code is used up. Null for anything else (wrong, used, expired: not told apart). */
  redeem(input: unknown): { steamId: string, serverId: string } | null {
    this.sweep()
    const code = normaliseCode(input)
    const entry = code ? this.byCode.get(code) : undefined
    if (!code || !entry) return null
    this.drop(code)
    return { steamId: entry.steamId, serverId: entry.serverId }
  }

  /** Counts a failed entry. */
  noteFailure() {
    const t = this.now()
    if (!this.failures || t - this.failures.start >= FAILURE_WINDOW_MS) this.failures = { start: t, count: 1 }
    else this.failures.count++
  }

  /** Seconds entry must wait because of too many failures in the last minute, else 0. */
  lockedFor(): number {
    const f = this.failures
    if (!f) return 0
    const t = this.now()
    if (t - f.start >= FAILURE_WINDOW_MS) { this.failures = null; return 0 }
    return f.count >= MAX_FAILURES_PER_WINDOW ? Math.max(1, Math.ceil((f.start + FAILURE_WINDOW_MS - t) / 1000)) : 0
  }
}

/** The one store of the process. Tests set its clock with `setVoiceClock`. */
export const voiceCodes = new VoiceCodes(() => clock())
let clock: () => number = Date.now
/** For tests: the clock the shared store (and so the routes) go by. */
export const setVoiceClock = (fn: (() => number) | null) => { clock = fn ?? Date.now }
