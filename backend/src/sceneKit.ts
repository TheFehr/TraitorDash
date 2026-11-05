import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, AmbientLight, DirectionalLight, Color, BufferAttribute,
  Box3, ConeGeometry, Group, Mesh as MeshClass, MeshBasicMaterial, TextureLoader,
  type LoadingManager, type Mesh, type MeshStandardMaterial, type BufferGeometry, type Object3D, type Plane,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/** What the map view and the replay start from: the same renderer, lit scene and camera, so a map looks the same in both. */

/** The dark background of the drawing: the canvas's own colour in the page stylesheet (#14110e). */
export const BACKGROUND = 0x14110e

/** A renderer on the canvas, with clipping on (the level cutaway) and the pixel ratio capped (2, or 1.5 on a touch screen). Throws without WebGL. */
export function makeRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.localClippingEnabled = true
  // A phone's screen has three or more pixels for each of the page's: drawing all of them is what makes it slow, so a touch screen gets at most one and a half
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, navigator.maxTouchPoints > 0 ? 1.5 : 2))
  return renderer
}

/** A scene with the dark background and the three lights. */
export function makeScene(): Scene {
  const scene = new Scene()
  scene.background = new Color(BACKGROUND)
  scene.add(new HemisphereLight(0xffffff, 0x555566, 1.4), new AmbientLight(0xffffff, 0.9))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(-1, 2, 1.2)
  scene.add(sun)
  return scene
}

/** The perspective camera both views use. */
export const makeCamera = (): PerspectiveCamera => new PerspectiveCamera(40, 1, 1, 200000)

/** In the game, a button that opens this page in the player's own browser (the Lua part gives the page `traitordash.open`); nothing elsewhere. Placed after `after`. */
export function offerBrowser(root: HTMLElement, label: string, after: Element | null): HTMLButtonElement | null {
  const open = (window as any).traitordash?.open
  if (typeof open !== 'function') return null
  const url = new URL(location.href)
  url.searchParams.delete('embed')
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.openInBrowser = ''
  button.textContent = label
  button.addEventListener('click', () => open(url.pathname))
  after?.after(button)
  button.style.margin = '0 1.2rem 1.2rem'
  return button
}

/**
 * What a page shows when the browser has no WebGL (the game's built-in browser has it switched off, so the 3D map and the
 * replay cannot be drawn in the game's window): the controls that would do nothing go away, and the message says where to
 * open the page instead. `hint` is a sentence for what is still there (the replay keeps its lists).
 */
export function explainNoWebGL(root: HTMLElement, say: (t: string) => void, what: string, hint = ''): void {
  root.querySelector('.view')?.classList.add('nogl')
  root.querySelector('canvas')?.setAttribute('hidden', '')
  root.querySelectorAll('.tools, [data-controls], [data-background], [data-disclaimer]').forEach(e => e.setAttribute('hidden', ''))
  const url = new URL(location.href)
  url.searchParams.delete('embed')
  // In the game the Lua part gives the page `traitordash.open`, which opens a page of this server in the player's own browser.
  const open = (window as any).traitordash?.open
  if (typeof open === 'function') {
    say(`This browser cannot draw ${what}: WebGL is not available in the game's window.${hint ? ` ${hint}` : ''}`)
    offerBrowser(root, 'Open in your browser', root.querySelector('[data-status]'))
    return
  }
  say(`This browser cannot draw ${what}: WebGL is not available in it. Open this page in your normal browser: ${url.host}${url.pathname}${hint ? ` ${hint}` : ''}`)
}

// ---- how a map is coloured (RFC 18, 5): the same in the map view and the replay

/** Plain (the default): warm greys, the light shows the form. Height: the same greys tinted a little by height over the whole map. Levels: one hue per storey. */
export type Colouring = 'plain' | 'height' | 'levels'
export const COLOURINGS: Colouring[] = ['plain', 'height', 'levels']
const PLAIN = { floor: 0xcfc6b0, wall: 0xa59d8c }
const LEVELS_WALL = 0x9999a6
// Height runs deep blue, teal, yellow (not orange: orange is the parts that move). Mostly the colour, a little of the surface's own.
const HEIGHT_STOPS = [new Color(0x2f4b8f), new Color(0x2fa39a), new Color(0xf0dc5a)], HEIGHT_TINT = 0.85
const STORE_KEY = 'traitordash.mapcolour'

/** One hue per level, low to high, so the storeys can be told apart. */
export const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)

/** The choice made on the map page, kept in this browser; Plain without one (or without storage). */
export const savedColouring = (fallback: Colouring = 'plain'): Colouring => {
  try { const v = localStorage.getItem(STORE_KEY); if (v && (COLOURINGS as string[]).includes(v)) return v as Colouring } catch { /* storage may be off */ }
  return fallback
}
export const saveColouring = (c: Colouring) => { try { localStorage.setItem(STORE_KEY, c) } catch { /* the choice just is not remembered */ } }

/** A floor or wall mesh of a level, which the colouring paints. */
export interface Painted { mesh: Mesh<BufferGeometry, MeshStandardMaterial>, wall: boolean, level: number }

/** Vertex colours for the Height colouring: the plain colour of the surface tinted by its height over the whole map. Heights are Source's (Z up, before the root node turns the model). */
export function heightColours(painted: Painted[]): void {
  // The range is the middle 96% of the heights, so a spire or a pit does not squeeze everything else into one colour.
  let lo = Infinity, hi = -Infinity
  for (const p of painted) { const pos = p.mesh.geometry.getAttribute('position'); for (let i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getZ(i)); hi = Math.max(hi, pos.getZ(i)) } }
  let zMin = lo, zMax = hi
  if (hi > lo) {
    const BINS = 512, bins = new Float64Array(BINS)
    let total = 0
    for (const p of painted) { const pos = p.mesh.geometry.getAttribute('position'); for (let i = 0; i < pos.count; i++) { bins[Math.min(BINS - 1, Math.floor(((pos.getZ(i) - lo) / (hi - lo)) * BINS))]! += 1; total++ } }
    let acc = 0, a = 0, b = BINS - 1
    for (let k = 0; k < BINS; k++) { acc += bins[k]!; if (acc >= total * 0.02) { a = k; break } }
    acc = 0
    for (let k = BINS - 1; k >= 0; k--) { acc += bins[k]!; if (acc >= total * 0.02) { b = k + 1; break } }
    if (b > a) { zMin = lo + (a / BINS) * (hi - lo); zMax = lo + (b / BINS) * (hi - lo) }
  }
  const c = new Color(), tint = new Color()
  const ramp = (t: number, out: Color) => { const x = t * (HEIGHT_STOPS.length - 1), k = Math.min(HEIGHT_STOPS.length - 2, Math.floor(x)); return out.copy(HEIGHT_STOPS[k]!).lerp(HEIGHT_STOPS[k + 1]!, x - k) }
  for (const p of painted) {
    const pos = p.mesh.geometry.getAttribute('position')
    const base = new Color(p.wall ? PLAIN.wall : PLAIN.floor)
    const out = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const t = zMax > zMin ? Math.min(1, Math.max(0, (pos.getZ(i) - zMin) / (zMax - zMin))) : 0.5
      c.copy(base).lerp(ramp(t, tint), HEIGHT_TINT)
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b
    }
    p.mesh.geometry.setAttribute('color', new BufferAttribute(out, 3))
  }
}

/** Paints the meshes in a colouring (call `heightColours` once before the first use of 'height'). */
export function applyColouring(painted: Painted[], mode: Colouring, levelCount: number): void {
  for (const p of painted) {
    const m = p.mesh.material
    m.vertexColors = mode === 'height'
    m.color = mode === 'height' ? new Color(0xffffff)
      : new Color(mode === 'levels' ? (p.wall ? LEVELS_WALL : levelColour(p.level, levelCount).getHex()) : p.wall ? PLAIN.wall : PLAIN.floor)
    m.needsUpdate = true
  }
}

/** The water node of a model (if it has one): cut like the levels, matte, and it never hides what is under it. */
export function prepareWater(model: Object3D, cut: Plane): Object3D | null {
  const water = model.getObjectByName('water') ?? null
  water?.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
    mesh.material = mesh.material.clone()
    mesh.material.clippingPlanes = [cut]
    mesh.material.metalness = 0
    mesh.material.roughness = 1
    mesh.material.depthWrite = false
  })
  return water
}

/** The parts that can move (doors, lifts, a collapsing building): cut like the levels, matte, and left in their own orange whatever the colouring. Null when the model has none. */
export function prepareMovable(model: Object3D, cut: Plane): Object3D | null {
  const node = model.getObjectByName('movable') ?? null
  node?.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
    mesh.material = mesh.material.clone()
    mesh.material.clippingPlanes = [cut]
    mesh.material.metalness = 0
    mesh.material.roughness = 1
  })
  return node
}

/**
 * A loader for the map's file. The textures in it (the leaves of the plants, RFC 18, 4.6) are PNG images inside the file; the loader's
 * own way of reading them fetches a `blob:` address, which the page's policy does not allow (`connect-src 'self'`), so they are read as
 * images (`img-src` has `blob:`), the way an older browser does it, and the policy stays as strict as it was.
 */
export function mapLoader(): GLTFLoader {
  const loader = new GLTFLoader()
  loader.register(parser => { (parser as unknown as { textureLoader: TextureLoader }).textureLoader = new TextureLoader((parser as unknown as { options: { manager: LoadingManager } }).options.manager); return { name: 'TD_images' } })
  return loader
}

/** The props of a model, if it has any: the meshes by kind, cut like the levels, matte. Their materials are shared by all the places, so they are set once. */
export function prepareProps(model: Object3D, cut: Plane): { solid: Mesh[], foliage: Mesh[] } {
  const out = { solid: [] as Mesh[], foliage: [] as Mesh[] }
  const seen = new Set<MeshStandardMaterial>()
  model.getObjectByName('props')?.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
    const foliage = mesh.material.name === 'foliage'
    if (!seen.has(mesh.material)) {
      seen.add(mesh.material)
      mesh.material.clippingPlanes = [cut]
      mesh.material.metalness = 0
      mesh.material.roughness = 1
    }
    ;(foliage ? out.foliage : out.solid).push(mesh)
  })
  return out
}

/**
 * The detached parts of a model (RFC 18, 4.4: pieces not near the rest of the map), if it has any: cut like the levels, matte,
 * hidden until asked for. Returns the node and its floor and wall meshes (to be painted like a level's).
 */
export function prepareDetached(model: Object3D, cut: Plane): { node: Object3D, painted: Painted[] } | null {
  const node = model.getObjectByName('detached')
  if (!node) return null
  node.visible = false
  const painted: Painted[] = []
  node.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
    const wall = mesh.material.name === 'wall'
    mesh.material = mesh.material.clone()
    mesh.material.clippingPlanes = [cut]
    mesh.material.metalness = 0
    mesh.material.roughness = 1
    painted.push({ mesh, wall, level: 1 })
  })
  return { node, painted }
}

/** The box around a model without some of its nodes (the detached parts must not decide where the camera looks). In the model's own space (three's Y-up, as `Box3.setFromObject`). */
export function boxWithout(model: Object3D, names: string[]): Box3 {
  model.updateWorldMatrix(true, true)
  const box = new Box3()
  const walk = (o: Object3D) => { if (names.includes(o.name)) return; if ((o as Mesh).isMesh) box.expandByObject(o, true); else o.children.forEach(walk) }
  walk(model)
  return box.isEmpty() ? new Box3().setFromObject(model) : box
}

export interface SpawnPoint { class: string, x: number, y: number, z: number }
const SPAWN_COLOURS: [RegExp, number][] = [[/terror/, 0xe5484d], [/counter|_ct/, 0x4f8ff7], [/.*/, 0x4cc38a]]

/** The spawn points as small cones standing on their spot, a group in the model's Source space (Z up), hidden until asked for. Red for the terrorists' spawns, blue for the counter-terrorists', green for the rest. */
export function makeSpawnMarkers(model: Object3D, spawns: SpawnPoint[], cut: Plane): Group | null {
  const space = model.getObjectByName('z-up')
  if (!space || spawns.length === 0) return null
  const group = new Group()
  group.name = 'spawn-markers'
  group.visible = false
  const geometry = new ConeGeometry(20, 64, 8)
  geometry.rotateX(Math.PI / 2) // the cone points along Y; this world's up is Z
  geometry.translate(0, 0, 32)
  const materials = new Map<number, MeshBasicMaterial>()
  for (const s of spawns) {
    if (![s.x, s.y, s.z].every(Number.isFinite)) continue
    const colour = SPAWN_COLOURS.find(([re]) => re.test(s.class))![1]
    let material = materials.get(colour)
    if (!material) { material = new MeshBasicMaterial({ color: colour, clippingPlanes: [cut] }); materials.set(colour, material) }
    const marker = new MeshClass(geometry, material)
    marker.position.set(s.x, s.y, s.z)
    group.add(marker)
  }
  space.add(group)
  return group
}
