import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import {
  decodeTrack, povVerticalFov, eyeHeightAt, povEye, povDirection, turnToBody, povSubject, hurtsDealt, cueLevels, shownLevels,
  POV_FOV, POV_NEAR, POV_VFOV_MAX, DUCK_BLEND_MS, DEATH_TURN_MS, HIT_MS, VIGNETTE_MS, type RawTrack, type TrackEvent, type Segment,
} from '../src/replaylogic'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 39, stage B: the POV camera: what the camera is made of (the eye, the lens, whose eyes after a death, the cues) and the facts of the page and the replay code.

const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
const A = 'A', K = 'K', J = 'J'
const flat = (n: number, extra: Partial<RawTrack['players'][0]['segments'][0]> = {}) => ({ from: 0, x: Array(n).fill(0), y: Array(n).fill(0), z: Array(n).fill(0), a: Array(n).fill(0), ...extra })
const raw = (over: Partial<RawTrack> = {}): RawTrack => ({
  t: [0, 200, 200, 200, 200, 200],
  players: [
    // A stands at the origin, looks down 10 degrees (40 quarter degrees) and crouches in samples 2-3
    { id: A, eh: 64, ed: 28, segments: [flat(6, { s: [0, 0, 1, 1, 0, 0], ap: [40, 0, 0, 0, 0, 0] })] },
    { id: K, segments: [flat(6, { x: [100, 0, 0, 0, 0, 0], a: [64, 0, 0, 0, 0, 0] })] }, // K at x = 800 units, heading 64 (90 degrees)
    { id: J, segments: [flat(6)] },
  ],
  deaths: [],
  ...over,
})
const seg = (r: RawTrack, id: string): Segment[] => decodeTrack(r).players.get(id)!
const death = (victim: string, attacker: string | null, t: number) => ({ victim, attacker, t, vx: 0, vy: 0, vz: 0, ax: attacker ? 800 : null, ay: attacker ? 0 : null, az: attacker ? 0 : null, weapon: 'weapon_zm_mac10' })

describe('the lens', () => {
  test('a wide canvas: the vertical field follows from the horizontal one; a tall one is capped at 100', () => {
    expect(povVerticalFov(POV_FOV.normal, 16 / 9)).toBeCloseTo(59, 0) // 90 horizontal on 16:9
    expect(povVerticalFov(POV_FOV.normal, 1)).toBeCloseTo(90, 5)
    expect(povVerticalFov(POV_FOV.normal, 390 / 560)).toBe(POV_VFOV_MAX) // a phone: 90 horizontal would be 108 vertical
    expect(povVerticalFov(POV_FOV.wide, 390 / 560)).toBe(POV_VFOV_MAX)
    expect(povVerticalFov(POV_FOV.wide, 16 / 9)).toBeGreaterThan(povVerticalFov(POV_FOV.normal, 16 / 9))
  })
  test('the constants: 90 to start, wide 105, near plane 2', () => { expect([POV_FOV.normal, POV_FOV.wide, POV_NEAR]).toEqual([90, 105, 2]) })
})

describe('the eye', () => {
  const eye = { stand: 64, duck: 28 }
  test('standing and crouching heights by the crouch bit; the start of a segment is at its height at once', () => {
    const s = seg(raw(), A)
    expect(eyeHeightAt(s, 0, eye)).toBe(64)
    expect(eyeHeightAt(s, 400 + 200, eye)).toBe(28) // well after the crouch began (sample 2 at 400 ms): sample 3 at 600 ms is the state, blend done
    expect(eyeHeightAt(s, 1000, eye)).toBe(64)
  })
  test('it moves smoothly between the two over 150 ms and never beyond them', () => {
    const s = seg(raw(), A) // crouch shows first at sample 2 (400 ms)
    expect(eyeHeightAt(s, 400, eye)).toBeCloseTo(64, 5)
    const mid = eyeHeightAt(s, 400 + DUCK_BLEND_MS / 2, eye)
    expect(mid).toBeLessThan(64); expect(mid).toBeGreaterThan(28)
    expect(eyeHeightAt(s, 400 + DUCK_BLEND_MS, eye)).toBeCloseTo(28, 5)
    let prev = 64
    for (let t = 400; t <= 560; t += 5) { const h = eyeHeightAt(s, t, eye); expect(h).toBeLessThanOrEqual(prev + 1e-9); expect(h).toBeGreaterThanOrEqual(28 - 1e-9); prev = h }
  })
  test('no segment at that time: the standing height', () => { expect(eyeHeightAt(seg(raw(), A), 99999, eye)).toBe(64) })
  test('povEye: the position plus the eye height, the heading, the pitch in degrees (level for a track without it); null with no sample', () => {
    const e = povEye(seg(raw(), A), 0, eye)!
    expect(e.z).toBe(0 + 64); expect(e.pitch).toBeCloseTo(10, 5); expect(e.yaw).toBe(0)
    expect(povEye(seg(raw(), J), 0, eye)!.pitch).toBe(0)
    expect(povEye(seg(raw(), A), 99999, eye)).toBeNull()
    expect(povEye(seg(raw(), K), 0, eye)!.x).toBe(800)
  })
})

describe('the direction', () => {
  const near = (v: number[], w: number[]) => v.forEach((c, i) => expect(c).toBeCloseTo(w[i]!, 5))
  test('heading 0 looks along +x, 64 along +y (three: -z), positive pitch looks down, level stays level', () => {
    near(povDirection({ yaw: 0, pitch: 0 }), [1, 0, 0])
    near(povDirection({ yaw: 64, pitch: 0 }), [0, 0, -1])
    const down = povDirection({ yaw: 0, pitch: 45 }); expect(down[1]).toBeLessThan(0)
    const up = povDirection({ yaw: 0, pitch: -45 }); expect(up[1]).toBeGreaterThan(0)
  })
  test('never straight up or down (the camera would have no side)', () => {
    expect(Math.abs(povDirection({ yaw: 0, pitch: 90 })[1])).toBeLessThan(1)
    expect(Math.abs(povDirection({ yaw: 0, pitch: -200 })[1])).toBeLessThan(1)
  })
})

describe('the death: whose eyes', () => {
  const data = (r: RawTrack) => { const d = decodeTrack(r); return { deaths: d.deaths, events: d.events, players: d.players } }
  test('a living player is their own subject', () => { expect(povSubject(data(raw()), A, 400)).toEqual({ id: A, killed: null, dead: null }) })
  test('after a death by a player of the round: the killer, and the overlay knows who died', () => {
    const r = raw({ deaths: [death(A, K, 600)] })
    expect(povSubject(data(r), A, 500).id).toBe(A)
    const s = povSubject(data(r), A, 700)
    expect(s.id).toBe(K); expect(s.killed).toBe(A); expect(s.dead).toBeNull()
  })
  test('the killer chain: the killer who is dead too leads to their killer; a loop ends; the world or nobody ends it', () => {
    const chain = raw({ deaths: [death(A, K, 300), death(K, J, 500)] })
    const s = povSubject(data(chain), A, 700)
    expect(s.id).toBe(J); expect(s.killed).toBe(K)
    const loop = raw({ deaths: [death(A, K, 300), death(K, A, 400)] })
    const l = povSubject(data(loop), A, 700)
    expect(l.id).toBe(K); expect(l.killed).toBe(A); expect(l.dead!.victim).toBe(K) // the chain stops where it would turn back
    const world = raw({ deaths: [death(A, null, 300)] })
    const w = povSubject(data(world), A, 700)
    expect(w.id).toBe(A); expect(w.dead!.victim).toBe(A)
    const stranger = raw({ deaths: [death(A, 'Z', 300)] }) // a killer who is not in the round
    expect(povSubject(data(stranger), A, 700).dead).not.toBeNull()
  })
  test('a revived player is alive again and their own subject', () => {
    const r = raw({ deaths: [death(A, K, 300)], events: [{ t: 500, p: A, k: 'revive' }] })
    expect(povSubject(data(r), A, 700)).toEqual({ id: A, killed: null, dead: null })
  })
  test('turnToBody: no turn at the death, the full turn after DEATH_TURN_MS, the position stays, smooth in between', () => {
    const eye = { x: 0, y: 0, z: 64, yaw: 0, pitch: 0 }
    const body: [number, number, number] = [0, 100, 0] // to the +y side: heading 64
    expect(turnToBody(eye, body, 0)).toEqual(eye)
    const done = turnToBody(eye, body, DEATH_TURN_MS)
    expect(done.yaw).toBeCloseTo(64, 3); expect(done.pitch).toBeGreaterThan(0); expect([done.x, done.y, done.z]).toEqual([0, 0, 64])
    expect(turnToBody(eye, body, DEATH_TURN_MS * 5).yaw).toBeCloseTo(64, 3)
    const half = turnToBody(eye, body, DEATH_TURN_MS / 2)
    expect(half.yaw).toBeGreaterThan(0); expect(half.yaw).toBeLessThan(64)
  })
})

describe('the cues', () => {
  const hurt = (t: number, p: string, a: string | undefined, d: number, h: number): TrackEvent => ({ t, p, k: 'hurt', a, w: 'weapon_zm_mac10', d, h })
  const events = [hurt(1000, J, A, 20, 50), hurt(2000, J, A, 50, 0), hurt(3000, A, K, 10, 90), hurt(4000, A, K, 80, 10), { t: 1500, p: K, k: 'say', text: 'x' } as TrackEvent]
  test('hurtsDealt groups the damage by attacker in time order and leaves the rest out', () => {
    const m = hurtsDealt(events)
    expect(m.get(A)!.map(e => e.t)).toEqual([1000, 2000]); expect(m.get(K)!.map(e => e.t)).toEqual([3000, 4000]); expect(m.has(J)).toBe(false)
  })
  const dealt = hurtsDealt(events)
  const taken = events.filter(e => e.p === A && e.k === 'hurt')
  test('the hit marker is full at the event, fades over HIT_MS, is stronger (kill) when the victim was left at 0, and is absent before and after', () => {
    expect(cueLevels(dealt.get(A), undefined, 999).hit).toBe(0)
    expect(cueLevels(dealt.get(A), undefined, 1000).hit).toBe(1)
    const half = cueLevels(dealt.get(A), undefined, 1000 + HIT_MS / 2); expect(half.hit).toBeCloseTo(0.5, 5); expect(half.kill).toBe(false)
    expect(cueLevels(dealt.get(A), undefined, 1000 + HIT_MS).hit).toBe(0)
    expect(cueLevels(dealt.get(A), undefined, 2000).kill).toBe(true)
  })
  test('the vignette: by the damage taken (40 or more is full, small is a quarter at least), fading over VIGNETTE_MS; none without a hit on them', () => {
    expect(cueLevels(undefined, taken, 3000).hurt).toBeCloseTo(0.25, 5)
    expect(cueLevels(undefined, taken, 4000).hurt).toBe(1)
    expect(cueLevels(undefined, taken, 4000 + VIGNETTE_MS / 2).hurt).toBeCloseTo(0.5, 5)
    expect(cueLevels(undefined, taken, 4000 + VIGNETTE_MS).hurt).toBe(0)
    expect(cueLevels(undefined, taken, 2999).hurt).toBe(0)
    expect(cueLevels(undefined, undefined, 1000)).toEqual({ hit: 0, kill: false, hurt: 0 })
  })
  test('shots are not a cue: no muzzle flash from merged shot events', () => {
    const shots: TrackEvent[] = [{ t: 1000, p: A, k: 'shots', w: 'weapon_zm_mac10', n: 5 }]
    expect(cueLevels(hurtsDealt(shots).get(A), undefined, 1000)).toEqual({ hit: 0, kill: false, hurt: 0 })
  })
})

describe('the levels in POV', () => {
  test('no level is cut away in POV, whatever the choice and the follow switch', () => {
    expect(shownLevels(1, false, 'pov')).toBe('all'); expect(shownLevels(1, true, 'pov')).toBe('all')
    expect(shownLevels(1, true, 'orbit')).toBe(1); expect(shownLevels(1, false, 'follow')).toBe(1); expect(shownLevels(1, true, 'follow')).toBe('all')
  })
})

describe('the page and the replay code', () => {
  const page = src('components/ReplayPage.tsx'), replay = src('replay.ts'), flatView = src('replayflat.ts')
  test('the page has the POV button next to Follow, its controls (kept in place when hidden), and the overlay parts, fixed in size', () => {
    expect(page).toContain('data-cam="pov"')
    expect(page.indexOf('data-cam="follow"')).toBeLessThan(page.indexOf('data-cam="pov"'))
    for (const k of ['data-pov-overlay', 'data-pov-vignette', 'data-pov-dot', 'data-pov-hit', 'data-pov-who', 'data-pov-weapon', 'data-pov-health', 'data-pov-controls', 'data-pov-fov="90"', 'data-pov-fov="105"', 'data-pov-dotbox', 'data-pov-note']) expect(page).toContain(k)
    expect(PUBLIC_CSS).toContain('[data-pov-controls][hidden]{display:flex;visibility:hidden}') // its place stays: no jump when the camera changes
    expect(PUBLIC_CSS).toContain('[data-pov-overlay]{position:absolute')
  })
  test('the camera mode: own near plane and field of view, level cut off, the subject hidden, no hole and no ghost, cues from the events, the choices kept on the device', () => {
    expect(replay).toContain("camMode === 'pov' ? POV_NEAR : 1")
    expect(replay).toContain("persp.fov = camMode === 'pov' ? povVerticalFov(povFov, persp.aspect) : 40")
    expect(replay).toContain('const sub = povSubject(data, selected, ms)')
    expect(replay).toContain('mk.group.visible = false; mk.ring.visible = false; mk.label.visible = false')
    expect(replay).toContain("updateHole(hole, camera, null, false)")
    expect(replay).toContain('cueLevels(dealt.get(sub.id), data.hurts.get(sub.id), ms)')
    expect(replay).toContain("keep('td-pov-fov'"); expect(replay).toContain("keep('td-pov-dot'")
    expect(replay).toContain("say('Select a player to watch from their POV.')")
  })
  test('the flat view (no WebGL) does not offer POV', () => { expect(flatView).toContain("b.dataset.cam === 'orbit' || b.dataset.cam === 'pov'") })
})
