import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NotEqualStencilFunc, ReplaceStencilOp, Bone, BufferGeometry, Float32BufferAttribute, GreaterDepth, Group, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Skeleton, SkinnedMesh, Vector3 } from 'three'
import { HOLE, holeGlsl, addGhost, ghostFigure, ghostMaterial, markSolid, ghostShown, holeAt, holeUniforms, holeView, patchHole, updateHole, type HoleView } from '../src/followHole'

// RFC 34: the hole the follow camera makes, and the ghost of the followed player
const text = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const replay = text('../src/replay.ts'), logic = text('../src/replaylogic.ts')

/** The follow camera's pose as replay.ts sets it: 300 back and 170 up, looking at a point 90 ahead and 50 up, three's Y-up. */
function followCamera(feet = new Vector3(0, 0, 0), yaw = 0, back = 300) {
  const cam = new PerspectiveCamera(40, 360 / 580, 1, 200000)
  const dx = Math.cos(yaw), dz = -Math.sin(yaw)
  cam.position.set(feet.x - dx * back, feet.y + 170 * (back / 300), feet.z - dz * back)
  cam.lookAt(feet.x + dx * 90, feet.y + 50, feet.z + dz * 90)
  return cam
}
function viewOf(cam: PerspectiveCamera, feet: Vector3) {
  const u = holeUniforms()
  updateHole(u, cam, feet, true)
  return { u, view: holeView(u) }
}
const toView = (cam: PerspectiveCamera, p: Vector3): [number, number, number] => p.clone().applyMatrix4(cam.matrixWorldInverse).toArray() as [number, number, number]
const normalToView = (cam: PerspectiveCamera, n: Vector3, p: [number, number, number]): [number, number, number] => {
  const v = n.clone().transformDirection(cam.matrixWorldInverse)
  if (v.x * p[0] + v.y * p[1] + v.z * p[2] > 0) v.negate() // turned to the camera, as the shader's derivatives give it
  return v.toArray() as [number, number, number]
}
const UP = new Vector3(0, 1, 0)

describe('the numbers for a frame (updateHole)', () => {
  test('the chest and the ground plane of a player straight ahead of a level camera', () => {
    const cam = new PerspectiveCamera(40, 1, 1, 1000)
    cam.position.set(0, HOLE.chest, 500); cam.lookAt(0, HOLE.chest, 0)
    const { view } = viewOf(cam, new Vector3(0, 0, 0))
    expect(view.ctr[0]).toBeCloseTo(0, 4); expect(view.ctr[1]).toBeCloseTo(0, 4); expect(view.ctr[2]).toBeCloseTo(-500, 4)
    expect(view.ground[0]).toBeCloseTo(0, 5); expect(view.ground[1]).toBeCloseTo(1, 5); expect(view.ground[2]).toBeCloseTo(0, 5)
    expect(view.ground[3]).toBeCloseTo(HOLE.chest, 4) // the camera is as high as the chest: the plane is that far below it
    expect(view.rad).toBe(HOLE.radius)
  })
  test('with a tilted camera the feet lie on the plane and the chest is a chest height above it', () => {
    const feet = new Vector3(120, 30, -80)
    const cam = followCamera(feet, 0.7)
    const { view } = viewOf(cam, feet)
    const onPlane = (p: [number, number, number]) => view.ground[0] * p[0] + view.ground[1] * p[1] + view.ground[2] * p[2] + view.ground[3]
    expect(onPlane(toView(cam, feet))).toBeCloseTo(0, 3)
    expect(onPlane(view.ctr)).toBeCloseTo(HOLE.chest, 3)
    expect(Math.hypot(view.ground[0], view.ground[1], view.ground[2])).toBeCloseTo(1, 5)
    // the chest in view space is the world chest seen from the camera
    const chest = toView(cam, new Vector3(feet.x, feet.y + HOLE.chest, feet.z))
    for (let i = 0; i < 3; i++) expect(view.ctr[i]).toBeCloseTo(chest[i]!, 3)
  })
  test('the matrices are worked out here: the camera has only been moved, not rendered (the replay sets its pose just before the picture)', () => {
    const cam = new PerspectiveCamera(40, 1, 1, 1000)
    cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0) // matrixWorldInverse is still the identity
    const { view } = viewOf(cam, new Vector3(0, -HOLE.chest, 0))
    expect(view.ctr[2]).toBeCloseTo(-100, 4)
  })
  test('no follow camera, no hole: the radius is 0 and nothing is cut', () => {
    const feet = new Vector3(0, 0, 0), cam = followCamera(feet)
    const u = holeUniforms()
    updateHole(u, cam, feet, true)
    expect(u.uRad.value).toBeGreaterThan(0)
    updateHole(u, cam, feet, false)
    expect(u.uRad.value).toBe(0)
    const p = toView(cam, new Vector3(0, 40, 100))
    expect(holeAt(p, normalToView(cam, new Vector3(0, 0, 1), p), holeView(u))).toBe(0)
    updateHole(u, cam, null, true) // nobody to follow
    expect(u.uRad.value).toBe(0)
  })
  test('it follows the player: a new place gives new numbers', () => {
    const cam = followCamera(new Vector3(0, 0, 0)), u = holeUniforms()
    updateHole(u, cam, new Vector3(0, 0, 0), true)
    const a = u.uCtr.value.clone()
    updateHole(u, cam, new Vector3(100, 0, 0), true)
    expect(u.uCtr.value.distanceTo(a)).toBeGreaterThan(50)
  })
})

describe('the rule (holeAt, in plain code)', () => {
  const feet = new Vector3(0, 0, 0)
  const cam = followCamera(feet)
  const { view } = viewOf(cam, feet)
  /** A world point on the line from the camera through the chest, `t` of the way (0: at the camera, 1: at the chest), moved sideways on the screen by `side` units at the chest's depth. */
  const onSight = (t: number, side = 0) => {
    const chest = new Vector3(0, HOLE.chest, 0)
    const p = cam.position.clone().lerp(chest, t)
    const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
    return p.addScaledVector(right, side * t)
  }
  const wallNormal = new Vector3().subVectors(cam.position, new Vector3(0, HOLE.chest, 0)).setY(0).normalize() // a wall across the way of the camera
  const cutAt = (p: Vector3, n: Vector3, sideTest = false) => { const v = toView(cam, p); return holeAt(v, normalToView(cam, n, v), view, sideTest) }

  test('something nearer than the player and inside the circle is cut', () => {
    expect(cutAt(onSight(0.5), wallNormal)).toBe(1)
    expect(cutAt(onSight(0.3, 20), wallNormal)).toBe(1)
    expect(cutAt(onSight(0.8, HOLE.radius * 0.7), wallNormal)).toBe(1)
  })
  test('outside the circle it stays', () => {
    expect(cutAt(onSight(0.5, HOLE.radius * 0.5 + 300), wallNormal)).toBe(0)
    expect(cutAt(onSight(0.9, HOLE.radius * 1.5), wallNormal)).toBe(0)
  })
  test('behind the player it stays', () => {
    const chest = new Vector3(0, HOLE.chest, 0)
    expect(cutAt(onSight(1.3), wallNormal)).toBe(0)
    expect(cutAt(onSight(2), wallNormal)).toBe(0)
    expect(cutAt(chest.clone().add(wallNormal.clone().multiplyScalar(-HOLE.nearTo * -1 - 60)), wallNormal)).toBe(0) // well past the ramp behind them
  })
  test('the floor under their feet stays, though it is nearer than their chest and inside the circle; the base of a wall there does not', () => {
    const onFeet = (t: number) => cam.position.clone().lerp(feet, t) // on the line of sight to their feet
    const under = onFeet(0.96) // 7 units above their floor, 14 units nearer than their feet
    expect(toView(cam, under)[2]!).toBeGreaterThan(view.ctr[2]) // nearer than the chest
    expect(cutAt(under, UP)).toBe(0) // a face that looks up: the floor they stand on
    expect(cutAt(onFeet(0.97), UP)).toBe(0)
    expect(cutAt(under, wallNormal)).toBe(0) // the same place, a wall face: its base is kept too (the ray to the soles passes below the ankles)
    const toHips = (t: number) => cam.position.clone().lerp(new Vector3(0, HOLE.chest + HOLE.lowTo, 0), t)
    expect(cutAt(toHips(0.85), UP)).toBe(1) // 25 units over the floor on the ray to their hips, a ledge that hides their body: cut
  })
  describe('what cannot hide the player stays (RFC 34, 9.4): a surface whose pixel ray passes below their feet', () => {
    /** The point `t` of the way from the camera to the world point `target`: a surface there is hit by the pixel ray that goes on to `target`. */
    const toward = (target: Vector3, t = 0.6) => cam.position.clone().lerp(target, t)
    const toTheCamera = wallNormal.clone() // horizontal, from the feet towards the camera
    test('the bug: terrain in front of and below the player, below the sight line, is not cut (a step face and its top)', () => {
      // the ground ahead of them is a step lower than their feet (the owner's b7_summer 1:19: the block sides below the feet were cut and showed the hollow shell). The points are inside the circle, so it is the rule, not the circle, that keeps them.
      const stepFace = toward(new Vector3(0, -30, 0).addScaledVector(toTheCamera, 10)), stepTop = toward(new Vector3(0, -10, 0).addScaledVector(toTheCamera, 45))
      for (const p of [stepFace, stepTop]) { expect(toView(cam, p)[2]!).toBeGreaterThan(view.ctr[2]) /* nearer than the player */; expect(cutAt(p, wallNormal)).toBeLessThan(0.1) } // a side face
      expect(cutAt(stepTop, UP)).toBeLessThan(0.1) // its top
      expect(cutAt(stepFace, new Vector3(0.6, 0.3, 0.74).normalize())).toBeLessThan(0.1) // a slanted one
      // the circle itself would cut them: a ray at the same depth and screen distance, through the body, is
      expect(cutAt(toward(new Vector3(0, HOLE.chest + 30, 0).addScaledVector(toTheCamera, 10)), wallNormal)).toBe(1)
    })
    test('the same pixel ray a little higher, through their body, is cut: it is the rule, not the circle, that keeps the step', () => {
      for (const dy of [HOLE.chest, 36, HOLE.chest + HOLE.lowTo]) expect(cutAt(toward(new Vector3(0, dy, 0)), wallNormal)).toBeGreaterThan(0.5)
    })
    test('a floor face above the line of sight (a ceiling or roof over them, seen from the camera) is cut; so is a wall there', () => {
      const roof = toward(new Vector3(0, HOLE.chest + 50, 0))
      expect(cutAt(roof, UP.clone().negate())).toBe(1)
      expect(cutAt(roof, wallNormal)).toBe(1)
    })
    test('a floor that hides their legs (a ledge on the ray to their hips) is cut', () => {
      const hips = new Vector3(0, HOLE.chest + HOLE.lowTo, 0) // where the ramp ends: from here up everything is cut
      expect(cutAt(toward(hips, 0.85), UP)).toBe(1)
      expect(cutAt(toward(hips, 0.85), wallNormal)).toBeGreaterThan(0.5)
    })
    test('no ground ring: a floor or ceiling in front of the feet whose ray passes below the ankles stays, the ring is drawn through it instead', () => {
      const front = toward(new Vector3(0, 0, 0).addScaledVector(toTheCamera, 30)) // the ray lands on the floor 30 units in front of their feet, below the soles on the screen
      expect(cutAt(front, UP.clone().negate())).toBe(0)
      expect(cutAt(front, UP)).toBe(0)
      expect(cutAt(front, wallNormal)).toBe(0)
    })
    test('the ramp: from the sight line down to below the ankles, half a unit at a time: monotone and no step', () => {
      let worst = 0, prev = NaN, first = 0, last = 0, rising = 0
      for (let dq = 0; dq >= -75; dq -= 0.5) { // the height at which the pixel ray passes the player's depth, below the chest
        const c = cutAt(toward(new Vector3(0, HOLE.chest + dq, 0)), wallNormal)
        if (dq === 0) first = c; else { worst = Math.max(worst, Math.abs(c - prev) / 0.5); if (c > prev + 1e-9) rising++ }
        prev = c; last = c
      }
      expect(first).toBe(1); expect(last).toBe(0); expect(rising).toBe(0)
      expect(worst).toBeLessThan(0.1) // a ramp of 20 units: 1.5 / 20 = 0.075 per unit at the steepest
    })
    test('the constants: the ramp lies above the ankles and inside the body, so it cannot straddle the soles', () => {
      expect(HOLE.lowFrom).toBeLessThan(HOLE.lowTo)
      expect(HOLE.lowFrom).toBe(-HOLE.chest + HOLE.ankle) // the soles are at -chest: nothing is cut below `ankle` above them
      expect(HOLE.ankle).toBeGreaterThanOrEqual(8) // a margin of a few pixels at least, at the follow camera's distance
      expect(HOLE.lowTo).toBeLessThan(0) // the ramp ends below the sight line: inside the body, between the ankles and the chest
      expect(HOLE.lowTo).toBeGreaterThan(HOLE.lowFrom)
    })
  })
  describe('the acceptance rule (RFC 34, 9.4): whatever a pixel ray passes below the ankles at the player\'s depth is not cut at any pixel of the hole', () => {
    const feet = new Vector3(40, 10, -25)
    /** The rule at `n` points of the player's camera for yaws, distances and pixel rays: the points are given as the pixel ray (a view-space offset at the chest's depth) and how much nearer than the player they are. Calls `visit(height of the ray at the player's depth relative to the chest, depth fraction, holeAt value)`. */
    function grid(visit: (h: number, k: number, c: number, kind: string) => void) {
      for (const yaw of [0, 0.7, 2.1, 4.0]) for (const back of [200, 300, 450]) {
        const cam = followCamera(feet, yaw, back), v = viewOf(cam, feet).view
        const D = -v.ctr[2], g = v.ground
        const normals: Record<string, Vector3> = { up: UP, down: UP.clone().negate(), wall: new Vector3(Math.cos(yaw + 3.1), 0, -Math.sin(yaw + 3.1)), slant: new Vector3(0.6, 0.3, 0.74).normalize() }
        for (let qx = -120; qx <= 120; qx += 10) for (let qy = -140; qy <= 100; qy += 4) { // the pixel ray's point at the chest's depth, relative to the chest, in view space
          const Q: [number, number, number] = [v.ctr[0] + qx, v.ctr[1] + qy, v.ctr[2]]
          const h = g[0] * (Q[0] - v.ctr[0]) + g[1] * (Q[1] - v.ctr[1]) + g[2] * (Q[2] - v.ctr[2])
          for (const k of [0.3, 0.5, 0.7, 0.85, 0.95, 0.99]) { // nearer than the player: the same pixel, a point k of the way to the camera
            const P: [number, number, number] = [Q[0] * k, Q[1] * k, Q[2] * k]
            for (const [kind, n] of Object.entries(normals)) {
              const nv = normalToView(cam, n, P)
              visit(h, k, holeAt(P, nv, v), kind)
            }
          }
        }
        void D
      }
    }
    test('every point whose pixel ray passes at or below the ankles is kept, exactly, for any surface, depth, camera and pixel', () => {
      let seen = 0, cutAbove = 0
      grid((h, _k, c) => { if (h <= -HOLE.chest + HOLE.ankle) { seen++; expect(c).toBe(0) } else if (h >= HOLE.lowTo && c === 1) cutAbove++ })
      expect(seen).toBeGreaterThan(1000) // the grid has points below the ankles...
      expect(cutAbove).toBeGreaterThan(1000) // ...and the hole is cut open above the ramp
    })
    test('above the ankle line the cut grows smoothly: along every pixel column no jump bigger than the ramp allows', () => {
      const cam = followCamera(feet, 0.7), v = viewOf(cam, feet).view
      const g = v.ground
      for (const k of [0.5, 0.9]) for (const n of [new Vector3(0, 0, 1), UP.clone().negate()]) {
        let prev = NaN, worst = 0
        for (let qy = -140; qy <= 60; qy += 0.25) {
          const Q: [number, number, number] = [v.ctr[0], v.ctr[1] + qy, v.ctr[2]]
          const P: [number, number, number] = [Q[0] * k, Q[1] * k, Q[2] * k]
          const c = holeAt(P, normalToView(cam, n, P), v)
          if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(c - prev))
          prev = c
          void g
        }
        expect(worst).toBeLessThan(0.06) // a ramp 20 units tall, 0.25 of a unit per step: 0.0375 at most
      }
    })
    test('the check has teeth: the ramp of the first fix across the soles, or a ramp with no margin, is caught by the same grid', () => {
      const keep = { lowFrom: HOLE.lowFrom, lowTo: HOLE.lowTo }
      const wrong = () => { let bad = 0; grid((h, _k, c) => { if (h <= -HOLE.chest + HOLE.ankle && c !== 0) bad++ }); return bad } // the ankle line is fixed by the soles, not by the ramp under test
      try {
        HOLE.lowFrom = -52; HOLE.lowTo = -30 // straddles the soles (-40)
        expect(wrong()).toBeGreaterThan(0)
        HOLE.lowFrom = -HOLE.chest; HOLE.lowTo = -HOLE.chest + 20 // no margin: starts at the soles
        expect(wrong()).toBeGreaterThan(0)
        HOLE.lowFrom = keep.lowFrom; HOLE.lowTo = keep.lowTo
        expect(wrong()).toBe(0)
      } finally { HOLE.lowFrom = keep.lowFrom; HOLE.lowTo = keep.lowTo }
    })
  })
  test('the circle shrinks with the distance: the same distance to the side is outside of it from further away', () => {
    const feet2 = new Vector3(0, 0, 0)
    const sideCut = (back: number, side: number) => {
      const c = followCamera(feet2, 0, back), v = viewOf(c, feet2).view
      const chest = new Vector3(0, HOLE.chest, 0)
      const p = c.position.clone().lerp(chest, 0.6).addScaledVector(new Vector3().setFromMatrixColumn(c.matrixWorld, 0), side * 0.6)
      const pv = toView(c, p)
      return holeAt(pv, normalToView(c, new Vector3(0, 0, 1), pv), v)
    }
    // the circle's radius in world units at the player's distance is HOLE.radius: a point 0.8 radii out is inside at any distance...
    expect(sideCut(300, HOLE.radius * 0.8)).toBe(1)
    expect(sideCut(900, HOLE.radius * 0.8)).toBe(1)
    // ...and the same pixel offset from the middle of the screen is a different number of world units: a point 0.8 radii out at 300 is 2.4 radii out at 900 seen from a camera that is three times as far, in the other camera's own units
    const near = viewOf(followCamera(feet2, 0, 300), feet2).view, far = viewOf(followCamera(feet2, 0, 900), feet2).view
    const screenRadius = (v: HoleView) => v.rad / -v.ctr[2]
    expect(screenRadius(far) / screenRadius(near)).toBeCloseTo(-near.ctr[2] / -far.ctr[2], 6)
    expect(screenRadius(far)).toBeLessThan(screenRadius(near) * 0.5)
  })
  test('the same spot on the screen is cut from near and not from far', () => {
    // 0.15 tangent units from the player on the screen: inside the circle at 300 back (radius 0.17 of the player's depth), outside at 700 (0.07)
    const at = (back: number) => {
      const c = followCamera(feet, 0, back), v = viewOf(c, feet).view
      const depth = -v.ctr[2] * 0.6
      return holeAt([(v.ctr[0] / -v.ctr[2] + 0.15) * depth, (v.ctr[1] / -v.ctr[2]) * depth, -depth], [0, 0, 1], v)
    }
    expect(at(300)).toBe(1)
    expect(at(700)).toBe(0)
  })

  describe('no discontinuity: nothing changes much between one pixel and the next (the straight-edged wedges of RFC 12 were steps on planes)', () => {
    const PX = (2 * Math.tan((40 * Math.PI) / 360)) / (580 * 1.5) // one device pixel in tangent units, at the phone size
    test('across the circle: at most a quarter of the value per pixel, and a pixel row has both its edges', () => {
      const v = view, depth = -v.ctr[2] * 0.6
      const cx = v.ctr[0] / -v.ctr[2], cy = v.ctr[1] / -v.ctr[2]
      let worst = 0, prev = NaN, cutPixels = 0
      for (let i = -500; i <= 500; i++) {
        const t = cx + i * PX
        const c = holeAt([t * depth, cy * depth, -depth], [0, 0, 1], v)
        if (i > -500) worst = Math.max(worst, Math.abs(c - prev))
        if (c > 0.5) cutPixels++
        prev = c
      }
      expect(worst).toBeLessThan(0.25)
      expect(cutPixels).toBeGreaterThan(100) // the edge is crossed twice and there is a window in between
    })
    test('along the way to the camera: the ramp behind the player, one unit at a time', () => {
      let worst = 0, prev = NaN
      for (let d = -120; d <= 120; d += 1) {
        const along = cam.position.clone().sub(new Vector3(0, HOLE.chest, 0)).normalize()
        const q = new Vector3(0, HOLE.chest, 0).addScaledVector(along, d)
        const pv = toView(cam, q)
        const c = holeAt(pv, normalToView(cam, wallNormal, pv), view)
        if (d > -120) worst = Math.max(worst, Math.abs(c - prev))
        prev = c
      }
      expect(worst).toBeLessThan(0.1)
    })
    test('down a slope along the line of sight to the knees (inside the ramp of the below-the-ankles rule and over the floor under them)', () => {
      // a ramp of 30 degrees; the ray to the knees runs through the ramp of the below-the-ankles rule (20 units: 0.075 per unit at most)
      const slope = new Vector3(-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0)
      let worst = 0, prev = NaN, first = 0, last = 0
      for (let i = 0; i <= 400; i++) {
        const p = cam.position.clone().lerp(new Vector3(0, 20, 0), 0.85 + 0.15 * (i / 400)) // the point on the way to the knees
        const pv = toView(cam, p)
        const c = holeAt(pv, normalToView(cam, slope, pv), view)
        if (i === 0) first = c
        if (i > 0) worst = Math.max(worst, Math.abs(c - prev))
        prev = c; last = c
      }
      expect(first).toBeGreaterThan(0.2); expect(first).toBeLessThan(0.9); expect(last).toBeCloseTo(first, 6) // a ray inside the ramp: neither cut nor kept
      expect(worst).toBeLessThan(0.05)
    })
  })

  describe('only what lies between (RFC 34, 4.3, behind a constant)', () => {
    test('is off by default only if the build says so, and the rule does not change without the constant', () => {
      const p = toView(cam, onSight(0.5))
      const n = normalToView(cam, wallNormal, p)
      expect(holeAt(p, n, view, false)).toBe(1)
    })
    test('a wall beside the player is kept, one between them and the camera is cut', () => {
      // a wall to the player's left, along the way the camera looks: its face is turned across the line from the camera
      const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0), fwd = new Vector3(0, 0, -1)
      const besidePoint = new Vector3(0, 60, 0).addScaledVector(right, -50).addScaledVector(fwd, 60) // 50 to the left, 60 towards the camera... nearer than the chest
      const besideNormal = right.clone() // faces the player
      const vb = toView(cam, besidePoint)
      expect(holeAt(vb, normalToView(cam, besideNormal, vb), view, true)).toBeLessThan(0.5)
      const betweenPoint = onSight(0.6, 10)
      const vt = toView(cam, betweenPoint)
      expect(holeAt(vt, normalToView(cam, wallNormal, vt), view, true)).toBe(1)
      // the sign: the same wall seen from the other side of the player (the player in front of it) is kept
      const behind = new Vector3(0, 60, 0).addScaledVector(wallNormal, -40) // behind the player, facing the camera
      const vk = toView(cam, behind)
      expect(holeAt(vk, normalToView(cam, wallNormal, vk), view, true)).toBe(0)
    })
  })
})

describe('the material patch', () => {
  const fake = () => ({ uniforms: {} as Record<string, unknown>, vertexShader: 'void main() {\n#include <begin_vertex>\n}', fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n#include <alphatest_fragment>\n gl_FragColor = vec4(1.0);\n}' })
  test('one function for every kind: only the fragment stage changes, the uniforms are the shared ones, the cut follows the alpha test', () => {
    const u = holeUniforms(), m = new MeshStandardMaterial(), vertex = fake().vertexShader
    patchHole(m, u)
    const s = fake()
    m.onBeforeCompile(s as any, null as any)
    expect(s.vertexShader).toBe(vertex)
    expect(s.uniforms.uCtr).toBe(u.uCtr); expect(s.uniforms.uGround).toBe(u.uGround); expect(s.uniforms.uRad).toBe(u.uRad)
    expect(s.fragmentShader).toContain('float holeAt(vec3 P)')
    expect(s.fragmentShader.indexOf('#include <alphatest_fragment>')).toBeLessThan(s.fragmentShader.indexOf('if (holeAt(-vViewPosition) > 0.5) discard;'))
    expect(s.fragmentShader.indexOf('float holeAt')).toBeLessThan(s.fragmentShader.indexOf('void main() {'))
    expect(s.fragmentShader).not.toMatch(/screenDoor|cutAt|uCam|uHead|aObject|vWorldC|lineOfSight/)
    expect(m.customProgramCacheKey()).toContain('followhole')
  })
  test('the shader is built from the constants the plain-code rule uses, and takes the derivatives out of the branches', () => {
    for (const n of [HOLE.nearFrom, HOLE.nearTo, HOLE.floorFrom, HOLE.floorTo, HOLE.upFrom, HOLE.upTo, HOLE.band, HOLE.lowFrom, HOLE.lowTo]) expect(holeGlsl()).toContain(Number.isInteger(n) ? n.toFixed(1) : String(n))
    expect(holeGlsl().slice(holeGlsl().indexOf('dFdx(P)')).match(/return/g)?.length).toBe(1) // (the derivatives are taken in uniform control flow: no return between them and the end but the last)
    expect(holeGlsl()).toContain('P.xy / -P.z') // a circle on the screen, not in the world
    expect(holeGlsl()).toContain('uRad / -uCtr.z') // the radius shrinks with the distance
    expect(holeGlsl()).toContain('P * (uCtr.z / P.z)') // the pixel ray at the player's depth: what the below-the-feet rule measures
    expect(holeGlsl()).toContain('keep = max(keep, below);') // one rule for every kind, no ground ring
    expect(holeGlsl()).not.toMatch(/near_ground|flatness/)
    expect(holeGlsl()).not.toMatch(/fract|noise|screenDoor|gl_FragCoord/) // no pattern: a hard edge
  })
})

describe('the ghost', () => {
  test('the material: flat, half transparent, drawn only where something is nearer, writes no depth', () => {
    const m = ghostMaterial(0xff0000)
    expect(m.depthFunc).toBe(GreaterDepth)
    expect(m.depthWrite).toBe(false)
    expect(m.transparent).toBe(true)
    expect(m.opacity).toBeGreaterThan(0.3); expect(m.opacity).toBeLessThan(0.7)
    expect(m.color.getHex()).toBe(0xff0000)
  })
  test('not over the player\'s own body: the body marks the stencil, the ghost is drawn where it is not marked (a limb behind the chest is "behind" it too)', () => {
    const body = new MeshStandardMaterial()
    markSolid(body)
    expect(body.stencilWrite).toBe(true); expect(body.stencilRef).toBe(1); expect(body.stencilZPass).toBe(ReplaceStencilOp)
    const m = ghostMaterial(0xffffff)
    expect(m.stencilWrite).toBe(true); expect(m.stencilFunc).toBe(NotEqualStencilFunc); expect(m.stencilRef).toBe(1)
    expect(m.stencilZPass).not.toBe(ReplaceStencilOp) // the ghost itself marks nothing
    const g = new Group(), cloth = new MeshStandardMaterial()
    g.add(new Mesh(new BufferGeometry(), cloth))
    const f = ghostFigure(g, 0x123456)
    expect(cloth.stencilWrite).toBe(true)
    expect(f.meshes.length).toBe(1); expect(f.material.depthFunc).toBe(GreaterDepth)
    expect(text('../src/sceneKit.ts')).toMatch(/new WebGLRenderer\(\{[^}]*stencil: true/) // the buffer exists
  })
  test('every mesh is drawn a second time with it, after the opaque scene, hidden until shown; a skinned one shares its skeleton', () => {
    const g = new Group()
    const cloth = new MeshStandardMaterial()
    const plain = new Mesh(new BufferGeometry(), cloth)
    const geo = new BufferGeometry(); geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    const skinned = new SkinnedMesh(geo, cloth)
    const bone = new Bone(); skinned.add(bone); skinned.bind(new Skeleton([bone]), new Matrix4())
    g.add(plain, skinned)
    const ghost = ghostMaterial(0x00ff00)
    const copies = addGhost(g, ghost)
    expect(copies.length).toBe(2)
    expect(g.children.length).toBe(4)
    for (const c of copies) { expect(c.material).toBe(ghost); expect(c.visible).toBe(false); expect(c.renderOrder).toBeGreaterThan(0); expect(c.renderOrder).toBeLessThan(10) } // (the pins are 10)
    expect(copies[0]!.geometry).toBe(plain.geometry)
    expect((copies[1] as SkinnedMesh).skeleton).toBe(skinned.skeleton)
    expect(plain.material).toBe(cloth); expect(skinned.material).toBe(cloth) // the player itself is as it was
  })
  test('it follows the followed player only, in the follow camera only, and only while they are drawn', () => {
    expect(ghostShown('follow', 'a', 'a', true)).toBe(true)
    expect(ghostShown('follow', 'a', 'b', true)).toBe(false)
    expect(ghostShown('orbit', 'a', 'a', true)).toBe(false)
    expect(ghostShown('top', 'a', 'a', true)).toBe(false)
    expect(ghostShown('follow', 'a', 'a', false)).toBe(false)
    expect(ghostShown('follow', null, 'a', true)).toBe(false)
  })
})

describe('the page (replay.ts)', () => {
  test('the line-of-sight fade is gone: no cone, no per-object value, no kinds of see-through, no overhead rule', () => {
    for (const name of ['CUT_GLSL', 'cutAt', 'seeThrough', 'aObject', 'BIG_PROP', 'lineOfSight', 'screenDoor', 'uHead', 'uCam']) expect(replay).not.toContain(name)
    for (const name of ['overheadFade', 'FADE ', 'FADE,']) expect(logic).not.toContain(name)
    expect(text('../src/sceneKit.ts')).not.toContain('aObject')
  })
  test('walls and floors, and every material of the props, get the one rule', () => {
    expect(replay).toContain('patchHole(mesh.material, hole)') // the levels' meshes: walls and floors alike
    expect(replay).toMatch(/patchHoles\(\.\.\.props\.solid\.map\([^)]*\), \.\.\.props\.foliage\.map\(/)
    expect(replay.indexOf('patchHoles(')).toBeLessThan(replay.indexOf('mergeDrawn(model, props.solid)'))
    expect((replay.match(/patchHole\(/g) ?? []).length).toBe(2)
  })
  test('each picture updates the numbers from the follower: the follow camera sets them after it is placed, any other camera switches the hole off', () => {
    const apply = replay.slice(replay.indexOf('const apply = () => {'))
    const look = apply.indexOf('persp.lookAt(tmp)'), up = apply.indexOf('updateHole(hole, persp, tmp.set(mine.x, mine.z, -mine.y), true)')
    expect(look).toBeGreaterThan(0)
    expect(up).toBeGreaterThan(look) // after the pose (the matrices are worked out from it)
    expect(apply).toContain('} else updateHole(hole, camera, null, false)')
    expect(apply.indexOf('render()')).toBeGreaterThan(apply.indexOf('updateHole(hole, camera, null, false)'))
  })
  test('the ghost: made for the figure of a player (not for the body that lies), shown by ghostShown, recoloured with the team', () => {
    expect((replay.match(/if \(!dim\) ghostOf\(g, colour\)/g) ?? []).length).toBe(3) // the skeleton, the model's shape, the boxes
    expect(replay).toContain('gm.visible = ghostShown(camMode, selected, id, m.group.visible)')
    expect(replay).toContain('m.body.userData.ghost?.material.color.setHex(colour)')
  })
  test('the player is not made unseen by the ghost in the other things drawn: the pins and names stay on top, the ring keeps its place', () => {
    expect(replay).toContain('renderOrder = 10') // the sprites
    expect(replay).toContain('group.add(ring, pin, label)')
    expect(replay).toContain('(m.ring.material as MeshBasicMaterial).depthTest = !ghostShown(camMode, selected, id, m.group.visible)') // the ring is seen through what covers it in the follow camera: the hole does not open what is below the feet
  })
})
