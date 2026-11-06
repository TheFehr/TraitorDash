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

  test('how the player moves (s: crouching 1, in the air 2, in water 4) is kept when it is there, and a track without it is fine', () => {
    const withS = good(); (withS.players[0]!.segments[0] as any).s = [0, 1, 1, 5]
    const r = validateTrack(withS, round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.players[0]!.segments[0]!.s).toEqual([0, 1, 1, 5])
    const without = validateTrack(good(), round)
    expect(without.ok && 's' in without.track.players[0]!.segments[0]!).toBe(false)
  })

  test('s must be whole numbers from 0 to 7, one for each position', () => {
    for (const bad of [[0, 1, 1], [0, 1, 1, 8], [0, 1, 1, -1], [0, 1, 1, 1.5], 'x', null]) {
      const body = good(); (body.players[0]!.segments[0] as any).s = bad
      refused(body, /s must be/)
    }
  })

  test('chat, purchases and bodies found are kept as they are sent, and anything else is refused (RFC 26)', () => {
    const body = (events: unknown[]) => ({ ...good(), events })
    const ok = validateTrack(body([
      { t: 100, p: A, k: 'say', text: 'hello there', ch: 'all' },
      { t: 200, p: A, k: 'say', text: 'traitors only', ch: 'team' },
      { t: 300, p: B, k: 'buy', item: 'weapon_ttt_c4' },
      { t: 400, p: B, k: 'buy', item: 'item_ttt_radar', it: true },
      { t: 500, p: A, k: 'found', of: B },
      { t: 600, p: A, k: 'found' },
    ]), round)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.track.events).toEqual([
      { t: 100, p: A, k: 'say', text: 'hello there', ch: 'all' }, { t: 200, p: A, k: 'say', text: 'traitors only', ch: 'team' },
      { t: 300, p: B, k: 'buy', item: 'weapon_ttt_c4' }, { t: 400, p: B, k: 'buy', item: 'item_ttt_radar', it: true },
      { t: 500, p: A, k: 'found', of: B }, { t: 600, p: A, k: 'found' },
    ])
    refused(body([{ t: 1, p: A, k: 'say', text: '', ch: 'all' }]), /1 to 200 characters/)
    refused(body([{ t: 1, p: A, k: 'say', text: 'x'.repeat(201), ch: 'all' }]), /1 to 200 characters/)
    expect(validateTrack(body([{ t: 1, p: A, k: 'say', text: 'ä'.repeat(200), ch: 'dead' }]), round).ok).toBe(true) // characters, not bytes
    refused(body([{ t: 1, p: A, k: 'say', text: 'a\nb', ch: 'all' }]), /control characters/)
    refused(body([{ t: 1, p: A, k: 'say', text: 'hi', ch: 'everyone' }]), /channel/)
    refused(body([{ t: 1, p: A, k: 'say', text: 'hi' }]), /channel/)
    refused(body([{ t: 1, p: 'stranger', k: 'say', text: 'hi', ch: 'all' }]), /not in the round/)
    refused(body([{ t: 1, p: A, k: 'buy', item: 'bad name;' }]), /class of what was bought/)
    refused(body([{ t: 1, p: A, k: 'buy', item: 'x', it: false }]), /item flag/)
    refused(body([{ t: 1, p: A, k: 'found', of: 'stranger' }]), /not in the round/)
    refused(body([{ t: 1, p: A, k: 'kick' }]), /unknown kind/)
    expect(validateTrack(body([{ t: 1, p: A, k: 'pickup', of: B }, { t: 2, p: A, k: 'drop' }]), round).ok).toBe(true) // RFC 24
    refused(body([{ t: 1, p: A, k: 'pickup', of: 'stranger' }]), /pickup event names a body/)
    refused(body(Array.from({ length: 4353 }, (_, i) => ({ t: i, p: A, k: 'found' }))), /at most 4352/)
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

describe('validateTrack: parts that move and their inputs (RFC 20, 4.5)', () => {
  // keyframes at ticks 0, 2 and 3 of the four; positions and angles as differences
  const part = (over: Record<string, unknown> = {}) => ({
    e: 1, m: 98, c: 'func_movelinear', n: 'building_collapse',
    k: [0, 2, 1], x: [160, 0, 0], y: [2240, 0, 0], z: [-602, 0, -208], p: [0, 0, 0], w: [0, 90, 90], r: [0, 0, 0], ...over,
  })
  const withParts = (parts: unknown[], inputs?: unknown[]) => ({ ...good(), parts, ...(inputs ? { inputs } : {}) })

  test('are kept when they are valid, and a track without them has neither', () => {
    const input = { t: 420, e: 1, i: 'open', v: 'input' as const, by: A }
    const r = validateTrack(withParts([part()], [input, { t: 500, e: 1, i: 'use', v: 'use' as const }]), round)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.track.parts).toEqual([part()])
      expect(r.track.inputs).toEqual([input, { t: 500, e: 1, i: 'use', v: 'use' as const }])
    }
    const none = validateTrack(good(), round)
    expect(none.ok && 'parts' in none.track).toBe(false)
    expect(none.ok && 'inputs' in none.track).toBe(false)
  })

  test('two entities of one model are two parts; the same entity number twice is refused', () => {
    expect(validateTrack(withParts([part(), part({ e: 2 })]), round).ok).toBe(true)
    refused(withParts([part(), part()]), /own whole number e/)
  })

  test('a part needs a model number, a class that moves and a name made of the usual characters', () => {
    for (const bad of [0, 65536, 1.5, '98', null]) refused(withParts([part({ m: bad })]), /model number/)
    for (const bad of ['prop_physics', 'func_breakable', 'func_door ', '', 7]) refused(withParts([part({ c: bad })]), /class/)
    for (const bad of ['has space', 'x'.repeat(65), 5]) refused(withParts([part({ n: bad })]), /name/)
    for (const bad of [0, 65536, 1.5, '1']) refused(withParts([part({ e: bad })]), /own whole number e/)
    const { n, ...unnamed } = part()
    expect(validateTrack(withParts([unnamed]), round).ok).toBe(true)
  })

  test('the keyframes are ticks of the track, in order, one at most for each tick', () => {
    refused(withParts([part({ k: [0, 0, 1] })]), /in order/)           // two keyframes on one tick
    refused(withParts([part({ k: [0, 2, 2] })]), /past the last tick/) // tick 4 of a track with ticks 0 to 3
    refused(withParts([part({ k: [4, 0, 0] })]), /keyframes/)
    refused(withParts([part({ k: [-1, 2, 1] })]), /keyframes/)
    refused(withParts([part({ k: [] })]), /keyframes/)
    expect(validateTrack(withParts([part({ k: [3], x: [1], y: [1], z: [1], p: [0], w: [0], r: [0] })]), round).ok).toBe(true) // one keyframe, on the last tick
  })

  test('every array is as long as the keyframes, in whole numbers, and the sums stay inside the map and the angles', () => {
    for (const f of ['x', 'y', 'z', 'p', 'w', 'r']) refused(withParts([part({ [f]: [0, 0] })]), /same length/)
    refused(withParts([part({ x: [160, 0.5, 0] })]), /same length/)
    refused(withParts([part({ z: [30000, 3000, 0] })]), /outside the map/)        // 33,000 is past +-32,768
    refused(withParts([part({ w: [0, 1440, 1] })]), /angle/)                       // 1,441 quarter degrees
    refused(withParts([part({ x: [160, 70000, 0] })]), /same length/)              // one step past the biggest difference
    expect(validateTrack(withParts([part({ w: [-720, 1439, 1] })]), round).ok).toBe(true)
  })

  test('at most 256 parts, 4,000 keyframes for a part and 50,000 in all', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => part({ e: i + 1 }))
    expect(validateTrack(withParts(many(256)), round).ok).toBe(true)
    refused(withParts(many(257)), /at most 256/)
    const long = { ...good(), t: Array.from({ length: 5000 }, () => 1) }
    const keys = (n: number) => ({ e: 1, m: 5, c: 'func_door', k: Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 1)), x: Array(n).fill(0), y: Array(n).fill(0), z: Array(n).fill(0), p: Array(n).fill(0), w: Array(n).fill(0), r: Array(n).fill(0) })
    expect(validateTrack({ ...long, players: [{ id: A, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [], parts: [keys(4000)] }, round).ok).toBe(true)
    refused({ ...long, players: [{ id: A, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [], parts: [keys(4001)] }, /keyframes/)
    // 13 parts of 4,000 keyframes are 52,000 in all
    const big = Array.from({ length: 13 }, (_, i) => ({ ...keys(4000), e: i + 1 }))
    refused({ ...long, players: [{ id: A, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [], parts: big }, /50000 keyframes in all/)
  })

  test('an input names a part of the track, a listed input, how it came, a time in order, and a player of the round or nobody', () => {
    const ok = { t: 100, e: 1, i: 'toggle', v: 'use' as const, by: B }
    expect(validateTrack(withParts([part()], [ok]), round).ok).toBe(true)
    refused(withParts([part()], [{ ...ok, e: 2 }]), /part that is not/)
    refused(withParts([], [ok]), /part that is not/)
    for (const bad of ['kill', 'Open', '', 5]) refused(withParts([part()], [{ ...ok, i: bad }]), /not recorded/)
    for (const bad of ['', 'Use', undefined, 1]) refused(withParts([part()], [{ ...ok, v: bad }]), /input or a use/)
    refused(withParts([part()], [{ ...ok, by: '76561198999999999' }]), /was not in the round/)
    refused(withParts([part()], [{ ...ok, t: -1 }]), /invalid time/)
    refused(withParts([part()], [{ ...ok, t: 7 * 3600 * 1000 }]), /invalid time/)
    refused(withParts([part()], [ok, { ...ok, t: 50 }]), /time order/)
    refused(withParts([part()], Array.from({ length: 1025 }, () => ok)), /at most 1024/)
    expect(validateTrack(withParts([part()], Array.from({ length: 1024 }, () => ok)), round).ok).toBe(true)
  })

  test('parts and inputs must be lists', () => {
    refused({ ...good(), parts: {} }, /parts must be/)
    refused({ ...good(), parts: [1] }, /part must be an object/)
    refused({ ...withParts([part()]), inputs: 'x' }, /inputs must be/)
    refused({ ...withParts([part()]), inputs: [null] }, /input must be an object/)
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

  describe('things that moved (RFC 20, 4.8)', () => {
    const thing = (over: Record<string, unknown> = {}) => ({ e: 1, c: 'prop_physics', mdl: 'models/props_junk/wood_crate001a.mdl', b: [-8, -8, 0, 8, 8, 32], k: [0, 1], x: [100, 80], y: [100, 0], z: [0, 0], p: [0, 0], w: [0, 0], r: [0, 0], ...over })
    const withThings = (things: unknown[]) => ({ ...good(), things })
    test('a valid list is stored; weapons and prop doors are classes; the map id and the gone tick are kept', () => {
      const ok = validateTrack(withThings([thing({ id: 12, g: 3 }), thing({ e: 2, c: 'weapon_zm_shotgun' }), thing({ e: 3, c: 'prop_door_rotating' })]), round)
      expect(ok.ok).toBe(true)
      if (ok.ok) expect(ok.track.things!.map(t => [t.e, t.c, t.id, t.g])).toEqual([[1, 'prop_physics', 12, 3], [2, 'weapon_zm_shotgun', undefined, undefined], [3, 'prop_door_rotating', undefined, undefined]])
      const none = validateTrack(good(), round)
      if (none.ok) expect(none.track.things).toBeUndefined()
    })
    test('every check refuses', () => {
      for (const [bad, why] of [
        [thing({ c: 'func_door' }), /class/], [thing({ c: 'weapon_' }), /class/], [thing({ mdl: '../x.mdl' }), /model/], [thing({ mdl: 'a b' }), /model/],
        [thing({ b: [8, 0, 0, -8, 1, 1] }), /bounds/], [thing({ b: [0, 0, 0] }), /bounds/], [thing({ id: -1 }), /map id/],
        [thing({ e: 0 }), /own whole number/], [thing({ k: [] , x: [], y: [], z: [], p: [], w: [], r: [] }), /keyframes/], [thing({ k: [0, 0] }), /in order/],
        [thing({ x: [100] }), /same length/], [thing({ x: [100, 99999] }), /range|outside/], [thing({ g: 0 }), /gone/], [thing({ g: 9999 }), /gone/],
      ] as [unknown, RegExp][]) refused(withThings([bad]), why)
      refused(withThings([thing(), thing()]), /own whole number/)
      refused(withThings(Array.from({ length: 257 }, (_, i) => thing({ e: i + 1 }))), /at most 256/)
      refused({ ...good(), things: 'x' }, /at most 256/)
    })
  })
})
