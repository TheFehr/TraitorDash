import { expect, test, describe } from 'bun:test'
import { validateTrack, trackConfig, effectiveLimits, parseLimit, TRACK_DEFAULTS, MAX_TICKS } from '../src/services/tracks'

// RFC 12, 3.3 and 3.4: what a track must look like to be stored, and what an instance keeps.

const A = '76561198000000001', B = '76561198000000002'
const round = { roundId: 'a1b2c3d4-0001', map: 'ttt_example', players: new Set([A, B]) }
const FP = 'cd'.repeat(32)

const good = (over: Record<string, unknown> = {}) => ({
  round_id: round.roundId, map: 'ttt_example', fingerprint: FP, truncated: false, degraded: false,
  t: [0, 200, 200, 200],
  players: [
    { id: A, segments: [{ from: 0, x: [120, 3, -1, 0], y: [-80, 0, 4, 0], z: [30, 0, 0, 0], a: [12, 2, -1, 0] }] },
    { id: B, segments: [{ from: 1, x: [10, 1], y: [10, 1], z: [10, 0], a: [250, 3] }] },
  ],
  deaths: [{ victim: B, attacker: A, t: 600, vx: 410, vy: -20, vz: 36, ax: 400, ay: -22, az: 36, weapon: 'weapon_ttt_m16' }],
  ...over,
})
const refused = (body: unknown, part: RegExp) => {
  const r = validateTrack(body, round)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(part)
}

describe('validateTrack', () => {
  test('accepts a good track and keeps only what it knows', () => {
    const r = validateTrack({ ...good(), extra: 'x', players: [{ ...good().players[0], note: 1 }, good().players[1]] }, round)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.track.players[0]).toEqual({ id: A, segments: good().players[0]!.segments })
      expect(r.track.fingerprint).toBe(FP)
      expect(JSON.stringify(r.track)).not.toContain('extra')
    }
  })

  test('a track without a fingerprint, flags or deaths is fine', () => {
    const { fingerprint, truncated, degraded, deaths, ...rest } = good()
    const r = validateTrack(rest, round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track).toMatchObject({ fingerprint: null, truncated: false, degraded: false, deaths: [] })
  })

  test('a death with no attacker needs no attacker position', () => {
    const r = validateTrack(good({ deaths: [{ victim: B, t: 10, vx: 1, vy: 2, vz: 3 }] }), round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.deaths[0]).toMatchObject({ attacker: null, ax: null, weapon: null })
  })

  test('refuses what is not about this round', () => {
    refused(good({ round_id: 'other-round-1' }), /round_id/)
    refused(good({ map: 'ttt_other' }), /map does not match/)
    refused(good({ map: '../etc' }), /map is required/)
    refused(null, /object/)
    refused([], /object/)
  })

  test('refuses players who were not in the round, and the same player twice', () => {
    refused(good({ players: [{ id: '76561198999999999', segments: [] }] }), /not in the round/)
    refused(good({ players: [{ id: A, segments: [] }, { id: A, segments: [] }] }), /twice/)
    refused(good({ players: [{ id: 'abc', segments: [] }] }), /invalid id/)
    refused(good({ deaths: [{ victim: '76561198999999999', t: 1, vx: 0, vy: 0, vz: 0 }] }), /victim/)
    refused(good({ deaths: [{ victim: A, attacker: '76561198999999999', t: 1, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 }] }), /attacker/)
  })

  test('refuses numbers that are not whole, or out of range', () => {
    refused(good({ t: [0, 1.5] }), /whole numbers/)
    refused(good({ t: [0, -1] }), /whole numbers/)
    refused(good({ t: [0, 'x'] }), /whole numbers/)
    refused(good({ t: [0, 70_000] }), /whole numbers/)
    refused(good({ t: [] }), /whole numbers/)
    const seg = (over: Record<string, unknown>) => good({ players: [{ id: A, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1], ...over }] }] })
    refused(seg({ x: [1.5] }), /invalid x/)
    refused(seg({ x: [5000] }), /outside the map/)
    refused(seg({ y: [-5000] }), /outside the map/)
    refused(seg({ a: [256] }), /same length/)
    refused(seg({ a: [200, 100] , x: [1, 1], y: [1, 1], z: [1, 1] }), /outside 0-255/)
    refused(seg({ a: [-1] }), /outside 0-255/)
    refused(seg({ z: [null] }), /same length/)
  })

  test('refuses a position that drifts out of range through its differences', () => {
    const drift = good({ players: [{ id: A, segments: [{ from: 0, x: [4000, 4000, 4000], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }] })
    refused(drift, /outside the map/)
  })

  test('refuses arrays of different lengths', () => {
    refused(good({ players: [{ id: A, segments: [{ from: 0, x: [1, 2], y: [1], z: [1, 2], a: [1, 2] }] }] }), /same length/)
  })

  test('refuses segments that overlap, run backwards, or reach past the last tick', () => {
    const s = (from: number, n: number) => ({ from, x: Array(n).fill(0), y: Array(n).fill(0), z: Array(n).fill(0), a: Array(n).fill(0) })
    refused(good({ players: [{ id: A, segments: [s(0, 2), s(1, 2)] }] }), /out of order|overlaps/)
    refused(good({ players: [{ id: A, segments: [s(2, 1), s(0, 1)] }] }), /out of order|overlaps/)
    refused(good({ players: [{ id: A, segments: [s(3, 2)] }] }), /invalid x/)
    refused(good({ players: [{ id: A, segments: [s(9, 1)] }] }), /starts past/)
    expect(validateTrack(good({ players: [{ id: A, segments: [s(0, 1), s(1, 1), s(3, 1)] }] }), round).ok).toBe(true)
  })

  test('refuses more than the caps', () => {
    refused(good({ t: Array(MAX_TICKS + 1).fill(1) }), /whole numbers/)
    refused(good({ players: Array.from({ length: 129 }, (_, i) => ({ id: String(76561198000000000n + BigInt(i)), segments: [] })) }), /players must be/)
    refused(good({ deaths: Array(513).fill({ victim: A, t: 1, vx: 0, vy: 0, vz: 0 }) }), /deaths must be/)
    refused(good({ t: Array(400).fill(60_000) }), /six hours/)
  })

  test('refuses bad flags and fingerprints', () => {
    refused(good({ truncated: 'yes' }), /truncated/)
    refused(good({ fingerprint: 'nope' }), /fingerprint/)
  })

  test('a round that did not say its map takes the track\'s', () => {
    expect(validateTrack(good(), { ...round, map: null }).ok).toBe(true)
  })
})

describe('trackConfig', () => {
  test('has the documented defaults', () => {
    expect(trackConfig({})).toEqual(TRACK_DEFAULTS)
    expect(TRACK_DEFAULTS).toEqual({ keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 50 })
  })
  test('takes the instance values from the environment', () => {
    expect(trackConfig({ TRACKS_KEEP_COUNT: '10', TRACKS_KEEP_MB: '5', TRACKS_MAX_COUNT: '20', TRACKS_MAX_MB: '30', TRACKS_MAX_PINNED: '3' }))
      .toEqual({ keepCount: 10, keepMb: 5, maxCount: 20, maxMb: 30, maxPinned: 3 })
  })
  test('refuses what is not a whole number, and a default above its own ceiling', () => {
    expect(() => trackConfig({ TRACKS_KEEP_COUNT: 'many' })).toThrow(/TRACKS_KEEP_COUNT must be a whole number/)
    expect(() => trackConfig({ TRACKS_KEEP_MB: '1.5' })).toThrow(/TRACKS_KEEP_MB/)
    expect(() => trackConfig({ TRACKS_MAX_COUNT: '-1' })).toThrow(/TRACKS_MAX_COUNT/)
    expect(() => trackConfig({ TRACKS_KEEP_COUNT: '3000' })).toThrow(/above TRACKS_MAX_COUNT/)
    expect(() => trackConfig({ TRACKS_KEEP_MB: '300', TRACKS_MAX_MB: '100' })).toThrow(/above TRACKS_MAX_MB/)
  })
  test('an empty value is the default', () => {
    expect(trackConfig({ TRACKS_KEEP_COUNT: '  ' })).toEqual(TRACK_DEFAULTS)
  })
})

describe('what a server keeps', () => {
  test('its own value, else the instance default, never above the ceiling', () => {
    const cfg = { keepCount: 200, keepMb: 200, maxCount: 300, maxMb: 300, maxPinned: 50 }
    expect(effectiveLimits(cfg, { count: null, mb: null })).toEqual({ count: 200, mb: 200 })
    expect(effectiveLimits(cfg, { count: 5, mb: 0 })).toEqual({ count: 5, mb: 0 })
    expect(effectiveLimits(cfg, { count: 900, mb: 900 })).toEqual({ count: 300, mb: 300 })
  })
  test('a form value: empty is the default, 0 is allowed, a ceiling or a non-number is refused', () => {
    expect(parseLimit('', 100, 'x')).toEqual({ ok: true, value: null })
    expect(parseLimit(' 0 ', 100, 'x')).toEqual({ ok: true, value: 0 })
    expect(parseLimit('100', 100, 'x')).toEqual({ ok: true, value: 100 })
    expect(parseLimit('101', 100, 'Count').ok).toBe(false)
    expect(parseLimit('-1', 100, 'x').ok).toBe(false)
    expect(parseLimit('1e3', 100, 'x').ok).toBe(false)
    expect(parseLimit('2.5', 100, 'x').ok).toBe(false)
  })
})
