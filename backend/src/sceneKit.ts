import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, AmbientLight, DirectionalLight, Color, BufferAttribute,
  Box3, CanvasTexture, ConeGeometry, Group, Mesh as MeshClass, MeshBasicMaterial, TextureLoader,
  type LoadingManager, type Texture, type Mesh, type MeshStandardMaterial, type BufferGeometry, type Object3D, type Plane,
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

/**
 * Textured (the default): the textures of the map's own surfaces and plants (RFC 18, 5); a surface with none is a warm grey, the light shows the form.
 * The others are the colour-by-storey views and have none of that colour. Height: greys tinted a little by height over the whole map. Levels: one hue per storey.
 */
export type Colouring = 'textured' | 'height' | 'levels'
export const COLOURINGS: Colouring[] = ['textured', 'height', 'levels']
/** The colour the leaves of plants have where their own colour is off: only their shape (the cut-out of their texture) is kept. */
const LEAF_COLOUR = 0xa9a996
const PLAIN = { floor: 0xcfc6b0, wall: 0xa59d8c }
const LEVELS_WALL = 0x9999a6
// Height runs deep blue, teal, yellow. Mostly the colour, a little of the surface's own.
const HEIGHT_STOPS = [new Color(0x2f4b8f), new Color(0x2fa39a), new Color(0xf0dc5a)], HEIGHT_TINT = 0.85
const STORE_KEY = 'traitordash.mapcolour'

/** One hue per level, low to high, so the storeys can be told apart. */
export const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)

/** The choice made on the map page, kept in this browser; Textured without one (or without storage; a choice of the old Plain is Textured). */
export const savedColouring = (fallback: Colouring = 'textured'): Colouring => {
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

/** Whether any surface of the model has a texture or a colour of its own (a mesh made before RFC 18, 5 has none, and has nothing for the Textured view to show). */
export const hasTextures = (painted: Painted[]) => painted.some(p => !!p.mesh.material.userData?.surface)

/**
 * Paints the meshes in a colouring (call `heightColours` once before the first use of 'height'). In the colour-by-storey views the textures and
 * the plain colours of the surfaces are put away, and come back in Textured; a surface with none is the plain floor or wall in every view.
 */
export function applyColouring(painted: Painted[], mode: Colouring, levelCount: number): void {
  for (const p of painted) {
    const m = p.mesh.material
    const own = m.userData?.surface as string | undefined
    if (own && !p.mesh.userData.own) p.mesh.userData.own = { map: m.map, color: m.color.clone(), transparent: m.transparent, alphaTest: m.alphaTest }
    const saved = p.mesh.userData.own as { map: typeof m.map, color: Color, transparent: boolean, alphaTest: number } | undefined
    if (mode === 'textured' && own && saved) {
      m.map = saved.map; m.color = saved.color.clone(); m.transparent = saved.transparent; m.alphaTest = saved.alphaTest; m.vertexColors = false
    } else {
      if (saved) { m.map = null; m.transparent = false; m.alphaTest = 0 } // a cut-out or see-through surface is a plain one where its texture is off
      m.vertexColors = mode === 'height'
      m.color = mode === 'height' ? new Color(0xffffff)
        : new Color(mode === 'levels' ? (p.wall ? LEVELS_WALL : levelColour(p.level, levelCount).getHex()) : p.wall ? PLAIN.wall : PLAIN.floor)
    }
    m.needsUpdate = true
  }
}

const alphaMaps = new WeakMap<Texture, Texture>()
/** A copy of a texture that carries only its alpha (in the green channel, which is where a material reads an alpha map), so a leaf can keep its shape without its colour. */
function alphaOnly(tex: Texture): Texture {
  let out = alphaMaps.get(tex)
  if (out) return out
  const image = tex.image as CanvasImageSource & { width: number, height: number }
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const g = canvas.getContext('2d')!
  g.drawImage(image, 0, 0)
  const data = g.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < data.data.length; i += 4) { const a = data.data[i + 3]!; data.data[i] = 255; data.data[i + 1] = a; data.data[i + 2] = 255; data.data[i + 3] = 255 }
  g.putImageData(data, 0, 0)
  out = new CanvasTexture(canvas)
  out.flipY = tex.flipY; out.wrapS = tex.wrapS; out.wrapT = tex.wrapT
  alphaMaps.set(tex, out)
  return out
}

/** The meshes of a node (none for no node). */
export const meshesOf = (node: Object3D | null): Mesh[] => { const out: Mesh[] = []; node?.traverse(o => { if ((o as Mesh).isMesh) out.push(o as Mesh) }); return out }

/**
 * The leaves of plants (and the glass) and the solid props: with their textures in the Textured view; in the others a leaf is its cut-out shape in a
 * flat colour and a solid prop is the plain prop colour. The look is kept on the material (which many meshes share), not on the mesh.
 */
export function propLook(meshes: Mesh[], textured: boolean): void {
  for (const mesh of meshes) {
    const m = mesh.material as MeshStandardMaterial
    const leaf = m.name === 'foliage'
    if (!m.userData.look && m.map) m.userData.look = { map: m.map, color: m.color.clone() }
    const own = m.userData.look as { map: Texture, color: Color } | undefined
    if (!own) continue
    if (textured) { m.map = own.map; m.alphaMap = null; m.color = own.color.clone() }
    else if (leaf) { m.map = null; m.alphaMap = alphaOnly(own.map); m.color = new Color(LEAF_COLOUR) }
    else { m.map = null; m.color = new Color().setRGB(0.72, 0.7, 0.63, 'srgb-linear') }
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

/** The parts that can move (doors, lifts, a collapsing building): cut like the levels and matte; their textures (or the plain prop colour) come and go with the colouring through `propLook`. Null when the model has none. */
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
