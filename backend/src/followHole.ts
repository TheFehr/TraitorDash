import { Color, DoubleSide, GreaterDepth, KeepStencilOp, LinearFilter, MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, RGBAFormat, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget, type Camera, type Material, type Mesh, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three'

// The hole the follow camera makes (RFC 34). Everything that is nearer to the camera than the followed player and lies inside a circle on the
// screen around them is cut away, with a hard edge and no noise: one rule for walls, floors and props, from the view-space position of the
// pixel and four numbers per frame. The player is drawn a second time as a flat ghost where something still covers them.
//
// `holeAt` below is the rule in plain code; holeGlsl is the same rule for the shader (both are built from the constants of HOLE).

/** The numbers of the rule. Lengths are in the map's world units (the player is 72 tall and 32 across). */
export const HOLE = {
  /** The radius of the circle on the screen, at the player's distance, inside which a roof or a ceiling is opened (see `roofFrom`). */
  radius: 80,
  /** How far above their feet the circle is centred (the chest). */
  chest: 40,
  /** The edge's width, as a fraction of the radius: tiny, so the edge is a clean line (the noisy soft band of RFC 34, 3 stays reachable here: 0.3). */
  band: 0.04,
  /** What is nearer than the player is cut; the ramp from "cut" to "kept" lies this far behind their centre (so a wall beside them has no straight edge). */
  nearFrom: -30,
  nearTo: -14,
  /** The floor they stand on stays: a surface that faces up (|n.up| between these) and is lower than `floorTo` above their feet; the ramp avoids a step on a slope. */
  upFrom: 0.5,
  upTo: 0.7,
  floorFrom: 10,
  floorTo: 18,
  /** What a pixel ray passes BELOW the player's ankles cannot hide them, so it is never cut (wall, floor and prop alike). Measured at the player's depth, as the height of the ray relative to the chest (the soles are at -chest): kept (exactly, no cut at any pixel) below `lowFrom`, which is `ankle` above the soles, cut above `lowTo`, a ramp between that lies inside the body, so the ramp cannot straddle the soles. Terrain in front of and below the player used to be cut, which opened the hollow shell under it (RFC 34, 9.4). */
  ankle: 12,
  lowFrom: -28,
  lowTo: -8,
  /** What is cut (RFC 34, 9.5): a surface is cut only when cutting it helps to see the player, and the hollow shell of the map shows interiors where it does not.
   *  1. The window: the surface lies on a pixel ray that passes within `reach` of the player's body axis (from `ankle` above the soles to `head`), so it can hide the body.
   *  2. The roof: a face that faces up or down (the ramp `upFrom`/`upTo`) and lies above the head (the ramp `roofFrom` to `roofTo` above the soles), inside the circle of `radius`.
   *  3. The wide window (RFC 34, 9.6): a wall-like face clearly nearer than the player, above the ankle line, inside the circle and not beside them, whatever its distance to the body ray.
   *  Everything else inside the circle stays: floors, decks, ground, and what lies behind or beside the player. `reach` is the body (about 16) plus a margin, tuned on the recorded moments. */
  head: 72,
  reach: 24,
  /** The margin for a face that looks up or down (the ramp `upFrom`/`upTo`): a floor or a deck does not hide an arm that sticks out beside the body, and the ring of margin it cuts only opens the hollow shell beside the hip (67th Way 0:44). The ghost shows what such a face still covers. */
  reachFlat: 17,
  roofFrom: 44,
  roofTo: 60,
  /** Only a face that really lies between the camera and the player is cut (RFC 34, 4.3): the face's plane is in front of their centre by `sideFrom` to `sideTo` units. */
  sideTest: false,
  sideFrom: 0,
  sideTo: 20,
  /** The wide window for walls (RFC 34, 9.6): a wall-like face (|n.up| below `upFrom`, the ramp to `upTo`) nearer than the player, above the ankle line, inside the circle of `radius` is cut whatever its distance to the body ray (a wall that covers the player from the camera opens the room behind it). 1 switches it on, 0 off. Floors, decks and ground never get it. */
  wide: 1,
  /** With `wideSide` 1 the wide cut is only for a wall that is between the camera and the player, not one beside them: the signed distance from the player's centre to the wall's plane along its camera-facing normal, negative when they stand in front of it, is a ramp: below `wideFrom` not cut, above `wideTo` cut fully. A wall beside the player has the plane well in front of them (a house wall 60 and more at 0:50 of b7_summer, the pool wall at 67th Way 0:44); a wall that covers them has it at or behind them. The numbers are negative: the player may stand up to 25 units in front of the plane and the wall is still cut. */
  wideSide: 1,
  /** A wall is opened widely only when it is clearly in front of the body: its depth is nearer than their centre by `wideNearFrom` (not at all) to `wideNearTo` (fully). The wall right behind a player who stands against it (the front of a house at 67th Way 0:57) is no cover, and opening it shows the hollow shell. */
  wideNearFrom: 8,
  wideNearTo: 24,
  wideFrom: -45,
  wideTo: -25,
  /** The ghost: opacity of the flat colour drawn where something covers the player. */
  ghostOpacity: 0.5,
  /** The body window by the player's silhouette (RFC 34, 9.7): the player is drawn in flat white into an off-screen mask with the same camera, at `maskScale` of the drawing buffer (bilinear), and a pixel is inside the body window where the mask says the player is. `maskDilate` device pixels of dilation (8 taps on a circle of that radius, the largest wins) against a one pixel rim of the occluder round the body (chosen on pictures: 1 and 2 draw a thin outline of what lies behind the cut, so it is half a pixel; the mask is full resolution because at half resolution the staircase of its edge cost 53 pixels of the body at one moment); the coverage is `maskLo` to `maskHi` of the bilinear value through a smoothstep, no hard threshold (the cut itself is the 0.5 contour). The capsule of 9.5 (`reach`, `reachFlat`) is only the fallback when the mask target cannot be made. */
  maskScale: 1,
  maskDilate: 0.5,
  maskLo: 0.25,
  maskHi: 0.75,
}

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

/** The rule in the shader (built when asked, from the current constants). Uniforms: the player's centre and the plane they stand on, in view space, and the radius (0: no hole). */
export const holeGlsl = () => `
uniform vec3 uCtr;
uniform vec4 uGround;
uniform float uRad;
uniform sampler2D uMask;
uniform vec2 uMaskInv;
uniform float uMaskOn;
float maskCover() {
  vec2 uv = gl_FragCoord.xy * uMaskInv;
  vec2 o = uMaskInv * ${f(HOLE.maskDilate)};
  vec2 q = o * 0.7071;
  float m = textureLod(uMask, uv, 0.0).r;
  m = max(m, textureLod(uMask, uv + vec2(o.x, 0.0), 0.0).r);
  m = max(m, textureLod(uMask, uv - vec2(o.x, 0.0), 0.0).r);
  m = max(m, textureLod(uMask, uv + vec2(0.0, o.y), 0.0).r);
  m = max(m, textureLod(uMask, uv - vec2(0.0, o.y), 0.0).r);
  m = max(m, textureLod(uMask, uv + q, 0.0).r);
  m = max(m, textureLod(uMask, uv - q, 0.0).r);
  m = max(m, textureLod(uMask, uv + vec2(q.x, -q.y), 0.0).r);
  m = max(m, textureLod(uMask, uv + vec2(-q.x, q.y), 0.0).r);
  return smoothstep(${f(HOLE.maskLo)}, ${f(HOLE.maskHi)}, m);
}
float rayCapDist(vec3 d, vec3 A, vec3 B) {
  vec3 e = B - A;
  float b = dot(d, e), c = dot(e, e), dA = dot(d, A), eA = dot(e, A);
  float qa = c - b * b, qb = eA - dA * b, qc = dot(A, A) - dA * dA;
  float s = qa > 1e-6 ? clamp(-qb / qa, 0.0, 1.0) : 0.0;
  return sqrt(max(qa * s * s + 2.0 * qb * s + qc, 0.0));
}
float holeAt(vec3 P) {
  if (uRad <= 0.0) return 0.0;
  vec3 nf = normalize(cross(dFdx(P), dFdy(P)));
  float dz = (-uCtr.z) - (-P.z);
  float near = smoothstep(${f(HOLE.nearFrom)}, ${f(HOLE.nearTo)}, dz);
  float h = dot(uGround.xyz, P) + uGround.w;
  float keep = smoothstep(${f(HOLE.upFrom)}, ${f(HOLE.upTo)}, abs(dot(nf, uGround.xyz))) * (1.0 - smoothstep(${f(HOLE.floorFrom)}, ${f(HOLE.floorTo)}, h));
  vec2 d = P.xy / -P.z - uCtr.xy / -uCtr.z;
  float R = uRad / -uCtr.z;
  vec3 Q = P * (uCtr.z / P.z);
  float below = 1.0 - smoothstep(${f(HOLE.lowFrom)}, ${f(HOLE.lowTo)}, dot(uGround.xyz, Q - uCtr));
  keep = max(keep, below);
  vec3 A = uCtr + uGround.xyz * ${f(HOLE.ankle - HOLE.chest)};
  vec3 B = uCtr + uGround.xyz * ${f(HOLE.head - HOLE.chest)};
  float flatF = smoothstep(${f(HOLE.upFrom)}, ${f(HOLE.upTo)}, abs(dot(nf, uGround.xyz)));
  float reachE = mix(${f(HOLE.reach)}, ${f(HOLE.reachFlat)}, flatF);
  float win = 0.0;
  if ((1.0 - keep) * near > 0.0) win = uMaskOn > 0.5 ? maskCover() : 1.0 - smoothstep(reachE * (1.0 - ${f(HOLE.band)}), reachE, rayCapDist(P / length(P), A, B));
  float roof = flatF * smoothstep(${f(HOLE.roofFrom)}, ${f(HOLE.roofTo)}, h) * (1.0 - smoothstep(R * (1.0 - ${f(HOLE.band)}), R, length(d)));
  float rim = 1.0 - smoothstep(R * (1.0 - ${f(HOLE.band)}), R, length(d));
  float wide = ${f(HOLE.wide)} * (1.0 - flatF) * rim${HOLE.wideSide ? ` * smoothstep(${f(HOLE.wideFrom)}, ${f(HOLE.wideTo)}, dot(nf, P - uCtr))` : ''};
  float c = (1.0 - keep) * max(near * max(win, roof), smoothstep(${f(HOLE.wideNearFrom)}, ${f(HOLE.wideNearTo)}, dz) * wide);
${HOLE.sideTest ? `  c *= smoothstep(${f(HOLE.sideFrom)}, ${f(HOLE.sideTo)}, dot(nf, P - uCtr));\n` : ''}  return c;
}`

export interface HoleUniforms {
  uCtr: { value: Vector3 }, uGround: { value: Vector4 }, uRad: { value: number },
  /** The player's silhouette (the mask target's texture), one over the drawing buffer's size, and 1 when the mask is used (0: the capsule fallback). */
  uMask: { value: Texture | null }, uMaskInv: { value: Vector2 }, uMaskOn: { value: number },
}
export const holeUniforms = (): HoleUniforms => ({ uCtr: { value: new Vector3() }, uGround: { value: new Vector4(0, 1, 0, 0) }, uRad: { value: 0 }, uMask: { value: null }, uMaskInv: { value: new Vector2(1, 1) }, uMaskOn: { value: 0 } })

/**
 * Makes a material cut the hole: the rule is in the fragment stage only (nothing per vertex, no world-space cone), after the alpha test.
 * The uniforms are the ones given, so updating them moves the hole of every material that has it.
 */
export function patchHole(material: Material, u: HoleUniforms) {
  material.customProgramCacheKey = () => `followhole-${HOLE.sideTest ? 'side' : 'plain'}-${HOLE.wide}${HOLE.wideSide}-mask${HOLE.maskDilate}`
  material.onBeforeCompile = shader => {
    shader.uniforms.uCtr = u.uCtr
    shader.uniforms.uGround = u.uGround
    shader.uniforms.uRad = u.uRad
    shader.uniforms.uMask = u.uMask
    shader.uniforms.uMaskInv = u.uMaskInv
    shader.uniforms.uMaskOn = u.uMaskOn
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${holeGlsl()}\nvoid main() {`)
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (holeAt(-vViewPosition) > 0.5) discard;')
  }
  material.needsUpdate = true
}

/**
 * The numbers the shader needs for one frame, from the camera and where the followed player stands (three's Y-up world, the feet): the player's chest
 * and the plane they stand on in view space, and the radius. `follow` false (any camera but the follow camera) switches the hole off.
 * Works the camera's matrices out first: the pose of the follow camera is set just before the picture is drawn.
 */
export function updateHole(u: HoleUniforms, camera: Camera, feet: Vector3 | null, follow: boolean, radius = HOLE.radius) {
  if (!follow || !feet) { u.uRad.value = 0; return }
  camera.updateMatrixWorld()
  const inv = camera.matrixWorldInverse
  u.uCtr.value.set(feet.x, feet.y + HOLE.chest, feet.z).applyMatrix4(inv)
  const n = new Vector3(0, 1, 0).transformDirection(inv)
  const o = feet.clone().applyMatrix4(inv)
  u.uGround.value.set(n.x, n.y, n.z, -n.dot(o))
  u.uRad.value = radius
}

export interface HoleView { ctr: [number, number, number], ground: [number, number, number, number], rad: number }
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

/** The distance of the line from the camera (the origin) along the unit direction `d` to the segment `A`-`B` (the player's body axis), in world units. Smooth in `d`, whatever the depth of the surface. */
export function rayCapDist(d: [number, number, number], A: [number, number, number], B: [number, number, number]): number {
  const e = [B[0] - A[0], B[1] - A[1], B[2] - A[2]] as [number, number, number]
  const b = dot3(d, e), c = dot3(e, e), dA = dot3(d, A), eA = dot3(e, A)
  const qa = c - b * b, qb = eA - dA * b, qc = dot3(A, A) - dA * dA
  const s = qa > 1e-6 ? Math.min(1, Math.max(0, -qb / qa)) : 0
  return Math.sqrt(Math.max(qa * s * s + 2 * qb * s + qc, 0))
}

/**
 * The rule of holeGlsl in plain code: 1 where the pixel at view-space position `P` (the camera at the origin looking down -z) is cut, 0 where it is kept, with
 * the edge as narrow as `HOLE.band`. `nf` is the unit normal of the face the pixel is on, turned to the camera (the shader takes it from the derivatives).
 * `mask` is the player's silhouette at this pixel, 0 to 1 (`maskCoverage`): it is the body window (RFC 34, 9.7). Without it (`undefined`) the body window is the
 * capsule of 9.5, the fallback for a browser that could not make the mask.
 */
export function holeAt(P: [number, number, number], nf: [number, number, number], u: HoleView, sideTest = HOLE.sideTest, mask?: number): number {
  if (u.rad <= 0) return 0
  const dz = -u.ctr[2] - -P[2]
  const near = smooth(HOLE.nearFrom, HOLE.nearTo, dz)
  const h = dot3(u.ground, P) + u.ground[3]
  let keep = smooth(HOLE.upFrom, HOLE.upTo, Math.abs(dot3(nf, u.ground))) * (1 - smooth(HOLE.floorFrom, HOLE.floorTo, h))
  const dx = P[0] / -P[2] - u.ctr[0] / -u.ctr[2], dy = P[1] / -P[2] - u.ctr[1] / -u.ctr[2]
  const R = u.rad / -u.ctr[2]
  const k = P[2] === 0 ? 0 : u.ctr[2] / P[2]
  const Q: [number, number, number] = [P[0] * k, P[1] * k, P[2] * k]
  const below = 1 - smooth(HOLE.lowFrom, HOLE.lowTo, dot3(u.ground, [Q[0] - u.ctr[0], Q[1] - u.ctr[1], Q[2] - u.ctr[2]]))
  keep = Math.max(keep, below)
  const A: [number, number, number] = [0, 1, 2].map(i => u.ctr[i]! + u.ground[i]! * (HOLE.ankle - HOLE.chest)) as [number, number, number]
  const B: [number, number, number] = [0, 1, 2].map(i => u.ctr[i]! + u.ground[i]! * (HOLE.head - HOLE.chest)) as [number, number, number]
  const len = Math.hypot(P[0], P[1], P[2])
  const flatF = smooth(HOLE.upFrom, HOLE.upTo, Math.abs(dot3(nf, u.ground)))
  const reachE = HOLE.reach + (HOLE.reachFlat - HOLE.reach) * flatF
  const win = mask !== undefined ? mask : 1 - smooth(reachE * (1 - HOLE.band), reachE, rayCapDist(len === 0 ? [0, 0, -1] : [P[0] / len, P[1] / len, P[2] / len], A, B))
  const roof = flatF * smooth(HOLE.roofFrom, HOLE.roofTo, h) * (1 - smooth(R * (1 - HOLE.band), R, Math.hypot(dx, dy)))
  const rim = 1 - smooth(R * (1 - HOLE.band), R, Math.hypot(dx, dy))
  const wide = HOLE.wide * (1 - flatF) * rim * (HOLE.wideSide ? smooth(HOLE.wideFrom, HOLE.wideTo, dot3(nf, [P[0] - u.ctr[0], P[1] - u.ctr[1], P[2] - u.ctr[2]])) : 1)
  let c = (1 - keep) * Math.max(near * Math.max(win, roof), smooth(HOLE.wideNearFrom, HOLE.wideNearTo, dz) * wide)
  if (sideTest) c *= smooth(HOLE.sideFrom, HOLE.sideTo, dot3(nf, [P[0] - u.ctr[0], P[1] - u.ctr[1], P[2] - u.ctr[2]]))
  return c
}

/** The coverage the shader makes from the taps it reads of the mask (the centre and the eight on the circle of the dilation, each a bilinear value 0 to 1): the largest, through the smoothstep. */
export const maskCoverage = (taps: ArrayLike<number>): number => { let m = 0; for (let i = 0; i < taps.length; i++) m = Math.max(m, taps[i]!); return smooth(HOLE.maskLo, HOLE.maskHi, m) }

/** The uniforms as numbers (what the shader gets), for the plain-code rule. */
export const holeView = (u: HoleUniforms): HoleView => ({ ctr: u.uCtr.value.toArray() as [number, number, number], ground: u.uGround.value.toArray() as [number, number, number, number], rad: u.uRad.value })

// ---- the ghost

/** The ghost's material: a flat colour at half opacity, drawn only where something nearer is in front (the depth test passes where the stored depth is smaller), writes no depth, and not where the player's own body was drawn (the stencil: a limb behind the chest is "behind" it too). */
export const ghostMaterial = (colour: number) => new MeshBasicMaterial({
  color: colour, transparent: true, opacity: HOLE.ghostOpacity, depthFunc: GreaterDepth, depthWrite: false,
  stencilWrite: true, stencilRef: 1, stencilFunc: NotEqualStencilFunc, stencilFail: KeepStencilOp, stencilZFail: KeepStencilOp, stencilZPass: KeepStencilOp,
})

/** Marks the pixels the player's own body is drawn on in the stencil buffer (where it passes the depth test), so the ghost leaves them alone. */
export function markSolid(material: Material) {
  material.stencilWrite = true; material.stencilRef = 1; material.stencilZPass = ReplaceStencilOp
}

/**
 * A second draw of every mesh under `root` (a skinned mesh shares its skeleton with its copy, so the ghost moves with the figure) with the ghost material,
 * after the opaque scene (`renderOrder`) and before the pins and names. Hidden until `ghostShown` says so. Returns the copies.
 */
export function addGhost(root: Object3D, material: Material): Mesh[] {
  const made: Mesh[] = []
  const meshes: Mesh[] = []
  root.traverse(o => { if ((o as Mesh).isMesh) meshes.push(o as Mesh) })
  for (const m of meshes) {
    const g = m.clone(false) as Mesh
    g.material = material
    g.renderOrder = 5
    g.visible = false
    g.layers.enable(MASK_LAYER) // the mask pass draws this layer only
    m.parent?.add(g)
    made.push(g)
  }
  return made
}

/** The ghost is drawn for the followed player, and only in the follow camera, and only while that player is drawn. */
export const ghostShown = (camera: 'orbit' | 'top' | 'follow', selected: string | null, id: string, drawn: boolean): boolean => camera === 'follow' && selected === id && drawn

/** The ghost of a figure: its meshes marked in the stencil, drawn again with a ghost material in `colour`. */
export function ghostFigure(root: Object3D, colour: number) {
  root.traverse(o => { if ((o as Mesh).isMesh) markSolid((o as Mesh).material as Material) })
  const material = ghostMaterial(colour)
  return { material, meshes: addGhost(root, material) }
}

// ---- the mask: the followed player's silhouette (RFC 34, 9.7)

/** The layer the ghost's meshes are also on: the mask pass draws this layer only (the camera's layers are swapped for it), so nothing but the followed player is in the mask. */
export const MASK_LAYER = 1

export interface HoleMask {
  target: WebGLRenderTarget
  /** The flat white every mesh of the mask pass is drawn with (the scene's override material), both sides, no depth test: the silhouette alone. */
  material: MeshBasicMaterial
  /** The target may hold a silhouette (it is cleared when the player is not drawn, so a stale one is never read). */
  dirty: boolean
  /** The mask could not be drawn: the capsule is used from then on. */
  failed: boolean
}

/**
 * The mask target for a renderer (WebGL2: three's only), and the uniforms switched to it; `null`, and the capsule fallback, when the target cannot be made
 * (an old context, an exception). The size is set by `sizeMask`.
 */
export function createMask(renderer: WebGLRenderer, u: HoleUniforms): HoleMask | null {
  try {
    const gl = renderer.getContext()
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) throw new Error('no WebGL2')
    const target = new WebGLRenderTarget(2, 2, { format: RGBAFormat, type: UnsignedByteType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false })
    const material = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, depthTest: false, depthWrite: false, toneMapped: false, fog: false })
    const mask: HoleMask = { target, material, dirty: true, failed: false }
    u.uMask.value = target.texture
    u.uMaskOn.value = 1
    sizeMask(renderer, mask, u)
    return mask
  } catch {
    u.uMask.value = null
    u.uMaskOn.value = 0
    return null
  }
}

/** The mask follows the drawing buffer (call after every `setSize`): `maskScale` of it, and the shader's one-over-size for `gl_FragCoord`. */
export function sizeMask(renderer: WebGLRenderer, mask: HoleMask, u: HoleUniforms) {
  const s = renderer.getDrawingBufferSize(new Vector2())
  mask.target.setSize(Math.max(1, Math.round(s.x * HOLE.maskScale)), Math.max(1, Math.round(s.y * HOLE.maskScale)))
  u.uMaskInv.value.set(1 / Math.max(1, s.x), 1 / Math.max(1, s.y))
  mask.dirty = true
}

/** Whether the mask is drawn this frame: the hole is on (radius above 0: the follow camera) and the followed player is drawn. Nothing else costs anything. */
export const maskWanted = (radius: number, playerDrawn: boolean): boolean => radius > 0 && playerDrawn

/**
 * The mask pass, BEFORE the picture of the frame and with the picture's own camera and the poses of this frame: the ghost's meshes (the followed player's, drawn ones
 * only; a skinned one shares its skeleton) in flat white into the target, no background, nothing else. When it is not wanted and the target still holds a silhouette
 * it is cleared once; otherwise it does nothing. An exception switches the capsule fallback on.
 */
export function renderMask(renderer: WebGLRenderer, scene: Scene, camera: Camera, mask: HoleMask, u: HoleUniforms, wanted: boolean) {
  if (mask.failed) return
  if (!wanted && !mask.dirty) return
  const layers = camera.layers.mask, background = scene.background, override = scene.overrideMaterial, target = renderer.getRenderTarget()
  const colour = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha()
  try {
    renderer.setRenderTarget(mask.target)
    renderer.setClearColor(0x000000, 0)
    if (wanted) {
      camera.layers.set(MASK_LAYER)
      scene.background = null
      scene.overrideMaterial = mask.material
      renderer.render(scene, camera)
    } else renderer.clear()
    mask.dirty = wanted
  } catch {
    mask.failed = true
    u.uMaskOn.value = 0
  } finally {
    camera.layers.mask = layers
    scene.background = background
    scene.overrideMaterial = override
    renderer.setRenderTarget(target)
    renderer.setClearColor(colour, alpha)
  }
}
