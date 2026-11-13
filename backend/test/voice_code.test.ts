import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { VoiceCodes, CODE_ALPHABET, CODE_TTL_MS, PLAYER_WAIT_MS, MAX_CODES, MAX_FAILURES_PER_WINDOW, FAILURE_WINDOW_MS, normaliseCode, showCode } from '../src/services/voiceCode'

// RFC 31, section 7: the code store (alphabet, shape, single use, five minutes, replacement, the cap and the sweep, the count of failures) and the
// voice cookie (what it is signed with, what reads it). The routes are in voice_code_routes.test.ts.

const ADMIN = '76561198000000000', P1 = '76561198000000041', P2 = '76561198000000042', P3 = '76561198000000043'

const SRV = 'srv-A'
const store = (start = 1_000_000) => {
  const clock = { now: start }
  return { clock, codes: new VoiceCodes(() => clock.now) }
}
const codeOf = (made: { code: string } | { wait: number }) => { if (!('code' in made)) throw new Error('waiting'); return made.code }

describe('the code', () => {
  test('the alphabet has 28 characters: digits 2 to 9 and the consonants without L; nothing that looks like another', () => {
    expect(CODE_ALPHABET).toHaveLength(28)
    expect(new Set(CODE_ALPHABET).size).toBe(28)
    expect(CODE_ALPHABET).toBe('23456789BCDFGHJKMNPQRSTVWXYZ')
    for (const bad of ['0', '1', 'O', 'I', 'L', 'A', 'E', 'U']) expect(CODE_ALPHABET).not.toContain(bad)
  })

  test('a code is six characters of the alphabet, shown in two groups of three', () => {
    const { codes } = store()
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const code = codeOf(codes.issue(`7656119800000${String(1000 + i)}`, SRV))
      expect(code).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/)
      expect(showCode(code)).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{3}-[23456789BCDFGHJKMNPQRSTVWXYZ]{3}$/)
      seen.add(code)
    }
    expect(seen.size).toBeGreaterThan(190) // random, not a counter
    expect(showCode('K7F3QX')).toBe('K7F-3QX')
  })

  test('typed input is upper-cased and stripped of spaces and dashes; what cannot be a code is nothing', () => {
    expect(normaliseCode('k7f-3qx')).toBe('K7F3QX')
    expect(normaliseCode(' K7F 3QX ')).toBe('K7F3QX')
    expect(normaliseCode('k-7-f-3-q-x')).toBe('K7F3QX')
    expect(normaliseCode('K7F3QX')).toBe('K7F3QX')
    for (const bad of ['K7F-3Q', 'K7F-3QXX', 'K7F-3Q1', 'K7F-3QO', 'K7F-3QL', 'AEIOU2', '', '      ', 42, null, undefined, {}, 'K7F-3QX'.repeat(20)]) expect(normaliseCode(bad as any), String(bad)).toBeNull()
  })

  test('what was issued is redeemed in any spelling the person types', () => {
    const { codes } = store()
    const code = codeOf(codes.issue(P1, SRV))
    expect(codes.redeem(showCode(code).toLowerCase().replace('-', ' '))?.steamId).toBe(P1)
  })
})

describe('the server that issued a code', () => {
  test('a code remembers the server it was issued for, and redeeming gives it with the player', () => {
    const { codes } = store()
    const a = codeOf(codes.issue(P1, 'srv-A')), b = codeOf(codes.issue(P2, 'srv-B'))
    expect(codes.redeem(b)).toEqual({ steamId: P2, serverId: 'srv-B' })
    expect(codes.redeem(a)).toEqual({ steamId: P1, serverId: 'srv-A' })
  })

  test('the same player asking from another server later gets that server', () => {
    const { clock, codes } = store()
    codeOf(codes.issue(P1, 'srv-A'))
    clock.now += PLAYER_WAIT_MS
    const second = codeOf(codes.issue(P1, 'srv-B'))
    expect(codes.redeem(second)?.serverId).toBe('srv-B')
  })
})

describe('single use, five minutes, replacement', () => {
  test('a code is used up by the first entry: the same code again gives nothing', () => {
    const { codes } = store()
    const code = codeOf(codes.issue(P1, SRV))
    expect(codes.redeem(code)?.steamId).toBe(P1)
    expect(codes.redeem(code)).toBeNull()
    expect(codes.size).toBe(0)
  })

  test('a code works until exactly five minutes after it was made, and not at five minutes', () => {
    const { clock, codes } = store()
    const a = codeOf(codes.issue(P1, SRV)), b = codeOf(codes.issue(P2, SRV)), c = codeOf(codes.issue(P3, SRV))
    expect(CODE_TTL_MS).toBe(300_000)
    clock.now += CODE_TTL_MS - 1
    expect(codes.redeem(a)?.steamId).toBe(P1)
    clock.now += 1
    expect(codes.redeem(b)).toBeNull()
    clock.now += 60_000
    expect(codes.redeem(c)).toBeNull()
  })

  test('a new code for a player replaces the old one, which no longer works', () => {
    const { clock, codes } = store()
    const first = codeOf(codes.issue(P1, SRV))
    clock.now += PLAYER_WAIT_MS
    const second = codeOf(codes.issue(P1, SRV))
    expect(second).not.toBe(first)
    expect(codes.redeem(first)).toBeNull()
    expect(codes.redeem(second)?.steamId).toBe(P1)
    expect(codes.size).toBe(0)
  })

  test('a player gets one new code every ten seconds, and is told how long to wait; another player is not held up', () => {
    const { clock, codes } = store()
    codeOf(codes.issue(P1, SRV))
    clock.now += PLAYER_WAIT_MS - 1
    expect(codes.issue(P1, SRV)).toEqual({ wait: 1 })
    expect('code' in codes.issue(P2, SRV)).toBe(true)
    clock.now += 1
    expect('code' in codes.issue(P1, SRV)).toBe(true)
  })

  test('the replaced code does not take the new one with it when it expires', () => {
    const { clock, codes } = store()
    codeOf(codes.issue(P1, SRV))
    clock.now += 200_000
    const second = codeOf(codes.issue(P1, SRV))
    clock.now += 200_000 // the first would have expired by now; the second has 100 s left
    expect(codes.redeem(second)?.steamId).toBe(P1)
  })
})

describe('the cap and the sweep', () => {
  test('there are never more than the cap; the oldest goes first', () => {
    const { clock, codes } = store()
    const first = codeOf(codes.issue('76561198000009999', SRV))
    for (let i = 0; i < MAX_CODES + 20; i++) {
      clock.now += 1
      codes.issue(`7656119800${String(100000 + i)}`, SRV)
    }
    expect(codes.size).toBe(MAX_CODES)
    expect(codes.redeem(first)).toBeNull()
  })

  test('every call sweeps what has expired: asking for a code frees the memory of the old ones', () => {
    const { clock, codes } = store()
    for (let i = 0; i < 50; i++) codes.issue(`7656119800${String(100000 + i)}`, SRV)
    expect(codes.size).toBe(50)
    clock.now += CODE_TTL_MS
    codes.issue(P1, SRV)
    expect(codes.size).toBe(1)
    clock.now += CODE_TTL_MS
    codes.redeem('222222')
    expect(codes.size).toBe(0)
  })
})

describe('failed entries are counted', () => {
  test('entry waits after 60 failures in a minute, with the seconds left, and opens again when the minute is over', () => {
    const { clock, codes } = store()
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW - 1; i++) codes.noteFailure()
    expect(codes.lockedFor()).toBe(0)
    codes.noteFailure()
    expect(codes.lockedFor()).toBe(60)
    clock.now += 30_000
    expect(codes.lockedFor()).toBe(30)
    clock.now += FAILURE_WINDOW_MS - 30_000
    expect(codes.lockedFor()).toBe(0)
    codes.noteFailure()
    expect(codes.lockedFor()).toBe(0)
  })
})

describe('the voice cookie: what signs it and what reads it', () => {
  let vs: typeof import('../src/services/voiceSession'), gameKey: typeof import('../src/services/gameKey'), session: typeof import('../src/middleware/session')
  beforeAll(async () => {
    vs = await import('../src/services/voiceSession')
    gameKey = await import('../src/services/gameKey')
    session = await import('../src/middleware/session')
  })
  const NOW = 1_800_000_000_000

  test('a cookie made now reads back as its player, until 30 days are over', () => {
    const value = vs.makeVoiceCookie(P1, NOW)
    expect(value).toMatch(/^\d{17}\.\d+\.[A-Za-z0-9_-]{43}$/)
    expect(vs.readVoiceCookie(value, NOW)).toBe(P1)
    expect(vs.VOICE_COOKIE_SECONDS).toBe(30 * 24 * 3600)
    expect(vs.readVoiceCookie(value, NOW + 30 * 24 * 3600 * 1000 - 1000)).toBe(P1)
    expect(vs.readVoiceCookie(value, NOW + 30 * 24 * 3600 * 1000)).toBeNull()
  })

  test('forged, changed and malformed cookies are nobody', () => {
    const value = vs.makeVoiceCookie(P1, NOW)
    const [id, expiry, sig] = value.split('.') as [string, string, string]
    for (const bad of [
      `${P2}.${expiry}.${sig}`, // another player under the same signature
      `${id}.${Number(expiry) + 1000}.${sig}`, // a longer life
      `${id}.${expiry}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, // one character of the signature
      `${id}.${expiry}.`, `${id}.${expiry}`, id, '', 'garbage', `${id}.${expiry}.${sig}.x`,
      `${id}.${expiry}.${'A'.repeat(43)}`,
    ]) expect(vs.readVoiceCookie(bad, NOW), bad).toBeNull()
    for (const notString of [undefined, null, 42, {}, ['a']]) expect(vs.readVoiceCookie(notString, NOW)).toBeNull()
  })

  test('a game key is not a voice cookie, and a voice cookie is not a game key (different keys)', () => {
    const key = gameKey.makeGameKey(P1, NOW)
    expect(key).toMatch(/^\d{17}\.\d+\.[A-Za-z0-9_-]{43}$/) // the same shape: only the signature tells them apart
    expect(vs.readVoiceCookie(key, NOW)).toBeNull()
    expect(gameKey.readGameKey(vs.makeVoiceCookie(P1, NOW), NOW)).toBeNull()
  })

  test('a signed session cookie value is not a voice cookie', async () => {
    const signed = (await serializeSigned('steam_id', P1, SECRET)).split(';')[0]!.split('=').slice(1).join('=')
    expect(vs.readVoiceCookie(decodeURIComponent(signed), NOW)).toBeNull()
    expect(vs.readVoiceCookie(`${P1}.${Math.floor(NOW / 1000) + 1000}.${signed.split('.')[1]}`, NOW)).toBeNull()
  })

  const ctx = (cookie: string) => ({ req: { raw: { headers: new Headers({ Cookie: cookie }) }, header: (n: string) => (n.toLowerCase() === 'cookie' ? cookie : undefined) } }) as any

  test('getVoiceSession: the cookie of a player who may sign in is a plain user; an admin\'s is never an admin', async () => {
    process.env.OPEN_SIGNIN = '1'
    try {
      expect(await vs.getVoiceSession(ctx(`${session.VOICE_COOKIE}=${vs.makeVoiceCookie(P1)}`))).toEqual({ steamId: P1, admin: false })
      expect(await vs.getVoiceSession(ctx(`${session.VOICE_COOKIE}=${vs.makeVoiceCookie(ADMIN)}`))).toEqual({ steamId: ADMIN, admin: false })
    } finally { delete process.env.OPEN_SIGNIN }
  })

  test('getVoiceSession: the same switches as a sign-in: blocked, and a non-admin without open sign-in, are nobody', async () => {
    const cookie = `${session.VOICE_COOKIE}=${vs.makeVoiceCookie(P1)}`
    expect(await vs.getVoiceSession(ctx(cookie))).toBeNull() // OPEN_SIGNIN is off
    process.env.OPEN_SIGNIN = '1'
    try {
      expect(await vs.getVoiceSession(ctx(cookie))).not.toBeNull()
      process.env.BLOCKED_STEAM_IDS = P1
      expect(await vs.getVoiceSession(ctx(cookie))).toBeNull()
      delete process.env.BLOCKED_STEAM_IDS
      delete process.env.OPEN_SIGNIN
      expect(await vs.getVoiceSession(ctx(`${session.VOICE_COOKIE}=${vs.makeVoiceCookie(ADMIN)}`))).toEqual({ steamId: ADMIN, admin: false }) // an admin may always
    } finally { delete process.env.OPEN_SIGNIN; delete process.env.BLOCKED_STEAM_IDS }
  })

  test('getVoiceSession tries the real session first: an admin with both is an admin; getSession itself never reads the voice cookie', async () => {
    const real = (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]!
    const voice = `${session.VOICE_COOKIE}=${vs.makeVoiceCookie(P1)}`
    process.env.OPEN_SIGNIN = '1'
    try {
      expect(await vs.getVoiceSession(ctx(`${real}; ${voice}`))).toEqual({ steamId: ADMIN, admin: true })
      expect(await session.getSession(ctx(voice))).toBeNull()
      expect(await session.getSession(ctx(`${session.GAME_COOKIE}=${vs.makeVoiceCookie(P1)}`))).toBeNull()
      expect(await session.getSession(ctx(`${session.SESSION_COOKIE}=${vs.makeVoiceCookie(P1)}`))).toBeNull()
      expect(await vs.getVoiceSession(ctx(`${session.GAME_COOKIE}=${gameKey.makeGameKey(P1)}`))).toBeNull() // a game key in the voice slot of another name
      expect(await vs.getVoiceSession(ctx(`${session.VOICE_COOKIE}=${gameKey.makeGameKey(P1)}`))).toBeNull()
    } finally { delete process.env.OPEN_SIGNIN }
  })
})
