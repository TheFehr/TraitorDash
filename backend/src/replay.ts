/// <reference lib="dom" />
import {
  WebGLRenderer, Scene, PerspectiveCamera, OrthographicCamera, HemisphereLight, DirectionalLight, AmbientLight, Box3, Vector3, Color, Group, Mesh,
  MeshStandardMaterial, MeshBasicMaterial, CapsuleGeometry, ConeGeometry, BoxGeometry, InstancedMesh, Matrix4, Object3D, Plane, Sprite, SpriteMaterial,
  CanvasTexture, BufferGeometry, Float32BufferAttribute, Line, LineSegments, LineBasicMaterial, type Camera, type MeshStandardMaterial as StdMat,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { decodeTrack, poseAt, lastPoseAt, trailBetween, levelOf, defaultSelection, teamColour, clock, type Decoded, type Segment, type LevelRange } from './replaylogic'

// The round replay (RFC 12, 3.5): one three.js scene that draws the best background there is (the
// map's mesh, its floor plan as tiles, or an empty grid) and puts the players into the same
// coordinates. Source is Z-up and three.js is Y-up, so everything that is in Source's coordinates
// sits in a group turned by a quarter turn, as the GLB's root node does.
//
// It draws on demand: while it plays, and when something changes; an open tab at rest costs nothing.

interface Payload {
  round: { id: string, map: string | null, result: string, duration: number | null, startedAt: string | null }
  players: { id: string, nick: string | null, role: string | null, team: string | null, won: boolean, survived: boolean }[]
  track: any
  trackInfo: { truncated: boolean, degraded: boolean, fingerprint: string | null, pinned: boolean }
  background: { kind: 'mesh' | 'plan' | 'none', meshUrl?: string, plan?: any, levels: LevelRange[], mismatch: boolean }
}

const LEVEL_NAME = /^level-(\d+)$/
const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)
const CUT_ABOVE = 128
const TRAIL_MS = 4000
const KILL_LINE_MS = 2500
const SPEEDS = [1, 2, 4, 8]

const el = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)
const text = (s: string, tag = 'span', cls = '') => { const e = document.createElement(tag); e.textContent = s; if (cls) e.className = cls; return e }
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

async function start(root: HTMLElement) {
  const src = root.dataset.src, viewer = root.dataset.viewer || null
  const canvas = el<HTMLCanvasElement>(root, '[data-canvas]')
  const status = el(root, '[data-status]')
  if (!src || !canvas) return
  const cv: HTMLCanvasElement = canvas
  const say = (t: string) => { if (status) { status.textContent = t; status.hidden = t === '' } }

  say('Loading the round…')
  let payload: Payload
  try {
    const r = await fetch(src, { credentials: 'same-origin' })
    if (!r.ok) throw new Error(String(r.status))
    payload = await r.json()
  } catch {
    say('The round could not be loaded.')
    return
  }

  const data: Decoded = decodeTrack(payload.track)
  const meta = new Map(payload.players.map(p => [p.id, p]))
  const ids = payload.players.map(p => p.id).filter(id => data.players.has(id))
  const levels = payload.background.levels
  const nick = (id: string) => meta.get(id)?.nick || id.slice(-6)
  const colourOf = (id: string) => teamColour(meta.get(id)?.team ?? null)

  // ---- state
  let ms = 0, playing = false, speed = 1, last = 0
  let selected = defaultSelection(ids, viewer, data.deaths)
  let camMode: 'orbit' | 'top' | 'follow' = 'orbit'
  let markerScale = 1 // grows with the map, so a player is still seen from far away
  let followLevel = true
  let upTo: number | 'all' = 'all'

  // ---- the page's own parts that do not need WebGL: the round's deaths, the player list, the notes
  const notes = el(root, '[data-notes]')
  const note = (t: string) => { if (notes) notes.append(text(t, 'p', 'text-xs text-yellow-300')) }
  if (payload.background.mismatch) note('The map in the background is another version than the one this round was played on; it may not match.')
  if (payload.trackInfo.truncated) note('This track was cut short (it reached a size or length limit), so the end of the round may be missing.')
  if (payload.trackInfo.degraded) note('The game server was too busy to keep recording, so the track ends early.')
  const bgText = { mesh: 'Drawn in the map\'s 3D geometry.', plan: 'Drawn on the map\'s floor plan (no 3D geometry for this map).', none: 'No map is available for this round: positions are drawn on an empty grid.' }[payload.background.kind]
  el(root, '[data-background]')!.textContent = bgText

  const deathsEl = el(root, '[data-deaths]')
  const seek = (t: number) => { ms = Math.max(0, Math.min(data.length, t)); changed() }
  for (const d of data.deaths) {
    if (!deathsEl) break
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'text-left hover:text-white'
    b.textContent = `${clock(d.t)}  ${nick(d.victim)}${d.attacker ? ' ← ' + nick(d.attacker) : ''}${d.weapon ? ' (' + d.weapon + ')' : ''}`
    b.addEventListener('click', () => { selected = d.victim; seek(d.t - 3000) })
    li.append(b)
    deathsEl.append(li)
  }
  if (deathsEl && data.deaths.length === 0) deathsEl.append(text('No deaths in this round.', 'li', 'text-gray-500'))

  const listEl = el(root, '[data-players]')
  const rows = new Map<string, HTMLElement>()
  for (const id of ids) {
    if (!listEl) break
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-gray-700'
    const dot = text('', 'span', 'inline-block w-3 h-3 rounded-full shrink-0')
    dot.style.background = hex(colourOf(id))
    b.append(dot, text(nick(id), 'span', 'truncate'), text(meta.get(id)?.role ?? '', 'span', 'ml-auto text-xs text-gray-400'))
    b.addEventListener('click', () => { selected = id; changed() })
    listEl.append(b)
    rows.set(id, b)
  }
  const scrub = el<HTMLInputElement>(root, '[data-scrub]')!
  scrub.max = String(data.length); scrub.value = '0'
  const ticks = el(root, '[data-ticks]')
  if (ticks) for (const d of data.deaths) {
    const t = text('', 'span', 'absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none')
    t.style.left = `${data.length ? (d.t / data.length) * 100 : 0}%`
    ticks.append(t)
  }
  const timeEl = el(root, '[data-time]')!

  // ---- WebGL: a browser without it gets the lists above and this message
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true })
  } catch {
    canvas.hidden = true
    say('This browser cannot draw the replay (WebGL is not available). The list of deaths is below.')
    el(root, '[data-controls]')?.setAttribute('hidden', '')
    return
  }
  renderer.localClippingEnabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new Scene()
  scene.background = new Color(0x111827)
  scene.add(new HemisphereLight(0xffffff, 0x555566, 1.4), new AmbientLight(0xffffff, 0.9))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(-1, 2, 1.2)
  scene.add(sun)

  const persp = new PerspectiveCamera(40, 1, 1, 200000)
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 200000)
  let camera: Camera = persp
  const orbit = new OrbitControls(persp, canvas)
  const topControls = new OrbitControls(ortho, canvas)
  topControls.enableRotate = false
  topControls.screenSpacePanning = true
  topControls.enabled = false

  // Everything in Source's coordinates (Z up) lives here.
  const world = new Group()
  world.rotation.x = -Math.PI / 2
  scene.add(world)

  // ---- the background
  const cut = new Plane(new Vector3(0, -1, 0), 1e9)
  const levelNodes: { index: number, node: Object3D }[] = []
  const wallMeshes: Mesh[] = []
  let bounds = new Box3(new Vector3(-512, -512, -64), new Vector3(512, 512, 256)) // Source coordinates

  const finish = (b: Box3) => { bounds = b; markerScale = Math.max(1, b.getSize(new Vector3()).length() / 2200) }

  // The extent of all the positions in the track: the grid is fitted to it, and so is a map without a mesh.
  const trackBox = new Box3()
  for (const segs of data.players.values()) for (const s of segs) for (let i = 0; i < s.x.length; i++) trackBox.expandByPoint(new Vector3(s.x[i]!, s.y[i]!, s.z[i]!))
  if (trackBox.isEmpty()) trackBox.set(new Vector3(-512, -512, 0), new Vector3(512, 512, 128))
  trackBox.expandByScalar(160)

  const bg = payload.background
  if (bg.kind === 'mesh' && bg.meshUrl) {
    say('Loading the map…')
    try {
      const buf = await fetch(bg.meshUrl, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
      const model = await new Promise<Object3D>((ok, fail) => new GLTFLoader().parse(buf, '', g => ok(g.scene), fail))
      model.traverse(o => { const m = LEVEL_NAME.exec(o.name); if (m && !levelNodes.some(l => l.node === o)) levelNodes.push({ index: Number(m[1]), node: o }) })
      levelNodes.sort((a, b) => a.index - b.index)
      for (const l of levelNodes) l.node.traverse(o => {
        if (!(o as Mesh).isMesh) return
        const mesh = o as Mesh<BufferGeometry, StdMat>
        const isWall = mesh.material.name === 'wall'
        mesh.material = mesh.material.clone()
        mesh.material.clippingPlanes = [cut]
        mesh.material.metalness = 0
        mesh.material.roughness = 1
        if (isWall) wallMeshes.push(mesh); else mesh.material.color = levelColour(l.index, levelNodes.length)
      })
      scene.add(model)
      const b = new Box3().setFromObject(model) // in three's Y-up
      // back to Source's Z-up: (x, y, z) three = (x, z, -y) Source
      finish(new Box3(new Vector3(b.min.x, -b.max.z, b.min.y), new Vector3(b.max.x, -b.min.z, b.max.y)))
    } catch {
      say('The map could not be loaded; the positions are drawn without it.')
      finish(trackBox)
    }
  } else if (bg.kind === 'plan' && bg.plan) {
    const g = bg.plan as { cell: number, minx: number, miny: number, nx: number, ny: number, rows: string[] }
    const perLevel = new Map<number, { x: number, y: number, z: number }[]>()
    g.rows.forEach((row, j) => row.split('|').forEach((cell, i) => {
      if (cell === '') return
      for (const f of cell.split(',')) {
        const z = parseInt(f, 10)
        const lv = levelOf(levels, z)
        const arr = perLevel.get(lv) ?? []
        arr.push({ x: g.minx + (i + 0.5) * g.cell, y: g.miny + (g.ny - 1 - j + 0.5) * g.cell, z })
        perLevel.set(lv, arr)
      }
    }))
    const box = new Box3()
    const geo = new BoxGeometry(g.cell * 0.96, g.cell * 0.96, 6)
    for (const [lv, cells] of perLevel) {
      const mat = new MeshStandardMaterial({ color: levelColour(Math.max(1, lv), Math.max(1, levels.length)), metalness: 0, roughness: 1, clippingPlanes: [] })
      const im = new InstancedMesh(geo, mat, cells.length)
      const m = new Matrix4()
      cells.forEach((c, k) => { m.makeTranslation(c.x, c.y, c.z - 3); im.setMatrixAt(k, m); box.expandByPoint(new Vector3(c.x, c.y, c.z)) })
      im.name = `level-${lv}`
      world.add(im)
      levelNodes.push({ index: lv, node: im })
    }
    levelNodes.sort((a, b) => a.index - b.index)
    box.expandByScalar(g.cell)
    finish(box.isEmpty() ? trackBox : box)
  } else {
    const box = trackBox.clone()
    const step = 128
    const pts: number[] = []
    const x0 = Math.floor(box.min.x / step) * step, x1 = Math.ceil(box.max.x / step) * step
    const y0 = Math.floor(box.min.y / step) * step, y1 = Math.ceil(box.max.y / step) * step
    for (let x = x0; x <= x1; x += step) pts.push(x, y0, box.min.z, x, y1, box.min.z)
    for (let y = y0; y <= y1; y += step) pts.push(x0, y, box.min.z, x1, y, box.min.z)
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pts, 3))
    world.add(new LineSegments(g, new LineBasicMaterial({ color: 0x374151 })))
    finish(box)
  }

  // ---- markers
  const bodyGeo = new CapsuleGeometry(16, 40, 4, 12)
  bodyGeo.rotateX(Math.PI / 2) // upright along Source's Z
  const arrowGeo = new ConeGeometry(9, 30, 10)
  arrowGeo.rotateZ(-Math.PI / 2) // points along +x
  const crossGeo = new BoxGeometry(46, 8, 8)

  interface Marker { group: Group, body: Mesh, arrow: Mesh, label: Sprite, trail: Line, cross: Group, segs: Segment[] }
  const markers = new Map<string, Marker>()
  const labelTexture = (name: string, colour: number) => {
    const c = document.createElement('canvas')
    c.width = 256; c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(name, 128, 32)
    g.fillStyle = hex(colour); g.fillText(name, 128, 32)
    return new CanvasTexture(c)
  }
  for (const id of ids) {
    const colour = colourOf(id)
    const group = new Group()
    const mat = new MeshStandardMaterial({ color: colour, metalness: 0, roughness: 0.7 })
    const body = new Mesh(bodyGeo, mat); body.position.z = 36
    const arrow = new Mesh(arrowGeo, new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.7 })); arrow.position.set(30, 0, 48)
    const label = new Sprite(new SpriteMaterial({ map: labelTexture(nick(id), colour), depthTest: false, transparent: true }))
    label.scale.set(120, 30, 1); label.position.z = 96; label.renderOrder = 10
    group.add(body, arrow, label)
    const trailGeo = new BufferGeometry()
    const trail = new Line(trailGeo, new LineBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }))
    trail.frustumCulled = false
    const cross = new Group()
    const cm = new MeshBasicMaterial({ color: colour })
    const c1 = new Mesh(crossGeo, cm), c2 = new Mesh(crossGeo, cm)
    c1.rotation.z = Math.PI / 4; c2.rotation.z = -Math.PI / 4
    c1.position.z = c2.position.z = 6
    cross.add(c1, c2); cross.visible = false
    world.add(group, trail, cross)
    markers.set(id, { group, body, arrow, label, trail, cross, segs: data.players.get(id) ?? [] })
  }
  const killGeo = new BufferGeometry()
  killGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3))
  const killLine = new Line(killGeo, new LineBasicMaterial({ color: 0xfacc15 }))
  killLine.frustumCulled = false; killLine.visible = false
  world.add(killLine)

  // ---- drawing
  let queued = false
  const draw = () => { queued = false; renderer.render(scene, camera) }
  const render = () => { if (!queued) { queued = true; requestAnimationFrame(draw) } }
  orbit.addEventListener('change', render)
  topControls.addEventListener('change', render)

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    persp.aspect = w / h; persp.updateProjectionMatrix()
    fitOrtho()
    render()
  }
  new ResizeObserver(resize).observe(canvas)

  // Where the map is, in three's coordinates, and the cameras for it.
  const centre3 = () => { const c = bounds.getCenter(new Vector3()); return new Vector3(c.x, c.z, -c.y) }
  const size3 = () => { const s = bounds.getSize(new Vector3()); return new Vector3(s.x, s.z, s.y) }
  function fitOrtho() {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1
    const aspect = w / h, s = size3()
    const halfH = Math.max(s.z / 2, s.x / 2 / aspect, 64) * 1.15
    ortho.top = halfH; ortho.bottom = -halfH; ortho.left = -halfH * aspect; ortho.right = halfH * aspect
    ortho.updateProjectionMatrix()
  }
  let saved: { pos: Vector3, target: Vector3 } | null = null // the free camera, kept while another mode is on
  function frame() {
    const c = centre3(), s = size3()
    const halfFov = Math.tan((persp.fov * Math.PI) / 360)
    persp.far = s.length() * 20
    persp.updateProjectionMatrix()
    persp.position.copy(c).addScaledVector(new Vector3(0.6, 0.6, 0.75).normalize(), (s.length() / 2 / halfFov) * 0.85)
    orbit.target.copy(c); orbit.update()
    saved = { pos: persp.position.clone(), target: c.clone() }
    ortho.up.set(0, 0, -1) // north (Source +y) is up on the screen
    ortho.position.set(c.x, c.y + s.y / 2 + 2000, c.z)
    ortho.far = s.length() * 20 + 4000
    topControls.target.copy(c); topControls.update()
    fitOrtho()
  }

  // ---- levels: the ones above the chosen are hidden and everything is cut a little above its floors
  const showLevels = () => {
    const top = typeof upTo === 'number' ? levels.find(l => l.index === upTo) : undefined
    for (const l of levelNodes) l.node.visible = upTo === 'all' || l.index <= upTo
    cut.constant = upTo === 'all' || !top ? 1e9 : top.hi + CUT_ABOVE
    root.querySelectorAll<HTMLElement>('[data-level]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === String(upTo))))
  }
  const levelBar = el(root, '[data-levels]')
  const BTN = 'px-3 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-white aria-pressed:bg-red-600 aria-pressed:border-red-500 aria-pressed:text-white transition'
  if (levelBar && levels.length > 0 && bg.kind !== 'none') {
    for (const l of levels) {
      const b = text(String(l.index), 'button', BTN) as HTMLButtonElement
      b.type = 'button'; b.dataset.level = String(l.index)
      b.addEventListener('click', () => { upTo = l.index; followLevel = false; syncFollowBox(); showLevels(); render() })
      levelBar.append(b)
    }
    const all = text('All', 'button', BTN) as HTMLButtonElement
    all.type = 'button'; all.dataset.level = 'all'
    all.addEventListener('click', () => { upTo = 'all'; followLevel = false; syncFollowBox(); showLevels(); render() })
    levelBar.append(all)
  } else levelBar?.closest('[data-levels-wrap]')?.setAttribute('hidden', '')
  const followBox = el<HTMLInputElement>(root, '[data-follow-level]')
  const syncFollowBox = () => { if (followBox) followBox.checked = followLevel }
  followBox?.addEventListener('change', () => { followLevel = followBox.checked; changed() })
  el<HTMLInputElement>(root, '[data-walls]')?.addEventListener('change', e => {
    for (const m of wallMeshes) m.visible = (e.target as HTMLInputElement).checked
    render()
  })

  // ---- what is shown at time `ms`
  const tmp = new Vector3()
  const apply = () => {
    for (const [id, m] of markers) {
      const p = poseAt(m.segs, ms)
      // A player on a level above the one shown would float in the air; one below is hidden by the floor, so its name is dimmed.
      const lv = p && levels.length > 0 && bg.kind !== 'none' ? levelOf(levels, p.z) : 0
      const above = typeof upTo === 'number' && lv > upTo
      m.group.visible = p !== null && !above
      ;(m.label.material as SpriteMaterial).opacity = typeof upTo === 'number' && lv > 0 && lv < upTo ? 0.35 : 1
      if (p) {
        m.group.position.set(p.x, p.y, p.z)
        m.group.rotation.z = (p.yaw / 256) * Math.PI * 2
        // the label must not turn with the body
        ;(m.label.material as SpriteMaterial).rotation = 0
      }
      const isSel = id === selected
      m.group.scale.setScalar(markerScale * (isSel ? 1.35 : 1))
      m.cross.scale.setScalar(markerScale)
      const death = data.deaths.find(d => d.victim === id && d.t <= ms)
      m.cross.visible = !!death
      if (death) m.cross.position.set(death.at[0], death.at[1], death.at[2])
      const trail = trailBetween(m.segs, ms - TRAIL_MS, ms)
      const pts = trail.length >= 6 ? trail : []
      m.trail.geometry.setAttribute('position', new Float32BufferAttribute(pts, 3))
      m.trail.visible = pts.length > 0 && !death
      const row = rows.get(id)
      if (row) {
        row.classList.toggle('bg-gray-700', isSel)
        row.classList.toggle('opacity-50', !!death)
        row.classList.toggle('line-through', !!death)
      }
    }
    // the line between victim and attacker while a kill is fresh
    const kill = data.deaths.find(d => d.from && ms >= d.t && ms <= d.t + KILL_LINE_MS)
    killLine.visible = !!kill
    if (kill?.from) killLine.geometry.setAttribute('position', new Float32BufferAttribute([...kill.from, ...kill.at], 3))

    // the selected player's level, when following it
    const sel = selected ? lastPoseAt(data.players.get(selected) ?? [], ms) : null
    if (followLevel && sel && levels.length > 0 && bg.kind !== 'none') {
      const lv = levelOf(levels, sel.z)
      if (lv !== upTo) { upTo = lv; showLevels() }
    }
    // follow camera: behind and above, looking where the player looks
    if (camMode === 'follow' && sel) {
      const a = (sel.yaw / 256) * Math.PI * 2
      const px = sel.x, py = sel.y, pz = sel.z
      const dx = Math.cos(a), dy = Math.sin(a)
      // Source (x, y, z) -> three (x, z, -y)
      persp.position.set(px - dx * 320 * markerScale, pz + 230 * markerScale, -(py - dy * 320 * markerScale))
      tmp.set(px + dx * 100, pz + 40, -(py + dy * 100))
      persp.lookAt(tmp)
    }
    scrub.value = String(ms)
    timeEl.textContent = `${clock(ms)} / ${clock(data.length)}`
    render()
  }
  function changed() { apply() }

  // ---- controls
  const playBtn = el<HTMLButtonElement>(root, '[data-play]')!
  const setPlaying = (p: boolean) => {
    playing = p && data.length > 0
    playBtn.textContent = playing ? 'Pause' : (ms >= data.length ? 'Replay' : 'Play')
    playBtn.setAttribute('aria-pressed', String(playing))
    if (playing) { last = performance.now(); requestAnimationFrame(loop) }
  }
  const loop = (now: number) => {
    if (!playing) return
    ms = Math.min(data.length, ms + (now - last) * speed)
    last = now
    apply()
    if (ms >= data.length) { setPlaying(false); return }
    requestAnimationFrame(loop)
  }
  playBtn.addEventListener('click', () => { if (!playing && ms >= data.length) ms = 0; setPlaying(!playing) })
  scrub.addEventListener('input', () => { ms = Number(scrub.value); setPlaying(playing); changed() })
  root.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.addEventListener('click', () => {
    speed = SPEEDS.includes(Number(b.dataset.speed)) ? Number(b.dataset.speed) : 1
    root.querySelectorAll<HTMLElement>('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
  }))
  const setCam = (mode: 'orbit' | 'top' | 'follow') => {
    if (camMode === 'orbit' && mode !== 'orbit') saved = { pos: persp.position.clone(), target: orbit.target.clone() }
    if (mode === 'orbit' && saved) { persp.position.copy(saved.pos); orbit.target.copy(saved.target) }
    camMode = mode
    camera = mode === 'top' ? ortho : persp
    orbit.enabled = mode === 'orbit'
    topControls.enabled = mode === 'top'
    if (mode === 'orbit') { orbit.update() }
    root.querySelectorAll<HTMLElement>('[data-cam]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === mode)))
    changed()
  }
  root.querySelectorAll<HTMLElement>('[data-cam]').forEach(b => b.addEventListener('click', () => setCam((b.dataset.cam as any) ?? 'orbit')))
  root.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.speed === '1')))
  frame()
  setCam(selected ? 'follow' : 'orbit') // opens on the selected player, as RFC 12 says
  syncFollowBox()
  showLevels()
  setPlaying(false)
  resize()
  say('')
  root.dataset.ready = '1'
  changed()

  // for tests and for debugging in the page
  ;(root as any).__replay = { seek, get ms() { return ms }, select: (id: string) => { selected = id; changed() }, setCam, setPlaying }
}

document.querySelectorAll<HTMLElement>('[data-replay]').forEach(r => { start(r) })
