/// <reference lib="dom" />
import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight, Box3, Vector3, Color, Mesh, MeshStandardMaterial,
  AmbientLight, Plane, type Object3D, type BufferGeometry,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// The 3D view of a map (RFC 11, 3.6): the stored GLB drawn by three.js, with a level cutaway.
// Loaded only on the page that shows it. It draws on demand (when the camera or a control
// changes), so an open tab costs nothing while nobody touches it.

const LEVEL_NAME = /^level-(\d+)$/
/** One hue per level, low to high, so the storeys can be told apart. */
const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)

function start(root: HTMLElement) {
  const src = root.dataset.src
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')
  const status = root.querySelector<HTMLElement>('[data-status]')
  if (!src || !canvas) return
  const say = (t: string) => { if (status) { status.textContent = t; status.hidden = t === '' } }

  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.localClippingEnabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new Scene()
  scene.background = new Color(0x111827)
  scene.add(new HemisphereLight(0xffffff, 0x555566, 1.4), new AmbientLight(0xffffff, 0.9))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(-1, 2, 1.2)
  scene.add(sun)
  const camera = new PerspectiveCamera(40, 1, 1, 200000)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = false

  const levels: { index: number, node: Object3D, hi: number }[] = []
  const walls: Mesh[] = []
  const draw = () => renderer.render(scene, camera)
  controls.addEventListener('change', draw)

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    draw()
  }
  new ResizeObserver(resize).observe(canvas)

  let centre = new Vector3(), size = new Vector3(1000, 1000, 1000)
  const half = Math.tan((camera.fov * Math.PI) / 360)
  const view = (mode: string) => {
    if (mode === 'top') {
      const d = (Math.max(size.x, size.z) / 2 / half) * 1.15 + size.y / 2
      camera.position.set(centre.x, centre.y + d, centre.z + 1)
    } else {
      const d = (size.length() / 2 / half) * 0.85
      camera.position.copy(centre).addScaledVector(new Vector3(0.6, 0.6, 0.75).normalize(), d)
    }
    controls.target.copy(centre)
    controls.update()
    draw()
  }

  // `which` is the button's own value: a level number, or "all".
  // A cutaway: the levels above the chosen one are hidden, and everything is cut a little above its
  // floors, so the tall walls of a lower level do not hide the inside. glTF is Y-up, so Source's height is Y.
  const CUT_ABOVE = 128
  const cut = new Plane(new Vector3(0, -1, 0), 1e9)
  const showLevels = (which: string) => {
    const upto = which === 'all' ? levels.length : Number(which)
    for (const l of levels) l.node.visible = l.index <= upto
    const top = levels.find(l => l.index === upto)
    cut.constant = which === 'all' || !top ? 1e9 : top.hi + CUT_ABOVE
    root.querySelectorAll<HTMLElement>('[data-level]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === which)))
    draw()
  }

  root.querySelectorAll<HTMLElement>('[data-level]').forEach(b => b.addEventListener('click', () => showLevels(b.dataset.level ?? 'all')))
  root.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.addEventListener('click', () => view(b.dataset.view ?? 'orbit')))
  root.querySelector<HTMLInputElement>('[data-walls]')?.addEventListener('change', e => {
    for (const m of walls) m.visible = (e.target as HTMLInputElement).checked
    draw()
  })

  say('Loading the map…')
  fetch(src, { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
    .then(buf => new Promise<Object3D>((ok, fail) => new GLTFLoader().parse(buf, '', g => ok(g.scene), fail)))
    .then(model => {
      model.traverse(o => { const m = LEVEL_NAME.exec(o.name); if (m && !levels.some(l => l.node === o)) levels.push({ index: Number(m[1]), node: o, hi: Number(o.userData.hi) }) })
      levels.sort((a, b) => a.index - b.index)
      for (const l of levels) {
        l.node.traverse(o => {
          if (!(o as Mesh).isMesh) return
          const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
          const isWall = mesh.material.name === 'wall'
          // The loader shares materials; a level gets its own so floors can be tinted per level.
          mesh.material = mesh.material.clone()
          mesh.material.clippingPlanes = [cut]
          // glTF's default material is a polished metal, which only reflects an environment this scene
          // does not have (the sides facing away from the light were black). Plain matte instead.
          mesh.material.metalness = 0
          mesh.material.roughness = 1
          if (isWall) walls.push(mesh); else mesh.material.color = levelColour(l.index, levels.length)
        })
      }
      scene.add(model)
      const box = new Box3().setFromObject(model)
      size = box.getSize(new Vector3())
      centre = box.getCenter(new Vector3())
      camera.far = size.length() * 20
      camera.updateProjectionMatrix()
      say('')
      resize()
      view('orbit')
      root.dataset.ready = '1'
    })
    .catch(() => say('The map could not be loaded.'))
}

document.querySelectorAll<HTMLElement>('[data-mapview]').forEach(start)
