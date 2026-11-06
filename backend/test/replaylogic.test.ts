import { expect, test, describe } from 'bun:test'
import { clipWeights, damp, dampAngle, decodeTrack, cyclesAt, sectorOf, DIRECTIONS, distanceAt, lerpAngle, moveAt, pathOf, velocityAt, SPEEDS, poseAt, lastPoseAt, trailBetween, lerpYaw, levelOf, holdLevel, LEVEL_HOLD_MS, cutHeight, shownLevels, FADE, overheadFade, NO_CUT, chooseBackground, versionMismatch, defaultSelection, teamColour, playerColour, roleColour, clock, type RawTrack } from '../src/replaylogic'

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
    // (the track holds each tick as the step from the one before, so these ticks are at 0, 100 and 800 ms) a player at a steady 800 units a second: one straight line, by time
    const steady = decodeTrack({ t: [0, 100, 700], players: [{ id: 'A', segments: [{ from: 0, x: [0, 10, 70], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [] }).players.get('A')!
    expect(poseAt(steady, 50)!.x).toBeCloseTo(40, 6) // halfway through the first 100 ms of 80 units
    expect(poseAt(steady, 400)!.x).toBeCloseTo(320, 6) // 400 ms at 800 units a second, though it is not the middle of the second step by index
    // one that stops: it is where it was sampled at each sample and stands still for the whole long step
    const stops = decodeTrack({ t: [0, 100, 700], players: [{ id: 'A', segments: [{ from: 0, x: [0, 10, 0], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [] }).players.get('A')!
    expect(poseAt(stops, 100)!.x).toBeCloseTo(80, 6)
    expect(poseAt(stops, 500)!.x).toBeCloseTo(80, 6)
    expect(poseAt(stops, 50)!.x).toBeGreaterThan(40) // it slows down into the stop: further than half the way at half the time
    expect(poseAt(stops, 50)!.x).toBeLessThan(80)
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
    const turn = poseAt(b, 100)!.yaw // 250 -> 4 the short way (through 255, 0), about halfway; never the long way round
    expect(turn > 250 || turn < 4).toBe(true)
    expect(Math.min(Math.abs(turn - 255), Math.abs(turn - 255 + 256), Math.abs(turn - 255 - 256))).toBeLessThan(3)
  })
})

describe('poseAt: a smooth curve through the samples', () => {
  // a track holds every number after the first as the step from the one before; positions in eighths of a unit, yaw in 256ths of a turn
  const one = (t: number[], x: number[], y: number[], a: number[] = x.map(() => 0), z: number[] = x.map(() => 0)) =>
    decodeTrack({ t, players: [{ id: 'A', segments: [{ from: 0, x, y, z, a }] }], deaths: [] }).players.get('A')!
  const steps = (v: number[]) => v.map((n, i) => (i ? n - v[i - 1]! : n))
  const track = (times: number[], xs: number[], ys: number[], yaws?: number[]) => one(steps(times), steps(xs), steps(ys), yaws ? steps(yaws) : undefined)
  const speed = (segs: any, ms: number, h = 1) => { const a = poseAt(segs, ms - h)!, b = poseAt(segs, ms + h)!; return { x: (b.x - a.x) / (2 * h), y: (b.y - a.y) / (2 * h) } }

  test('it is exactly on every sample', () => {
    const segs = track([0, 200, 400, 600, 900], [0, 10, 25, 30, 31], [0, 5, 0, -8, -9], [0, 10, 40, 60, 70])
    for (const [i, t] of [0, 200, 400, 600, 900].entries()) {
      const p = poseAt(segs, t)!
      expect(p.x).toBeCloseTo(segs[0]!.x[i]!, 9); expect(p.y).toBeCloseTo(segs[0]!.y[i]!, 9); expect(p.yaw).toBeCloseTo(segs[0]!.a[i]!, 9)
    }
  })

  test('a player going at a steady speed in a straight line is on that line, at that speed, at any time', () => {
    const segs = track([0, 200, 400, 600, 1000], [0, 20, 40, 60, 100], [0, 10, 20, 30, 50]) // 160 units a second along x, 80 along y (x8)
    for (const t of [10, 100, 199, 250, 530, 777, 990]) {
      const p = poseAt(segs, t)!
      expect(p.x).toBeCloseTo(t * 0.8 * 1, 6); expect(p.y).toBeCloseTo(t * 0.4 * 1, 6)
    }
  })

  test('there is no change of speed at a sample, where straight lines had one', () => {
    // going round a bend: samples every 200 ms along a quarter circle of 1,600 units
    const n = 8, xs: number[] = [], ys: number[] = [], ts: number[] = []
    for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); ts.push(i * 200); xs.push(Math.round(1600 * Math.sin(a) / 8)); ys.push(Math.round(1600 * (1 - Math.cos(a)) / 8)) }
    const segs = track(ts, xs, ys)
    const jump = (at: number, v: (ms: number) => { x: number, y: number }) => { const a = v(at - 3), b = v(at + 3); return Math.hypot(b.x - a.x, b.y - a.y) }
    const linear = (ms: number) => { // the straight lines it used to be, over the same samples
      const i = Math.min(Math.floor(ms / 200), n - 1), f = (ms - i * 200) / 200
      return { x: (xs[i]! + (xs[i + 1]! - xs[i]!) * f) * 8, y: (ys[i]! + (ys[i + 1]! - ys[i]!) * f) * 8 }
    }
    for (const at of [400, 600, 800, 1000, 1200]) {
      const smooth = jump(at, ms => ({ x: speed(segs, ms, 1).x, y: speed(segs, ms, 1).y })) // change of velocity over the two sides of a sample, units per ms
      const line = jump(at, ms => { const a = linear(ms - 1), b = linear(ms + 1); return { x: (b.x - a.x) / 2, y: (b.y - a.y) / 2 } })
      expect(line).toBeGreaterThan(0.03) // what straight lines do: a kink in the velocity at every sample
      expect(smooth).toBeLessThan(line * 0.25) // and the curve: next to none
    }
  })

  test('it never goes beyond the two samples it is between, in any direction, also where a player turns round or stops', () => {
    const segs = track([0, 200, 400, 600, 1400, 1600], [0, 40, 0, 0, 30, 30], [0, 0, 20, 21, 21, -5], [0, 10, 50, 70, 70, 200])
    for (let i = 0; i + 1 < segs[0]!.t.length; i++) {
      for (const k of ['x', 'y', 'z'] as const) {
        const lo = Math.min(segs[0]![k][i]!, segs[0]![k][i + 1]!), hi = Math.max(segs[0]![k][i]!, segs[0]![k][i + 1]!)
        for (let f = 0; f <= 1; f += 0.05) {
          const v = poseAt(segs, segs[0]!.t[i]! + (segs[0]!.t[i + 1]! - segs[0]!.t[i]!) * f)![k]
          expect(v).toBeGreaterThanOrEqual(lo - 1e-9); expect(v).toBeLessThanOrEqual(hi + 1e-9)
        }
      }
    }
  })

  test('the view direction turns the short way and smoothly across 0, never the long way round', () => {
    const segs = track([0, 200, 400, 600, 800], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [250, 254, 2, 6, 10]) // turning through 0 (as 250, 254, 258, 262, 266)
    for (let t = 0; t <= 800; t += 10) {
      const y = poseAt(segs, t)!.yaw
      expect(y >= 249.9 || y <= 10.1).toBe(true) // never through the middle of the circle
    }
    let last = poseAt(segs, 0)!.yaw
    for (let t = 10; t <= 800; t += 10) { // one way only: no step back
      const y = poseAt(segs, t)!.yaw
      expect((((y - last) % 256) + 256) % 256).toBeLessThan(10)
      last = y
    }
    expect(poseAt(segs, 400)!.yaw).toBeCloseTo(2, 9)
  })

  test('two samples at the same time, one sample and a long still step give a pose and no NaN', () => {
    const twins = one([0, 0, 200], [0, 5, 5], [0, 0, 0])
    for (const t of [0, 100, 200]) { const p = poseAt(twins, t); expect(p).not.toBeNull(); expect(Number.isFinite(p!.x + p!.y + p!.z + p!.yaw)).toBe(true) }
    expect(poseAt(one([0], [3], [4]), 0)).toMatchObject({ x: 24, y: 32 })
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
    const v = velocityAt(segs, 200) // in the run, where it goes at a steady speed on both sides
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

describe('holdLevel', () => {
  const walk = (raws: [number, number][]) => { let st: ReturnType<typeof holdLevel> | null = null; return raws.map(([ms, raw]) => (st = holdLevel(st, raw, ms)).level) }

  test('going up is at once, so a player who climbed is never hidden by a cut that is one level too low', () => {
    expect(walk([[0, 1], [200, 1], [400, 2], [600, 2]])).toEqual([1, 1, 2, 2])
  })

  test('going down waits until the player has been found lower for the hold time', () => {
    expect(walk([[0, 2], [200, 1], [400, 1], [200 + LEVEL_HOLD_MS - 1, 1]]).slice(0, 3)).toEqual([2, 2, 2])
    expect(walk([[0, 2], [200, 1], [400, 1], [200 + LEVEL_HOLD_MS, 1]])).toEqual([2, 2, 2, 1])
  })

  test('on stairs the height crosses the line again and again and the level does not flicker', () => {
    const raws: [number, number][] = [[0, 2], [100, 1], [200, 2], [300, 1], [400, 2], [500, 1], [600, 2], [700, 1], [800, 2]]
    expect(walk(raws)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2])
  })

  test('a seek (back in time, or more than 1.5 s ahead), the first call and a level of 0 take the level as it is', () => {
    expect(walk([[5000, 3], [4000, 1]])).toEqual([3, 1]) // back
    expect(walk([[0, 3], [3000, 1]])).toEqual([3, 1]) // far ahead
    expect(walk([[0, 0], [100, 2]])).toEqual([0, 2])
    expect(walk([[0, 2], [100, 0]])).toEqual([2, 0])
  })

  test('two lower levels in turn each need their own hold', () => {
    expect(walk([[0, 3], [100, 2], [300, 1], [600, 1], [700, 1]])).toEqual([3, 3, 3, 3, 1])
  })
})

describe('cutHeight and shownLevels', () => {
  const levels = [{ index: 1, lo: 0, hi: 100 }, { index: 2, lo: 200, hi: 300 }, { index: 3, lo: 400, hi: 500 }]

  test('a level is cut a little above its floors; all, a level that is not there and a map with no levels are not cut', () => {
    expect(cutHeight(levels, 1)).toBe(228)
    expect(cutHeight(levels, 3)).toBe(628)
    expect(cutHeight(levels, 'all')).toBe(NO_CUT)
    expect(cutHeight(levels, 9)).toBe(NO_CUT)
    expect(cutHeight([], 1)).toBe(NO_CUT)
  })

  test('the follow camera that follows the player\'s level shows everything; every other case keeps the level that is chosen', () => {
    expect(shownLevels(2, true, 'follow')).toBe('all')
    expect(shownLevels(2, true, 'orbit')).toBe(2) // the cutaway, to look into a building from outside
    expect(shownLevels(2, true, 'top')).toBe(2)
    expect(shownLevels(2, false, 'follow')).toBe(2) // a level the viewer picked is kept
    expect(shownLevels('all', false, 'follow')).toBe('all')
  })
})

describe('FADE and overheadFade', () => {
  test('the cone is narrow: it was up to 400 units wide at the camera', () => {
    expect(FADE.base + FADE.gain).toBeLessThanOrEqual(200)
    expect(FADE.base).toBeGreaterThanOrEqual(60) // wide enough for the body (32 units across) and some margin
  })

  // the camera 300 units behind the player and 100 above their eyes, looking along +x; the eyes at y 64
  const cam: [number, number, number] = [-300, 164, 0], head: [number, number, number] = [0, 64, 0]

  test('beyond the player, what is above their head is faded and what is at their height or below is not (a plank hid nothing)', () => {
    expect(overheadFade(cam, head, [100, 200, 0])).toBe(1) // a roof just beyond them
    expect(overheadFade(cam, head, [100, 64 + FADE.headroom - 1, 0])).toBe(0) // below the head room
    expect(overheadFade(cam, head, [100, 30, 0])).toBe(0) // a plank at the shins
    expect(overheadFade(cam, head, [100, -50, 0])).toBe(0) // the ground
  })

  test('only within the box beyond and beside the player: not before them, not far beyond, not far to the side', () => {
    expect(overheadFade(cam, head, [-100, 200, 0])).toBe(0) // before them
    expect(overheadFade(cam, head, [FADE.past + 10, 200, 0])).toBe(0)
    expect(overheadFade(cam, head, [100, 200, FADE.side + 10])).toBe(0)
    expect(overheadFade(cam, head, [100, 200, -FADE.side - 10])).toBe(0)
    const edge = overheadFade(cam, head, [0.8 * FADE.past, 200, 0])
    expect(edge).toBeGreaterThan(0); expect(edge).toBeLessThan(1) // it fades out at the edge, not at once
  })

  test('the box follows the way the camera looks', () => {
    const camZ: [number, number, number] = [0, 164, -300] // looking along +z
    expect(overheadFade(camZ, head, [0, 200, 100])).toBe(1)
    expect(overheadFade(camZ, head, [FADE.side + 40, 200, 0])).toBe(0) // beside them, outside the side
    expect(overheadFade(camZ, head, [0, 200, -100])).toBe(0)
  })
})
