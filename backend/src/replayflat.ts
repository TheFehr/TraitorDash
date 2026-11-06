/// <reference lib="dom" />
import { Color, type BufferGeometry, type Mesh, type MeshStandardMaterial, type Object3D } from 'three'
import { hex } from './teamColours'
import { mapLoader, levelColour, paintPlain, type Painted } from './sceneKit'
import { bodyAt, currentDeath, lastPoseAt, levelOf, poseAt, revivePose, trailBetween, type Decoded, type LevelRange, type TrackEvent } from './replaylogic'

// RFC 19, 3.1: the replay drawn from above on a plain 2D canvas, for a browser without WebGL (the game's window). The map's
// floors are filled shapes, its walls lines, drawn level by level from the lowest; the picture of the map is made once and
// kept (a cache a little larger than the window), and each frame copies it and draws the players over it. So the cost of a
// frame does not depend on the number of triangles. Everything that is a list or a control on the page is shared with the
// WebGL drawing (replay.ts); this file only draws.

export interface FlatHost {
  root: HTMLElement
  canvas: HTMLCanvasElement
  say: (t: string) => void
  background: { kind: 'mesh' | 'plan' | 'none', meshUrl?: string, plan?: any, levels: LevelRange[], mismatch: boolean }
  data: Decoded
  ids: string[]
  levels: LevelRange[]
  revivals: TrackEvent[]
  /** The colour a player has at a time (a number, 0xrrggbb). */
  colourOf: (id: string, at: number) => number
  nick: (id: string) => string
  ms: () => number
  selected: () => string | null
  upTo: () => number | 'all'
  followLevel: () => boolean
  /** Moves the level cutaway, and the bar's buttons show it. */
  setUpTo: (n: number | 'all') => void
  markLevels: () => void
  /** Brings the page's lists up to date for the time and selection. */
  lists: () => void
  hooks: { paint: () => void, level: () => void, walls: (on: boolean) => void, resize: () => void }
}

const TRAIL_MS = 4000
const KILL_LINE_MS = 2500
const REVIVE_MARK_MS = 2500
const GROUND = '#14110e' // the canvas's colour in the page stylesheet

/** A colour as one key, with the low two bits of each channel dropped, so many triangles share one fill. */
// three keeps colours in linear light and turns them back when it draws; the canvas wants the screen's values
const screen = new Color()
const keyOf = (r: number, g: number, b: number) => screen.setRGB(r, g, b).getHex() & 0xfcfcfc
const css = (key: number) => `#${key.toString(16).padStart(6, '0')}`

/** The triangles (six numbers each, Source's x and y) and the wall segments (four each) of one level, grouped by colour. */
export interface Layer { index: number, floors: Map<number, number[]>, walls: Map<number, number[]> }
export interface Flat { layers: Layer[], water: number[], min: [number, number], max: [number, number] }

const push = (m: Map<number, number[]>, key: number, ...v: number[]) => { const a = m.get(key); if (a) a.push(...v); else m.set(key, v) }

/** The floors and walls of a loaded model as flat shapes. Heights are not kept: from above only where a thing is matters, and the levels say what covers what. */
export function flatten(model: Object3D): Flat {
  model.updateMatrixWorld(true)
  const nodes: { index: number, node: Object3D }[] = []
  model.traverse(o => { const m = /^level-(\d+)$/.exec(o.name); if (m && !nodes.some(l => l.node === o)) nodes.push({ index: Number(m[1]), node: o }) })
  nodes.sort((a, b) => a.index - b.index)

  const painted: Painted[] = []
  for (const l of nodes) l.node.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh<BufferGeometry, MeshStandardMaterial>
    mesh.material = mesh.material.clone()
    painted.push({ mesh, wall: mesh.material.name === 'wall', level: l.index })
  })
  paintPlain(painted)

  const min: [number, number] = [Infinity, Infinity], max: [number, number] = [-Infinity, -Infinity]
  const see = (x: number, y: number) => { if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x; if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y }

  /** The vertices of a mesh in Source's x and y (the model is Y-up: Source's y is minus three's z). */
  const vertices = (mesh: Mesh) => {
    const pos = mesh.geometry.getAttribute('position')
    const e = mesh.matrixWorld.elements
    const out = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      out[i * 2] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
      out[i * 2 + 1] = -(e[2]! * x + e[6]! * y + e[10]! * z + e[14]!)
    }
    return out
  }
  const triangles = (mesh: Mesh) => {
    const idx = mesh.geometry.getIndex()
    const n = idx ? idx.count : mesh.geometry.getAttribute('position').count
    return { n, at: (k: number) => (idx ? idx.getX(k) : k) }
  }

  const byLevel = new Map<number, Layer>()
  const layer = (index: number) => { let l = byLevel.get(index); if (!l) { l = { index, floors: new Map(), walls: new Map() }; byLevel.set(index, l) } return l }
  for (const p of painted) {
    const v = vertices(p.mesh)
    const { n, at } = triangles(p.mesh)
    const mat = p.mesh.material
    const own = mat.vertexColors ? p.mesh.geometry.getAttribute('color') : null
    const plain = keyOf(mat.color.r, mat.color.g, mat.color.b)
    const l = layer(p.level)
    for (let k = 0; k + 2 < n; k += 3) {
      const a = at(k), b = at(k + 1), c = at(k + 2)
      const ax = v[a * 2]!, ay = v[a * 2 + 1]!, bx = v[b * 2]!, by = v[b * 2 + 1]!, cx = v[c * 2]!, cy = v[c * 2 + 1]!
      see(ax, ay); see(bx, by); see(cx, cy)
      const key = own
        ? keyOf((own.getX(a) + own.getX(b) + own.getX(c)) / 3, (own.getY(a) + own.getY(b) + own.getY(c)) / 3, (own.getZ(a) + own.getZ(b) + own.getZ(c)) / 3)
        : plain
      if (p.wall) { // a wall seen from above is a line: the longest edge of its triangle
        const edges: [number, number, number, number][] = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]
        let best = edges[0]!, len = -1
        for (const e of edges) { const d = (e[2] - e[0]) ** 2 + (e[3] - e[1]) ** 2; if (d > len) { len = d; best = e } }
        if (len > 0) push(l.walls, key, ...best)
      } else push(l.floors, key, ax, ay, bx, by, cx, cy)
    }
  }

  const water: number[] = []
  model.getObjectByName('water')?.traverse(o => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh
    const v = vertices(mesh)
    const { n, at } = triangles(mesh)
    for (let k = 0; k + 2 < n; k += 3) for (let j = 0; j < 3; j++) { const i = at(k + j); water.push(v[i * 2]!, v[i * 2 + 1]!) }
  })
  return { layers: [...byLevel.values()].sort((a, b) => a.index - b.index), water, min, max }
}

/** The floor plan (cells with the heights of their floors) as the same flat shapes: one square for each cell, in its level's colour. */
function flattenPlan(g: { cell: number, minx: number, miny: number, nx: number, ny: number, rows: string[] }, levels: LevelRange[]): Flat {
  const byLevel = new Map<number, Layer>()
  const min: [number, number] = [Infinity, Infinity], max: [number, number] = [-Infinity, -Infinity]
  g.rows.forEach((row, j) => row.split('|').forEach((cell, i) => {
    if (cell === '') return
    for (const f of cell.split(',')) {
      const lv = levelOf(levels, parseInt(f, 10))
      let l = byLevel.get(lv)
      if (!l) { l = { index: lv, floors: new Map(), walls: new Map() }; byLevel.set(lv, l) }
      const c = levelColour(Math.max(1, lv), Math.max(1, levels.length))
      const x0 = g.minx + i * g.cell, y0 = g.miny + (g.ny - 1 - j) * g.cell, x1 = x0 + g.cell, y1 = y0 + g.cell
      push(l.floors, keyOf(c.r, c.g, c.b), x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1)
      min[0] = Math.min(min[0], x0); min[1] = Math.min(min[1], y0); max[0] = Math.max(max[0], x1); max[1] = Math.max(max[1], y1)
    }
  }))
  return { layers: [...byLevel.values()].sort((a, b) => a.index - b.index), water: [], min, max }
}

/** Grid lines for a map with nothing to draw, over the extent of the positions. */
function flattenGrid(box: { min: [number, number], max: [number, number] }): Flat {
  const step = 128, walls = new Map<number, number[]>()
  const x0 = Math.floor(box.min[0] / step) * step, x1 = Math.ceil(box.max[0] / step) * step
  const y0 = Math.floor(box.min[1] / step) * step, y1 = Math.ceil(box.max[1] / step) * step
  const lines: number[] = []
  for (let x = x0; x <= x1; x += step) lines.push(x, y0, x, y1)
  for (let y = y0; y <= y1; y += step) lines.push(x0, y, x1, y)
  walls.set(0x373f51, lines)
  return { layers: [{ index: 0, floors: new Map(), walls }], water: [], min: [x0, y0], max: [x1, y1] }
}

export async function startFlat(host: FlatHost): Promise<void> {
  const { root, canvas, data, ids, levels, hooks } = host
  const g = canvas.getContext('2d')
  if (!g) { host.say('This browser cannot draw the replay: no canvas.'); return }

  // The extent of all the positions in the track.
  const track: { min: [number, number], max: [number, number] } = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] }
  for (const segs of data.players.values()) for (const s of segs) for (let i = 0; i < s.x.length; i++) {
    track.min[0] = Math.min(track.min[0], s.x[i]!); track.max[0] = Math.max(track.max[0], s.x[i]!)
    track.min[1] = Math.min(track.min[1], s.y[i]!); track.max[1] = Math.max(track.max[1], s.y[i]!)
  }
  if (!Number.isFinite(track.min[0])) { track.min = [-512, -512]; track.max = [512, 512] }
  track.min = [track.min[0] - 160, track.min[1] - 160]; track.max = [track.max[0] + 160, track.max[1] + 160]

  // ---- the map
  const bg = host.background
  let flat: Flat | null = null
  if (bg.kind === 'mesh' && bg.meshUrl) {
    host.say('Loading the map…')
    try {
      const buf = await fetch(bg.meshUrl, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
      const model = await new Promise<Object3D>((ok, fail) => mapLoader().parse(buf, '', x => ok(x.scene), fail))
      flat = flatten(model)
    } catch {
      host.say('The map could not be loaded; the positions are drawn without it.')
    }
  } else if (bg.kind === 'plan' && bg.plan) flat = flattenPlan(bg.plan, levels)
  if (!flat || !Number.isFinite(flat.min[0])) flat = flattenGrid(track)
  const map = flat
  const bounds = { min: [Math.min(map.min[0], track.min[0]), Math.min(map.min[1], track.min[1])], max: [Math.max(map.max[0], track.max[0]), Math.max(map.max[1], track.max[1])] }
  const drawsWalls = map.layers.some(l => l.walls.size > 0)
  let showWalls = (root.querySelector<HTMLInputElement>('[data-walls]')?.checked) ?? true

  // ---- the view: a centre in Source's x and y and a scale in pixels (of the page) for a world unit
  let mode: 'top' | 'follow' = 'top'
  let cx = (bounds.min[0]! + bounds.max[0]!) / 2, cy = (bounds.min[1]! + bounds.max[1]!) / 2
  let fit = 0.1, scaleTop = 0.1, scaleFollow = 0.3
  let W = 1, H = 1, dpr = 1 // the canvas in page pixels and the pixel ratio

  // ---- the picture of the map, kept in a canvas twice the size of the window
  const cache = document.createElement('canvas')
  const cg = cache.getContext('2d')!
  const baked = { ok: false, cx: 0, cy: 0, k: 1, upTo: '' as string, walls: true }
  let settle = 0

  const scale = () => (mode === 'follow' ? scaleFollow : scaleTop)

  function bake() {
    const k = scale() * dpr
    const cw = cache.width, ch = cache.height
    cg.setTransform(1, 0, 0, 1, 0, 0)
    cg.fillStyle = GROUND
    cg.fillRect(0, 0, cw, ch)
    const x0 = cw / 2 - cx * k, y0 = ch / 2 + cy * k
    const upTo = host.upTo()
    const sx = (x: number) => x * k + x0, sy = (y: number) => y0 - y * k
    cg.lineJoin = 'round'
    for (const l of map.layers) {
      if (typeof upTo === 'number' && l.index > upTo) continue
      for (const [key, v] of l.floors) {
        cg.beginPath()
        for (let i = 0; i < v.length; i += 6) {
          const ax = sx(v[i]!), ay = sy(v[i + 1]!), bx = sx(v[i + 2]!), by = sy(v[i + 3]!), px = sx(v[i + 4]!), py = sy(v[i + 5]!)
          if ((ax < 0 && bx < 0 && px < 0) || (ay < 0 && by < 0 && py < 0) || (ax > cw && bx > cw && px > cw) || (ay > ch && by > ch && py > ch)) continue
          cg.moveTo(ax, ay); cg.lineTo(bx, by); cg.lineTo(px, py); cg.closePath()
        }
        cg.fillStyle = cg.strokeStyle = css(key)
        cg.lineWidth = 0.6 * dpr // closes the hairlines between triangles
        cg.fill(); cg.stroke()
      }
      if (showWalls) for (const [key, v] of l.walls) {
        cg.beginPath()
        for (let i = 0; i < v.length; i += 4) {
          const ax = sx(v[i]!), ay = sy(v[i + 1]!), bx = sx(v[i + 2]!), by = sy(v[i + 3]!)
          if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > cw && bx > cw) || (ay > ch && by > ch)) continue
          cg.moveTo(ax, ay); cg.lineTo(bx, by)
        }
        cg.strokeStyle = css(key); cg.lineWidth = Math.max(1, 1.4 * dpr)
        cg.stroke()
      }
    }
    if (map.water.length > 0) { // translucent, over the floors, so a pool on a level shows
      cg.beginPath()
      const w = map.water
      for (let i = 0; i < w.length; i += 6) { cg.moveTo(sx(w[i]!), sy(w[i + 1]!)); cg.lineTo(sx(w[i + 2]!), sy(w[i + 3]!)); cg.lineTo(sx(w[i + 4]!), sy(w[i + 5]!)); cg.closePath() }
      cg.fillStyle = 'rgba(70,120,200,0.45)'; cg.fill()
    }
    baked.ok = true; baked.cx = cx; baked.cy = cy; baked.k = k; baked.upTo = String(upTo); baked.walls = showWalls
  }

  // ---- a frame
  const player = (id: string) => data.players.get(id) ?? []
  let queued = false
  const draw = () => {
    queued = false
    const ms = host.ms()
    const selected = host.selected()

    // following the selected player's level
    const sel = selected ? lastPoseAt(player(selected), ms) : null
    if (host.followLevel() && sel && levels.length > 0 && bg.kind !== 'none') {
      const lv = levelOf(levels, sel.z)
      if (lv !== host.upTo()) host.setUpTo(lv)
    }
    if (mode === 'follow' && sel) { cx = sel.x; cy = sel.y }

    // the map: the kept picture, made again when it no longer fits
    const k = scale() * dpr
    const upTo = host.upTo()
    const r = baked.ok ? k / baked.k : 0
    const slack = (cache.width - W * dpr) / 2 * 0.8
    const slackY = (cache.height - H * dpr) / 2 * 0.8
    const stale = !baked.ok || baked.upTo !== String(upTo) || baked.walls !== showWalls || r < 0.8 || r > 1.25
      || Math.abs((baked.cx - cx) * k) > slack || Math.abs((baked.cy - cy) * k) > slackY
    if (stale) bake()
    const rr = baked.ok ? k / baked.k : 1
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.fillStyle = GROUND
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.drawImage(cache, (W * dpr) / 2 + (baked.cx - cx) * k - (cache.width / 2) * rr, (H * dpr) / 2 - (baked.cy - cy) * k - (cache.height / 2) * rr, cache.width * rr, cache.height * rr)
    if (rr !== 1) { clearTimeout(settle); settle = window.setTimeout(() => { baked.ok = false; paint() }, 180) }

    // the players, over it, at one size on the screen whatever the zoom
    const X = (x: number) => (W * dpr) / 2 + (x - cx) * k
    const Y = (y: number) => (H * dpr) / 2 - (y - cy) * k
    const px = dpr
    g.lineCap = 'round'; g.lineJoin = 'round'

    for (const v of host.revivals) {
      if (!(ms >= v.t && ms <= v.t + REVIVE_MARK_MS)) continue
      const at = revivePose(player(v.p), v.t)
      if (!at) continue
      g.strokeStyle = '#34d399'; g.lineWidth = 3 * px
      g.beginPath(); g.arc(X(at.x), Y(at.y), 14 * px, 0, Math.PI * 2); g.stroke()
      const by = v.by ? lastPoseAt(player(v.by), ms) : null
      if (by) { g.beginPath(); g.moveTo(X(by.x), Y(by.y)); g.lineTo(X(at.x), Y(at.y)); g.stroke() }
    }
    const kill = data.deaths.find(d => d.from && ms >= d.t && ms <= d.t + KILL_LINE_MS)
    if (kill?.from) {
      g.strokeStyle = '#facc15'; g.lineWidth = 2 * px
      g.beginPath(); g.moveTo(X(kill.from[0]), Y(kill.from[1])); g.lineTo(X(kill.at[0]), Y(kill.at[1])); g.stroke()
    }

    const visible = (z: number) => {
      const lv = levels.length > 0 && bg.kind !== 'none' ? levelOf(levels, z) : 0
      return { above: typeof upTo === 'number' && lv > upTo, dim: typeof upTo === 'number' && lv > 0 && lv < upTo }
    }
    g.font = `bold ${12 * px}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom'
    const drawn: { id: string, x: number, y: number, dim: boolean }[] = []
    for (const id of ids) {
      const colour = hex(host.colourOf(id, ms))
      const segs = player(id)
      const death = currentDeath(data.deaths, data.events, id, ms) // a revived player is not dead any more
      if (death) {
        const body = bodyAt(data.bodies.get(id), death, ms) // where it lies now (RFC 24)
        if (visible(body.at[2]).above) continue
        const x = X(body.at[0]), y = Y(body.at[1]), s = 6 * px
        g.lineWidth = 7 * px; g.strokeStyle = '#000'
        g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke()
        g.lineWidth = 4 * px; g.strokeStyle = colour
        g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke()
        if (id === selected) { g.lineWidth = 2 * px; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, y, 14 * px, 0, Math.PI * 2); g.stroke() }
        continue
      }
      const p = poseAt(segs, ms)
      if (!p) continue
      const { above, dim } = visible(p.z)
      if (above) continue
      const trail = trailBetween(segs, ms - TRAIL_MS, ms)
      if (trail.length >= 6) {
        g.globalAlpha = dim ? 0.2 : 0.6
        g.strokeStyle = colour; g.lineWidth = 2 * px
        g.beginPath()
        for (let i = 0; i + 2 < trail.length; i += 3) { if (i === 0) g.moveTo(X(trail[i]!), Y(trail[i + 1]!)); else g.lineTo(X(trail[i]!), Y(trail[i + 1]!)) }
        g.stroke()
        g.globalAlpha = 1
      }
      drawn.push({ id, x: X(p.x), y: Y(p.y), dim })
    }
    // the player pins after all the trails, so no trail runs over a name
    for (const d of drawn) {
      const p = poseAt(player(d.id), ms)!
      const colour = hex(host.colourOf(d.id, ms))
      const a = (p.yaw / 256) * Math.PI * 2, ux = Math.cos(a), uy = -Math.sin(a) // north is up on the screen
      g.globalAlpha = d.dim ? 0.4 : 1
      if (d.id === selected) { g.lineWidth = 2 * px; g.strokeStyle = '#fff'; g.beginPath(); g.arc(d.x, d.y, 15 * px, 0, Math.PI * 2); g.stroke() }
      g.beginPath(); g.moveTo(d.x + ux * 17 * px, d.y + uy * 17 * px); g.lineTo(d.x + (ux * 8 - uy * 6) * px, d.y + (uy * 8 + ux * 6) * px); g.lineTo(d.x + (ux * 8 + uy * 6) * px, d.y + (uy * 8 - ux * 6) * px); g.closePath()
      g.fillStyle = '#fff'; g.fill()
      g.beginPath(); g.arc(d.x, d.y, 8 * px, 0, Math.PI * 2)
      g.fillStyle = colour; g.fill(); g.lineWidth = 2.5 * px; g.strokeStyle = '#fff'; g.stroke()
      const name = host.nick(d.id)
      const label = name.length > 18 ? name.slice(0, 17) + '…' : name
      g.lineWidth = 4 * px; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(label, d.x, d.y - 11 * px)
      g.fillStyle = colour; g.fillText(label, d.x, d.y - 11 * px)
      g.globalAlpha = 1
    }
    host.lists()
  }
  const paint = () => { if (!queued) { queued = true; requestAnimationFrame(draw) } }

  // ---- the size of the picture
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (w === 0 || h === 0) return
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = w; H = h
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    cache.width = canvas.width * 2; cache.height = canvas.height * 2
    const fitX = W / (bounds.max[0]! - bounds.min[0]!), fitY = H / (bounds.max[1]! - bounds.min[1]!)
    const wasFit = scaleTop === fit
    fit = Math.min(fitX, fitY) * 0.92
    if (wasFit) scaleTop = fit
    if (scaleFollow === 0.3 || scaleFollow < fit) scaleFollow = Math.max(0.3, fit * 2.5)
    baked.ok = false
    paint()
  }

  // ---- the controls only this view has: drag to move, wheel to zoom, From above and Follow
  const markCam = () => root.querySelectorAll<HTMLElement>('[data-cam]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === mode)))
  const setMode = (m: 'top' | 'follow') => { mode = m; markCam(); baked.ok = false; paint() }
  root.querySelectorAll<HTMLElement>('[data-cam]').forEach(b => {
    if (b.dataset.cam === 'orbit') b.hidden = true // the 3D view needs WebGL
    else b.addEventListener('click', () => setMode(b.dataset.cam === 'follow' ? 'follow' : 'top'))
  })
  canvas.style.cursor = 'grab'
  let drag: { x: number, y: number } | null = null
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing' })
  canvas.addEventListener('pointermove', e => {
    if (!drag) return
    if (mode === 'follow') { scaleTop = scaleFollow; mode = 'top'; markCam() } // moving the picture by hand leaves the player, at the zoom it had
    cx -= (e.clientX - drag.x) / scale(); cy += (e.clientY - drag.y) / scale()
    drag = { x: e.clientX, y: e.clientY }
    paint()
  })
  const release = () => { drag = null; canvas.style.cursor = 'grab' }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    const box = canvas.getBoundingClientRect()
    const mx = e.clientX - box.left - W / 2, my = e.clientY - box.top - H / 2
    const before = scale()
    const next = Math.min(fit * 40, Math.max(fit * 0.5, before * Math.exp(-e.deltaY * 0.0015)))
    if (mode === 'follow') scaleFollow = next
    else { // the point under the pointer stays where it is
      cx += mx / before - mx / next; cy -= my / before - my / next
      scaleTop = next
    }
    paint()
  }, { passive: false })
  canvas.addEventListener('dblclick', () => { scaleTop = fit; cx = (bounds.min[0]! + bounds.max[0]!) / 2; cy = (bounds.min[1]! + bounds.max[1]!) / 2; setMode('top') })

  hooks.paint = paint
  hooks.level = () => { host.markLevels(); baked.ok = false; paint() }
  hooks.walls = on => { showWalls = on; paint() }
  hooks.resize = resize
  if (!drawsWalls) root.querySelector<HTMLElement>('[data-walls]')?.closest('label')?.setAttribute('hidden', '')
  new ResizeObserver(resize).observe(canvas)

  ;(root as any).__flat = { map, bounds, get view() { return { cx, cy, fit, scaleTop, scaleFollow, W, H, dpr, mode } } } // for tests and for looking at it in the page
  mode = host.selected() ? 'follow' : 'top'
  markCam()
  resize()
  host.say('')
}
