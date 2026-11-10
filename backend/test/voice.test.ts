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

const state = (phase: 'prep' | 'active' | 'over', alive: string[], at = 1000): VoiceState => ({ boot: 1, seq: 1, phase, alive: new Set(alive), at })

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
  const ok = { boot: 5, seq: 1, phase: 'active' as const, alive: [A, B] }
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
    expect(Object.keys(parseVoiceState({ ...ok, role: 'traitor', pos: [1, 2, 3] }) as object).sort()).toEqual(['alive', 'boot', 'phase', 'seq'])
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
      { sid: 'PA_1', identity: A, tracks: [{ sid: 'TR_a', type: 'AUDIO' }, { sid: 'TR_v', type: 'VIDEO' }] },
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
    expect(list).toEqual<Participant[]>([{ sid: 'PA_1', identity: A, audio: ['TR_a'] }, { sid: 'PA_2', identity: B, audio: ['TR_b'] }, { sid: 'PA_3', identity: C, audio: [] }])
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
  failNext = false
  join(identity: string, sid = `PA_${identity.slice(-2)}_${this.people.length}`) {
    this.people = this.people.filter(p => p.identity !== identity)
    this.people.push({ sid, identity, audio: [`TR_${identity.slice(-2)}_${sid}`] })
    this.subs.set(identity, new Set()) // a new connection starts with nothing
  }
  leave(identity: string) { this.people = this.people.filter(p => p.identity !== identity); this.subs.delete(identity) }
  api = {
    listParticipants: async () => this.people.map(p => ({ ...p })),
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
    expect(t).toContain(`data-token="/servers/${server.id}/voice/token"`)
    expect(t).not.toContain(CFG.secret); expect(t).not.toContain(CFG.key)
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' wss://lk.test https://lk.test;")
    expect((await get('/servers/nope/voice', ADMIN)).status).toBe(302)
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

  test('tokens are limited per account', async () => {
    configureVoice(CFG)
    let last = 200
    for (let i = 0; i < 25; i++) last = (await postToken(`/servers/${server.id}/voice/token`, ADMIN)).status
    expect(last).toBe(429)
  })
})
