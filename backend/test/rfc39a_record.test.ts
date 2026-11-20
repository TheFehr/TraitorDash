import { expect, test, describe } from 'bun:test'
import { validateTrack } from '../src/services/tracks'
import { decodeTrack, poseAt, pitchAt, eyeHeights, EYE_STAND, EYE_DUCK, type RawTrack } from '../src/replaylogic'

// RFC 39, stage A: what the backend accepts of the view pitch, the eye heights and the weapon models, and what the replay makes of them.

const A = '76561198000000001', B = '76561198000000002'
const round = { roundId: 'a1b2c3d4-0001', map: 'ttt_example', players: new Set([A, B]) }
const FP = 'cd'.repeat(32)
const good = (over: Record<string, unknown> = {}, seg: Record<string, unknown> = {}, player: Record<string, unknown> = {}) => ({
  round_id: round.roundId, map: 'ttt_example', fingerprint: FP, truncated: false, degraded: false,
  t: [0, 200, 200, 200],
  players: [{ id: A, ...player, segments: [{ from: 0, x: [120, 3, -1, 0], y: [-80, 0, 4, 0], z: [30, 0, 0, 0], a: [12, 2, -1, 0], ...seg }] }],
  deaths: [],
  ...over,
})
const refused = (body: unknown, part: RegExp) => { const r = validateTrack(body, round); expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(part) }

describe('validateTrack: pitch (ap)', () => {
  test('whole numbers, as many as there are positions, adding up inside -360..360, are kept', () => {
    const r = validateTrack(good({}, { ap: [0, 100, -460, 360] }), round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.players[0]!.segments[0]!.ap).toEqual([0, 100, -460, 360])
  })
  test('a track without ap is as good as before', () => { expect(validateTrack(good(), round).ok).toBe(true) })
  test('the wrong length, fractions, strings and a running sum outside the range are refused', () => {
    refused(good({}, { ap: [0, 1, 2] }), /ap must/)
    refused(good({}, { ap: [0, 1.5, 0, 0] }), /ap must/)
    refused(good({}, { ap: [0, 'x', 0, 0] }), /ap must/)
    refused(good({}, { ap: [0, 400, 0, 0] }), /ap must/)
    refused(good({}, { ap: [0, -361, 0, 0] }), /ap must/)
    refused(good({}, { ap: 5 }), /ap must/)
  })
})

describe('validateTrack: eye heights (eh, ed)', () => {
  test('whole numbers from 1 to 128 are kept', () => {
    const r = validateTrack(good({}, {}, { eh: 64, ed: 28 }), round)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.track.players[0]!.eh).toBe(64); expect(r.track.players[0]!.ed).toBe(28) }
  })
  test('0, 129, fractions and strings are refused', () => {
    for (const k of ['eh', 'ed']) for (const v of [0, 129, 64.5, '64', null]) refused(good({}, {}, { [k]: v }), new RegExp(`${k} must`))
  })
})

describe('validateTrack: weapon models (wm)', () => {
  test('a class to a plain models path is kept; none is fine', () => {
    const r = validateTrack(good({ wm: { weapon_ttt_m16: 'models/weapons/w_rif_m4a1.mdl', weapon_zm_mac10: 'models/weapons/gamefreak/w_kid_mac.mdl' } }), round)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.wm).toEqual({ weapon_ttt_m16: 'models/weapons/w_rif_m4a1.mdl', weapon_zm_mac10: 'models/weapons/gamefreak/w_kid_mac.mdl' })
    const none = validateTrack(good({ wm: {} }), round)
    expect(none.ok && none.track.wm).toBeFalsy()
  })
  test('paths that are not models, are not lower case, climb out with .., are too long or are not strings are refused, so are bad class words and arrays', () => {
    for (const p of ['materials/x.vmt', 'Models/weapons/a.mdl', 'models/../a.mdl', 'models/' + 'a'.repeat(130) + '.mdl', 'models/a b.mdl', 'models/a.mdl\n', 7, null]) refused(good({ wm: { weapon_x: p } }), /wm holds/)
    refused(good({ wm: { 'bad class': 'models/a.mdl' } }), /wm holds/)
    refused(good({ wm: ['models/a.mdl'] }), /wm must/)
    refused(good({ wm: 'models/a.mdl' }), /wm must/)
  })
  test('more than 64 classes are refused', () => {
    const wm: Record<string, string> = {}
    for (let i = 0; i < 65; i++) wm['w' + i] = `models/w${i}.mdl`
    refused(good({ wm }), /at most 64/)
  })
})

const raw = (over: Partial<RawTrack> = {}): RawTrack => ({
  t: [0, 1000, 1000, 1000],
  players: [
    { id: A, eh: 60, ed: 30, segments: [{ from: 0, x: [0, 0, 0, 0], y: [0, 0, 0, 0], z: [0, 0, 0, 0], a: [0, 0, 0, 0], ap: [0, 40, 40, -40] }] }, // 0, 10, 20, 10 degrees
    { id: B, segments: [{ from: 0, x: [0, 0, 0, 0], y: [0, 0, 0, 0], z: [0, 0, 0, 0], a: [0, 0, 0, 0] }] },
  ],
  deaths: [],
  wm: { weapon_ttt_m16: 'models/weapons/w_rif_m4a1.mdl' },
  ...over,
})

describe('the replay: pitch, eyes and weapon models', () => {
  test('the pitch is rebuilt in degrees; a track without it has none; eyes and weapon models are kept, the defaults fill the rest', () => {
    const d = decodeTrack(raw())
    expect(d.players.get(A)![0]!.ap).toEqual([0, 10, 20, 10])
    expect('ap' in d.players.get(B)![0]!).toBe(false)
    expect(d.eyes.get(A)).toEqual({ stand: 60, duck: 30 })
    expect(eyeHeights(d.eyes, A)).toEqual({ stand: 60, duck: 30 })
    expect(eyeHeights(d.eyes, B)).toEqual({ stand: EYE_STAND, duck: EYE_DUCK })
    expect([EYE_STAND, EYE_DUCK]).toEqual([64, 28])
    expect(d.weaponModels.get('weapon_ttt_m16')).toBe('models/weapons/w_rif_m4a1.mdl')
    expect(decodeTrack(raw({ wm: undefined })).weaponModels.size).toBe(0)
  })
  test('a player with only one of the two heights gets the default for the other', () => {
    const d = decodeTrack(raw({ players: [{ id: A, eh: 70, segments: raw().players[0]!.segments }] }))
    expect(d.eyes.get(A)).toEqual({ stand: 70, duck: EYE_DUCK })
  })
  test('pitchAt passes exactly through the samples, is smooth between them, never goes beyond what the samples around it say, and is null without data', () => {
    const segs = decodeTrack(raw()).players.get(A)!
    expect(pitchAt(segs, 0)).toBe(0); expect(pitchAt(segs, 1000)).toBe(10); expect(pitchAt(segs, 2000)).toBe(20); expect(pitchAt(segs, 3000)).toBe(10)
    const mid = pitchAt(segs, 500)!
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(10)
    const peak = Math.max(...[2000, 2250, 2500, 2750, 3000].map(t => pitchAt(segs, t)!)) // the curve must not overshoot the highest sample (20)
    expect(peak).toBeLessThanOrEqual(20.0001)
    expect(pitchAt(segs, -5)).toBeNull(); expect(pitchAt(segs, 3001)).toBeNull()
    expect(pitchAt(decodeTrack(raw()).players.get(B)!, 500)).toBeNull() // a track without pitch
  })
  test('the pitch is smooth: no jump larger than the samples allow between neighbouring milliseconds', () => {
    const segs = decodeTrack(raw()).players.get(A)!
    let prev = pitchAt(segs, 0)!
    for (let t = 10; t <= 3000; t += 10) { const v = pitchAt(segs, t)!; expect(Math.abs(v - prev)).toBeLessThan(0.5); prev = v }
  })
  test('poseAt is unchanged by a pitch in the track', () => {
    const withAp = decodeTrack(raw()).players.get(A)!
    const without = decodeTrack(raw({ players: [{ id: A, segments: [{ from: 0, x: [0, 0, 0, 0], y: [0, 0, 0, 0], z: [0, 0, 0, 0], a: [0, 0, 0, 0] }] }] })).players.get(A)!
    expect(poseAt(withAp, 1500)).toEqual(poseAt(without, 1500))
  })
})
