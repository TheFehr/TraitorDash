import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { Group, Bone, Object3D, Quaternion, Vector3, Euler } from 'three'
import { tiltShares, followTilt, followHeights, HEAD_LIMIT, FOLLOW_TILT, FOLLOW_TILT_MAX } from '../src/replaylogic'
import { findTiltBones, applyTilt, tiltFigure } from '../src/figureTilt'

// RFC 39, stage C (4a): the head and the spine and the third-person camera look up and down with the player.

const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')

describe('how the pitch is shared', () => {
  test('the head takes half up to its limit, the spine the rest, and they add up to the pitch (limited to -89..89)', () => {
    expect(tiltShares(0)).toEqual({ head: 0, spine: 0 })
    expect(tiltShares(40)).toEqual({ head: 20, spine: 20 })
    expect(tiltShares(-40)).toEqual({ head: -20, spine: -20 })
    const steep = tiltShares(89); expect(steep.head).toBeLessThanOrEqual(HEAD_LIMIT); expect(steep.head + steep.spine).toBeCloseTo(89, 9)
    const over = tiltShares(500); expect(over.head + over.spine).toBeCloseTo(89, 9)
    expect(tiltShares(-500).head + tiltShares(-500).spine).toBeCloseTo(-89, 9)
  })
  test('the head never goes beyond its limit, whatever the share', () => {
    for (let p = -89; p <= 89; p += 1) expect(Math.abs(tiltShares(p).head)).toBeLessThanOrEqual(HEAD_LIMIT)
  })
})

describe('the follow camera', () => {
  test('by the factor 0.4, within 35 degrees, and none when switched off', () => {
    expect(FOLLOW_TILT).toBe(0.4)
    expect(followTilt(50, true)).toBeCloseTo(20, 9)
    expect(followTilt(-50, true)).toBeCloseTo(-20, 9)
    expect(followTilt(89, true, 1)).toBe(FOLLOW_TILT_MAX)
    expect(followTilt(-89, true, 1)).toBe(-FOLLOW_TILT_MAX)
    expect(followTilt(50, false)).toBe(0)
  })
  test('level it is the old camera (170 above the feet, looking at 50); looking down the camera goes up and the point down, looking up the other way', () => {
    expect(followHeights(0)).toEqual({ camera: 170, target: 50 })
    const down = followHeights(20); expect(down.camera).toBeGreaterThan(170); expect(down.target).toBeLessThan(50)
    const up = followHeights(-20); expect(up.camera).toBeLessThan(170); expect(up.target).toBeGreaterThan(50)
  })
  test('it never goes below the floor or runs away at the limit', () => {
    for (let t = -FOLLOW_TILT_MAX; t <= FOLLOW_TILT_MAX; t += 5) { const h = followHeights(t); expect(h.camera).toBeGreaterThan(0); expect(Number.isFinite(h.target)).toBe(true) }
  })
})

/** A figure facing +x with a pelvis, three spine bones and a head, every bone turned in its own odd way, so that nothing depends on the bones' axes. */
function figure(prefix = 'ValveBiped.') {
  const g = new Group()
  g.rotation.z = 0.7 // the player's heading: the side axis is the figure's, not the world's
  const odd = [new Euler(0.4, -0.9, 1.3), new Euler(-1.1, 0.2, 0.6), new Euler(0.3, 1.2, -0.5), new Euler(2.0, 0.1, 0.9), new Euler(-0.7, -0.3, 1.8)]
  const names = ['Bip01_Pelvis', 'Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2', 'Bip01_Head1']
  const bones: Bone[] = []
  let parent: Object3D = g
  names.forEach((n, i) => {
    const b = new Bone(); b.name = prefix + n
    b.quaternion.setFromEuler(odd[i]!); b.position.set(0, 0, 10 * i)
    parent.add(b); bones.push(b); parent = b
  })
  g.updateMatrixWorld(true)
  return { g, bones, head: bones[4]!, spine: [bones[1]!, bones[2]!, bones[3]!] }
}
/** The figure-space direction a probe attached to a bone points in: the probe's offset in the bone is chosen so that at rest it points along +x of the figure. */
function probe(g: Object3D, bone: Object3D) {
  const q = new Quaternion(); bone.getWorldQuaternion(q)
  const gq = new Quaternion(); g.getWorldQuaternion(gq)
  const inFigure = gq.clone().invert().multiply(q) // the bone's frame in the figure's
  return { offset: new Vector3(1, 0, 0).applyQuaternion(inFigure.clone().invert()), bone }
}
const direction = (g: Object3D, p: { offset: Vector3, bone: Object3D }) => {
  const q = new Quaternion(); p.bone.getWorldQuaternion(q)
  const gq = new Quaternion(); g.getWorldQuaternion(gq)
  return p.offset.clone().applyQuaternion(gq.invert().multiply(q))
}

describe('the bones', () => {
  test('finds the head and the spine bones, with or without the prefix, the spine from the pelvis up; nothing else', () => {
    for (const prefix of ['ValveBiped.', '']) {
      const f = figure(prefix); const found = findTiltBones(f.g)
      expect(found.head).toBe(f.head); expect(found.spine).toEqual(f.spine)
    }
    expect(findTiltBones(new Group())).toEqual({ head: null, spine: [] })
  })
  test('the head by 30 degrees looks 30 degrees down: +x turns towards -z, whatever the bones\' own axes and the player\'s heading', () => {
    const f = figure(); const p = probe(f.g, f.head)
    const before = direction(f.g, p); expect(before.x).toBeCloseTo(1, 6)
    applyTilt(f.g, findTiltBones(f.g), { head: 30, spine: 0 })
    const after = direction(f.g, p)
    expect(after.x).toBeCloseTo(Math.cos(Math.PI / 6), 6); expect(after.y).toBeCloseTo(0, 6); expect(after.z).toBeCloseTo(-Math.sin(Math.PI / 6), 6)
    applyTilt(f.g, findTiltBones(f.g), { head: -60, spine: 0 }) // and back past level: 30 - 60 = 30 degrees up
    const up = direction(f.g, p); expect(up.z).toBeCloseTo(Math.sin(Math.PI / 6), 6)
  })
  test('the spine and the head together turn the head by the whole pitch', () => {
    const f = figure(); const p = probe(f.g, f.head)
    tiltFigure(f.g, findTiltBones(f.g), 50)
    const d = direction(f.g, p)
    expect(d.x).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 5); expect(d.z).toBeCloseTo(-Math.sin((50 * Math.PI) / 180), 5); expect(d.y).toBeCloseTo(0, 5)
    // the head's own share is 25 and the spine's is 25 spread over three bones: a spine bone alone turns less than the whole
    const s = figure(); const ps = probe(s.g, s.spine[0]!)
    tiltFigure(s.g, findTiltBones(s.g), 50)
    expect(Math.acos(Math.min(1, direction(s.g, ps).x)) * 180 / Math.PI).toBeCloseTo(25 / 3, 4)
  })
  test('level is no turn at all, and a figure without those bones is left alone', () => {
    const f = figure(); const q = f.head.quaternion.clone()
    tiltFigure(f.g, findTiltBones(f.g), 0); expect(f.head.quaternion.equals(q)).toBe(true)
    const plain = new Group(); const o = new Object3D(); plain.add(o)
    expect(() => tiltFigure(plain, findTiltBones(plain), 40)).not.toThrow()
  })
})

describe('the replay code', () => {
  const replay = src('replay.ts'), page = src('components/ReplayPage.tsx')
  test('the pose is tilted after the animation, with the sampled pitch, only when there is a pitch; the follow camera takes the tilt through the same height rule', () => {
    expect(replay).toContain('pitchAt(m.segs, ms) ?? 0) }')
    expect(replay).toContain('rig.mixer.update(0)\n    if (pitch !== 0)')
    expect(replay).toContain('const hts = followHeights(follow.tilt)')
    expect(replay).toContain('followTilt(pitchAt(data.players.get(selected!) ?? [], ms) ?? 0, lookWith)')
    expect(replay).toContain("keep('td-look'")
  })
  test('the page has "Look with them", on', () => { expect(page).toContain('<input type="checkbox" data-look checked /> Look with them') })
})
