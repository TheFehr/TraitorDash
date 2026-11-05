import { expect, test, describe } from 'bun:test'
import { clipWeights, damp, dampAngle, decodeTrack, cyclesAt, sectorOf, DIRECTIONS, distanceAt, lerpAngle, moveAt, pathOf, velocityAt, SPEEDS, poseAt, lastPoseAt, trailBetween, lerpYaw, levelOf, chooseBackground, versionMismatch, defaultSelection, teamColour, playerColour, roleColour, clock, type RawTrack } from '../src/replaylogic'

// RFC 12, 3.5: the logic of the replay that is not drawing.

const raw = (over: Partial<RawTrack> = {}): RawTrack => ({
  t: [0, 200, 200, 200, 200, 200],
  players: [
    { id: 'A', segments: [{ from: 0, x: [10, 1, 1, 1, 1, 1], y: [0, 0, 0, 0, 0, 0], z: [2, 0, 0, 0, 0, 0], a: [0, 8, 8, 8, 8, 8] }] },
    // B is seen for ticks 0-2, absent for 3, and back for 4-5 (a gap)
    { id: 'B', segments: [
      { from: 0, x: [100, 10, 10], y: [0, 0, 0], z: [0, 0, 0], a: [250, -246, 0] },
      { from: 4, x: [50, 10], y: [0, 0], z: [0, 0], a: [0, 0] }] },
  ],
  deaths: [
    { victim: 'B', attacker: 'A', t: 900, vx: 5, vy: 6, vz: 7, ax: 1, ay: 2, az: 3, weapon: 'w' },
    { victim: 'A', attacker: null, t: 100, vx: 0, vy: 0, vz: 0, ax: null, ay: null, az: null, weapon: null },
  ],
  ...over,
})

describe('decodeTrack', () => {
  test('rebuilds times and positions from the differences, in units', () => {
    const d = decodeTrack(raw())
    expect(d.times).toEqual([0, 200, 400, 600, 800, 1000])
    expect(d.length).toBe(1000)
    const a = d.players.get('A')![0]!
    expect(a.t).toEqual(d.times)
    expect(a.x).toEqual([80, 88, 96, 104, 112, 120])
    expect(a.z).toEqual([16, 16, 16, 16, 16, 16])
    expect(a.a).toEqual([0, 8, 16, 24, 32, 40])
  })
  test('a segment takes the times of its own ticks', () => {
    const b = decodeTrack(raw()).players.get('B')!
    expect(b).toHaveLength(2)
    expect(b[0]!.t).toEqual([0, 200, 400])
    expect(b[1]!.t).toEqual([800, 1000])
    expect(b[1]!.x).toEqual([400, 480])
  })
  test('deaths are in time order, in units, and an attacker without a position has none', () => {
    const d = decodeTrack(raw())
    expect(d.deaths.map(x => x.victim)).toEqual(['A', 'B'])
    expect(d.deaths[1]).toMatchObject({ at: [40, 48, 0], from: [8, 16, 24], weapon: 'w' }) // the height 56 is 56 above B's sample before it: the eyes of a spectator, so the feet's 0
    expect(d.deaths[0]!.from).toBeNull()
  })
  test('an empty track has length 0', () => {
    expect(decodeTrack({ t: [], players: [], deaths: [] }).length).toBe(0)
  })
})

describe('poseAt: interpolation uses the real times', () => {
  const d = decodeTrack(raw())
  const a = d.players.get('A')!, b = d.players.get('B')!
  test('exactly on a sample, and between two by their times', () => {
    expect(poseAt(a, 200)).toMatchObject({ x: 88, z: 16 })
    expect(poseAt(a, 300)!.x).toBeCloseTo(92)
    expect(poseAt(a, 1000)!.x).toBe(120)
  })
  test('uneven ticks are interpolated by time, not by index', () => {
    const uneven = decodeTrack({ t: [0, 100, 800], players: [{ id: 'A', segments: [{ from: 0, x: [0, 10, 10], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [] })
    expect(poseAt(uneven.players.get('A')!, 50)!.x).toBeCloseTo(40) // halfway through the first 100 ms of 80 units
    expect(poseAt(uneven.players.get('A')!, 500)!.x).toBeCloseTo(120) // halfway through the long 800 ms step
  })
  test('before the first sample and after the last there is no pose', () => {
    expect(poseAt(a, -1)).toBeNull()
    expect(poseAt(a, 1001)).toBeNull()
  })
  test('a gap stays a gap: no pose between two segments, never a line across it', () => {
    expect(poseAt(b, 400)).not.toBeNull()
    expect(poseAt(b, 500)).toBeNull()
    expect(poseAt(b, 799)).toBeNull()
    expect(poseAt(b, 800)).not.toBeNull()
  })
  test('the heading takes the short way round', () => {
    expect(lerpYaw(250, 10, 0.5)).toBeCloseTo(2)
    expect(lerpYaw(10, 250, 0.5)).toBeCloseTo(2)
    expect(lerpYaw(0, 100, 0.5)).toBeCloseTo(50)
    expect(poseAt(b, 100)!.yaw).toBeCloseTo(255) // 250 -> 4 the short way (through 255, 0), halfway
  })
})

describe('lastPoseAt and trailBetween', () => {
  const d = decodeTrack(raw())
  const b = d.players.get('B')!
  test('the last pose at or before a time, across a gap, and none before the first', () => {
    expect(lastPoseAt(b, 500)).toMatchObject({ x: 960, yaw: 4 }) // the last sample of the first segment, at 400 ms
    expect(lastPoseAt(b, 900)!.x).toBe(400)
    expect(lastPoseAt(b, -5)).toBeNull()
  })
  test('a trail has the samples inside the window and the interpolated ends, and no line across a gap', () => {
    const a = d.players.get('A')!
    const t = trailBetween(a, 100, 500)
    expect(t.length % 3).toBe(0)
    expect(t[0]).toBeCloseTo(84) // 100 ms
    expect(t.slice(-3)[0]).toBeCloseTo(100) // 500 ms
    expect(t.length / 3).toBe(2 + 2) // the ends and the samples at 200 and 400
    const across = trailBetween(b, 300, 900)
    expect(across.length / 3).toBe(2 + 2) // 300-400 in the first segment, 800-900 in the second, nothing across the gap
  })
})

describe('levelOf', () => {
  const levels = [{ index: 1, lo: 0, hi: 120 }, { index: 2, lo: 130, hi: 260 }, { index: 3, lo: 250, hi: 400 }]
  test('a height inside a level, between levels, and beyond both ends', () => {
    expect(levelOf(levels, 60)).toBe(1)
    expect(levelOf(levels, 200)).toBe(2)
    expect(levelOf(levels, 125)).toBe(1) // nearer to the first's top (5) than to the second's bottom (5): tie goes to the lower... by middle
    expect(levelOf(levels, -500)).toBe(1)
    expect(levelOf(levels, 9000)).toBe(3)
  })
  test('where two levels both reach the height the one whose middle is nearer wins (stairs)', () => {
    expect(levelOf(levels, 255)).toBe(2) // 2 is 130-260 (mid 195), 3 is 250-400 (mid 325): 255 is nearer 195? |195-255|=60, |325-255|=70
    expect(levelOf(levels, 300)).toBe(3)
  })
  test('without levels everything is level 0', () => {
    expect(levelOf([], 10)).toBe(0)
  })
})

describe('background and selection', () => {
  test('the mesh is preferred, then the plan, then nothing', () => {
    expect(chooseBackground({ mesh: true, plan: true })).toBe('mesh')
    expect(chooseBackground({ mesh: false, plan: true })).toBe('plan')
    expect(chooseBackground({ mesh: true, plan: false })).toBe('mesh')
    expect(chooseBackground({ mesh: false, plan: false })).toBe('none')
  })
  test('another version is flagged; an unknown one is not', () => {
    expect(versionMismatch('a', 'b')).toBe(true)
    expect(versionMismatch('a', 'a')).toBe(false)
    expect(versionMismatch(null, 'a')).toBe(false)
    expect(versionMismatch('a', null)).toBe(false)
  })
  test('the viewer\'s own player if they took part; else the first victim; else the first player', () => {
    const deaths = [{ victim: 'C', t: 500 }, { victim: 'B', t: 100 }]
    expect(defaultSelection(['A', 'B', 'C'], 'C', deaths)).toBe('C')
    expect(defaultSelection(['A', 'B', 'C'], 'Z', deaths)).toBe('B') // not in the round: nobody by mistake
    expect(defaultSelection(['A', 'B', 'C'], null, deaths)).toBe('B')
    expect(defaultSelection(['A', 'B', 'C'], null, [])).toBe('A')
    expect(defaultSelection(['A'], null, [{ victim: 'X', t: 1 }])).toBe('A') // a victim who is not a player
    expect(defaultSelection([], 'A', [])).toBeNull()
  })
  test('team colours: the two teams are fixed, others stable', () => {
    expect(teamColour('traitors')).toBe(0xdc2626)
    expect(teamColour('innocents')).toBe(0x22c55e)
    expect(teamColour(null)).toBe(0x9ca3af)
    expect(teamColour('jackals')).toBe(teamColour('jackals'))
    expect(teamColour('jackals')).not.toBe(teamColour('infected'))
  })
  test('the clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(61_900)).toBe('1:01')
    expect(clock(-5)).toBe('0:00')
  })
})

describe('role colours', () => {
  test("a player is drawn in their role's colour, else their team's", () => {
    const c = { detective: '#1f4dbf', odd: 'red' }
    expect(playerColour(c, 'detective', 'innocents')).toBe(0x1f4dbf)
    expect(playerColour(c, 'innocent', 'innocents')).toBe(teamColour('innocents'))
    expect(playerColour(c, null, 'traitors')).toBe(teamColour('traitors'))
    expect(playerColour(c, 'odd', 'traitors')).toBe(teamColour('traitors'))
    expect(playerColour(c, 'toString', 'traitors')).toBe(teamColour('traitors'))
    expect(playerColour({}, 'x', null)).toBe(teamColour(null))
  })
  test('roleColour gives #rrggbb: the own colour when valid, else the team colour', () => {
    expect(roleColour('#0a141e', 'traitors')).toBe('#0a141e')
    expect(roleColour(null, 'traitors')).toBe('#dc2626')
    expect(roleColour('#fff', 'innocents')).toBe('#22c55e')
  })
})

import { fitLabel } from '../src/replaylogic'
describe('fitLabel', () => {
  // a fake font: every character is 0.6 of the font size wide
  const width = (s: string, px: number) => s.length * px * 0.6
  test('a short name keeps the full size', () => {
    expect(fitLabel('Fehr', width)).toEqual({ text: 'Fehr', px: 30 })
  })
  test('a longer name takes the largest size that fits', () => {
    const r = fitLabel('A_rather_long_name_', width)   // 19 characters: 30 px = 342 wide, 20 px = 228 wide
    expect(r.text).toBe('A_rather_long_name_')
    expect(r.px).toBe(20)
    expect(width(r.text, r.px)).toBeLessThanOrEqual(236)
  })
  test('a name too long for the smallest size ends in an ellipsis and fits', () => {
    const r = fitLabel('Longname_with_a_very_long_nickname_x', width)
    expect(r.px).toBe(18)
    expect(r.text.endsWith('…')).toBe(true)
    expect(width(r.text, r.px)).toBeLessThanOrEqual(236)
    expect(r.text.length).toBeGreaterThan(5)
  })
  test('nothing and one character are handled', () => {
    expect(fitLabel('', width)).toEqual({ text: '', px: 30 })
    expect(fitLabel('W', () => 999)).toEqual({ text: 'W…', px: 18 })
  })
})

describe('the height of a death', () => {
  // The track holds units / 8. A stands at height 16 (2) for three samples; at 1 000 ms it dies and the sample taken then is
  // at the height the game reports, which is `rise` units too high (the view of a spectator).
  const track = (rise: number, over: Partial<RawTrack> = {}): RawTrack => ({
    t: [0, 400, 300, 300], // 0, 400, 700, 1000 ms
    players: [{ id: 'A', segments: [{ from: 0, x: [10, 0, 0, 0], y: [0, 0, 0, 0], z: [2, 0, 0, rise / 8], a: [0, 0, 0, 0] }] }],
    deaths: [{ victim: 'A', attacker: null, t: 1000, vx: 10, vy: 0, vz: 2 + rise / 8, ax: null, ay: null, az: null, weapon: null }],
    ...over,
  })
  const of = (raw: RawTrack) => { const d = decodeTrack(raw); return { death: d.deaths[0]!.at, samples: d.players.get('A')![0]!.z } }

  test('a standing victim\'s death and the sample taken with it are put back to the height of their feet', () => {
    expect(of(track(64))).toEqual({ death: [80, 0, 16], samples: [16, 16, 16, 16] })
  })
  test('a ducking victim, whose eyes are lower, is corrected too', () => {
    expect(of(track(24)).death[2]).toBe(16)
    expect(of(track(32)).samples).toEqual([16, 16, 16, 16])
  })
  test('a death that is already at the height of the feet is left alone', () => {
    expect(of(track(0))).toEqual({ death: [80, 0, 16], samples: [16, 16, 16, 16] })
    expect(of(track(8)).death[2]).toBe(24) // a step, not eyes
  })
  test('a fall or a drop is what the game said', () => {
    expect(of(track(160)).death[2]).toBe(176)
    expect(of(track(-64)).death[2]).toBe(-48)
  })
  test('the samples before the death are not touched, and the place across is the one reported', () => {
    const raw = track(64)
    raw.deaths[0]!.vx = 11; raw.deaths[0]!.vy = 3
    const r = of(raw)
    expect(r.death).toEqual([88, 24, 16])
    expect(r.samples.slice(0, 3)).toEqual([16, 16, 16])
  })
  test('a victim with nothing sampled before the death, or a death that is not at a sample, is as reported', () => {
    expect(of(track(64, { t: [1000, 0, 0, 0] })).death[2]).toBe(80)
    const later = track(64); later.deaths[0]!.t = 1100 // no sample at the death: the one before it is the high one, so there is no rise to take off
    expect(of(later).death[2]).toBe(80)
  })
})

describe('how a player moves', () => {
  // A runs along x at 200 units a second (a sample every 200 ms, 40 units apart), then stands; its samples carry the bits of how it moves.
  const runner = () => decodeTrack({
    t: [0, 200, 200, 200, 200, 200],
    players: [{ id: 'A', segments: [{ from: 0, x: [0, 5, 5, 5, 0, 0], y: [0, 0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0, 0], s: [0, 0, 1, 1, 2, 0] }] }],
    deaths: [],
  } as any).players.get('A')!

  test('the bits of the sample at or before a time, and 0 where there is no sample (or no bits recorded)', () => {
    const segs = runner()
    expect(moveAt(segs, 0)).toBe(0)
    expect(moveAt(segs, 399)).toBe(0) // the third sample is at 400
    expect(moveAt(segs, 400)).toBe(1)
    expect(moveAt(segs, 700)).toBe(1)
    expect(moveAt(segs, 900)).toBe(2)
    expect(moveAt(segs, 1000)).toBe(0)
    expect(moveAt(segs, 5000)).toBe(0)
    expect(moveAt(segs, -5)).toBe(0)
    expect(moveAt(decodeTrack({ t: [0, 200], players: [{ id: 'A', segments: [{ from: 0, x: [0, 1], y: [0, 0], z: [0, 0], a: [0, 0] }] }], deaths: [] }).players.get('A')!, 100)).toBe(0)
  })

  test('the speed and the way a player goes, from a moment before and after', () => {
    const segs = runner()
    const v = velocityAt(segs, 400) // in the middle of the run
    expect(v.speed).toBeCloseTo(200, 0)
    expect(v.heading).toBeCloseTo(0, 5)
    expect(velocityAt(segs, 1000).speed).toBeCloseTo(0, 5) // stood still from the sample at 600 on
  })

  test('at the ends of a segment the speed is taken from the side there is', () => {
    const segs = runner()
    expect(velocityAt(segs, 0).speed).toBeCloseTo(200, 0)
    expect(velocityAt(segs, 1000).speed).toBeLessThan(5)
    expect(velocityAt([], 100)).toEqual({ speed: 0, heading: 0 })
  })

  test('the distance gone is the length of the path, a straight line between samples, and a gap adds nothing', () => {
    const segs = runner()
    const path = pathOf(segs)
    expect(distanceAt(path, 0)).toBe(0)
    expect(distanceAt(path, 200)).toBeCloseTo(40, 5)
    expect(distanceAt(path, 300)).toBeCloseTo(60, 5) // half way between 40 and 80
    expect(distanceAt(path, 1000)).toBeCloseTo(120, 5)
    expect(distanceAt(path, 99_999)).toBeCloseTo(120, 5)
    expect(distanceAt(path, -5)).toBe(0)
    const gap = pathOf(decodeTrack({ t: [0, 200, 200, 200], players: [{ id: 'A', segments: [
      { from: 0, x: [0, 5], y: [0, 0], z: [0, 0], a: [0, 0] }, { from: 2, x: [100, 5], y: [0, 0], z: [0, 0], a: [0, 0] }] }], deaths: [] }).players.get('A')!)
    expect(gap.d.at(-1)).toBeCloseTo(80, 5) // two 40-unit walks; the jump between the segments is not one
  })
})

describe('which clip is shown', () => {
  const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0)
  const only = (w: Record<string, number>) => Object.fromEntries(Object.entries(w).filter(([, v]) => v > 1e-9))
  test('standing still is idle, a walk is the walk clip, a run the run clip, and the speeds between are blends of two', () => {
    expect(only(clipWeights(0, 0, false))).toEqual({ idle: 1 })
    expect(only(clipWeights(SPEEDS.walk + 10, 0, false))).toEqual({ walk_f: 1 })
    expect(only(clipWeights(130, 0, false))).toEqual({ walk_f: 1 })
    expect(only(clipWeights(250, 0, false))).toEqual({ run_f: 1 })
    const slow = clipWeights((SPEEDS.still + SPEEDS.walk) / 2, 0, false)
    expect(slow.idle).toBeCloseTo(0.5, 5); expect(slow.walk_f).toBeCloseTo(0.5, 5)
    const quick = clipWeights((SPEEDS.run + SPEEDS.runFull) / 2, 0, false)
    expect(quick.walk_f).toBeCloseTo(0.5, 5); expect(quick.run_f).toBeCloseTo(0.5, 5)
  })
  test('a crouching player has the crouch clips', () => {
    expect(only(clipWeights(0, 0, true))).toEqual({ cidle: 1 })
    expect(only(clipWeights(120, 0, true))).toEqual({ cwalk_f: 1 })
  })
  test('the gait is shown in the direction the player goes relative to where they look: backwards, to the side, and between', () => {
    expect(only(clipWeights(120, Math.PI, false))).toEqual({ walk_b: 1 })
    expect(only(clipWeights(120, Math.PI / 2, false))).toEqual({ walk_l: 1 }) // +y is to the left
    expect(only(clipWeights(120, -Math.PI / 2, false))).toEqual({ walk_r: 1 })
    expect(only(clipWeights(250, -Math.PI / 4, false))).toEqual({ run_fr: 1 })
    expect(only(clipWeights(120, 3 * Math.PI, true))).toEqual({ cwalk_b: 1 }) // any number of turns
    const between = clipWeights(120, Math.PI / 8, false)
    expect(between.walk_f).toBeCloseTo(0.5, 9); expect(between.walk_fl).toBeCloseTo(0.5, 9)
    const wrap = clipWeights(120, -Math.PI / 8, false) // from forward-right across the front to forward
    expect(wrap.walk_f).toBeCloseTo(0.5, 9); expect(wrap.walk_fr).toBeCloseTo(0.5, 9)
  })
  test('the weights always add up to one, in every direction', () => {
    for (let v = 0; v <= 400; v += 7) for (const c of [false, true]) for (let r = -7; r <= 7; r += 0.37) expect(sum(clipWeights(v, r, c))).toBeCloseTo(1, 9)
  })
  test('the directions are the eight of the model, counter-clockwise from ahead', () => {
    expect([...DIRECTIONS]).toEqual(['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'])
    expect(sectorOf(0)).toEqual({ a: 0, b: 1, f: 0 })
    expect(sectorOf(-0.01).a).toBe(7)
  })
})

describe('the cycles of a walk', () => {
  const strides = { walk: [80, 60, 45, 50, 60, 50, 45, 60], run: [126, 90, 90, 90, 100, 90, 90, 90], cwalk: [60, 42, 60, 42, 60, 42, 60, 42] }
  // the track holds positions in eighths of a unit, each after the first as a step from the one before, so a step of one is eight units
  const line = (heading: number, look: number) => decodeTrack({ t: [0, 100, 100], players: [{ id: 'A', segments: [{
    from: 0, x: [0, Math.cos(heading), Math.cos(heading)], y: [0, Math.sin(heading), Math.sin(heading)], z: [0, 0, 0],
    a: [Math.round(look / (2 * Math.PI) * 256), 0, 0] }] }], deaths: [] }).players.get('A')!
  test('a step is divided by the stride of the direction it goes in relative to the look', () => {
    expect(cyclesAt(pathOf(line(0, 0), strides), 'walk', 200)).toBeCloseTo(16 / 80, 5) // ahead
    expect(cyclesAt(pathOf(line(Math.PI, 0), strides), 'walk', 200)).toBeCloseTo(16 / 60, 5) // backwards
    expect(cyclesAt(pathOf(line(Math.PI / 2, 0), strides), 'walk', 200)).toBeCloseTo(16 / 45, 5) // to the left
    expect(cyclesAt(pathOf(line(Math.PI / 2, Math.PI / 2), strides), 'walk', 200)).toBeCloseTo(16 / 80, 5) // looking where it goes
    expect(cyclesAt(pathOf(line(0, 0), strides), 'run', 100)).toBeCloseTo(8 / 126, 5)
  })
  test('between samples it is a straight line, and a path made without strides has none', () => {
    expect(cyclesAt(pathOf(line(0, 0), strides), 'walk', 50)).toBeCloseTo(4 / 80, 5)
    expect(cyclesAt(pathOf(line(0, 0)), 'walk', 200)).toBe(0)
  })
})

describe('turning an angle', () => {
  test('an angle is turned the short way round', () => {
    expect(lerpAngle(0.1, 0.3, 0.5)).toBeCloseTo(0.2, 9)
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(3 + 0.5 * (2 * Math.PI - 6), 9) // across the back, not through zero
    expect(lerpAngle(1, 1, 0.7)).toBeCloseTo(1, 9)
  })
})

describe('damping (the follow camera)', () => {
  test('covers the same fraction of the way in the same time, however it is cut into frames', () => {
    let one = 0
    one = damp(one, 100, 100, 80)
    let ten = 0
    for (let i = 0; i < 10; i++) ten = damp(ten, 100, 10, 80)
    expect(one).toBeCloseTo(ten, 9)
    expect(one).toBeCloseTo(100 * (1 - Math.exp(-100 / 80)), 9)
  })
  test('stays where it is when no time has passed, and gets there in the end', () => {
    expect(damp(5, 100, 0, 80)).toBe(5)
    expect(damp(5, 100, -10, 80)).toBe(5)
    expect(damp(0, 100, 10_000, 80)).toBeCloseTo(100, 6)
  })
  test('an angle goes the short way round', () => {
    const a = dampAngle(3.0, -3.0, 100, 100) // 3 to -3 is a short step across pi, not six radians back
    expect(a).toBeGreaterThan(3.0)
    expect(dampAngle(0.2, 0.2, 100, 100)).toBeCloseTo(0.2, 9)
  })
})
