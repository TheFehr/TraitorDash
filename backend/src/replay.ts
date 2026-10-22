/// <reference lib="dom" />
import {
  WebGLRenderer, OrthographicCamera, Box3, Vector3, Color, Group, Mesh, MeshStandardMaterial, MeshBasicMaterial,
  SphereGeometry, RingGeometry, DoubleSide, ConeGeometry, BoxGeometry, InstancedMesh, Matrix4, Object3D, Plane, Sprite,
  SpriteMaterial, CanvasTexture, BufferGeometry, Float32BufferAttribute, Line, LineSegments, LineBasicMaterial,
  type Camera, type MeshStandardMaterial as StdMat,
} from 'three'
import { hex } from './teamColours'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { makeCamera, makeRenderer, makeScene } from './sceneKit'
import {
  decodeTrack, poseAt, lastPoseAt, trailBetween, levelOf, defaultSelection, playerColour, clock, stateAt, currentDeath, killerDiedBefore, reviveSource, revivePose,
  type Decoded, type Segment, type LevelRange, type TrackEvent,
} from './replaylogic'

// The round replay (RFC 12, 3.5): one three.js scene that draws the best background there is (the
// map's mesh, its floor plan as tiles, or an empty grid) and puts the players into the same
// coordinates. Source is Z-up and three.js is Y-up, so everything that is in Source's coordinates
// sits in a group turned by a quarter turn, as the GLB's root node does.
//
// It draws on demand: while it plays, and when something changes; an open tab at rest costs nothing.

interface Payload {
  round: { id: string, map: string | null, result: string, duration: number | null, startedAt: string | null }
  players: { id: string, nick: string | null, role: string | null, team: string | null, endRole: string | null, endTeam: string | null, won: boolean, survived: boolean }[]
  colours?: Record<string, string>
  revives: { victim: string, reviver: string | null, how: string | null, why: string | null, at: number | null }[]
  track: any
  trackInfo: { truncated: boolean, degraded: boolean, fingerprint: string | null, pinned: boolean }
  background: { kind: 'mesh' | 'plan' | 'none', meshUrl?: string, plan?: any, levels: LevelRange[], mismatch: boolean }
}

const LEVEL_NAME = /^level-(\d+)$/
const levelColour = (index: number, count: number) => new Color().setHSL(0.38 - 0.34 * (count > 1 ? (index - 1) / (count - 1) : 0), 0.55, 0.45)
const CUT_ABOVE = 128
const TRAIL_MS = 4000
const KILL_LINE_MS = 2500
const REVIVE_MARK_MS = 2500
const MAX_REVIVE_MARKS = 64
const SPEEDS = [1, 2, 4, 8]

const el = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)
const text = (s: string, tag = 'span', cls = '') => { const e = document.createElement(tag); e.textContent = s; if (cls) e.className = cls; return e }

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
  // The team a player has at the time shown: the one they started with, then each role change (RFC 14, 4.6).
  const startOf = (id: string) => ({ role: meta.get(id)?.role ?? null, team: meta.get(id)?.team ?? null })
  const stateOf = (id: string, at: number) => stateAt(startOf(id), data.events, id, at)
  const colourOf = (id: string, at = 0) => { const st = stateOf(id, at); return playerColour(payload.colours ?? {}, st.role, st.team) }

  // ---- state
  let ms = 0, playing = false, speed = 1, last = 0
  let selected = defaultSelection(ids, viewer, data.deaths)
  let camMode: 'orbit' | 'top' | 'follow' = 'orbit'
  let followLevel = true
  let upTo: number | 'all' = 'all'

  // ---- the page's own parts that do not need WebGL: the round's deaths, the player list, the notes
  const notes = el(root, '[data-notes]')
  const note = (t: string) => { if (notes) notes.append(text(t, 'p', 'warn')) }
  if (payload.background.mismatch) note('The map in the background is another version than the one this round was played on; it may not match.')
  if (payload.trackInfo.truncated) note('This track was cut short (it reached a size or length limit), so the end of the round may be missing.')
  if (payload.trackInfo.degraded) note('The game server was too busy to keep recording, so the track ends early.')
  const bgText = { mesh: 'Drawn in the map\'s 3D geometry.', plan: 'Drawn on the map\'s floor plan (no 3D geometry for this map).', none: 'No map is available for this round: positions are drawn on an empty grid.' }[payload.background.kind]
  el(root, '[data-background]')!.textContent = bgText

  /** One line for a revival or a role change. */
  function eventText(e: TrackEvent) {
    if (e.k === 'role') return `${nick(e.p)} became ${e.role} (${e.team})`
    return `${nick(e.p)} was revived${e.by ? ' by ' + nick(e.by) : ''} (${reviveSource(e.how)})`
  }
  /** The fact "came back N s after their killer died", when the recorded events show it. */
  const killerFact = (e: { t: number, p: string }) => {
    const k = killerDiedBefore(data.deaths, e)
    return k ? `came back ${k.seconds} s after their killer, ${nick(k.killer)}, died` : null
  }

  // Every revival of the round: from the track when it has them (with the time to the millisecond),
  // else from the round report (to the second).
  const trackRevives = data.events.filter(e => e.k === 'revive')
  const revivals: TrackEvent[] = trackRevives.length > 0 ? trackRevives
    : (payload.revives ?? []).filter(v => v.at !== null).map(v => ({ t: (v.at as number) * 1000, p: v.victim, k: 'revive' as const, by: v.reviver ?? undefined, how: v.how ?? undefined, why: v.why ?? undefined }))
  const revivesEl = el(root, '[data-revives]')
  const revivesWrap = el(root, '[data-revives-wrap]')
  if (revivesEl && revivesWrap) {
    for (const e of revivals) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'lnk'
      const fact = killerFact(e)
      b.textContent = `${clock(e.t)}  ${eventText(e)}${fact ? ' — ' + fact : ''}`
      b.addEventListener('click', () => { selected = e.p; seek(e.t - 3000) })
      li.append(b)
      revivesEl.append(li)
    }
    revivesWrap.hidden = revivals.length === 0
  }
  // the selected player's own events, rebuilt when the selection changes
  const eventsEl = el(root, '[data-player-events]')
  let listedFor: string | null | undefined
  const listEvents = () => {
    if (!eventsEl || listedFor === selected) return
    listedFor = selected
    eventsEl.replaceChildren()
    const mine = data.events.filter(e => e.p === selected)
    for (const e of mine) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'; b.className = 'lnk'
      b.textContent = `${clock(e.t)}  ${e.k === 'role' ? 'became ' + e.role + ' (' + e.team + ')' : 'revived' + (e.by ? ' by ' + nick(e.by) : '') + ' (' + reviveSource(e.how) + ')'}`
      b.addEventListener('click', () => seek(e.t - 1000))
      li.append(b)
      eventsEl.append(li)
    }
    if (mine.length === 0) eventsEl.append(text(data.events.length === 0 && !payload.track.events ? 'No role changes or revivals recorded for this track.' : 'No role changes or revivals.', 'li', 'dim'))
  }

  const deathsEl = el(root, '[data-deaths]')
  const seek = (t: number) => { ms = Math.max(0, Math.min(data.length, t)); changed() }
  for (const d of data.deaths) {
    if (!deathsEl) break
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'lnk'
    b.textContent = `${clock(d.t)}  ${nick(d.victim)}${d.attacker ? ' ← ' + nick(d.attacker) : ''}${d.weapon ? ' (' + d.weapon + ')' : ''}`
    b.addEventListener('click', () => { selected = d.victim; seek(d.t - 3000) })
    li.append(b)
    deathsEl.append(li)
  }
  if (deathsEl && data.deaths.length === 0) deathsEl.append(text('No deaths in this round.', 'li', 'dim'))

  const listEl = el(root, '[data-players]')
  const rows = new Map<string, HTMLElement>()
  const chips = new Map<string, { dot: HTMLElement, role: HTMLElement }>()
  for (const id of ids) {
    if (!listEl) break
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'prow'
    const dot = text('', 'span', 'pdot')
    dot.style.background = hex(colourOf(id))
    const roleEl = text(meta.get(id)?.role ?? '', 'span', 'prole')
    b.append(dot, text(nick(id), 'span', 'pname'), roleEl)
    b.addEventListener('click', () => { selected = id; changed() })
    listEl.append(b)
    rows.set(id, b)
    chips.set(id, { dot, role: roleEl })
  }
  const scrub = el<HTMLInputElement>(root, '[data-scrub]')!
  scrub.max = String(data.length); scrub.value = '0'
  const ticks = el(root, '[data-ticks]')
  if (ticks) for (const d of data.deaths) {
    const t = text('', 'span', 'tick')
    t.style.left = `${data.length ? (d.t / data.length) * 100 : 0}%`
    t.title = `${clock(d.t)} ${nick(d.victim)} died`
    ticks.append(t)
  }
  // revivals (green) and role changes (violet) beside the deaths
  if (ticks) for (const e of data.events) {
    const t = text('', 'span', `tick ${e.k === 'revive' ? 'tick-revive' : 'tick-role'}`)
    t.style.left = `${data.length ? (e.t / data.length) * 100 : 0}%`
    t.dataset.mark = e.k
    t.title = `${clock(e.t)} ${eventText(e)}`
    ticks.append(t)
  }
  const timeEl = el(root, '[data-time]')!

  // ---- WebGL: a browser without it gets the lists above and this message
  let renderer: WebGLRenderer
  try {
    renderer = makeRenderer(canvas)
  } catch {
    canvas.hidden = true
    say('This browser cannot draw the replay (WebGL is not available). The list of deaths is below.')
    el(root, '[data-controls]')?.setAttribute('hidden', '')
    return
  }
  const scene = makeScene()

  const persp = makeCamera()
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

  const finish = (b: Box3) => { bounds = b }

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
  // A player is drawn at the size of a Source player: a box 32 wide and 72 tall, the eyes at 64. It is
  // never enlarged to be seen; what keeps a player findable from far away is a pin and a name that
  // stay the same size on the screen, whatever the distance.
  const legGeo = new BoxGeometry(12, 12, 34)
  const torsoGeo = new BoxGeometry(16, 28, 26)
  const armGeo = new BoxGeometry(8, 8, 26)
  const headGeo = new SphereGeometry(9, 16, 12)
  const noseGeo = new ConeGeometry(3, 9, 8)
  noseGeo.rotateZ(-Math.PI / 2) // points along +x, where the player faces
  const groundArrowGeo = new ConeGeometry(7, 26, 10)
  groundArrowGeo.rotateZ(-Math.PI / 2)
  const ringGeo = new RingGeometry(26, 32, 40)
  const matte = (c: number) => new MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.8 })
  const LEGS = 0x2b3547, SKIN = 0xe2c3a0

  /** A person standing at the origin facing +x, in the team's colour; `dim` for a body that lies where its player died. */
  const figure = (colour: number, dim: boolean) => {
    const g = new Group()
    const cloth = matte(dim ? new Color(colour).multiplyScalar(0.45).getHex() : colour)
    const legs = matte(dim ? 0x1c2230 : LEGS), skin = matte(dim ? 0x8a7660 : SKIN)
    for (const y of [-7, 7]) { const l = new Mesh(legGeo, legs); l.position.set(0, y, 17); g.add(l) }
    const torso = new Mesh(torsoGeo, cloth); torso.position.z = 47
    const head = new Mesh(headGeo, skin); head.position.z = 63
    const nose = new Mesh(noseGeo, skin); nose.position.set(10, 0, 63)
    g.add(torso, head, nose)
    for (const y of [-18, 18]) { const a = new Mesh(armGeo, cloth); a.position.set(0, y, 47); g.add(a) }
    g.userData.cloth = cloth // so a change of team can repaint it
    return g
  }

  /** A sprite that is the same size on the screen at any distance. `size` is a fraction of the view's height. */
  const screenSprite = (map: CanvasTexture, w: number, h: number) => {
    const sp = new Sprite(new SpriteMaterial({ map, depthTest: false, transparent: true, sizeAttenuation: false }))
    sp.scale.set(w, h, 1)
    sp.renderOrder = 10
    return sp
  }
  const canvasTexture = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    draw(c.getContext('2d')!)
    return new CanvasTexture(c)
  }
  const pinTexture = (colour: number, heading: boolean) => canvasTexture(heading ? 128 : 64, heading ? 128 : 64, g => {
    const c = heading ? 64 : 32, r = heading ? 22 : 24
    if (heading) { // a pointer to the right (+x); the sprite is turned to the player's heading
      g.beginPath(); g.moveTo(c + r + 22, c); g.lineTo(c + r - 2, c - 15); g.lineTo(c + r - 2, c + 15); g.closePath()
      g.fillStyle = '#ffffff'; g.fill()
    }
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2)
    g.fillStyle = hex(colour); g.fill()
    g.lineWidth = 6; g.strokeStyle = '#ffffff'; g.stroke()
  })
  const crossTexture = (colour: number) => canvasTexture(64, 64, g => {
    g.lineCap = 'round'
    for (const [lw, st] of [[16, '#000000'], [9, hex(colour)]] as const) {
      g.lineWidth = lw; g.strokeStyle = st
      g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke()
    }
  })
  const labelTexture = (name: string, colour: number) => canvasTexture(256, 64, g => {
    g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(name, 128, 32)
    g.fillStyle = hex(colour); g.fillText(name, 128, 32)
  })

  interface Look { plain: CanvasTexture, pointer: CanvasTexture, cross: CanvasTexture, label: CanvasTexture }
  interface Marker {
    group: Group, pin: Sprite, label: Sprite, ring: Mesh, trail: Line, corpse: Group, deadPin: Sprite, segs: Segment[]
    body: Group, lying: Group, colour: number, looks: Map<number, Look>
  }
  const markers = new Map<string, Marker>()
  const PIN = 0.03, LABEL_H = 0.036
  /** The textures of a player in one team colour; made once per colour, a team change swaps them. */
  const lookOf = (m: { looks: Map<number, Look> }, id: string, colour: number): Look => {
    let l = m.looks.get(colour)
    if (!l) { l = { plain: pinTexture(colour, false), pointer: pinTexture(colour, true), cross: crossTexture(colour), label: labelTexture(nick(id), colour) }; m.looks.set(colour, l) }
    return l
  }
  for (const id of ids) {
    const colour = colourOf(id)
    const group = new Group()
    const body = figure(colour, false)
    group.add(body)
    const arrow = new Mesh(groundArrowGeo, matte(0xffffff)); arrow.position.set(40, 0, 2)
    const ring = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: DoubleSide })); ring.position.z = 1.5; ring.visible = false
    const looks = new Map<number, Look>()
    const look = lookOf({ looks }, id, colour)
    const pin = screenSprite(look.plain, PIN, PIN); pin.position.z = 86
    const label = screenSprite(look.label, LABEL_H * 4, LABEL_H); label.position.z = 86; label.center.set(0.5, -0.55)
    group.add(arrow, ring, pin, label)

    const trail = new Line(new BufferGeometry(), new LineBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }))
    trail.frustumCulled = false

    // Where a player died: their body lies there, with a cross over it.
    const corpse = new Group()
    const lying = figure(colour, true)
    lying.rotation.y = -Math.PI / 2 // onto its back, head towards -x
    lying.position.z = 9
    const deadPin = screenSprite(look.cross, PIN, PIN); deadPin.position.z = 50
    corpse.add(lying, deadPin)
    corpse.visible = false

    world.add(group, trail, corpse)
    markers.set(id, { group, pin, label, ring, trail, corpse, deadPin, segs: data.players.get(id) ?? [], body, lying, colour, looks })
  }
  const killGeo = new BufferGeometry()
  killGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3))
  const killLine = new Line(killGeo, new LineBasicMaterial({ color: 0xfacc15 }))
  killLine.frustumCulled = false; killLine.visible = false
  world.add(killLine)

  // A revival is a ring where the player comes back and, when the reviver is known, a line from the
  // reviver to them, for a moment. The gap in the trail stays a gap.
  const reviveMarks = revivals.slice(0, MAX_REVIVE_MARKS).map(e => {
    const pose = revivePose(data.players.get(e.p) ?? [], e.t)
    const ring = new Mesh(new RingGeometry(34, 44, 40), new MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9, side: DoubleSide }))
    ring.visible = false
    const line = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0x34d399 }))
    line.frustumCulled = false; line.visible = false
    if (pose) ring.position.set(pose.x, pose.y, pose.z + 2)
    world.add(ring, line)
    return { e, pose, ring, line }
  })

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
  if (levelBar && levels.length > 0 && bg.kind !== 'none') {
    for (const l of levels) {
      const b = text(String(l.index), 'button', 'tog') as HTMLButtonElement
      b.type = 'button'; b.dataset.level = String(l.index)
      b.addEventListener('click', () => { upTo = l.index; followLevel = false; syncFollowBox(); showLevels(); render() })
      levelBar.append(b)
    }
    const all = text('All', 'button', 'tog') as HTMLButtonElement
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
  // Pins and names are the same size on the screen. A perspective camera does that by itself
  // (sizeAttenuation off); an orthographic one does not, so there they are sized by what the view shows.
  const spriteUnit = () => (camera === ortho ? ((ortho.top - ortho.bottom) / ortho.zoom) / (2 * Math.tan((persp.fov * Math.PI) / 360)) : 1)
  const apply = () => {
    const unit = spriteUnit(), top = camera === ortho
    for (const [id, m] of markers) {
      const st = stateOf(id, ms)
      const colour = playerColour(payload.colours ?? {}, st.role, st.team)
      if (colour !== m.colour) { // a conversion: the figure, its pin and its name change colour at that moment
        m.colour = colour
        ;(m.body.userData.cloth as MeshStandardMaterial).color.setHex(colour)
        ;(m.lying.userData.cloth as MeshStandardMaterial).color.setHex(colour).multiplyScalar(0.45)
        const look = lookOf(m, id, colour)
        ;(m.label.material as SpriteMaterial).map = look.label
        ;(m.deadPin.material as SpriteMaterial).map = look.cross
        for (const sp of [m.label, m.deadPin, m.pin]) (sp.material as SpriteMaterial).needsUpdate = true
        const c = chips.get(id); if (c) c.dot.style.background = hex(colour)
      }
      const look = lookOf(m, id, m.colour)
      const chip = chips.get(id)
      if (chip) chip.role.textContent = st.role ? (st.was.length ? `${st.role} (was ${st.was[0]})` : st.role) : ''
      const p = poseAt(m.segs, ms)
      // A player on a level above the one shown would float in the air; one below is hidden by the floor, so its name is dimmed.
      const lv = p && levels.length > 0 && bg.kind !== 'none' ? levelOf(levels, p.z) : 0
      const above = typeof upTo === 'number' && lv > upTo
      const dim = typeof upTo === 'number' && lv > 0 && lv < upTo
      m.group.visible = p !== null && !above
      ;(m.label.material as SpriteMaterial).opacity = dim ? 0.35 : 1
      ;(m.pin.material as SpriteMaterial).opacity = dim ? 0.35 : 1
      if (p) {
        m.group.position.set(p.x, p.y, p.z)
        m.group.rotation.z = (p.yaw / 256) * Math.PI * 2
      }
      // from above the bodies are specks, so the pin itself points the way the player faces
      const pinMat = m.pin.material as SpriteMaterial
      const want = top ? look.pointer : look.plain
      if (pinMat.map !== want) { pinMat.map = want; pinMat.needsUpdate = true }
      pinMat.rotation = top && p ? (p.yaw / 256) * Math.PI * 2 : 0
      m.pin.scale.set(PIN * unit * (top ? 2 : 1), PIN * unit * (top ? 2 : 1), 1)
      m.label.scale.set(LABEL_H * 4 * unit, LABEL_H * unit, 1)
      m.deadPin.scale.set(PIN * unit, PIN * unit, 1)
      const isSel = id === selected
      m.ring.visible = isSel // the selected player is marked on the ground, not by a bigger body
      const death = currentDeath(data.deaths, data.events, id, ms) // a revived player is not dead any more
      const deathLevel = death && levels.length > 0 && bg.kind !== 'none' ? levelOf(levels, death.at[2]) : 0
      m.corpse.visible = !!death && !(typeof upTo === 'number' && deathLevel > upTo)
      if (death) {
        m.corpse.position.set(death.at[0], death.at[1], death.at[2])
        const last = lastPoseAt(m.segs, death.t)
        m.corpse.rotation.z = last ? (last.yaw / 256) * Math.PI * 2 : 0
      }
      const trail = trailBetween(m.segs, ms - TRAIL_MS, ms)
      const pts = trail.length >= 6 ? trail : []
      m.trail.geometry.setAttribute('position', new Float32BufferAttribute(pts, 3))
      m.trail.visible = pts.length > 0 && !death
      const row = rows.get(id)
      if (row) {
        row.classList.toggle('sel', isSel)
        row.classList.toggle('dead', !!death)
      }
    }
    for (const v of reviveMarks) {
      const fresh = ms >= v.e.t && ms <= v.e.t + REVIVE_MARK_MS
      v.ring.visible = fresh && v.pose !== null
      const by = v.e.by ? markers.get(v.e.by) : undefined
      const from = by ? lastPoseAt(by.segs, ms) : null
      v.line.visible = fresh && !!from && v.pose !== null
      if (v.line.visible && from && v.pose) v.line.geometry.setAttribute('position', new Float32BufferAttribute([from.x, from.y, from.z + 40, v.pose.x, v.pose.y, v.pose.z + 40], 3))
    }
    listEvents()
    const panel = el(root, '[data-selected-role]')
    if (panel) {
      const st = selected ? stateOf(selected, ms) : null
      panel.textContent = selected && st ? `${nick(selected)}: ${st.role ?? 'role unknown'}${st.was.length ? ' (was ' + st.was.join(', ') + ')' : ''}${st.team ? ', ' + st.team : ''}` : ''
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
      persp.position.set(px - dx * 300, pz + 170, -(py - dy * 300))
      tmp.set(px + dx * 90, pz + 50, -(py + dy * 90))
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
