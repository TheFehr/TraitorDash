import { GreaterDepth, KeepStencilOp, MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, Vector3, Vector4, type Camera, type Material, type Mesh, type Object3D } from 'three'

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
   *  Everything else inside the circle stays. `reach` is the body (about 16) plus a margin, tuned on the recorded moments. */
  head: 72,
  reach: 24,
  roofFrom: 56,
  roofTo: 76,
  /** Only a face that really lies between the camera and the player is cut (RFC 34, 4.3): the face's plane is in front of their centre by `sideFrom` to `sideTo` units. */
  sideTest: false,
  sideFrom: 0,
  sideTo: 20,
  /** The ghost: opacity of the flat colour drawn where something covers the player. */
  ghostOpacity: 0.5,
}

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

/** The rule in the shader (built when asked, from the current constants). Uniforms: the player's centre and the plane they stand on, in view space, and the radius (0: no hole). */
export const holeGlsl = () => `
uniform vec3 uCtr;
uniform vec4 uGround;
uniform float uRad;
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
  float win = 1.0 - smoothstep(${f(HOLE.reach)} * (1.0 - ${f(HOLE.band)}), ${f(HOLE.reach)}, rayCapDist(P / length(P), A, B));
  float flatF = smoothstep(${f(HOLE.upFrom)}, ${f(HOLE.upTo)}, abs(dot(nf, uGround.xyz)));
  float roof = flatF * smoothstep(${f(HOLE.roofFrom)}, ${f(HOLE.roofTo)}, h) * (1.0 - smoothstep(R * (1.0 - ${f(HOLE.band)}), R, length(d)));
  float c = near * (1.0 - keep) * max(win, roof);
${HOLE.sideTest ? `  c *= smoothstep(${f(HOLE.sideFrom)}, ${f(HOLE.sideTo)}, dot(nf, P - uCtr));\n` : ''}  return c;
}`

export interface HoleUniforms { uCtr: { value: Vector3 }, uGround: { value: Vector4 }, uRad: { value: number } }
export const holeUniforms = (): HoleUniforms => ({ uCtr: { value: new Vector3() }, uGround: { value: new Vector4(0, 1, 0, 0) }, uRad: { value: 0 } })

/**
 * Makes a material cut the hole: the rule is in the fragment stage only (nothing per vertex, no world-space cone), after the alpha test.
 * The uniforms are the ones given, so updating them moves the hole of every material that has it.
 */
export function patchHole(material: Material, u: HoleUniforms) {
  material.customProgramCacheKey = () => `followhole-${HOLE.sideTest ? 'side' : 'plain'}`
  material.onBeforeCompile = shader => {
    shader.uniforms.uCtr = u.uCtr
    shader.uniforms.uGround = u.uGround
    shader.uniforms.uRad = u.uRad
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
 */
export function holeAt(P: [number, number, number], nf: [number, number, number], u: HoleView, sideTest = HOLE.sideTest): number {
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
  const win = 1 - smooth(HOLE.reach * (1 - HOLE.band), HOLE.reach, rayCapDist(len === 0 ? [0, 0, -1] : [P[0] / len, P[1] / len, P[2] / len], A, B))
  const flatF = smooth(HOLE.upFrom, HOLE.upTo, Math.abs(dot3(nf, u.ground)))
  const roof = flatF * smooth(HOLE.roofFrom, HOLE.roofTo, h) * (1 - smooth(R * (1 - HOLE.band), R, Math.hypot(dx, dy)))
  let c = near * (1 - keep) * Math.max(win, roof)
  if (sideTest) c *= smooth(HOLE.sideFrom, HOLE.sideTo, dot3(nf, [P[0] - u.ctr[0], P[1] - u.ctr[1], P[2] - u.ctr[2]]))
  return c
}

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
