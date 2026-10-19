import { expect, test, describe } from 'bun:test'
import { decodeTrack, poseAt, lastPoseAt, trailBetween, lerpYaw, levelOf, chooseBackground, versionMismatch, defaultSelection, teamColour, clock, type RawTrack } from '../src/replaylogic'

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
    expect(d.deaths[1]).toMatchObject({ at: [40, 48, 56], from: [8, 16, 24], weapon: 'w' })
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
