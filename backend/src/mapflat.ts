/// <reference lib="dom" />
import { Color, type BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three'
import { applyColouring, mapLoader, COLOURINGS, heightColours, offerBrowser, saveColouring, savedColouring, type Colouring, type Painted } from './sceneKit'

// RFC 19, 3.2: the 3D view of a map on a plain 2D canvas, for a browser without WebGL (the game's window). The painter's
// algorithm: every triangle of the map is turned to the camera, the triangles are put in order from far to near and filled
// one after the other, each darker or lighter by how it faces a fixed light. It is a rough view (the order is by the middle
// of a triangle, so it is wrong now and then), and the page says so. The map is drawn with orthographic projection, without
// props, glass, moving parts or markers. While the picture is being turned or zoomed only every third triangle is drawn,
// and all of them when it stops.

const CUT_ABOVE = 128
const BUCKETS = 8192
const SHADES = 12
const SETTLE_MS = 160
const WATER = 'rgba(70,120,200,0.45)'
const GROUND = '#14110e'
const LIGHT = [-0.35, 0.55, 0.76] // in the view: right, up, towards the viewer

/** Every triangle of the map's levels and water, in Source's coordinates (x east, y north, z up). */
export interface Soup {
  n: number
  pos: Float32Array // nine numbers each
  normal: Float32Array // three each, unit
  base: Uint32Array // the colour in the current colouring, 0xrrggbb
  level: Uint8Array
  wall: Uint8Array
  water: Uint8Array
  /** The top of each level in Source's z, by index (for the cutaway). */
  hi: Map<number, number>
  min: [number, number, number]
  max: [number, number, number]
  /** The triangles from the largest to the smallest, so a picture of the first third has the fewest holes. */
  bySize: Uint32Array
  /** Sets `base` for a colouring. */
  recolour: (mode: Colouring) => void
  levels: number[]
}

/** The triangles of a loaded model: the levels (floors and walls) and the water. The model is Y-up; Source's y is minus three's z. */
export function soupOf(model: Object3D, mode: Colouring): Soup {
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
  heightColours(painted)
  const water: Mesh[] = []
  model.getObjectByName('water')?.traverse(o => { if ((o as Mesh).isMesh) water.push(o as Mesh) })

  const parts: { mesh: Mesh, p: Painted | null }[] = [...painted.map(p => ({ mesh: p.mesh as Mesh, p })), ...water.map(mesh => ({ mesh, p: null }))]
  const count = (m: Mesh) => Math.floor((m.geometry.getIndex()?.count ?? m.geometry.getAttribute('position').count) / 3)
  const n = parts.reduce((a, x) => a + count(x.mesh), 0)
  const soup: Soup = {
    n, pos: new Float32Array(n * 9), normal: new Float32Array(n * 3), base: new Uint32Array(n),
    level: new Uint8Array(n), wall: new Uint8Array(n), water: new Uint8Array(n),
    bySize: new Uint32Array(n), hi: new Map(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], recolour: () => {}, levels: nodes.map(l => l.index),
  }
  for (const l of nodes) { const hi = Number(l.node.userData.hi); if (Number.isFinite(hi)) soup.hi.set(l.index, hi) }

  const ranges: { p: Painted, from: number, to: number, a: Uint32Array }[] = []
  let at = 0
  for (const { mesh, p } of parts) {
    const pos = mesh.geometry.getAttribute('position')
    const idx = mesh.geometry.getIndex()
    const e = mesh.matrixWorld.elements
    const vx = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      vx[i * 3] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
      vx[i * 3 + 1] = -(e[2]! * x + e[6]! * y + e[10]! * z + e[14]!)
      vx[i * 3 + 2] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
    }
    const from = at, m = count(mesh)
    const tri = new Uint32Array(m * 3)
    for (let k = 0; k < m * 3; k++) tri[k] = idx ? idx.getX(k) : k
    for (let t = 0; t < m; t++, at++) {
      for (let j = 0; j < 3; j++) {
        const v = tri[t * 3 + j]! * 3
        for (let c = 0; c < 3; c++) {
          const value = vx[v + c]!
          soup.pos[at * 9 + j * 3 + c] = value
          if (p) { // the water can reach far beyond the map, so it does not decide where the camera looks
            if (value < soup.min[c]!) soup.min[c] = value
            if (value > soup.max[c]!) soup.max[c] = value
          }
        }
      }
      const q = soup.pos, o = at * 9
      const ux = q[o + 3]! - q[o]!, uy = q[o + 4]! - q[o + 1]!, uz = q[o + 5]! - q[o + 2]!
      const wx = q[o + 6]! - q[o]!, wy = q[o + 7]! - q[o + 1]!, wz = q[o + 8]! - q[o + 2]!
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len; ny /= len; nz /= len
      soup.normal[at * 3] = nx; soup.normal[at * 3 + 1] = ny; soup.normal[at * 3 + 2] = nz
      if (p) { soup.level[at] = p.level; soup.wall[at] = p.wall ? 1 : 0 } else soup.water[at] = 1
    }
    if (p) ranges.push({ p, from, to: at, a: tri })
  }

  const area = new Float32Array(n)
  for (let t = 0; t < n; t++) { const q = soup.pos, o = t * 9; area[t] = Math.hypot((q[o + 4]! - q[o + 1]!) * (q[o + 8]! - q[o + 2]!) - (q[o + 5]! - q[o + 2]!) * (q[o + 7]! - q[o + 1]!), (q[o + 5]! - q[o + 2]!) * (q[o + 6]! - q[o]!) - (q[o + 3]! - q[o]!) * (q[o + 8]! - q[o + 2]!), (q[o + 3]! - q[o]!) * (q[o + 7]! - q[o + 1]!) - (q[o + 4]! - q[o + 1]!) * (q[o + 6]! - q[o]!)) }
  soup.bySize = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => area[b]! - area[a]!)
  // three keeps colours in linear light and turns them back when it draws; the canvas wants the screen's values
  const tmp = new Color()
  const hexOf = (r: number, g: number, b: number) => tmp.setRGB(r, g, b).getHex()
  soup.recolour = (m: Colouring) => {
    applyColouring(painted, m, Math.max(1, nodes.length))
    for (const r of ranges) {
      const mat = r.p.mesh.material
      const own = mat.vertexColors ? r.p.mesh.geometry.getAttribute('color') : null
      const plain = hexOf(mat.color.r, mat.color.g, mat.color.b)
      for (let t = r.from; t < r.to; t++) {
        if (!own) { soup.base[t] = plain; continue }
        const a = r.a[(t - r.from) * 3]!, b = r.a[(t - r.from) * 3 + 1]!, c = r.a[(t - r.from) * 3 + 2]!
        soup.base[t] = hexOf((own.getX(a) + own.getX(b) + own.getX(c)) / 3, (own.getY(a) + own.getY(b) + own.getY(c)) / 3, (own.getZ(a) + own.getZ(b) + own.getZ(c)) / 3)
      }
    }
  }
  soup.recolour(mode)
  return soup
}

/** The camera: where it looks from as an angle around and above the target, and the screen position of a world point. */
export function basis(yaw: number, pitch: number) {
  const d: [number, number, number] = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)] // from the target to the camera
  // right = forward × up, forward = -d, up = z
  let r: [number, number, number] = [-d[1], d[0], 0]
  const rl = Math.hypot(r[0], r[1]) || 1
  r = [r[0] / rl, r[1] / rl, 0]
  const u: [number, number, number] = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]]
  return { d, r, u }
}

export function startMapFlat(root: HTMLElement, canvas: HTMLCanvasElement, say: (t: string) => void, src: string): void {
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) { say('This browser cannot draw the map: no canvas.'); return }
  say('Loading the map…')

  fetch(src, { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
    .then(buf => new Promise<Object3D>((ok, fail) => mapLoader().parse(buf, '', x => ok(x.scene), fail)))
    .then(model => run(model))
    .catch(() => say('The map could not be loaded.'))

  function run(model: Object3D) {
    const g = ctx2d!
    const soup = soupOf(model, savedColouring(root.dataset.storeys === '0' ? 'height' : 'plain'))
    if (soup.n === 0) { say('This map has nothing to draw.'); return }
    const centre: [number, number, number] = [(soup.min[0] + soup.max[0]) / 2, (soup.min[1] + soup.max[1]) / 2, (soup.min[2] + soup.max[2]) / 2]
    const radius = Math.hypot(soup.max[0] - soup.min[0], soup.max[1] - soup.min[1], soup.max[2] - soup.min[2]) / 2 || 1

    let yaw = Math.atan2(-0.75, 0.6), pitch = Math.asin(0.6 / Math.hypot(0.6, 0.75, 0.6))
    let zoom = 1 // 1 fits the whole map
    let pan: [number, number] = [0, 0] // a move of the target in the picture's right and up, in world units
    let upTo: number | 'all' = 'all'
    let walls = true, water = true
    let W = 1, H = 1, dpr = 1
    let moving = false
    let settle = 0
    let queued = false

    // memory for a frame
    const sx = new Float32Array(soup.n * 3), sy = new Float32Array(soup.n * 3)
    const bucket = new Uint16Array(soup.n)
    const visible = new Uint32Array(soup.n)
    const order = new Uint32Array(soup.n)
    const counts = new Uint32Array(BUCKETS + 1)
    const css = new Map<number, string>()
    const colourOf = (base: number, shade: number) => {
      const key = base * 16 + shade
      let c = css.get(key)
      if (!c) {
        const f = 0.55 + 0.6 * (shade / (SHADES - 1)) // from a darker to a lighter face
        const ch = (v: number) => Math.min(255, Math.round(v * f))
        c = `rgb(${ch((base >> 16) & 255)},${ch((base >> 8) & 255)},${ch(base & 255)})`
        css.set(key, c)
      }
      return c
    }

    const last = { project: 0, sort: 0, fill: 0, drawn: 0 }
    function draw() {
      queued = false
      const t0 = performance.now()
      const { d, r, u } = basis(yaw, pitch)
      const k = (Math.min(W, H) / (2 * radius)) * 0.95 * zoom * dpr // pixels for a world unit
      const tx = centre[0] + r[0] * pan[0] + u[0] * pan[1], ty = centre[1] + r[1] * pan[0] + u[1] * pan[1], tz = centre[2] + r[2] * pan[0] + u[2] * pan[1]
      const cw = W * dpr, ch = H * dpr
      const lx = r[0] * LIGHT[0]! + u[0] * LIGHT[1]! + d[0] * LIGHT[2]!, ly = r[1] * LIGHT[0]! + u[1] * LIGHT[1]! + d[1] * LIGHT[2]!, lz = r[2] * LIGHT[0]! + u[2] * LIGHT[1]! + d[2] * LIGHT[2]!
      const cutZ = typeof upTo === 'number' && soup.hi.has(upTo) ? soup.hi.get(upTo)! + CUT_ABOVE : Infinity
      const limit = moving ? Math.ceil(soup.n / 3) : soup.n // while turning, the biggest third

      // 1. which triangles, where on the screen, how far
      let m = 0
      counts.fill(0)
      for (let t = 0; t < limit; t++) {
        const i = soup.bySize[t]!
        if (soup.water[i]) { if (!water) continue } else {
          if (typeof upTo === 'number' && soup.level[i]! > upTo) continue
          if (!walls && soup.wall[i]) continue
        }
        const o = i * 9
        const p = soup.pos
        const mx = (p[o]! + p[o + 3]! + p[o + 6]!) / 3 - tx, my = (p[o + 1]! + p[o + 4]! + p[o + 7]!) / 3 - ty, mz = (p[o + 2]! + p[o + 5]! + p[o + 8]!) / 3 - tz
        if (cutZ !== Infinity && mz + tz > cutZ) continue
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (let j = 0; j < 3; j++) {
          const x = p[o + j * 3]! - tx, y = p[o + j * 3 + 1]! - ty, z = p[o + j * 3 + 2]! - tz
          const X = cw / 2 + (x * r[0] + y * r[1] + z * r[2]) * k, Y = ch / 2 - (x * u[0] + y * u[1] + z * u[2]) * k
          sx[i * 3 + j] = X; sy[i * 3 + j] = Y
          if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y
        }
        { // grown a little from the middle, so the edge between two neighbours does not show as a line
          const cx = (sx[i * 3]! + sx[i * 3 + 1]! + sx[i * 3 + 2]!) / 3, cy = (sy[i * 3]! + sy[i * 3 + 1]! + sy[i * 3 + 2]!) / 3
          for (let j = 0; j < 3; j++) {
            const ex = sx[i * 3 + j]! - cx, ey = sy[i * 3 + j]! - cy, l = Math.hypot(ex, ey) || 1
            sx[i * 3 + j] = sx[i * 3 + j]! + (ex / l) * 0.4 * dpr; sy[i * 3 + j] = sy[i * 3 + j]! + (ey / l) * 0.4 * dpr
          }
        }
        if (maxX < 0 || minX > cw || maxY < 0 || minY > ch) continue
        if (maxX - minX < 0.5 * dpr && maxY - minY < 0.5 * dpr) continue // too small to be seen
        const depth = mx * d[0] + my * d[1] + mz * d[2] // larger is nearer the camera
        const b = Math.max(0, Math.min(BUCKETS - 1, Math.floor(((depth / radius + 1) / 2) * BUCKETS)))
        bucket[i] = b
        visible[m++] = i
        counts[b + 1]!++
      }
      const t1 = performance.now()
      // 2. far to near
      for (let b = 0; b < BUCKETS; b++) counts[b + 1]! += counts[b]!
      for (let v = 0; v < m; v++) { const i = visible[v]!; order[counts[bucket[i]!]!++] = i }

      const t2 = performance.now()
      // 3. fill them in that order
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.fillStyle = GROUND
      g.fillRect(0, 0, canvas.width, canvas.height)
      // Neighbours of one colour are filled as one shape: that is faster, and the hairlines between them do not show.
      let run = ''
      const flush = () => {
        if (run === '') return
        g.fillStyle = run
        g.fill()
        run = ''
      }
      for (let v = 0; v < m; v++) {
        const i = order[v]!
        let style: string
        if (soup.water[i]) style = WATER
        else {
          const dot = Math.abs(soup.normal[i * 3]! * lx + soup.normal[i * 3 + 1]! * ly + soup.normal[i * 3 + 2]! * lz)
          style = colourOf(soup.base[i]!, Math.round(Math.min(1, dot) * (SHADES - 1)))
        }
        if (style !== run) { flush(); run = style; g.beginPath() }
        g.moveTo(sx[i * 3]!, sy[i * 3]!); g.lineTo(sx[i * 3 + 1]!, sy[i * 3 + 1]!); g.lineTo(sx[i * 3 + 2]!, sy[i * 3 + 2]!); g.closePath()
      }
      flush()
      last.project = t1 - t0; last.sort = t2 - t1; last.fill = performance.now() - t2; last.drawn = m
    }
    const paint = () => { if (!queued) { queued = true; requestAnimationFrame(draw) } }
    const interact = () => { moving = true; clearTimeout(settle); settle = window.setTimeout(() => { moving = false; paint() }, SETTLE_MS); paint() }

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (w === 0 || h === 0) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = w; H = h
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      paint()
    }
    new ResizeObserver(resize).observe(canvas)

    // ---- controls
    const mark = (sel: string, attr: string, value: string) => root.querySelectorAll<HTMLElement>(sel).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)))
    root.querySelectorAll<HTMLElement>('[data-level]').forEach(b => b.addEventListener('click', () => {
      const which = b.dataset.level ?? 'all'
      upTo = which === 'all' ? 'all' : Number(which)
      mark('[data-level]', 'level', which)
      paint()
    }))
    root.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.addEventListener('click', () => {
      pan = [0, 0]; zoom = 1
      if (b.dataset.view === 'top') { pitch = Math.PI / 2 - 0.0001; yaw = -Math.PI / 2 } else { yaw = Math.atan2(-0.75, 0.6); pitch = Math.asin(0.6 / Math.hypot(0.6, 0.75, 0.6)) }
      paint()
    }))
    root.querySelector<HTMLInputElement>('[data-walls]')?.addEventListener('change', e => { walls = (e.target as HTMLInputElement).checked; paint() })
    root.querySelector<HTMLInputElement>('[data-water]')?.addEventListener('change', e => { water = (e.target as HTMLInputElement).checked; paint() })
    root.querySelectorAll<HTMLElement>('[data-colour]').forEach(b => b.addEventListener('click', () => {
      const mode = (b.dataset.colour ?? 'plain') as Colouring
      if (!(COLOURINGS as string[]).includes(mode)) return
      saveColouring(mode); soup.recolour(mode); mark('[data-colour]', 'colour', mode); paint()
    }))
    mark('[data-colour]', 'colour', savedColouring(root.dataset.storeys === '0' ? 'height' : 'plain'))
    // what this view does not draw
    for (const sel of ['[data-props]', '[data-foliage]', '[data-movable]', '[data-parts]', '[data-spawns]']) root.querySelector(sel)?.closest('label')?.setAttribute('hidden', '')

    // drag to turn (shift or the right button to move), wheel to zoom
    canvas.style.cursor = 'grab'
    canvas.style.touchAction = 'none'
    let drag: { x: number, y: number, move: boolean } | null = null
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, move: e.shiftKey || e.button === 2 }; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing' })
    canvas.addEventListener('pointermove', e => {
      if (!drag) return
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y
      drag.x = e.clientX; drag.y = e.clientY
      if (drag.move) {
        const per = (2 * radius) / (Math.min(W, H) * 0.95 * zoom)
        pan = [pan[0] - dx * per, pan[1] + dy * per]
      } else {
        yaw -= dx * 0.008
        pitch = Math.max(0.05, Math.min(Math.PI / 2 - 0.0001, pitch + dy * 0.008))
      }
      interact()
    })
    const release = () => { drag = null; canvas.style.cursor = 'grab' }
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointercancel', release)
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.min(12, Math.max(0.4, zoom * Math.exp(-e.deltaY * 0.0015))); interact() }, { passive: false })

    const note = document.createElement('p')
    note.className = 'foot'
    note.textContent = 'A simple view: the game\'s window cannot draw the full 3D map, so this one is rough (props, glass and moving parts are left out, and some faces may be in the wrong order).'
    root.append(note)
    offerBrowser(root, 'Open in your browser for the full 3D map', note)

    ;(root as any).__flatmap = { soup, last, get view() { return { yaw, pitch, zoom, upTo } } } // for tests and for looking at it in the page
    say('')
    resize()
    root.dataset.ready = '1'
    root.dataset.flat = '1'
  }
}
