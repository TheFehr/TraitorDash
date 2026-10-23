import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, AmbientLight, DirectionalLight, Color, BufferAttribute,
  type Mesh, type MeshStandardMaterial, type BufferGeometry, type Object3D, type Plane,
} from 'three'

/** What the map view and the replay start from: the same renderer, lit scene and camera, so a map looks the same in both. */

/** The dark background of the drawing: the canvas's own colour in the page stylesheet (#14110e). */
export const BACKGROUND = 0x14110e

/** A renderer on the canvas, with clipping on (the level cutaway) and the pixel ratio capped at 2. Throws without WebGL. */
export function makeRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.localClippingEnabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
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
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.openInBrowser = ''
    button.textContent = 'Open in your browser'
    button.addEventListener('click', () => open(url.pathname))
    const status = root.querySelector('[data-status]')
    status?.after(button)
    button.style.margin = '0 1.2rem 1.2rem'
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
const HEIGHT_LOW = new Color(0x6f8fa8), HEIGHT_HIGH = new Color(0xd9a066), HEIGHT_TINT = 0.35
const STORE_KEY = 'traitordash.mapcolour'

/** One hue per level, low to high, so the storeys can be told apart. */
export const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)

/** The choice made on the map page, kept in this browser; Plain without one (or without storage). */
export const savedColouring = (): Colouring => {
  try { const v = localStorage.getItem(STORE_KEY); if (v && (COLOURINGS as string[]).includes(v)) return v as Colouring } catch { /* storage may be off */ }
  return 'plain'
}
export const saveColouring = (c: Colouring) => { try { localStorage.setItem(STORE_KEY, c) } catch { /* the choice just is not remembered */ } }

/** A floor or wall mesh of a level, which the colouring paints. */
export interface Painted { mesh: Mesh<BufferGeometry, MeshStandardMaterial>, wall: boolean, level: number }

/** Vertex colours for the Height colouring: the plain colour of the surface tinted by its height over the whole map. Heights are Source's (Z up, before the root node turns the model). */
export function heightColours(painted: Painted[]): void {
  let zMin = Infinity, zMax = -Infinity
  for (const p of painted) { const pos = p.mesh.geometry.getAttribute('position'); for (let i = 0; i < pos.count; i++) { zMin = Math.min(zMin, pos.getZ(i)); zMax = Math.max(zMax, pos.getZ(i)) } }
  const c = new Color()
  for (const p of painted) {
    const pos = p.mesh.geometry.getAttribute('position')
    const base = new Color(p.wall ? PLAIN.wall : PLAIN.floor)
    const out = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const t = zMax > zMin ? Math.min(1, Math.max(0, (pos.getZ(i) - zMin) / (zMax - zMin))) : 0.5
      c.copy(HEIGHT_LOW).lerp(HEIGHT_HIGH, t)
      c.copy(base).lerp(c, HEIGHT_TINT)
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

/** The props of a model, if it has any: the meshes by kind, cut like the levels, matte; foliage never hides what is behind it. Their materials are shared by all the places, so they are set once. */
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
      if (foliage) mesh.material.depthWrite = false
    }
    ;(foliage ? out.foliage : out.solid).push(mesh)
  })
  return out
}
