import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 27: who hears whom (the living hear the living, the dead hear everyone, outside a round everyone hears everyone), what is
// sent to the media server to make it so, and the routes. The media server is a recording fake.
import {
  STALE_MS, canHear, configureVoice, joinToken, liveKitConfig, LiveKitApi, parseVoiceState, roomOf, signJwt, VoiceHub,
  type LiveKitConfig, type Participant, type VoiceState,
} from '../src/services/voice'

const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003', D = '76561198000000004'
const ADMIN = '76561198000000000'
const CFG: LiveKitConfig = { url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'devkey', secret: 'devsecret-devsecret-devsecret-00' }

const state = (phase: 'prep' | 'active' | 'over', alive: string[], at = 1000): VoiceState => ({ boot: 1, seq: 1, phase, alive: new Set(alive), at, names: new Map() })

describe('canHear', () => {
  test('in a round the living hear the living, and the dead hear everyone', () => {
    const s = state('active', [A, B])
    expect(canHear(s, A, B, 1000)).toBe(true)
    expect(canHear(s, A, C, 1000)).toBe(false) // a living player does not hear a dead one
    expect(canHear(s, C, A, 1000)).toBe(true)  // the dead hear the living
    expect(canHear(s, C, D, 1000)).toBe(true)  // and each other
  })

  test('nobody hears themselves', () => {
    expect(canHear(state('active', [A]), A, A, 1000)).toBe(false)
    expect(canHear(null, A, A, 1000)).toBe(false)
  })

  test('before and between rounds everyone hears everyone', () => {
    for (const phase of ['prep', 'over'] as const) {
      const s = state(phase, [A])
      expect(canHear(s, A, C, 1000)).toBe(true)
      expect(canHear(s, C, A, 1000)).toBe(true)
    }
  })

  test('someone who is not in the list (a latecomer, a spectator) counts as dead', () => {
    const s = state('active', [A, B])
    expect(canHear(s, D, A, 1000)).toBe(true)
    expect(canHear(s, A, D, 1000)).toBe(false)
  })

  test('without a state, or with an old one, everyone hears everyone: a lost connection never leaves anyone muted', () => {
    expect(canHear(null, A, B, 1000)).toBe(true)
    const s = state('active', [A], 1000)
    expect(canHear(s, A, B, 1000 + STALE_MS)).toBe(false) // still fresh at the limit
    expect(canHear(s, A, B, 1000 + STALE_MS + 1)).toBe(true)
  })
})

describe('the bridge message', () => {
  const ok = { boot: 5, seq: 1, phase: 'active' as const, alive: [A, B], names: {} as Record<string, string> }
  test('is taken when whole', () => {
    expect(parseVoiceState(ok)).toEqual(ok)
    expect(parseVoiceState({ ...ok, alive: [A, A, B] })).toEqual(ok) // a repeat is one
    expect(parseVoiceState({ ...ok, alive: [] })).toMatchObject({ alive: [] })
  })
  test('is refused when anything is wrong', () => {
    for (const bad of [null, 'x', [], { ...ok, seq: -1 }, { ...ok, seq: 1.5 }, { ...ok, boot: 'a' }, { ...ok, phase: 'round' }, { ...ok, alive: 'a' },
      { ...ok, alive: ['bot'] }, { ...ok, alive: [123] }, { ...ok, alive: Array(129).fill(A) }, { seq: 1, boot: 1, phase: 'over' }]) {
      expect(typeof parseVoiceState(bad)).toBe('string')
    }
  })
  test('carries nothing else: a role or a position in it is dropped, not kept', () => {
    expect(Object.keys(parseVoiceState({ ...ok, role: 'traitor', pos: [1, 2, 3] }) as object).sort()).toEqual(['alive', 'boot', 'names', 'phase', 'seq'])
  })
  test('the nicks of everyone connected are optional, cleaned, and not a way to say who is alive', () => {
    expect((parseVoiceState({ ...ok, names: undefined }) as any).names).toEqual({}) // an old bridge sends none
    expect((parseVoiceState({ ...ok, names: [] }) as any).names).toEqual({}) // an empty Lua table arrives as an empty list
    const named = parseVoiceState({ ...ok, names: { [A]: '  Alice\u0007\n ', [B]: 'x'.repeat(100), [C]: '   ', } }) as any
    expect(named.names).toEqual({ [A]: 'Alice', [B]: 'x'.repeat(32) }) // control characters out, trimmed, at most 32, nothing left means no entry
    expect((parseVoiceState({ ...ok, names: { [A]: '😀'.repeat(40) } }) as any).names[A]).toBe('😀'.repeat(32)) // characters, not bytes
    for (const bad of [{ ...ok, names: 'Bob' }, { ...ok, names: { bot: 'Bob' } }, { ...ok, names: { [A]: 5 } }, { ...ok, names: ['Bob'] },
      { ...ok, names: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`7656119800000${String(i).padStart(4, '0')}`, 'n'])) }]) {
      expect(typeof parseVoiceState(bad)).toBe('string')
    }
  })
})

describe('the media server settings and tokens', () => {
  test('voice is on only with an address and both keys', () => {
    expect(liveKitConfig({})).toBeNull()
    expect(liveKitConfig({ LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_KEY: 'k' })).toBeNull()
    expect(liveKitConfig({ LIVEKIT_URL: 'https://lk.test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })).toBeNull() // not a websocket address
    expect(liveKitConfig({ LIVEKIT_URL: 'wss://lk.test/', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })).toEqual({ url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'k', secret: 's' })
    expect(liveKitConfig({ LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })!.apiUrl).toBe('http://localhost:7880')
    expect(liveKitConfig({ LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_URL: 'http://lk:7880', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })!.apiUrl).toBe('http://lk:7880')
  })

  const decode = (jwt: string) => {
    const [h, p, sig] = jwt.split('.')
    expect(createHmac('sha256', CFG.secret).update(`${h}.${p}`).digest("base64url")).toBe(sig!)
    return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(p!, 'base64url').toString()) }
  }

  test('a join token is signed with the secret and may publish and subscribe, nothing more', () => {
    const { header, claims } = decode(joinToken(CFG, roomOf('srv-1'), A, A, 1_700_000_000_000))
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(claims).toMatchObject({ iss: 'devkey', sub: A, name: A, video: { room: 'traitordash-srv-1', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } })
    expect(claims.exp - claims.nbf).toBeGreaterThan(3600)
    expect(claims.video.roomAdmin).toBeUndefined()
  })

  test('signJwt signs what it is given', () => {
    expect(decode(signJwt(CFG.secret, { a: 1 })).claims).toEqual({ a: 1 })
  })
})

describe('the calls to the media server', () => {
  const sent: { url: string, auth: string, body: any }[] = []
  const fake = (async (url: string, init: any) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) })
    if (url.endsWith('/ListParticipants')) return Response.json({ participants: [
      { sid: 'PA_1', identity: A, name: 'Alice', tracks: [{ sid: 'TR_a', type: 'AUDIO' }, { sid: 'TR_v', type: 'VIDEO' }] },
      { sid: 'PA_2', identity: B, tracks: [{ sid: 'TR_b' }] }, // an audio track's type 0 may be left out of the JSON
      { sid: 'PA_3', identity: C },
      { nope: true },
    ] })
    return Response.json({})
  }) as unknown as typeof fetch

  test('lists the room\'s people and their audio tracks', async () => {
    sent.length = 0
    const api = new LiveKitApi(CFG, fake, () => 1_700_000_000_000)
    const list = await api.listParticipants('traitordash-x')
    expect(list).toEqual<Participant[]>([{ sid: 'PA_1', identity: A, name: 'Alice', audio: ['TR_a'] }, { sid: 'PA_2', identity: B, name: '', audio: ['TR_b'] }, { sid: 'PA_3', identity: C, name: '', audio: [] }])
    expect(sent[0]!.url).toBe('https://lk.test/twirp/livekit.RoomService/ListParticipants')
    expect(sent[0]!.body).toEqual({ room: 'traitordash-x' })
    const claims = JSON.parse(Buffer.from(sent[0]!.auth.replace('Bearer ', '').split('.')[1]!, 'base64url').toString())
    expect(claims.video).toEqual({ roomAdmin: true, room: 'traitordash-x' })
  })

  test('sets subscriptions by listener and track', async () => {
    sent.length = 0
    await new LiveKitApi(CFG, fake).updateSubscriptions('traitordash-x', A, ['TR_b'], true)
    expect(sent[0]!.url).toBe('https://lk.test/twirp/livekit.RoomService/UpdateSubscriptions')
    expect(sent[0]!.body).toEqual({ room: 'traitordash-x', identity: A, track_sids: ['TR_b'], subscribe: true })
  })

  test('sets the name a participant shows in the room', async () => {
    sent.length = 0
    await new LiveKitApi(CFG, fake).updateParticipantName('traitordash-x', A, 'Alice')
    expect(sent[0]!.url).toBe('https://lk.test/twirp/livekit.RoomService/UpdateParticipant')
    expect(sent[0]!.body).toEqual({ room: 'traitordash-x', identity: A, name: 'Alice' })
  })

  test('an answer that is not 200 is an error', async () => {
    const bad = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch
    await expect(new LiveKitApi(CFG, bad).listParticipants('x')).rejects.toThrow('HTTP 401')
  })
})

/** A media server that remembers who is subscribed to what, as the real one does. */
class FakeRoom {
  people: Participant[] = []
  subs = new Map<string, Set<string>>() // listener identity -> tracks
  calls: string[] = []
  renames: string[] = []
  failNext = false
  failName = false
  join(identity: string, sid = `PA_${identity.slice(-2)}_${this.people.length}`) {
    this.people = this.people.filter(p => p.identity !== identity)
    this.people.push({ sid, identity, name: `n${identity.slice(-2)}`, audio: [`TR_${identity.slice(-2)}_${sid}`] })
    this.subs.set(identity, new Set()) // a new connection starts with nothing
  }
  leave(identity: string) { this.people = this.people.filter(p => p.identity !== identity); this.subs.delete(identity) }
  api = {
    listParticipants: async () => this.people.map(p => ({ ...p })),
    updateParticipantName: async (_room: string, identity: string, name: string) => {
      if (this.failName) { this.failName = false; throw new Error('down') }
      this.renames.push(`${identity.slice(-2)}=${name}`)
      const p = this.people.find(x => x.identity === identity); if (p) p.name = name
    },
    updateSubscriptions: async (_room: string, identity: string, tracks: string[], subscribe: boolean) => {
      if (this.failNext) { this.failNext = false; throw new Error('down') }
      this.calls.push(`${identity.slice(-2)}${subscribe ? '+' : '-'}${tracks.length}`)
      const set = this.subs.get(identity)!
      for (const t of tracks) subscribe ? set.add(t) : set.delete(t)
    },
  } as unknown as LiveKitApi
  /** Who `listener` hears, as the identities of the speakers. */
  hears(listener: string): string[] {
    const mine = this.subs.get(listener) ?? new Set()
    return this.people.filter(p => p.audio.some(t => mine.has(t))).map(p => p.identity).sort()
  }
}

describe('the routing', () => {
  const setup = () => {
    const room = new FakeRoom()
    let now = 10_000
    const hub = new VoiceHub(room.api, () => now, () => {})
    const msg = (seq: number, phase: 'prep' | 'active' | 'over', alive: string[], boot = 1) => hub.setState('srv', { boot, seq, phase, alive })
    for (const id of [A, B, C]) room.join(id)
    hub.watch('srv')
    return { room, hub, msg, tick: (ms: number) => { now += ms }, at: () => now }
  }

  test('with no state everyone hears everyone else', async () => {
    const { room, hub } = setup()
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([B, C]); expect(room.hears(B)).toEqual([A, C]); expect(room.hears(C)).toEqual([A, B])
  })

  test('in a round the dead are heard only by the dead', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B])
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([B]) // C is dead
    expect(room.hears(B)).toEqual([A])
    expect(room.hears(C)).toEqual([A, B]) // the dead hear the living
  })

  test('a death, a revival and a second death: after each step the groups are exactly the rules', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B, C]); await hub.reconcile('srv')
    expect([room.hears(A), room.hears(B), room.hears(C)]).toEqual([[B, C], [A, C], [A, B]])

    msg(2, 'active', [A, C]); await hub.reconcile('srv') // B dies
    expect([room.hears(A), room.hears(B), room.hears(C)]).toEqual([[C], [A, C], [A]])

    msg(3, 'active', [A, B, C]); await hub.reconcile('srv') // B is revived
    expect([room.hears(A), room.hears(B), room.hears(C)]).toEqual([[B, C], [A, C], [A, B]])

    msg(4, 'active', [A, C]); await hub.reconcile('srv') // and dies again
    expect([room.hears(A), room.hears(B), room.hears(C)]).toEqual([[C], [A, C], [A]])
  })

  test('the revival reaches the room at once when the state arrives, without waiting for the loop', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, C]); await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([C])
    msg(2, 'active', [A, B, C]) // a watched server: setState starts a pass by itself
    await new Promise(r => setTimeout(r, 20))
    expect(room.hears(A)).toEqual([B, C])
  })

  test('a lost message is made good by the next list, which is whole', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B, C]); await hub.reconcile('srv')
    // the message that said "B died" never came; the one after it says who is alive now
    msg(5, 'active', [A, C]); await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([C])
  })

  test('a message that arrives after a newer one is ignored', async () => {
    const { room, hub, msg } = setup()
    expect(msg(2, 'active', [A, C])).toBe('ok')
    expect(msg(1, 'active', [A, B, C])).toBe('old') // the older list, late
    expect(msg(2, 'active', [A, B, C])).toBe('old') // the same number again
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([C])
  })

  test('a server that restarted (another boot) starts again from 1', async () => {
    const { hub, msg } = setup()
    expect(msg(40, 'active', [A, B, C])).toBe('ok')
    expect(msg(1, 'over', [], 2)).toBe('ok')
    expect(hub.state('srv')!.phase).toBe('over')
  })

  test('repeating the same list changes nothing and makes no call', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B]); await hub.reconcile('srv')
    const calls = room.calls.length
    msg(2, 'active', [A, B]); await hub.reconcile('srv')
    msg(3, 'active', [A, B]); await hub.reconcile('srv')
    expect(room.calls.length).toBe(calls)
  })

  test('between rounds, and when the state goes quiet, everyone hears everyone again', async () => {
    const { room, hub, msg, tick } = setup()
    msg(1, 'active', [A]); await hub.reconcile('srv')
    expect(room.hears(B)).toEqual([A, C])
    expect(room.hears(A)).toEqual([])
    msg(2, 'over', [A, B, C]); await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([B, C])
    msg(3, 'active', [A]); await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([])
    tick(STALE_MS + 1) // a map change: nothing from the game for a while
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([B, C])
  })

  test('a player who joins later gets what the rules give, a player who reconnects gets it again', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B]); await hub.reconcile('srv')
    room.join(D) // not in the list: counts as dead
    await hub.reconcile('srv')
    expect(room.hears(D)).toEqual([A, B, C])
    expect(room.hears(A)).toEqual([B]) // D is dead, so A does not hear D
    room.join(A) // A's browser reconnected: a new connection, nothing subscribed
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([B])
    expect(room.hears(B)).toEqual([A]) // and B hears A's new microphone
  })

  test('a call that fails is tried again by the next pass, and does not stop the others', async () => {
    const { room, hub, msg } = setup()
    msg(1, 'active', [A, B, C])
    room.failNext = true
    await hub.reconcile('srv')
    await hub.reconcile('srv')
    expect([room.hears(A), room.hears(B), room.hears(C)]).toEqual([[B, C], [A, C], [A, B]])
  })

  test('without a media server nothing happens and nothing throws', async () => {
    const hub = new VoiceHub(null)
    hub.setState('srv', { boot: 1, seq: 1, phase: 'active', alive: [A] })
    expect(await hub.reconcile('srv')).toBe(0)
  })

  test('a room that stays empty is given up on, and a state for a server nobody joined is just kept', async () => {
    const { room, hub, msg } = setup()
    for (const id of [A, B, C]) room.leave(id)
    msg(1, 'active', [A])
    for (let i = 0; i < 8; i++) await hub.reconcile('srv')
    room.join(A)
    // not watched any more: setState does not start a pass; watch() does, when someone asks to join again
    hub.watch('srv')
    await hub.reconcile('srv')
    expect(room.hears(A)).toEqual([])
  })
})

describe('the page\'s code', () => {
  test('starts only after everything it uses at once is defined (it crashed with "store is undefined" when it did not)', async () => {
    const src = await Bun.file(new URL('../src/voice.ts', import.meta.url)).text()
    const call = src.indexOf('if (root) start(root)')
    expect(call).toBeGreaterThan(-1)
    for (const top of src.matchAll(/^const (\w+) =/gm)) {
      if (top[1] === 'root') continue
      expect(src.indexOf(top[0]), top[1]).toBeLessThan(call)
    }
    expect(src.lastIndexOf('function start(')).toBeLessThan(call)
  })

  // The page's code is bundled the way the build bundles it and run against a stand-in page. livekit-client and the noise filter (both need
  // a real browser) are replaced by small fakes. The fake microphone behaves as LiveKit's does: mute() switches the track off, and a copy
  // made then is off too.
  const LIVEKIT_FAKE = `
    export const RoomEvent = { TrackSubscribed: 'ts', TrackUnsubscribed: 'tu', ParticipantConnected: 'pc', ParticipantDisconnected: 'pd', ParticipantNameChanged: 'pnc', Reconnecting: 'rc', Reconnected: 'rd', Disconnected: 'dc' }
    export class Room {
      constructor() { globalThis.__room = this; globalThis.__handlers = {}; this.remoteParticipants = new Map(); this.localParticipant = { publishTrack: async (t, o) => { globalThis.__log.push('published ' + (t === globalThis.__mic ? 'raw' : 'filtered') + ' dtx=' + o.dtx) } } }
      on(ev, fn) { globalThis.__handlers[ev] = fn } async connect(url, token, opts) { globalThis.__log.push('connect autoSubscribe=' + opts.autoSubscribe) } async startAudio() {} async disconnect() {}
    }
    export class LocalAudioTrack {
      constructor(t) { this.mediaStreamTrack = t }
      async mute() { this.mediaStreamTrack.enabled = false; globalThis.__log.push('mute') }
      async unmute() { this.mediaStreamTrack.enabled = true; globalThis.__log.push('unmute') }
      stop() {}
    }
    export const createLocalAudioTrack = async () => globalThis.__mic
  `
  const RNNOISE_FAKE = `
    export const loadRnnoise = async (urls) => { globalThis.__log.push('load ' + urls.url + ' ' + urls.simdUrl); if (globalThis.__rnnoiseFails) throw new Error('no wasm'); return new ArrayBuffer(1) }
    export class RnnoiseWorkletNode { constructor(ctx, o) { globalThis.__log.push('rnnoise maxChannels=' + o.maxChannels); this.connect = () => {} } }
  `
  async function load() {
    const built = await Bun.build({
      entrypoints: [new URL('../src/voice.ts', import.meta.url).pathname], format: 'iife',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /^livekit-client$/ }, () => ({ path: 'livekit-client', namespace: 'stub' }))
        b.onResolve({ filter: /^@sapphi-red\/web-noise-suppressor$/ }, () => ({ path: 'rnnoise', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path === 'rnnoise' ? RNNOISE_FAKE : LIVEKIT_FAKE }))
      } }],
    })
    expect(built.success).toBe(true)
    const code = await built.outputs[0]!.text()

    const listeners: Record<string, Record<string, Function>> = {}
    const attrs: Record<string, Record<string, string>> = {}
    const el = (name: string, extra: Record<string, unknown> = {}) => {
      listeners[name] = {}; attrs[name] = {}
      return { style: {} as Record<string, string>, dataset: {} as Record<string, string>, classList: { toggle() {}, remove() {} }, textContent: '', value: '12', disabled: false,
        appendChild() {}, addEventListener(t: string, fn: Function) { listeners[name]![t] = fn },
        setAttribute(k: string, v: string) { attrs[name]![k] = v }, getAttribute: (k: string) => attrs[name]![k] ?? null, ...extra }
    }
    const node = () => {
      const n: any = { style: {}, children: [] as any[], attrs: {} as Record<string, string>, listeners: {} as Record<string, Function>, className: '', value: '', _text: '',
        appendChild(c: any) { n.children.push(c) }, addEventListener(t: string, f: Function) { n.listeners[t] = f },
        setAttribute(k: string, v: string) { n.attrs[k] = v }, getAttribute: (k: string) => n.attrs[k] ?? null, remove() {} }
      Object.defineProperty(n, 'textContent', { get: () => n._text, set: (v: string) => { n._text = v; if (v === '') n.children = [] } })
      return n
    }
    const parts: Record<string, any> = {}
    parts['[data-people]'] = node()
    parts['[data-who]'] = node()
    for (const sel of ['[data-join]', '[data-status]', '[data-level]', '[data-marker]', '[data-marker-close]', '[data-speaking]', '[data-db]', '[data-threshold-out]', '[data-close-out]', '[data-measure]', '[data-measure-note]', '[data-gate-note]', '[data-count]', '[data-audio]', '[data-vad-box]', '[data-ptt-box]', '[data-ptt-key]', '[data-monitor]', '[data-filter-note]']) parts[sel] = el(sel)
    parts['[data-threshold]'] = el('[data-threshold]', { value: '-50' })
    parts['[data-close-threshold]'] = el('[data-close-threshold]', { value: '-56' })
    parts['[data-auto]'] = el('[data-auto]'); attrs['[data-auto]']!['aria-pressed'] = 'false'
    const modes = [el('vad', { dataset: { mode: 'vad' } }), el('ptt', { dataset: { mode: 'ptt' }, disabled: true })]
    const filters = [el('on', { dataset: { filter: 'on' } }), el('off', { dataset: { filter: 'off' } })]
    attrs['on']!['aria-pressed'] = 'true'; attrs['off']!['aria-pressed'] = 'false'
    const root = { dataset: { token: '/servers/x/voice/token', peopleUrl: '/servers/x/voice/people' }, querySelector: (s: string) => parts[s],
      querySelectorAll: (s: string) => (s.includes('data-filter') ? filters : modes) }
    const timers: Function[] = []
    const timeouts: { fn: Function, ms: number }[] = []
    const win = { addEventListener() {}, setInterval: (fn: Function) => { timers.push(fn); return timers.length }, clearInterval() {},
      setTimeout: (fn: Function, ms: number) => { timeouts.push({ fn, ms }); return timeouts.length }, clearTimeout() {} }
    const store = new Map<string, string>([['td_voice_mode', 'ptt'], ['td_voice_threshold', '30']]) // a saved choice of the disabled mode, and the old linear threshold (dropped by RFC 29)
    const local = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
    const run = (extra: Record<string, unknown> = {}) => {
      const names = ['document', 'window', 'localStorage', ...Object.keys(extra)]
      return new Function(...names, code)({ querySelector: () => root, createElement: () => node() }, win, local, ...Object.values(extra))
    }
    return { run, parts, modes, filters, listeners, attrs, timers, timeouts, local, store, node }
  }

  test('runs as the browser runs it: bundled, against a page with its parts, it starts without an error and wires the buttons', async () => {
    const page = await load()
    expect(() => page.run()).not.toThrow()
    expect(page.listeners['[data-join]']!.click).toBeInstanceOf(Function)
    expect(page.listeners['[data-threshold]']!.input).toBeInstanceOf(Function)
    expect(page.listeners['[data-close-threshold]']!.input).toBeInstanceOf(Function)
    // the lines are placed on the dBFS meter (-80 to 0): the defaults -50 and -56, the old saved linear 30 is not carried over
    expect(page.parts['[data-marker]'].style.left).toBe('37.5%')
    expect(page.parts['[data-marker-close]'].style.left).toBe('30%')
    expect(page.parts['[data-threshold-out]'].textContent).toBe('-50 dBFS')
    expect(page.parts['[data-measure-note]'].textContent).toContain('Not measured yet') // a player without a new setting is offered the measurement
    expect(page.attrs['[data-auto]']!['aria-pressed']).toBe('false') // adjusting by itself is off by default
    // the disabled mode is not taken from a saved choice: nothing was switched to it
    page.listeners['vad']!.click!()
    expect([page.modes[0]!.getAttribute('aria-pressed'), page.modes[1]!.getAttribute('aria-pressed')]).toEqual(['true', 'false'])
  })

  /** Everything a join needs: the fake microphone, audio context, fetch; returns what the test looks at. */
  function setup(opts: { rnnoiseFails?: boolean, gateFails?: boolean, chainFails?: boolean } = {}) {
    const log: string[] = []
    const g = globalThis as any
    g.__log = log; g.__rnnoiseFails = !!opts.rnnoiseFails
    const track = (enabled: boolean) => ({ enabled, copy: null as any, stopped: false, stop() { this.stopped = true },
      clone() { const c = track(this.enabled); this.copy = c; return c } })
    const rawTrack = track(true)
    g.__mic = { mediaStreamTrack: rawTrack, async mute() { rawTrack.enabled = false; log.push('mute') }, async unmute() { rawTrack.enabled = true; log.push('unmute') }, stop() { log.push('raw stopped') } }
    const outTrack = track(true) // the filtered output: what is sent
    const gains: { gain: { value: number } }[] = []
    const gate = { contexts: 0, rate: 0 }
    let sourceTracks: any[] = []
    const sound = { v: 0.1 } // what the fake microphone's copy gives the analyser (0.1 is -20 dBFS)
    const gateNodes: any[] = [] // the gate's worklet node, as the page made it
    class FakeGateNode {
      sent: any[] = []
      port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (m: unknown) => { this.sent.push(m) } }
      constructor(public ctx: unknown, public name: string, public options: any) { gateNodes.push(this) }
      connect() {}
    }
    class FakeContext {
      destination = {}
      audioWorklet = { addModule: async (u: string) => { log.push('worklet ' + u); if (opts.gateFails && u === '/public/gate.js') throw new Error('no such file') } }
      constructor(o: { sampleRate: number }) { gate.contexts++; gate.rate = o.sampleRate }
      async resume() { log.push('resume') } async close() {}
      createGain() { const n = { gain: { value: 1 }, connect() {} }; gains.push(n); return n }
      createMediaStreamDestination() { if (opts.chainFails) throw new Error('no destination'); return { stream: { getAudioTracks: () => [outTrack] } } }
      createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(sourceTracks.length && sourceTracks.every(t => t.enabled) ? sound.v : 0) } }
      createMediaStreamSource(stream: any) { sourceTracks = stream.tracks; return { connect() {} } }
    }
    class FakeStream { constructor(public tracks: any[]) {} }
    const state = { people: [] as { id: string, name: string }[] }
    const fetchFake = async (url: string) => (url.includes('/people')
      ? { ok: true, json: async () => ({ people: state.people }) }
      : { ok: true, json: async () => ({ url: 'wss://lk.test', token: 'tok' }) })
    return { log, g, rawTrack, outTrack, gains, gate, gateNodes, sound, state, globals: { AudioContext: FakeContext, MediaStream: FakeStream, AudioWorkletNode: FakeGateNode, fetch: fetchFake }, done() { delete g.__log; delete g.__mic; delete g.__rnnoiseFails; delete g.__room; delete g.__handlers } }
  }

  /** A join, done: the page with the fake browser and the join finished. */
  async function joined(opts: Parameters<typeof setup>[0] = {}) {
    const page = await load()
    const t = setup(opts)
    page.run(t.globals)
    page.listeners['[data-join]']!.click!()
    await new Promise(r => setTimeout(r, 30))
    const post = (level: number, open = false, at = 0) => t.gateNodes[0].port.onmessage({ data: { t: at, level, open } })
    return { page, t, post }
  }

  test('a join: the context is made in the click at 48 kHz, the microphone goes through the filter and the gate, the track is published ON and never muted, and the meter follows what the gate posts', async () => {
    const page = await load()
    const t = setup()
    page.run(t.globals)
    page.listeners['[data-join]']!.click!()
    expect(t.gate).toEqual({ contexts: 1, rate: 48000 }) // made synchronously in the click, before any await: a context made later starts suspended
    await new Promise(r => setTimeout(r, 30))
    expect(t.log).toContain('connect autoSubscribe=false') // the dashboard decides who is heard, not the page
    expect(t.log).toContain('load /public/rnnoise/rnnoise.wasm /public/rnnoise/rnnoise_simd.wasm')
    expect(t.log).toContain('worklet /public/rnnoise/worklet.js')
    expect(t.log).toContain('worklet /public/gate.js')
    expect(t.log.indexOf('worklet /public/rnnoise/worklet.js')).toBeLessThan(t.log.indexOf('worklet /public/gate.js')) // the gate comes after the filter
    expect(t.log).toContain('published filtered dtx=true') // what is sent is the chain's output, not the raw microphone; silence suppression asked for
    expect(page.parts['[data-status]'].textContent).toBe('Connected.')
    expect(page.parts['[data-filter-note]'].textContent).toBe('')
    expect(page.parts['[data-gate-note]'].textContent).toBe('')
    expect(t.gateNodes).toHaveLength(1)
    expect(t.gateNodes[0].name).toBe('td-gate')
    expect(t.gateNodes[0].options.processorOptions).toEqual({ open: -50, close: -56 }) // the worklet starts with the page's thresholds
    // the gain does the opening: the published track is never switched off, nothing is muted, and no second copy is listened to
    expect(t.outTrack.enabled).toBe(true)
    expect(t.outTrack.copy).toBeNull()
    expect(t.log).not.toContain('mute'); expect(t.log).not.toContain('unmute')
    expect(page.timers).toHaveLength(0) // no 50 ms timer of the page: the worklet posts the levels

    // the worklet says: -30 dBFS, gate open
    t.gateNodes[0].port.onmessage({ data: { t: 0.05, level: -30, open: true } })
    expect(page.parts['[data-level]'].style.width).toBe('62.5%') // -30 on a -80 to 0 scale
    expect(page.parts['[data-speaking]'].textContent).toBe('talking') // the mark is the gate's state
    expect(page.parts['[data-db]'].textContent).toBe('-30 dBFS')
    t.gateNodes[0].port.onmessage({ data: { t: 0.1, level: -70, open: false } })
    expect(page.parts['[data-speaking]'].textContent).toBe('')
    expect(page.parts['[data-level]'].style.width).toBe('12.5%')
    expect(t.log).not.toContain('mute'); expect(t.log).not.toContain('unmute') // still never
    t.done()
  })

  test('the sensitivity slider sets the open threshold and the close one follows at the same distance; the advanced slider changes the distance; all is sent to the gate and remembered', async () => {
    const { page, t } = await joined()
    const node = t.gateNodes[0]
    const sens = page.parts['[data-threshold]'], close = page.parts['[data-close-threshold]']
    sens.value = '-45'; page.listeners['[data-threshold]']!.input!()
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -45, close: -51 })
    expect(page.parts['[data-marker]'].style.left).toBe('43.75%'); expect(page.parts['[data-marker-close]'].style.left).toBe('36.25%')
    expect(close.value).toBe('-51'); expect(page.parts['[data-close-out]'].textContent).toBe('-51 dBFS')
    expect(page.store.get('td_voice_gate_open')).toBe('-45'); expect(page.store.get('td_voice_gate_close')).toBe('-51')
    close.value = '-60'; page.listeners['[data-close-threshold]']!.input!()
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -45, close: -60 })
    sens.value = '-40'; page.listeners['[data-threshold]']!.input!() // the distance (15 dB) is kept
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -40, close: -55 })
    close.value = '-30'; page.listeners['[data-close-threshold]']!.input!() // never above the open one
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -40, close: -40 })
    t.done()
  })

  test('the saved thresholds are read at the start (the old linear one is not), and a page with none offers the measurement', async () => {
    const page = await load()
    page.store.set('td_voice_gate_open', '-42'); page.store.set('td_voice_gate_close', '-50')
    page.run()
    expect(page.parts['[data-marker]'].style.left).toBe('47.5%'); expect(page.parts['[data-marker-close]'].style.left).toBe('37.5%')
    expect(page.parts['[data-threshold]'].value).toBe('-42'); expect(page.parts['[data-close-threshold]'].value).toBe('-50')
    expect(page.parts['[data-measure-note]'].textContent).toBe('')
    // nonsense in the store falls back to the defaults
    const other = await load()
    other.store.set('td_voice_gate_open', '12'); other.store.set('td_voice_gate_close', 'abc') // 12 is above the range (a leftover of the old scale)
    other.run()
    expect(other.parts['[data-marker]'].style.left).toBe('37.5%')
    expect(other.parts['[data-measure-note]'].textContent).toContain('Not measured yet')
    // the saved automatic switch
    const auto = await load()
    auto.store.set('td_voice_gate_auto', '1')
    auto.run()
    expect(auto.attrs['[data-auto]']!['aria-pressed']).toBe('true')
    expect(auto.parts['[data-threshold]'].disabled).toBe(true); expect(auto.parts['[data-close-threshold]'].disabled).toBe(true)
  })

  test('"Measure my room": 3 seconds of the posted levels, then the thresholds are set from them and the page says what it set', async () => {
    const { page, t, post } = await joined()
    page.listeners['[data-measure]']!.click!()
    expect(page.parts['[data-measure-note]'].textContent).toContain('3 seconds')
    expect(page.parts['[data-measure]'].disabled).toBe(true)
    const wait = page.timeouts.filter(x => x.ms === 3000).at(-1)!
    for (let i = 0; i < 60; i++) post(i % 4 === 0 ? -66 : -65, false, i * 0.05) // a quiet room, around -65
    wait.fn()
    expect(page.parts['[data-measure]'].disabled).toBe(false)
    expect(t.gateNodes[0].sent.at(-1)).toEqual({ type: 'set', open: -55, close: -59 })
    expect(page.store.get('td_voice_gate_open')).toBe('-55'); expect(page.store.get('td_voice_gate_close')).toBe('-59')
    expect(page.parts['[data-measure-note]'].textContent).toBe('Your room is at -65 dBFS. The microphone opens at -55 dBFS and closes at -59 dBFS.')
    expect(page.parts['[data-marker]'].style.left).toBe('31.25%')
    t.done()
  })

  test('"Measure my room" asks to try again when the levels vary, and changes nothing; before joining it says to join first', async () => {
    const early = await load()
    early.run(setup().globals)
    early.listeners['[data-measure]']!.click!()
    expect(early.parts['[data-measure-note]'].textContent).toContain('Join the voice chat first')

    const { page, t, post } = await joined()
    page.listeners['[data-measure]']!.click!()
    const wait = page.timeouts.filter(x => x.ms === 3000).at(-1)!
    for (let i = 0; i < 60; i++) post(i % 6 < 3 ? -60 : -30, false, i * 0.05) // somebody talks
    wait.fn()
    expect(page.parts['[data-measure-note]'].textContent).toContain('try again')
    expect(t.gateNodes[0].sent.filter((m: any) => m.type === 'set')).toHaveLength(1) // only the one at the start
    expect(page.store.get('td_voice_gate_open')).toBeUndefined()
    // too little heard
    page.listeners['[data-measure]']!.click!()
    const wait2 = page.timeouts.filter(x => x.ms === 3000).at(-1)!
    post(-60); wait2.fn()
    expect(page.parts['[data-measure-note]'].textContent).toContain('Not enough')
    t.done()
  })

  test('a measurement that was begun before leaving does not end a later one, and does not write to the page after leaving', async () => {
    const { page, t, post } = await joined()
    page.listeners['[data-measure]']!.click!()
    const stale = page.timeouts.filter(x => x.ms === 3000).at(-1)! // the first measurement's 3 second timer
    page.listeners['[data-join]']!.click!() // leave
    await new Promise(r => setTimeout(r, 30))
    // the stale timer fires after the player left: it must leave the page as it is
    const noteAfterLeave = page.parts['[data-measure-note]'].textContent
    stale.fn()
    expect(page.parts['[data-measure-note]'].textContent).toBe(noteAfterLeave)
    // join again and measure again; the first timer then fires in the middle of the second measurement
    page.listeners['[data-join]']!.click!()
    await new Promise(r => setTimeout(r, 30))
    page.listeners['[data-measure]']!.click!()
    expect(page.parts['[data-measure]'].disabled).toBe(true)
    for (let i = 0; i < 25; i++) t.gateNodes[1].port.onmessage({ data: { t: i * 0.05, level: -65, open: false } })
    stale.fn()
    expect(page.parts['[data-measure]'].disabled).toBe(true) // still measuring
    expect(page.parts['[data-measure-note]'].textContent).toContain('3 seconds')
    t.done()
  })

  test('"Adjust by itself": off by default; on, it follows the room\'s floor while the gate is closed, never while it is open, never saves what it adjusts, and off gives back the player\'s own setting', async () => {
    const { page, t, post } = await joined()
    const node = t.gateNodes[0]
    for (let i = 0; i < 100; i++) post(-62, false, i * 0.05)
    expect(node.sent.filter((m: any) => m.type === 'set')).toHaveLength(1) // off: nothing moves
    page.listeners['[data-auto]']!.click!()
    expect(page.attrs['[data-auto]']!['aria-pressed']).toBe('true'); expect(page.store.get('td_voice_gate_auto')).toBe('1')
    expect(page.parts['[data-threshold]'].disabled).toBe(true); expect(page.parts['[data-close-threshold]'].disabled).toBe(true)
    for (let i = 0; i < 40; i++) post(-62, false, 10 + i * 0.05)
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -52, close: -56 }) // floor -62: open +10, close +6
    expect(page.store.get('td_voice_gate_open')).toBeUndefined() // what it adjusts is never saved
    // speech: the gate is open, nothing is followed
    const sets = node.sent.length
    for (let i = 0; i < 400; i++) post(-20, true, 12 + i * 0.05)
    expect(node.sent.length).toBe(sets)
    page.listeners['[data-auto]']!.click!()
    expect(page.attrs['[data-auto]']!['aria-pressed']).toBe('false'); expect(page.store.get('td_voice_gate_auto')).toBe('0')
    expect(page.parts['[data-threshold]'].disabled).toBe(false)
    expect(page.parts['[data-threshold]'].value).toBe('-50') // the player's own setting (here the starting one) is back
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -50, close: -56 })
    const afterOff = node.sent.length
    for (let i = 0; i < 100; i++) post(-40, false, 40 + i * 0.05)
    expect(node.sent.length).toBe(afterOff) // off again: it does not move
    t.done()
  })

  test('"Adjust by itself" never overwrites what the player saved, and switching it off puts it back', async () => {
    const { page, t, post } = await joined()
    const node = t.gateNodes[0]
    page.parts['[data-threshold]'].value = '-45'; page.listeners['[data-threshold]']!.input!() // the player's own setting
    expect(page.store.get('td_voice_gate_open')).toBe('-45'); expect(page.store.get('td_voice_gate_close')).toBe('-51')
    page.listeners['[data-auto]']!.click!()
    for (let i = 0; i < 40; i++) post(-62, false, 10 + i * 0.05)
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -52, close: -56 }) // it adjusts...
    expect(page.store.get('td_voice_gate_open')).toBe('-45'); expect(page.store.get('td_voice_gate_close')).toBe('-51') // ...but the saved setting is the player's
    page.listeners['[data-auto]']!.click!()
    expect(node.sent.at(-1)).toEqual({ type: 'set', open: -45, close: -51 })
    expect(page.parts['[data-threshold]'].value).toBe('-45')
    t.done()
  })

  test('the filter switch and "Hear myself" change the gains at once, and "Hear myself" starts off', async () => {
    const page = await load()
    const t = setup()
    page.run(t.globals)
    page.listeners['[data-join]']!.click!()
    await new Promise(r => setTimeout(r, 30))
    const [dry, wet, monitor] = t.gains.map(n => n.gain)
    expect([dry!.value, wet!.value, monitor!.value]).toEqual([0, 1, 0]) // filter on, monitor off
    page.listeners['off']!.click!()
    expect([dry!.value, wet!.value]).toEqual([1, 0])
    expect(page.store.get('td_voice_filter')).toBe('off') // remembered
    page.listeners['on']!.click!()
    expect([dry!.value, wet!.value]).toEqual([0, 1])
    page.listeners['[data-monitor]']!.click!()
    expect(monitor!.value).toBe(1)
    expect(page.attrs['[data-monitor]']!['aria-pressed']).toBe('true')
    page.listeners['[data-monitor]']!.click!()
    expect(monitor!.value).toBe(0)
    t.done()
  })

  test('people: everyone on the voice chat is listed with a volume and a mute that act on their audio, are remembered by SteamID64, and apply when their track comes', async () => {
    const page = await load()
    const t = setup()
    const BOB = '76561198000000002', CARA = '76561198000000003'
    page.store.set('td_voice_vol_' + CARA, '25') // chosen on an earlier visit
    page.run(t.globals)
    page.listeners['[data-join]']!.click!()
    await new Promise(r => setTimeout(r, 30))
    const g = globalThis as any
    g.__room.remoteParticipants.set(BOB, { identity: BOB, name: 'Bob' })
    g.__room.remoteParticipants.set(CARA, { identity: CARA, name: '' })
    g.__handlers.pc() // a participant connected
    const rows = page.parts['[data-people]'].children
    expect(rows).toHaveLength(2)
    const [name, slider, pct, mute] = rows[0].children
    expect(name.textContent).toBe('Bob') // by name when the token had one
    expect(rows[1].children[0].textContent).toBe(CARA) // else by SteamID64
    expect(slider.value).toBe('100'); expect(rows[1].children[1].value).toBe('25') // the default, and what was remembered
    expect(page.parts['[data-count]'].textContent).toBe('3')

    // the dashboard puts a name right after the player joined (RFC 28): the list follows at once
    g.__room.remoteParticipants.get(BOB).name = 'Robert'
    g.__handlers.pnc()
    expect(page.parts['[data-people]'].children[0].children[0].textContent).toBe('Robert')

    // the track of Bob arrives: his volume is applied to the audio element, and moves with the slider
    const audio = { volume: 1, remove() {} }
    const trackOf = (el: any) => ({ attach: () => el, detach: () => [el] })
    g.__handlers.ts(trackOf(audio), {}, { identity: BOB })
    expect(audio.volume).toBe(1)
    slider.value = '40'; slider.listeners.input()
    expect(audio.volume).toBeCloseTo(0.4); expect(pct.textContent).toBe('40%')
    expect(page.store.get('td_voice_vol_' + BOB)).toBe('40')
    mute.listeners.click()
    expect(audio.volume).toBe(0); expect(mute.attrs['aria-pressed']).toBe('true')
    mute.listeners.click()
    expect(audio.volume).toBeCloseTo(0.4)

    // Cara's track arrives later (the game lets her be heard): her remembered volume is on it at once
    const caraAudio = { volume: 1, remove() {} }
    g.__handlers.ts(trackOf(caraAudio), {}, { identity: CARA })
    expect(caraAudio.volume).toBeCloseTo(0.25)
    // and when the track goes the setting stays: the next one gets it again
    g.__handlers.tu(trackOf(caraAudio), {}, { identity: CARA })
    const again = { volume: 1, remove() {} }
    g.__handlers.ts(trackOf(again), {}, { identity: CARA })
    expect(again.volume).toBeCloseTo(0.25)

    // someone leaves: the list is made again without them
    g.__room.remoteParticipants.delete(BOB)
    g.__handlers.pd()
    expect(page.parts['[data-people]'].children).toHaveLength(1)
    t.done()
  })

  test('before joining, the page asks who is on every 5 seconds and shows the count and the names; it stops when the player joins and starts again when they leave', async () => {
    const page = await load()
    const t = setup()
    const BOB = '76561198000000002', CARA = '76561198000000003'
    t.state.people = [{ id: BOB, name: 'Bob' }, { id: CARA, name: 'Cara' }]
    page.run(t.globals) // the first look is made at once
    await new Promise(r => setTimeout(r, 10))
    expect(page.parts['[data-count]'].textContent).toBe('2') // not 0: somebody else is on, though this player is not
    expect(page.parts['[data-who]'].textContent).toBe('On now: Bob, Cara')
    expect(page.timeouts.at(-1)!.ms).toBe(5000)

    t.state.people = [{ id: CARA, name: 'Cara' }]
    await page.timeouts.at(-1)!.fn()
    expect(page.parts['[data-count]'].textContent).toBe('1')
    t.state.people = []
    await page.timeouts.at(-1)!.fn()
    expect(page.parts['[data-count]'].textContent).toBe('0')
    expect(page.parts['[data-who]'].textContent).toBe('Nobody is on the voice chat.')

    page.listeners['[data-join]']!.click!() // joining: the room itself tells who is on
    await new Promise(r => setTimeout(r, 30))
    expect(page.parts['[data-who]'].textContent).toBe('')
    expect(page.parts['[data-count]'].textContent).toBe('1') // this player alone
    const looks = page.timeouts.length
    t.state.people = [{ id: BOB, name: 'Bob' }]
    await page.timeouts.at(-1)!.fn() // a late look does nothing once joined
    expect(page.timeouts.length).toBe(looks)
    expect(page.parts['[data-count]'].textContent).toBe('1')

    page.listeners['[data-join]']!.click!() // leaving: it looks again
    await new Promise(r => setTimeout(r, 30))
    expect(page.timeouts.length).toBeGreaterThan(looks)
    expect(page.parts['[data-count]'].textContent).toBe('1')
    expect(page.parts['[data-who]'].textContent).toBe('On now: Bob')
    t.done()
  })

  test('when the filter cannot start the gate still works, the microphone is sent without the filter, and the page says so', async () => {
    const page = await load()
    const t = setup({ rnnoiseFails: true })
    const warn = console.warn; console.warn = () => {}
    try {
      page.run(t.globals)
      page.listeners['[data-join]']!.click!()
      await new Promise(r => setTimeout(r, 30))
    } finally { console.warn = warn }
    expect(t.log).toContain('published filtered dtx=true') // the chain's output (the gate), not the raw microphone
    expect(page.parts['[data-status]'].textContent).toBe('Connected.')
    expect(page.parts['[data-filter-note]'].textContent).toContain('could not start')
    expect(page.filters.every(f => f.disabled)).toBe(true)
    expect(t.gateNodes).toHaveLength(1)
    // switching the filter on does not leave the sound without a way: the dry path stays open
    page.listeners['on']!.click!()
    expect([t.gains[0]!.gain.value, t.gains[1]!.gain.value]).toEqual([1, 0])
    t.gateNodes[0].port.onmessage({ data: { t: 0.1, level: -30, open: true } })
    expect(page.parts['[data-speaking]'].textContent).toBe('talking')
    expect(t.log).not.toContain('mute')
    t.done()
  })

  test('when the gate cannot start the join still works: the page says so and does the opening itself with the mute, as before, on a copy of the sound', async () => {
    const page = await load()
    const t = setup({ gateFails: true })
    const warn = console.warn; console.warn = () => {}
    try {
      page.run(t.globals)
      page.listeners['[data-join]']!.click!()
      await new Promise(r => setTimeout(r, 30))
    } finally { console.warn = warn }
    expect(page.parts['[data-status]'].textContent).toBe('Connected.')
    expect(page.parts['[data-gate-note]'].textContent).toContain('gate could not start')
    expect(t.gateNodes).toHaveLength(0)
    expect(t.log).toContain('published filtered dtx=true') // the filter's output goes on
    expect(t.outTrack.enabled).toBe(false) // closed until the player speaks
    expect(t.outTrack.copy.enabled).toBe(true) // but what is listened to is on
    page.timers[0]!() // one look: the fake microphone is at 0.1 (-20 dBFS), above the threshold of -50
    expect(parseFloat(page.parts['[data-level]'].style.width)).toBeCloseTo(75, 3)
    expect(page.parts['[data-speaking]'].textContent).toBe('talking')
    expect(t.log.at(-1)).toBe('unmute')
    expect(t.outTrack.enabled).toBe(true)
    // the sound stops: the microphone stays open for the 250 ms hold (4 looks of 50 ms), then closes
    t.sound.v = 0
    for (let i = 0; i < 4; i++) page.timers[0]!()
    expect(t.log.at(-1)).toBe('unmute')
    page.timers[0]!()
    expect(t.log.at(-1)).toBe('mute')
    expect(page.parts['[data-speaking]'].textContent).toBe('')
    t.done()
  })

  test('when the whole chain cannot be built the microphone is sent as it is, the join still works, and the page does the opening', async () => {
    const page = await load()
    const t = setup({ chainFails: true })
    const warn = console.warn; console.warn = () => {}
    try {
      page.run(t.globals)
      page.listeners['[data-join]']!.click!()
      await new Promise(r => setTimeout(r, 30))
    } finally { console.warn = warn }
    expect(t.log).toContain('published raw dtx=true')
    expect(page.parts['[data-status]'].textContent).toBe('Connected.')
    expect(page.parts['[data-filter-note]'].textContent).toContain('could not start')
    expect(page.parts['[data-gate-note]'].textContent).toContain('gate could not start')
    expect(page.filters.every(f => f.disabled)).toBe(true)
    page.timers[0]!()
    expect(parseFloat(page.parts['[data-level]'].style.width)).toBeCloseTo(75, 3) // the meter and the detection still work, on a copy of the raw microphone
    expect(t.log.at(-1)).toBe('unmute')
    t.done()
  })
})

describe('the noise filter files', () => {
  test('the build copies the worklet and the two WebAssembly files to where the page asks for them, and they exist', async () => {
    const root = new URL('..', import.meta.url).pathname
    const pkg = JSON.parse(await Bun.file(root + 'package.json').text())
    const copy: string = pkg.scripts['copy:rnnoise']
    expect(pkg.scripts['build:js']).toContain('bun run copy:rnnoise')
    const src = await Bun.file(root + 'src/voice.ts').text()
    for (const [from, to] of [['dist/rnnoise/workletProcessor.js', 'worklet.js'], ['dist/rnnoise.wasm', 'rnnoise.wasm'], ['dist/rnnoise_simd.wasm', 'rnnoise_simd.wasm']] as const) {
      expect(copy).toContain(from)
      expect(src).toContain(`/public/rnnoise/${to}`) // the address the page loads is the name the build gives
      expect(await Bun.file(root + 'node_modules/@sapphi-red/web-noise-suppressor/' + from).exists()).toBe(true)
    }
    expect(copy).toContain('LICENSE') // MIT, and the licence of RNNoise is in the package's: it goes along
    expect(await Bun.file(root + '.gitignore').text()).toContain('src/public/rnnoise/')
  })

  test('the build makes the gate worklet (/public/gate.js) from its source, as one file, and keeps it out of git; the page loads that address', async () => {
    const root = new URL('..', import.meta.url).pathname
    const pkg = JSON.parse(await Bun.file(root + 'package.json').text())
    expect(pkg.scripts['build:js']).toContain('bun build src/gate-worklet.ts --outfile src/public/gate.js --minify --format=iife')
    expect(pkg.scripts['watch:js']).toContain('src/gate-worklet.ts --outfile src/public/gate.js')
    expect(await Bun.file(root + '.gitignore').text()).toContain('src/public/gate.js')
    expect(await Bun.file(root + 'src/voice.ts').text()).toContain("addModule('/public/gate.js')")
    expect(await Bun.file(root + 'src/gate-worklet.ts').text()).toContain("registerProcessor('td-gate'")
  })
})

describe('the name the room shows (RFC 28: a name that arrives after the player has joined)', () => {
  const setup = () => {
    const room = new FakeRoom()
    const hub = new VoiceHub(room.api, () => 10_000, () => {})
    const names: Record<string, string | null> = {}
    hub.setNameResolver((_s, id) => names[id] ?? null)
    room.join(A); room.join(B)
    room.people.forEach(p => { p.name = p.identity }) // both joined with digits: the dashboard knew nothing of them
    return { room, hub, names }
  }

  test('a player who joined as digits gets the name the dashboard knows now, once, and the others are left alone', async () => {
    const { room, hub, names } = setup()
    await hub.reconcile('srv')
    expect(room.renames).toEqual([]) // it knows nothing yet
    names[A] = 'Alice'
    await hub.reconcile('srv')
    expect(room.renames).toEqual(['01=Alice'])
    await hub.reconcile('srv')
    expect(room.renames).toEqual(['01=Alice']) // the room has it now: not again
    expect(room.people.find(p => p.identity === B)!.name).toBe(B)
    names[B] = 'Bob'
    await hub.reconcile('srv')
    expect(room.renames).toEqual(['01=Alice', '02=Bob'])
  })

  test('a name that changes (a rename in the game) is changed in the room', async () => {
    const { room, hub, names } = setup()
    names[A] = 'Alice'; await hub.reconcile('srv')
    names[A] = 'Alice2'; await hub.reconcile('srv')
    expect(room.renames).toEqual(['01=Alice', '01=Alice2'])
  })

  test('a call that fails does not stop the routing, and is tried again at the next pass', async () => {
    const { room, hub, names } = setup()
    hub.setState('srv', { boot: 1, seq: 1, phase: 'active', alive: [A, B], names: {} })
    names[A] = 'Alice'; room.failName = true
    await hub.reconcile('srv')
    expect(room.renames).toEqual([])
    expect(room.hears(A)).toEqual([B]) // the routing was done all the same
    await hub.reconcile('srv')
    expect(room.renames).toEqual(['01=Alice'])
  })

  test('a name that did not take is not sent at every pass', async () => {
    const { room, hub, names } = setup()
    let sent = 0
    ;(room.api as any).updateParticipantName = async () => { sent++ } // the room never shows it
    names[A] = 'Alice'
    for (let i = 0; i < 4; i++) await hub.reconcile('srv')
    expect(sent).toBe(1)
  })
})

describe('who is on the voice chat (before a player has joined)', () => {
  test('is the media server\'s list, asked at most once in 3 seconds, and the last answer stands when it cannot be asked', async () => {
    const room = new FakeRoom()
    let now = 10_000
    const hub = new VoiceHub(room.api, () => now, () => {})
    expect(await hub.people('srv')).toEqual([])
    room.join(A); room.join(B)
    expect(await hub.people('srv')).toEqual([]) // still the answer of a moment ago
    now += 3001
    expect((await hub.people('srv')).map(p => p.id).sort()).toEqual([A, B])
    room.api.listParticipants = async () => { throw new Error('down') }
    now += 3001
    expect((await hub.people('srv')).map(p => p.id).sort()).toEqual([A, B])
    expect(await new VoiceHub(null).people('srv')).toEqual([])
  })

  test('the nicks the game server sends are kept while it is still talking, and forgotten when it goes quiet', () => {
    let now = 1000
    const hub = new VoiceHub(null, () => now, () => {})
    hub.setState('srv', { boot: 1, seq: 1, phase: 'active', alive: [A], names: { [A]: 'Alice', [B]: 'Bob' } })
    expect(hub.nameOf('srv', B)).toBe('Bob') // a dead player's nick too: it says nothing about who is alive
    expect(hub.nameOf('srv', C)).toBeNull()
    now += STALE_MS + 1
    expect(hub.nameOf('srv', B)).toBeNull()
  })
})

describe('the meter\'s styles', () => {
  test('the level fill sits inside the bar by position, with no percentage margin (a percentage margin is of the width, and it pushed the fill 70 px out of the bar)', async () => {
    const css = await Bun.file(new URL('../src/components/styles.ts', import.meta.url)).text()
    const rule = /^\.lvl i\{([^}]*)\}/m.exec(css)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toContain('position:absolute')
    expect(rule).toContain('top:25%'); expect(rule).toContain('height:50%')
    for (const line of css.split('\n').filter(l => /^\.lvl\b/.test(l))) expect(line, line).not.toMatch(/margin(-top|-bottom)?:[^;}]*%/)
  })

  test('what the page writes while it runs has a place that is there when it is empty, so nothing below it jumps (measured in Chromium: the row grew 16 to 23 px, and 24 to 47 px on a phone, when the dB reading came)', async () => {
    const css = await Bun.file(new URL('../src/components/styles.ts', import.meta.url)).text()
    expect(/^\.vc \.lvl-read\{[^}]*min-height:/m.test(css)).toBe(true) // the line under the bar: the dB reading and "talking"
    expect(/^\.vc \.db\{[^}]*min-width:/m.test(css)).toBe(true); expect(/^\.vc \.talk\{[^}]*min-width:/m.test(css)).toBe(true)
    expect(/^\.vc \.note\{[^}]*min-height:/m.test(css)).toBe(true) // the notes that come in normal use: who is on, the measurement
    const page = await Bun.file(new URL('../src/components/VoicePage.tsx', import.meta.url)).text()
    expect(page).toMatch(/class="lvl-read"><span data-db[^>]*><\/span><span data-speaking[^>]*><\/span><\/div>/) // not in the row of the bar: it wrapped
    for (const hook of ['data-who', 'data-measure-note']) expect(page).toMatch(new RegExp(`class="muted note[ "][^>]*${hook}`))
  })

  // Measured in Chromium (Playwright, 1100 and 390 px wide, every state the code puts the page in, every element's box before and after):
  // a pressed toggle was 6.4 px wider and 7.6 px taller than an unpressed one (the shared rule ".f .tog[aria-pressed=true]" has a higher
  // specificity than ".vc .tog", so it gave a 2 px border and less padding), so every row with a toggle jumped, and the whole page under it;
  // "Join voice" to "Leave voice" widened the button by 15.7 px and pushed the status; a status of 10 to 30 characters moved the count by up
  // to 40 px; a long error or a long list of names made their row 130 px (237 on a phone) taller; the filter and gate notes pushed the level
  // section 23 px down. These tests hold what fixed it; the browser is not run here.
  test('a toggle is the same box pressed and unpressed: same padding, same border width, only the colours change', async () => {
    const css = await Bun.file(new URL('../src/components/styles.ts', import.meta.url)).text()
    const body = (selector: string) => new RegExp('^' + selector.replace(/[.[\]=]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(css)?.[1]
    // The pressed look is the shared rule's, which marks it with a border colour and an inset line and never touches the padding or the
    // border width (it used to give a 2 px border and less padding, which the voice page's own padding could not undo). So here: the
    // voice page's toggle padding is set once, on the base rule, and the shared pressed rule leaves the box alone.
    const base = body('.vc .tog')!, pressed = body('.f .tog[aria-pressed=true]')
    expect(base).toMatch(/padding:/)
    expect(pressed, 'the shared rule for a pressed toggle').toBeDefined()
    expect(pressed).not.toMatch(/(?:^|;)\s*(padding|margin|border-width|border|width|height|font-size|font-weight)\s*:/)
    expect(pressed).toContain('border-color'); expect(pressed).toContain('box-shadow:inset')
    expect(body('.tog')).toMatch(/border:1px solid/) // the unpressed border, the same width as the pressed one
    // and nothing else under .vc that changes the size of a toggle when it is pressed, hovered, focused or pressed with the mouse
    for (const m of css.matchAll(/^([^{}\n]*\.vc[^{}\n]*(?::hover|:focus|:active|:disabled|\[aria-pressed)[^{}\n]*)\{([^}]*)\}/gm)) {
      expect(m[2], m[1]).not.toMatch(/(?:^|;)\s*(padding|margin|font-size|font-weight|letter-spacing|width|min-width|height|min-height)\s*:/)
      expect(m[2], m[1]).not.toMatch(/border(?:-width)?:\s*[2-9]/)
    }
  })

  test('the things whose text changes have a fixed width or one line, so what is beside and under them stays put', async () => {
    const css = await Bun.file(new URL('../src/components/styles.ts', import.meta.url)).text()
    const rule = (sel: string) => new RegExp('^' + sel.replace(/[.[\]=]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(css)?.[1] ?? ''
    // The cards sit as the cards of the other pages do (RFC 30: the shared ".stack" has --space-4 between the cards, as ".g" has between its rows,
    // and the room for the first card's tab above the first): each card has a coloured tab (--tab) above it that takes up part of that space,
    // and with a smaller gap the tab nearly touched the card above it (the owner noticed: the maps page and this page looked different).
    expect(rule('.stack')).toContain('gap:var(--space-4)'); expect(rule('.stack')).toContain('padding-top:calc(var(--tab) + var(--space-2))')
    expect(rule('.g,.pair,.nums')).toContain('gap:var(--space-4) var(--space-3)'); expect(rule('.g,.pair,.nums')).toContain('padding-top:calc(var(--tab) + var(--space-2))')
    expect(await Bun.file(new URL('../src/components/VoicePage.tsx', import.meta.url)).text()).toMatch(/<div data-voice [^>]*class="stack"/)
    expect(rule('.vc .jn')).toMatch(/min-width:/) // "Join voice" to "Leave voice"
    // The name column of the People list is one width for every row and every name (digits, a nick, a long nick), on one line with an ellipsis:
    // with a width that followed the name, the slider of each row began somewhere else, and slid sideways when a nick replaced the digits.
    expect(rule('.vc .pname')).toMatch(/flex:0 0 [\d.]+rem/); expect(rule('.vc .pname')).toContain('white-space:nowrap'); expect(rule('.vc .pname')).toContain('text-overflow:ellipsis')
    expect(await Bun.file(new URL('../src/voice.ts', import.meta.url)).text()).toContain('name.title = p.name || id') // the whole name on hover
    for (const sel of ['.vc [data-status]', '.vc [data-who]']) {
      expect(rule(sel), sel).toContain('white-space:nowrap'); expect(rule(sel), sel).toContain('text-overflow:ellipsis') // a long error or list is one line
    }
    expect(rule('.vc [data-status]')).toMatch(/flex:1 1 [\d.]+rem/) // takes the width left, never wraps the count to another line
    expect(rule('.vc [data-count]')).toMatch(/min-width:/)
    expect(rule('.vc .mnote')).toMatch(/min-height:2\.8em/) // two lines kept free, and four on a phone
    expect(css).toMatch(/@media \(max-width:640px\)\{\.vc \.mnote\{min-height:5\.6em\}\}/)
    expect(rule('.vc .lvl-read')).toContain('align-items:flex-start') // a baseline alignment moved "talking" 15 px when the reading came
    expect(Number(/min-width:([\d.]+)rem/.exec(rule('.vc .db'))?.[1])).toBeGreaterThanOrEqual(6.5) // "-100 dBFS" fits
    expect(rule('.vc .pct')).toMatch(/min-width:3rem/)
    // the notes that only come when something failed are the last thing in the card, so nothing is under them to be pushed
    const page = await Bun.file(new URL('../src/components/VoicePage.tsx', import.meta.url)).text()
    const at = (hook: string) => page.indexOf(hook)
    for (const hook of ['data-filter-note', 'data-gate-note']) {
      expect(at(hook), hook).toBeGreaterThan(at('data-ptt-box')); expect(at(hook), hook).toBeGreaterThan(at('data-close-out'))
      expect(page.slice(at(hook)), hook).not.toMatch(/class="cap"|<button/) // nothing but the card's end under them
    }
  })

  test('the status and the who-is-on line keep the whole text in the title when the line cuts it', async () => {
    const code = await Bun.file(new URL('../src/voice.ts', import.meta.url)).text()
    expect(code).toMatch(/const say = \(el: HTMLElement, text: string\) => \{ el\.textContent = text; el\.title = text \}/)
    expect(code).not.toMatch(/\b(status|who)\.textContent\s*=/) // every write goes through say()
  })
})

describe('the routes', () => {
  let app: any, api: any, Store: any, server: { id: string, token: string }
  const cookieFor = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
  const get = async (path: string, as?: string) => app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookieFor(as) } : {} }))
  const postToken = async (path: string, as?: string) => app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: as ? { Cookie: await cookieFor(as) } : {} }))
  const bridge = (body: unknown, tok = server.token) => api.request('/v1/voice', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })

  beforeAll(async () => {
    const idx = await import('../src/index')
    app = idx.app
    api = (await import('../src/routes/api')).default
    Store = (await import('../src/services/Store')).Store
  })
  beforeEach(async () => {
    server = Store.addServer('Voice') as any
    configureVoice(null)
    ;(await import('../src/routes/api')).voiceLimiter.reset()
    ;(await import('../src/index')).voiceTokenLimiter.reset()
    ;(await import('../src/index')).voicePeopleLimiter.reset()
  })
  afterAll(() => configureVoice(null))

  test('the bridge posts the state with its token, and only then', async () => {
    const { voiceHub } = await import('../src/services/voice')
    const body = { boot: 1, seq: 1, phase: 'active', alive: [A, B] }
    expect((await api.request('/v1/voice', { method: 'POST', body: JSON.stringify(body) })).status).toBe(401)
    expect((await bridge(body, 'wrong')).status).toBe(401)
    const ok = await bridge(body)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, result: 'ok' })
    expect([...voiceHub.state(server.id)!.alive].sort()).toEqual([A, B])
    expect(await (await bridge(body)).json()).toEqual({ ok: true, result: 'old' })
    expect((await bridge({ ...body, phase: 'nope' })).status).toBe(400)
    expect((await bridge('not json')).status).toBe(400)
  })

  test('is limited, and the limit is per server', async () => {
    const other = Store.addServer('Other') as any
    let last = 200
    for (let i = 0; i < 70; i++) last = (await bridge({ boot: 1, seq: i, phase: 'over', alive: [] })).status
    expect(last).toBe(429)
    expect((await bridge({ boot: 1, seq: 1, phase: 'over', alive: [] }, other.token)).status).toBe(200)
  })

  test('the page needs a signed-in user; it says so when there is no media server', async () => {
    expect((await get(`/servers/${server.id}/voice`)).status).toBe(302)
    const res = await get(`/servers/${server.id}/voice`, ADMIN)
    expect(res.status).toBe(200)
    const t = await res.text()
    expect(t).toContain('data-voice-off')
    expect(t).not.toContain('data-join')
    expect(res.headers.get('content-security-policy')).not.toContain('wss://')
  })

  test('with a media server the page has its controls, and its policy lets it connect there and nowhere else', async () => {
    configureVoice(CFG)
    const res = await get(`/servers/${server.id}/voice`, ADMIN)
    const t = await res.text()
    expect(t).toContain('data-voice'); expect(t).toContain('data-join'); expect(t).toContain('/public/voice.js')
    // two cards: who is on (join, the list, the volumes) and the player's own microphone (how it opens, the filter, the level)
    expect((t.match(/class="f c-gray vc"/g) ?? []).length).toBe(2)
    const first = t.indexOf('On the voice chat'), second = t.indexOf('Your microphone')
    expect(first).toBeGreaterThan(-1); expect(second).toBeGreaterThan(first)
    for (const mine of ['data-join', 'data-people', 'data-who', 'data-count']) expect(t.indexOf(mine), mine).toBeLessThan(second)
    for (const mine of ['data-mode="vad"', 'data-filter="on"', 'data-monitor', 'data-level', 'data-threshold', 'data-measure', 'data-auto', 'data-close-threshold']) expect(t.indexOf(mine), mine).toBeGreaterThan(second)
    expect(t).toContain(`data-token="/servers/${server.id}/voice/token"`)
    // the same kind of controls as the replay's (buttons that are pressed), not browser radios with their labels stacked under them
    expect(t).toContain('data-mode="vad" aria-pressed="true"'); expect(t).toContain('data-mode="ptt" aria-pressed="false"')
    expect(t).toMatch(/<button[^>]*data-mode="ptt"[^>]* disabled/) // holding a key cannot work from a browser tab while the game has the focus: stage 2 (the desktop app)
    expect(t).toContain('data-level'); expect(t).toContain('data-marker'); expect(t).toContain('data-threshold')
    // the gate's controls (RFC 29): both markers, the close slider under "Advanced", the measurement, the automatic switch
    expect(t).toContain('data-marker-close'); expect(t).toContain('data-close-threshold'); expect(t).toContain('Advanced')
    expect(t).toMatch(/data-threshold[^>]*min="-70"[^>]*max="-20"/)
    expect(t).toContain('data-measure'); expect(t).toContain('Measure my room')
    expect(t).toMatch(/<button[^>]*data-auto="true" aria-pressed="false"/); expect(t).toContain('Adjust by itself')
    expect(t).not.toContain('type="radio"'); expect(t).not.toContain('<meter')
    expect(t).not.toContain(CFG.secret); expect(t).not.toContain(CFG.key)
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' wss://lk.test https://lk.test;")
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'wasm-unsafe-eval';") // the noise filter (WebAssembly)
    expect((await get('/servers/nope/voice', ADMIN)).status).toBe(302)
  })

  test('the voice page is linked from the section links of the server\'s pages, only where the dashboard has a media server, and marks itself when it is open', async () => {
    const link = `href="/servers/${server.id}/voice"`
    const stats = async () => (await get(`/servers/${server.id}/stats`, ADMIN)).text()
    expect(await stats()).not.toContain(link) // no media server: no link to a page that says it is not set up
    configureVoice(CFG)
    expect(await stats()).toContain(link)
    expect(await (await get(`/servers/${server.id}/maps`, ADMIN)).text()).toContain(link) // every page with the section links
    const here = await (await get(`/servers/${server.id}/voice`, ADMIN)).text()
    expect(here).toMatch(new RegExp(`<a ${link.replace(/[/]/g, '\\/')}[^>]*aria-current="page"`))
    configureVoice(null)
    expect(await stats()).not.toContain(link)
  })

  test('a token is for a signed-in user, for their own SteamID64, in the server\'s room', async () => {
    expect((await postToken(`/servers/${server.id}/voice/token`)).status).toBe(401)
    expect((await postToken(`/servers/${server.id}/voice/token`, ADMIN)).status).toBe(503) // no media server
    configureVoice(CFG)
    expect((await postToken('/servers/nope/voice/token', ADMIN)).status).toBe(404)
    const res = await postToken(`/servers/${server.id}/voice/token`, ADMIN)
    expect(res.status).toBe(200)
    const { url, token } = await res.json()
    expect(url).toBe('wss://lk.test')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims).toMatchObject({ iss: 'devkey', sub: ADMIN, video: { room: roomOf(server.id), canPublish: true, canSubscribe: true } })
  })

  test('the token carries the nick a round knows for the player (for the others\' list), else the SteamID64', async () => {
    configureVoice(CFG)
    const nameIn = async () => {
      const { token } = await (await postToken(`/servers/${server.id}/voice/token`, ADMIN)).json()
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).name
    }
    expect(await nameIn()).toBe(ADMIN)
    const round = await api.request('/v1/round', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ round_id: 'round-nick-001', map: 'ttt_example', result: 'innocents', duration: 300, players: [{ steam_id: ADMIN, nick: 'Phil', role: 'innocent', team: 'innocents' }], deaths: [] }) })
    expect(round.status).toBe(200)
    expect(await nameIn()).toBe('Phil')
    // the nick the game server gives for someone connected now is the freshest, and wins
    const { voiceHub } = await import('../src/services/voice')
    voiceHub.setState(server.id, { boot: 1, seq: 1, phase: 'over', alive: [], names: { [ADMIN]: 'Phil in game' } })
    expect(await nameIn()).toBe('Phil in game')
  })

  test('who is on: signed-in users only; the names come from the media server, else the game, else a round, else the SteamID64', async () => {
    const path = `/servers/${server.id}/voice/people`
    expect((await get(path)).status).toBe(401)
    expect((await get(path, ADMIN)).status).toBe(503) // no media server
    configureVoice(CFG, (async () => Response.json({ participants: [
      { sid: 'PA_1', identity: A, name: 'Alice' }, { sid: 'PA_2', identity: B, name: B }, { sid: 'PA_3', identity: C, name: '' }] })) as unknown as typeof fetch)
    expect((await get('/servers/nope/voice/people', ADMIN)).status).toBe(404)
    const { voiceHub } = await import('../src/services/voice')
    voiceHub.setState(server.id, { boot: 1, seq: 1, phase: 'over', alive: [], names: { [B]: 'Bob' } })
    const res = await get(path, ADMIN)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).people).toEqual([{ id: A, name: 'Alice' }, { id: B, name: 'Bob' }, { id: C, name: C }])
  })

  test('who is on is limited per account', async () => {
    configureVoice(CFG, (async () => Response.json({ participants: [] })) as unknown as typeof fetch)
    let last = 200
    for (let i = 0; i < 62; i++) last = (await get(`/servers/${server.id}/voice/people`, ADMIN)).status
    expect(last).toBe(429)
  })

  test('tokens are limited per account', async () => {
    configureVoice(CFG)
    let last = 200
    for (let i = 0; i < 25; i++) last = (await postToken(`/servers/${server.id}/voice/token`, ADMIN)).status
    expect(last).toBe(429)
  })
})
