import { createHmac } from 'node:crypto'
import { STEAM_ID64 } from './validators'

/**
 * Voice chat through the dashboard (RFC 27): who hears whom, and the calls to the media server (LiveKit) that make it so.
 * The rules take only the round's phase and the list of the living: no role, team or position ever comes in.
 */

/** After this long without a message from the game server, everyone hears everyone (a map change must not mute the living). */
export const STALE_MS = 20_000
/** What a whole list of the living may hold: a server has about 10 players. */
export const MAX_ALIVE = 128

export type Phase = 'prep' | 'active' | 'over'
export interface VoiceState { boot: number, seq: number, phase: Phase, alive: Set<string>, at: number, names: Map<string, string> }

/** A nick as it is kept: no control characters, trimmed, at most 32 characters (not bytes); null when nothing is left. */
export function cleanNick(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const n = [...raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim()].slice(0, 32).join('').trim()
  return n === '' ? null : n
}

/** The bridge's message, checked. A string is the reason it is refused. */
export interface VoiceMessage { boot: number, seq: number, phase: Phase, alive: string[], names: Record<string, string> }
export function parseVoiceState(body: any): VoiceMessage | string {
  if (!body || typeof body !== 'object') return 'a JSON object is required'
  const { boot, seq, phase, alive } = body
  const rawNames = body.names
  if (!Number.isSafeInteger(boot) || boot < 0) return 'boot must be a whole number'
  if (!Number.isSafeInteger(seq) || seq < 0) return 'seq must be a whole number'
  if (phase !== 'prep' && phase !== 'active' && phase !== 'over') return 'phase must be prep, active or over'
  if (!Array.isArray(alive) || alive.length > MAX_ALIVE) return `alive must be a list of at most ${MAX_ALIVE} SteamID64s`
  for (const a of alive) if (typeof a !== 'string' || !STEAM_ID64.test(a)) return 'alive holds only SteamID64s'
  // The nicks of everyone connected (RFC 27, 7): optional, and an empty table may come as an empty list (a Lua table has no kind).
  const names: Record<string, string> = {}
  if (rawNames !== undefined && rawNames !== null && !(Array.isArray(rawNames) && rawNames.length === 0)) {
    if (typeof rawNames !== 'object' || Array.isArray(rawNames)) return 'names must be a table of SteamID64 to nick'
    const entries = Object.entries(rawNames)
    if (entries.length > MAX_ALIVE) return `names holds at most ${MAX_ALIVE} entries`
    for (const [id, nick] of entries) {
      if (!STEAM_ID64.test(id) || typeof nick !== 'string') return 'names maps SteamID64s to nicks'
      const clean = cleanNick(nick)
      if (clean) names[id] = clean
    }
  }
  return { boot, seq, phase, alive: [...new Set<string>(alive)], names }
}

/**
 * Whether `listener` hears `speaker` (RFC 27, 2): outside a round everyone hears everyone; in a round the living hear the living
 * and the dead hear everyone. Without a recent state, everyone hears everyone, so a lost connection never leaves anyone muted.
 */
export function canHear(state: VoiceState | null, listener: string, speaker: string, now: number): boolean {
  if (listener === speaker) return false
  if (!state || now - state.at > STALE_MS || state.phase !== 'active') return true
  if (!state.alive.has(listener)) return true
  return state.alive.has(speaker)
}

// ---------------------------------------------------------------- the media server

export interface LiveKitConfig {
  /** What the browser connects to (wss://…). */
  url: string
  /** What this server calls (https://…), by default the same address with http(s). */
  apiUrl: string
  key: string
  secret: string
}

/** From the environment: null (voice is off) unless the address and both keys are set. */
export function liveKitConfig(env: Record<string, string | undefined> = process.env): LiveKitConfig | null {
  const url = (env.LIVEKIT_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.LIVEKIT_API_KEY ?? '').trim()
  const secret = (env.LIVEKIT_API_SECRET ?? '').trim()
  if (!/^wss?:\/\//i.test(url) || !key || !secret) return null
  const apiUrl = (env.LIVEKIT_API_URL ?? '').trim().replace(/\/+$/, '') || url.replace(/^ws/i, 'http')
  if (!/^https?:\/\//i.test(apiUrl)) return null
  return { url, apiUrl, key, secret }
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/** A signed token (HS256) as LiveKit expects it. */
export function signJwt(secret: string, claims: Record<string, unknown>): string {
  const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export const roomOf = (serverId: string) => `traitordash-${serverId}`

/** What a player's browser needs to join: may publish and subscribe, and nothing else. It subscribes to nothing by itself; the server decides. */
export function joinToken(cfg: LiveKitConfig, room: string, identity: string, name: string, now = Date.now(), ttlSeconds = 6 * 3600): string {
  const s = Math.floor(now / 1000)
  return signJwt(cfg.secret, {
    iss: cfg.key, sub: identity, name, nbf: s - 10, exp: s + ttlSeconds,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
  })
}

export interface Participant { sid: string, identity: string, name: string, audio: string[] }

/** The few calls of LiveKit's room service (a Twirp API over HTTP and JSON) that routing needs. */
export class LiveKitApi {
  constructor(private cfg: LiveKitConfig, private fetchFn: typeof fetch = fetch, private now: () => number = Date.now) {}

  private async call(method: string, room: string, body: Record<string, unknown>): Promise<any> {
    const s = Math.floor(this.now() / 1000)
    const token = signJwt(this.cfg.secret, { iss: this.cfg.key, nbf: s - 10, exp: s + 600, video: { roomAdmin: true, room } })
    const res = await this.fetchFn(`${this.cfg.apiUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
    return res.json()
  }

  async listParticipants(room: string): Promise<Participant[]> {
    const out = await this.call('ListParticipants', room, { room })
    const list = Array.isArray(out?.participants) ? out.participants : []
    return list.filter((p: any) => typeof p?.sid === 'string' && typeof p?.identity === 'string').map((p: any) => ({
      sid: p.sid, identity: p.identity, name: typeof p.name === 'string' ? p.name : '',
      // The room holds microphones only. An audio track's type is 0, which the JSON may leave out.
      audio: (Array.isArray(p.tracks) ? p.tracks : [])
        .filter((t: any) => typeof t?.sid === 'string' && t.type !== 'VIDEO' && t.type !== 1 && t.type !== 'DATA' && t.type !== 2)
        .map((t: any) => t.sid as string),
    }))
  }

  /** Sets the name the room shows for a participant (the others' lists follow it). */
  async updateParticipantName(room: string, identity: string, name: string): Promise<void> {
    await this.call('UpdateParticipant', room, { room, identity, name })
  }

  async updateSubscriptions(room: string, identity: string, trackSids: string[], subscribe: boolean): Promise<void> {
    await this.call('UpdateSubscriptions', room, { room, identity, track_sids: trackSids, subscribe })
  }
}

// ---------------------------------------------------------------- the routing

/** Keeps each server's latest state and makes the media server match it. */
export class VoiceHub {
  private states = new Map<string, VoiceState>()
  /** Servers with someone on the voice page lately, and how many rounds of the loop found the room empty. */
  private watched = new Map<string, number>()
  /** Per server and listener (by connection): the tracks the listener has been given. */
  private applied = new Map<string, Map<string, Set<string>>>()
  private lastFull = new Map<string, number>()
  private peopleCache = new Map<string, { at: number, list: { id: string, name: string }[] }>()
  /** The name this process last gave each participant (by connection), so a name that did not take is not sent again at every pass. */
  private named = new Map<string, Map<string, string>>()
  private nameFor: ((serverId: string, steamId: string) => string | null) | null = null
  /** The pass in progress for a server, and the one waiting behind it (a state that arrives mid-pass is acted on, not skipped). */
  private current = new Map<string, Promise<number>>()
  private queued = new Map<string, Promise<number>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private api: LiveKitApi | null, private now: () => number = Date.now, private log: (msg: string) => void = (m) => console.warn(m)) {}

  /** A message from the bridge. 'old' means it was older than one already taken (or the same), and is ignored. */
  setState(serverId: string, msg: { boot: number, seq: number, phase: Phase, alive: string[], names?: Record<string, string> }): 'ok' | 'old' {
    const last = this.states.get(serverId)
    if (last && last.boot === msg.boot && msg.seq <= last.seq) return 'old'
    this.states.set(serverId, { boot: msg.boot, seq: msg.seq, phase: msg.phase, alive: new Set(msg.alive), at: this.now(), names: new Map(Object.entries(msg.names ?? {})) })
    if (this.watched.has(serverId)) void this.reconcile(serverId)
    return 'ok'
  }

  state(serverId: string): VoiceState | null { return this.states.get(serverId) ?? null }

  /** The nick the game server last gave for a player who is connected to it, if it is still saying anything. */
  nameOf(serverId: string, steamId: string): string | null {
    const s = this.states.get(serverId)
    return s && this.now() - s.at <= STALE_MS ? s.names.get(steamId) ?? null : null
  }

  /**
   * Who is in the server's voice room now, for the page's count and names before a player has joined. Asked of the media server, at most
   * once in 3 seconds per server however many pages ask; when it cannot be asked, the last answer stands.
   */
  async people(serverId: string): Promise<{ id: string, name: string }[]> {
    if (!this.api) return []
    const now = this.now()
    const kept = this.peopleCache.get(serverId)
    if (kept && now - kept.at < 3000) return kept.list
    let list = kept?.list ?? []
    try {
      list = (await this.api.listParticipants(roomOf(serverId))).map(p => ({ id: p.identity, name: p.name }))
    } catch (err) {
      this.log(`[Voice] could not list the room of ${serverId}: ${(err as Error).message}`)
    }
    this.peopleCache.set(serverId, { at: now, list })
    return list
  }

  /** What the dashboard knows as the name of a player (the game's nick, a round's, Steam's), or null when it knows none. */
  setNameResolver(fn: ((serverId: string, steamId: string) => string | null) | null) { this.nameFor = fn }

  /** For tests, and for a server whose media server is set up while it runs. */
  setApi(api: LiveKitApi | null) { this.api = api }

  /** Someone asked to join: this server's room is looked after from now on. */
  watch(serverId: string) { this.watched.set(serverId, 0) }

  /** One pass: reads who is in the room and gives each listener exactly the tracks the rules allow. Returns the calls made. */
  reconcile(serverId: string): Promise<number> {
    if (!this.api) return Promise.resolve(0)
    const waiting = this.queued.get(serverId)
    if (waiting) return waiting
    const running = this.current.get(serverId)
    if (!running) {
      const p: Promise<number> = this.pass(serverId).finally(() => { if (this.current.get(serverId) === p) this.current.delete(serverId) })
      this.current.set(serverId, p)
      return p
    }
    const next = running.then(() => { this.queued.delete(serverId); return this.reconcile(serverId) })
    this.queued.set(serverId, next)
    return next
  }

  private async pass(serverId: string): Promise<number> {
    const api = this.api
    if (!api) return 0
    let calls = 0
    try {
      const room = roomOf(serverId)
      const parts = await api.listParticipants(room)
      const now = this.now()
      if (parts.length === 0) {
        this.applied.delete(serverId)
        const quiet = (this.watched.get(serverId) ?? 0) + 1
        if (quiet > 5) this.watched.delete(serverId); else if (this.watched.has(serverId)) this.watched.set(serverId, quiet)
        return 0
      }
      if (this.watched.has(serverId)) this.watched.set(serverId, 0)
      // Now and then everything is given again from nothing, in case a call was lost without an error.
      if (now - (this.lastFull.get(serverId) ?? 0) > 30_000) { this.applied.delete(serverId); this.lastFull.set(serverId, now) }
      // The name each participant shows in the room is the one in their token, made when they joined: a player the dashboard knew nothing about
      // then (a Steam name still on its way, a nick the game server had not sent) shows as digits to the others until this puts it right.
      if (this.nameFor) {
        const done = this.named.get(serverId) ?? new Map<string, string>()
        this.named.set(serverId, done)
        const here = new Set(parts.map(p => p.sid))
        for (const sid of [...done.keys()]) if (!here.has(sid)) done.delete(sid)
        for (const p of parts) {
          const want = this.nameFor(serverId, p.identity)?.slice(0, 64)
          if (!want || want === p.name || done.get(p.sid) === want) continue
          try { await api.updateParticipantName(room, p.identity, want); done.set(p.sid, want); calls++ } catch (err) {
            this.log(`[Voice] could not set the name of ${p.identity}: ${(err as Error).message}`)
          }
        }
      }
      const book = this.applied.get(serverId) ?? new Map<string, Set<string>>()
      this.applied.set(serverId, book)
      const present = new Set(parts.map(p => p.sid))
      for (const sid of [...book.keys()]) if (!present.has(sid)) book.delete(sid)
      const everyTrack = new Set(parts.flatMap(p => p.audio))
      const state = this.states.get(serverId) ?? null
      for (const listener of parts) {
        const want = new Set<string>()
        for (const speaker of parts) {
          if (speaker.sid !== listener.sid && canHear(state, listener.identity, speaker.identity, now)) for (const t of speaker.audio) want.add(t)
        }
        const have = book.get(listener.sid) ?? new Set<string>()
        const add = [...want].filter(t => !have.has(t))
        const drop = [...have].filter(t => !want.has(t) && everyTrack.has(t))
        try {
          if (add.length) { await api.updateSubscriptions(room, listener.identity, add, true); calls++ }
          if (drop.length) { await api.updateSubscriptions(room, listener.identity, drop, false); calls++ }
          book.set(listener.sid, want)
        } catch (err) {
          this.log(`[Voice] could not set what ${listener.identity} hears: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      this.log(`[Voice] could not read the room of ${serverId}: ${(err as Error).message}`)
    }
    return calls
  }

  /** The loop: every few seconds, every watched server. */
  start(intervalMs = 2000) {
    if (this.timer || !this.api) return
    this.timer = setInterval(() => { for (const id of [...this.watched.keys()]) void this.reconcile(id) }, intervalMs)
    this.timer.unref?.()
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
}

let current = liveKitConfig()
/** The one hub of this process. Voice is off (no api, no loop) until LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set. */
export const voiceHub = new VoiceHub(current ? new LiveKitApi(current) : null)
/** The media server's settings, or null when voice is off. */
export const voiceConfig = () => current
/** For tests: the settings in use, with the hub made to match. */
export function configureVoice(cfg: LiveKitConfig | null, fetchFn?: typeof fetch) {
  current = cfg
  voiceHub.setApi(cfg ? new LiveKitApi(cfg, fetchFn) : null)
}
