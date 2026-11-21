import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { Group, Bone } from 'three'
import { findHand } from '../src/figureTilt'

// RFC 39, stage C (3.4, 4a): the weapon in a figure's hand and in the POV view: what can be tested without a browser (the hand bone, and the facts of the replay code).

const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')

describe('the hand', () => {
  const chain = (names: string[]) => { const g = new Group(); let p: any = g; for (const n of names) { const b = new Bone(); b.name = n; p.add(b); p = b } return g }
  test('finds the right hand with or without the prefix, and not the left one; null without', () => {
    expect(findHand(chain(['ValveBiped.Bip01_Spine', 'ValveBiped.Bip01_L_Hand', 'ValveBiped.Bip01_R_Hand']))?.name).toBe('ValveBiped.Bip01_R_Hand')
    expect(findHand(chain(['Bip01_R_Hand']))?.name).toBe('Bip01_R_Hand')
    expect(findHand(chain(['Bip01_L_Hand', 'Bip01_R_Forearm']))).toBeNull()
    expect(findHand(new Group())).toBeNull()
  })
})

describe('the replay code', () => {
  const replay = src('replay.ts')
  test('a weapon is asked of the route of this round by class, only for classes the track recorded, retried at most 5 times 20 s apart, and shown as a plain box until it is there', () => {
    expect(replay).toContain("src.replace(/track\\.json.*$/, 'weapon-model.glb')")
    expect(replay).toContain('data.weaponModels.has(cls) && weaponUrl ? 0 : 99') // a class with no recorded model is never asked for
    expect(replay).toContain('w.tries >= 5 || performance.now() < w.retryAt')
    expect(replay).toContain('retryAt = performance.now() + 20000')
    expect(replay).toContain('new Mesh(placeholderGeo, placeholderMat)')
    expect(replay).toContain("scene.getObjectByName('z-up')?.quaternion.set(0, 0, 0, 1)") // the vertices are in Source's axes, as the world group wants them
  })
  test('the weapon follows the hand\'s place but keeps to the aim (yaw of the figure, pitch of the player), and is set after the pose', () => {
    expect(replay).toContain('hand.getWorldPosition(handPos)')
    expect(replay).toContain('st.obj.quaternion.setFromAxisAngle(SIDE_AXIS, (Math.min(Math.max(pitch, -89), 89) * Math.PI) / 180)')
    expect(replay).toContain('holdWeapon(id, m, ms, pitchAt(m.segs, ms) ?? 0)')
    expect(replay).toContain('holdAt(data.polled.hold.get(id), ms, currentDeath(data.deaths, data.events, id, ms) !== null)') // a dead player holds nothing
  })
  test('in POV the followed player\'s weapon is in the view only when the real model is there, drawn over the world, at a fixed pose, and gone outside POV', () => {
    expect(replay).toContain('viewWeapon.visible = viewState.real')
    expect(replay).toContain('c.depthTest = false; c.depthWrite = false')
    expect(replay).toContain('mesh.renderOrder = 999')
    expect(replay).toContain('const VIEW_AT = new Vector3(9, -13, -42)')
    expect(replay).toContain("if (mode !== 'pov') viewWeapon.visible = false")
    expect(replay).toContain('showViewWeapon(holdAt(data.polled.hold.get(sub.id), ms, !!sub.dead))')
  })
})
