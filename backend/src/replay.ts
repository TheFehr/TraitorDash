/// <reference lib="dom" />
import {
  WebGLRenderer, OrthographicCamera, Box3, Vector3, Color, Group, Mesh, MeshStandardMaterial, MeshBasicMaterial,
  SphereGeometry, CylinderGeometry, RingGeometry, DoubleSide, ConeGeometry, BoxGeometry, InstancedMesh, Matrix4, Object3D, Plane, Sprite,
  SpriteMaterial, CanvasTexture, Raycaster, BufferGeometry, Float32BufferAttribute, Line, LineSegments, LineBasicMaterial, AnimationMixer, BufferAttribute, type Material, type AnimationAction, type AnimationClip,
  type Camera, type MeshStandardMaterial as StdMat,
} from 'three'
import { hex } from './teamColours'
import { depthOf } from './bodyDepth'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneRig } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { startFlat } from './replayflat'
import { offerBrowser, levelColour, paintPlain, makeCamera, makeRenderer, makeScene, mapLoader, prepareMovable, prepareProps, prepareWater, boxWithout, type Painted } from './sceneKit'
import {
  decodeTrack, poseAt, lastPoseAt, clipWeights, damp, dampAngle, cyclesAt, clipNames, gaitClips, GAITS, moveAt, pathOf, velocityAt, MOVE, type ClipName, type Path, type Strides, trailBetween, levelOf, holdLevel, cutHeight, shownLevels, FADE, type LevelHold, defaultSelection, playerColour, clock, stateAt, currentDeath, killerDiedBefore, reviveSource, revivePose, fitLabel,
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
  background: { kind: 'mesh' | 'plan' | 'none', meshUrl?: string, plan?: any, levels: LevelRange[], listed?: number[], mismatch: boolean }
  /** Where the players' model (posed, one for everyone) is, when the backend can build it (RFC 22). */
  playerModel?: string
}

const LEVEL_NAME = /^level-(\d+)$/
const CUT_ABOVE = 128
const TRAIL_MS = 4000
const TRAIL_POINTS = 256 // the most points of a trail drawn (a sample every 0.1 s at the fastest, for four seconds, is 40)
const KILL_LINE_MS = 2500
const REVIVE_MARK_MS = 2500
const MAX_REVIVE_MARKS = 64
const SPEEDS = [1, 2, 4, 8]

/** Writes text into an element only when it differs: a write is work for the page even if nothing changes. */
const setText = (e: Element, t: string) => { if (e.textContent !== t) e.textContent = t }
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
  let levelHold: LevelHold | null = null, levelHoldFor: string | null = null // the level the cut follows, held for a moment when the player is found lower (replaylogic: holdLevel)
  let upTo: number | 'all' = 'all'
  // What the drawing behind the page does when something changes: the WebGL scene or the flat canvas sets these.
  const hooks = { paint: () => {}, level: () => {}, walls: (_on: boolean) => {}, leaves: (_on: boolean) => {}, resize: () => {} }

  // ---- the page's own parts that do not need WebGL: the round's deaths, the player list, the notes
  const notes = el(root, '[data-notes]')
  const note = (t: string) => { if (notes) notes.append(text(t, 'p', 'warn')) }
  if (payload.background.mismatch) note('The map in the background is another version than the one this round was played on; it may not match.')
  if (payload.trackInfo.truncated) note('This track was cut short (it reached a size or length limit), so the end of the round may be missing.')
  if (payload.trackInfo.degraded) note('The game server was too busy to keep recording, so the track ends early.')
  const bgText = { mesh: 'Drawn in the map\'s 3D geometry.', plan: 'Drawn on the map\'s floor plan (no 3D geometry for this map).', none: 'No map is available for this round: positions are drawn on an empty grid.' }[payload.background.kind]
  el(root, '[data-background]')!.textContent = bgText

  /** What happened to the player, without the name (a shop item is shown by its class, as the game knows it). */
  function ownText(e: TrackEvent) {
    switch (e.k) {
      case 'role': return `became ${e.role} (${e.team})`
      case 'say': return `${e.ch === 'team' ? 'said to their team' : e.ch === 'dead' ? 'said among the dead' : 'said'}: ${e.text}`
      case 'buy': return `bought ${e.item}${e.it ? ' (item)' : ''}`
      case 'found': return `found ${e.of ? 'the body of ' + nick(e.of) : 'a body'}`
      default: return `revived${e.by ? ' by ' + nick(e.by) : ''} (${reviveSource(e.how)})`
    }
  }
  /** One line for an event, with the name. */
  function eventText(e: TrackEvent) {
    if (e.k === 'role') return `${nick(e.p)} became ${e.role} (${e.team})`
    if (e.k === 'say') return `${nick(e.p)}${e.ch === 'team' ? ' (team)' : e.ch === 'dead' ? ' (dead)' : ''}: ${e.text}`
    if (e.k === 'buy' || e.k === 'found') return `${nick(e.p)} ${ownText(e)}`
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
  // Everything said, bought and found in the round, in order (RFC 26).
  const feedEl = el(root, '[data-feed]')
  const feedWrap = el(root, '[data-feed-wrap]')
  if (feedEl && feedWrap) {
    const feed = data.events.filter(e => e.k === 'say' || e.k === 'buy' || e.k === 'found')
    for (const e of feed) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'lnk'
      b.textContent = `${clock(e.t)}  ${eventText(e)}`
      b.addEventListener('click', () => { selected = e.p; seek(e.t - 2000) })
      li.append(b)
      feedEl.append(li)
    }
    feedWrap.hidden = feed.length === 0
  }
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
      b.textContent = `${clock(e.t)}  ${ownText(e)}`
      b.addEventListener('click', () => seek(e.t - 1000))
      li.append(b)
      eventsEl.append(li)
    }
    if (mine.length === 0) eventsEl.append(text(data.events.length === 0 && !payload.track.events ? 'Nothing recorded for this track but where players were.' : 'Nothing recorded for this player.', 'li', 'dim'))
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
    if (e.k !== 'revive' && e.k !== 'role') continue // chat, shop and bodies are in the feed, not on the bar
    const t = text('', 'span', `tick ${e.k === 'revive' ? 'tick-revive' : 'tick-role'}`)
    t.style.left = `${data.length ? (e.t / data.length) * 100 : 0}%`
    t.dataset.mark = e.k
    t.title = `${clock(e.t)} ${eventText(e)}`
    ticks.append(t)
  }
  const timeEl = el(root, '[data-time]')!

  // ---- the controls that both drawings share; each drawing says what they do
  const markLevels = () => root.querySelectorAll<HTMLElement>('[data-level]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === String(upTo))))
  const levelBar = el(root, '[data-levels]')
  if (levelBar && levels.length > 0 && payload.background.kind !== 'none') {
    for (const l of levels) {
      if (payload.background.listed && !payload.background.listed.includes(l.index)) continue // not a place a player can get to (RFC 21, 12)
      const b = text(String(l.index), 'button', 'tog') as HTMLButtonElement
      b.type = 'button'; b.dataset.level = String(l.index)
      b.addEventListener('click', () => { upTo = l.index; followLevel = false; syncFollowBox(); hooks.level() })
      levelBar.append(b)
    }
    const all = text('All', 'button', 'tog') as HTMLButtonElement
    all.type = 'button'; all.dataset.level = 'all'
    all.addEventListener('click', () => { upTo = 'all'; followLevel = false; syncFollowBox(); hooks.level() })
    levelBar.append(all)
  } else levelBar?.closest('[data-levels-wrap]')?.setAttribute('hidden', '')
  const followBox = el<HTMLInputElement>(root, '[data-follow-level]')
  const syncFollowBox = () => { if (followBox) followBox.checked = followLevel }
  followBox?.addEventListener('change', () => { followLevel = followBox.checked; showLevels(); changed() })
  el<HTMLInputElement>(root, '[data-walls]')?.addEventListener('change', e => hooks.walls((e.target as HTMLInputElement).checked))
  el<HTMLInputElement>(root, '[data-leaves]')?.addEventListener('change', e => hooks.leaves((e.target as HTMLInputElement).checked))

  // ---- controls
  const playBtn = el<HTMLButtonElement>(root, '[data-play]')!
  const setPlaying = (p: boolean) => {
    playing = p && data.length > 0
    playBtn.textContent = playing ? 'Pause' : (ms >= data.length ? 'Replay' : 'Play')
    playBtn.setAttribute('aria-pressed', String(playing))
    if (playing) { last = performance.now(); requestAnimationFrame(loop) }
  }
  // While it plays, a picture is made for every frame the screen asks for, as long as that is cheap enough (the work a picture costs
  // the page, not counting the graphics card, stays under a limit); a device that cannot is given thirty a second, which it keeps up with
  // where it would stutter at sixty. Time goes on at the real rate either way.
  let drawn = -1e9, cost = 4, slow = false
  const loop = (now: number) => {
    if (!playing) return
    ms = Math.min(data.length, ms + (now - last) * speed)
    last = now
    if (!slow || now - drawn >= 30 || ms >= data.length) {
      drawn = now
      const t0 = performance.now()
      hooks.paint()
      cost = cost * 0.9 + Math.min(performance.now() - t0, 25) * 0.1 // (a first picture that has to compile its shaders is not what a picture costs)
      if (cost > 9) slow = true
      else if (cost < 6) slow = false
    }
    if (ms >= data.length) { setPlaying(false); return }
    requestAnimationFrame(loop)
  }
  playBtn.addEventListener('click', () => { if (!playing && ms >= data.length) ms = 0; setPlaying(!playing) })
  scrub.addEventListener('input', () => { ms = Number(scrub.value); setPlaying(playing); changed() })
  root.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.addEventListener('click', () => {
    speed = SPEEDS.includes(Number(b.dataset.speed)) ? Number(b.dataset.speed) : 1
    root.querySelectorAll<HTMLElement>('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
  }))
  // Theater: the replay fills the window (the page around it is 56 rem wide). T toggles, Esc leaves.
  const theaterBtn = el(root, '[data-theater]')
  const setTheater = (on: boolean) => {
    root.classList.toggle('theater', on)
    document.documentElement.classList.toggle('theater', on)
    theaterBtn?.setAttribute('aria-pressed', String(on))
    if (on) window.scrollTo(0, 0)
    hooks.resize()
  }
  theaterBtn?.addEventListener('click', () => setTheater(!root.classList.contains('theater')))
  document.addEventListener('keydown', e => {
    const t = e.target as HTMLElement | null
    if (e.ctrlKey || e.metaKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && (t as HTMLInputElement).type !== 'range')) return
    if (e.key === 'Escape' && root.classList.contains('theater')) setTheater(false)
    else if (e.key === 't' || e.key === 'T') setTheater(!root.classList.contains('theater'))
  })
  root.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.speed === '1')))

  // ---- WebGL: a browser without it gets the lists above and this message
  let renderer: WebGLRenderer
  try {
    renderer = makeRenderer(canvas)
  } catch {
    // No WebGL (the game's window): the replay is drawn from above on a plain canvas instead (RFC 19).
    await startFlat({
      root, canvas, say, background: payload.background, data, ids, levels, revivals, nick,
      colourOf: (id, at) => colourOf(id, at), ms: () => ms, selected: () => selected, upTo: () => upTo, followLevel: () => followLevel,
      setUpTo: n => { upTo = n; markLevels() }, markLevels,
      lists: () => {
        for (const id of ids) {
          const st = stateOf(id, ms), chip = chips.get(id), row = rows.get(id)
          if (chip) { chip.dot.style.background = hex(colourOf(id, ms)); chip.role.textContent = st.role ? (st.was.length ? `${st.role} (was ${st.was[0]})` : st.role) : '' }
          row?.classList.toggle('sel', id === selected)
          row?.classList.toggle('dead', !!currentDeath(data.deaths, data.events, id, ms))
        }
        listEvents()
        const panel = el(root, '[data-selected-role]')
        if (panel) {
          const st = selected ? stateOf(selected, ms) : null
          panel.textContent = selected && st ? `${nick(selected)}: ${st.role ?? 'role unknown'}${st.was.length ? ' (was ' + st.was.join(', ') + ')' : ''}${st.team ? ', ' + st.team : ''}` : ''
        }
        scrub.value = String(ms)
        timeEl.textContent = `${clock(ms)} / ${clock(data.length)}`
      },
      hooks,
    })
    const bgNote = el(root, '[data-background]')
    offerBrowser(root, 'Open in your browser for the 3D view', bgNote)
    if (bgNote) bgNote.textContent += ' A view from above: the 3D view needs WebGL, which the game\'s window does not have.'
    setPlaying(false)
    root.dataset.ready = '1'
    root.dataset.flat = '1'
    ;(root as any).__replay = { seek, get ms() { return ms }, select: (id: string) => { selected = id; changed() }, setPlaying }
    changed()
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

  // ---- seeing through what is between the camera and the player (the follow camera)
  // The camera sits behind the player, and whatever is on the way (a wall, a building, a tree) would hide them. Instead of pulling the
  // camera forward, what is in a cone from the camera to the player's head is faded out, with a screen-door pattern so nothing has to be
  // sorted. A prop is faded as a whole, by where its middle is (every prop knows its middle and its size); a wall by each pixel; a floor
  // only where it is above the line from the camera to the player's feet (a ceiling, or a ledge that hides their legs). Nothing is faded beyond the player.
  // radius (units) from which a prop is faded by the pixel and not as a whole: a tree crown or a bush is cut out where it is in the way, and one
  // whose middle is by the player (its leaves hanging over their head) is not skipped because its middle is past the end of the line
  const BIG_PROP = 60
  const lineOfSight = { uCam: { value: new Vector3() }, uHead: { value: new Vector3() } }
  const CUT_GLSL = `
    uniform vec3 uCam;
    uniform vec3 uHead;
    // 1 where a thing at p (of size r) is in the way of the line of sight from uCam to uHead, 0 where it is not; ceiling: only above the line
    float cutAt(vec3 p, float r, float ceiling) {
      vec3 ab = uHead - uCam;
      float l2 = dot(ab, ab);
      if (l2 < 1.0) return 0.0;
      float t = dot(p - uCam, ab) / l2;
      // an object of size r whose middle is behind the camera can still surround it (the camera inside a helicopter), so the lower limit
      // allows for the size; a pixel (r = 0) keeps the plain limit
      // nothing is faded at the player or beyond: the last stretch is a fixed 8 units (it was 8% of the line, about 25, and a wall 17 units in front of
      // the player, with their body behind it, stayed solid)
      // (a floor or a ledge above their feet could go on past them, to show whoever stands behind the player; it faded planks that hid nothing, so FADE.past is 0)
      float last = ceiling > 0.5 ? 1.0 + ${FADE.past.toFixed(1)} / sqrt(l2) : 1.0 - 8.0 / sqrt(l2);
      if (t < -0.05 - r / sqrt(l2) || t > last) return 0.0;
      vec3 q = uCam + ab * clamp(t, 0.0, 1.0);
      float radius = ${FADE.base.toFixed(1)} + ${FADE.gain.toFixed(1)} * (1.0 - t);
      // a floor is faded only where it can hide some of the player: above the line from the camera to their feet (a ledge below the line to the
      // head still hides their legs; one below the line to the feet hides nothing and is what they stand on)
      if (ceiling > 0.5) {
        // (a ledge that hides their feet lies exactly on the line to the feet, so the test allows a margin below it; the floor they stand
        // on is kept by a second test, against the height of their feet)
        float ground = uHead.y - 64.0;
        float feet = uCam.y + (ground - uCam.y) * clamp(t, 0.0, 1.0);
        if (p.y < feet - 24.0 || p.y < ground + 16.0) return 0.0;
        radius *= 0.8;
      }
      // the cone reaches higher than it is wide: what is above the line (a wall top, a roof, a branch) hides the surroundings of the player
      // as much as what is beside it, and the camera looks down, so a round cone left them in the picture
      vec3 off = p - q;
      if (off.y > 0.0) off.y *= 0.55;
      float d = length(off) - r * 0.5;
      return 1.0 - smoothstep(radius * 0.75, radius, d);
    }
    float screenDoor(vec2 f) { return fract(52.9829189 * fract(dot(f, vec2(0.06711056, 0.00583715)))); }`
  /** Makes a material fade what is on the line of sight: 'prop' (whole objects, from `aObject` = the middle and size), 'wall' or 'floor' (each pixel). */
  function seeThrough(material: Material, kind: 'prop' | 'wall' | 'floor') {
    material.customProgramCacheKey = () => `seethrough-${kind}`
    material.onBeforeCompile = shader => {
      shader.uniforms.uCam = lineOfSight.uCam
      shader.uniforms.uHead = lineOfSight.uHead
      // a prop that is large (a building, a wall) is faded by the pixel like a wall: its middle can be far from the line of sight while the
      // camera is inside it, and the whole object cannot fade because a corner of it is in the way
      const piece = kind === 'prop' ? 'varying float vCut;\nvarying float vBig;\nvarying vec3 vWorldC;' : 'varying vec3 vWorldC;'
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${CUT_GLSL}\n${kind === 'prop' ? 'attribute vec4 aObject;' : ''}\n${piece}\nvoid main() {`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${kind === 'prop' ? `vBig = aObject.w > ${BIG_PROP.toFixed(1)} ? 1.0 : 0.0; vCut = vBig > 0.5 ? 0.0 : cutAt(aObject.xyz, aObject.w, 0.0); vWorldC = (modelMatrix * vec4(transformed, 1.0)).xyz;` : 'vWorldC = (modelMatrix * vec4(transformed, 1.0)).xyz;'}`)
      const test = kind === 'prop' ? 'max(vCut, vBig > 0.5 ? cutAt(vWorldC, 0.0, 0.0) : 0.0)' : `cutAt(vWorldC, 0.0, ${kind === 'floor' ? '1.0' : '0.0'})`
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${CUT_GLSL}\n${piece}\nvoid main() {`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n{ float c = ${test}; if (c > 0.0 && screenDoor(gl_FragCoord.xy) < c) discard; }`)
    }
  }

  /** Draws `meshes` (props placed in the map) as one mesh for each material, in the place they are, even where a material has only one; the ones given are hidden. A set that cannot be put together (different attributes) is left as it is. Returns the merged meshes made. */
  const mergeDrawn = (root: Object3D, meshes: Mesh[]): Mesh[] => {
    const made: Mesh[] = []
    const byMaterial = new Map<Material, Mesh[]>()
    for (const m of meshes) { const list = byMaterial.get(m.material as Material); if (list) list.push(m); else byMaterial.set(m.material as Material, [m]) }
    for (const [material, list] of byMaterial) {
      // (also a material with one mesh: the fade needs the attribute that is made here, and a prop that is not merged is never faded)
      const parts = list.map(m => {
        const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld)
        // every vertex of a prop knows where the prop's middle is and how big it is, so a prop can be faded as one
        g.computeBoundingSphere()
        const c = g.boundingSphere!, n = g.getAttribute('position').count, a = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) a.set([c.center.x, c.center.y, c.center.z, c.radius], i * 4)
        g.setAttribute('aObject', new BufferAttribute(a, 4))
        return g
      })
      const merged = mergeGeometries(parts, false)
      parts.forEach(g => g.dispose())
      if (!merged) continue
      seeThrough(material, 'prop') // (only a material that is drawn merged has the attribute it needs)
      const one = new Mesh(merged, material)
      one.name = 'props-merged'
      root.add(one)
      made.push(one)
      for (const m of list) m.visible = false
    }
    return made
  }

  // ---- the background
  const cut = new Plane(new Vector3(0, -1, 0), 1e9)
  const levelNodes: { index: number, node: Object3D }[] = []
  const wallMeshes: Mesh[] = []
  // The leaves of the map's plants (Glass and leaves, RFC 18, 4.6): drawn with their own textures, cut out as the game does; a switch to see the ground through them
  const leafMeshes: Mesh[] = []
  // What a body can lie on: the floors of the map and its solid props (not the walls, the leaves or the water)
  const groundMeshes: Mesh[] = []
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
      const model = await new Promise<Object3D>((ok, fail) => mapLoader().parse(buf, '', g => ok(g.scene), fail))
      model.traverse(o => { const m = LEVEL_NAME.exec(o.name); if (m && !levelNodes.some(l => l.node === o)) levelNodes.push({ index: Number(m[1]), node: o }) })
      levelNodes.sort((a, b) => a.index - b.index)
      // The same look as the map page, and the same water.
      const painted: Painted[] = []
      for (const l of levelNodes) l.node.traverse(o => {
        if (!(o as Mesh).isMesh) return
        const mesh = o as Mesh<BufferGeometry, StdMat>
        const isWall = mesh.material.name === 'wall'
        mesh.material = mesh.material.clone()
        mesh.material.clippingPlanes = [cut]
        mesh.material.metalness = 0
        mesh.material.roughness = 1
        seeThrough(mesh.material, isWall ? 'wall' : 'floor')
        if (isWall) wallMeshes.push(mesh)
        painted.push({ mesh, wall: isWall, level: l.index })
      })
      prepareWater(model, cut)
      const props = prepareProps(model, cut)
      prepareMovable(model, cut)
      // Parts apart from the map (RFC 18, 4.4) are not drawn in the replay.
      const apart = model.getObjectByName('detached')
      if (apart) apart.visible = false
      paintPlain(painted)
      scene.add(model)
      model.updateMatrixWorld(true)
      // Hundreds of props are hundreds of draw calls, which is what a phone is slowest at: the props of one material are drawn as one mesh
      // (the separate ones stay, unseen, for the camera). Then nothing of the map moves, so its matrices are not worked out again each frame.
      const mergedSolid = mergeDrawn(model, props.solid)
      groundMeshes.push(...painted.filter(q => !q.wall).map(q => q.mesh), ...mergedSolid, ...props.solid.filter(m => m.visible))
      const mergedLeaves = mergeDrawn(model, props.foliage)
      leafMeshes.push(...mergedLeaves, ...props.foliage.filter(m => m.visible)) // the ones that could not be merged stay as they are
      const leavesBox = el<HTMLInputElement>(root, '[data-leaves]')
      for (const m of leafMeshes) m.visible = !!leavesBox?.checked
      if (leafMeshes.length === 0) leavesBox?.closest('label')?.setAttribute('hidden', '')
      model.traverse(o => { o.matrixAutoUpdate = false })
      const b = boxWithout(model, ['detached']) // in three's Y-up
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

  // ---- the players' model (RFC 22): the game's own, in the team's colour. Moving when the backend sends clips (a skeleton that is
  // posed from how the player moves), still when it sends a pose; the box figure below is the fallback.
  let real: { geometry: BufferGeometry, height: number, back: number, thick: number } | null = null
  let moving: { scene: Object3D, clips: Map<string, AnimationClip>, strides: Strides } | null = null
  if (payload.playerModel) {
    try {
      const buf = await fetch(payload.playerModel, { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
      const gltf = await new Promise<{ scene: Object3D, animations: AnimationClip[], parser: { json: any } }>((ok, fail) => new GLTFLoader().parse(buf, '', g => ok(g as any), fail))
      let geometry: BufferGeometry | null = null
      gltf.scene.traverse(o => { if (!geometry && (o as Mesh).isMesh) geometry = (o as Mesh).geometry })
      if (geometry) {
        // the vertices are in Source's coordinates, facing +x, as the world group below wants them
        const g: BufferGeometry = geometry
        g.computeBoundingBox()
        const height = Number(gltf.parser.json?.extras?.height) || g.boundingBox!.max.z
        real = { geometry: g, height, back: -g.boundingBox!.min.x, thick: g.boundingBox!.max.x - g.boundingBox!.min.x }
        const names: string[] = clipNames()
        const clips = new Map(gltf.animations.filter(c => names.includes(c.name)).map(c => [c.name, c] as const))
        if (clips.size === names.length) {
          const walked = new Map<string, number>((gltf.parser.json?.animations ?? []).map((a: any) => [a.name, Number(a.extras?.stride) || 0] as const))
          const strides = Object.fromEntries(GAITS.map(g => [g, gaitClips(g).map(n => walked.get(n) ?? 0)])) as Strides // how far each clip of a gait walks in one cycle, by direction
          moving = { scene: gltf.scene, clips, strides }
        }
      }
    } catch { /* the boxes it is */ }
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
  const ringGeo = new RingGeometry(26, 32, 40)
  const matte = (c: number) => new MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.8 })
  const LEGS = 0x2b3547, SKIN = 0xe2c3a0

  /** A person standing at the origin facing +x, in the team's colour; `dim` for a body that lies where its player died. */
  const figure = (colour: number, dim: boolean) => {
    if (moving) {
      const g = new Group()
      const cloth = new MeshStandardMaterial({ color: dim ? new Color(colour).multiplyScalar(0.45).getHex() : colour, metalness: 0, roughness: 0.8, side: DoubleSide })
      const body = cloneRig(moving.scene) as Object3D // the skeleton and its skin, copied, so each player has their own
      body.getObjectByName('z-up')?.quaternion.set(0, 0, 0, 1) // this world is Source's already (Z up)
      body.traverse(o => { if ((o as Mesh).isMesh) { (o as Mesh).material = cloth; o.frustumCulled = false } })
      g.add(body)
      const mixer = new AnimationMixer(body)
      const actions = new Map<string, AnimationAction>()
      for (const [name, clip] of moving.clips) { const a = mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); actions.set(name, a) }
      g.userData.cloth = cloth // so a change of team can repaint it
      g.userData.rig = { mixer, actions }
      return g
    }
    if (real) {
      const g = new Group()
      const cloth = new MeshStandardMaterial({ color: dim ? new Color(colour).multiplyScalar(0.45).getHex() : colour, metalness: 0, roughness: 0.8, side: DoubleSide })
      g.add(new Mesh(real.geometry, cloth))
      g.userData.cloth = cloth // so a change of team can repaint it
      return g
    }
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
    // a long nickname shrinks and then ends in an ellipsis: the texture is 256 pixels wide and would cut it off on both sides
    const fit = fitLabel(name, (s, px) => { g.font = `bold ${px}px sans-serif`; return g.measureText(s).width })
    g.font = `bold ${fit.px}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(fit.text, 128, 32)
    g.fillStyle = hex(colour); g.fillText(fit.text, 128, 32)
  })

  /**
   * Poses a figure's skeleton: how much of each clip (`weights`), and how far into each. A gait is in step in all its directions (the
   * clips are made to be blended): the cycle is the one gone along the path, so a foot does not slide at any speed or direction and
   * when scrubbing; the two idles go by the time.
   */
  const poseRig = (g: Group, weights: Record<ClipName, number>, path: Path | null, ms: number) => {
    const rig = g.userData.rig as { mixer: AnimationMixer, actions: Map<string, AnimationAction> } | undefined
    if (!rig || !moving) return
    for (const [name, action] of rig.actions) {
      const w = weights[name as ClipName] ?? 0
      action.setEffectiveWeight(w)
      action.enabled = w > 0
      if (w <= 0) continue
      const clip = moving.clips.get(name)!
      const gait = GAITS.find(x => name.startsWith(x + '_'))
      const cycle = gait && path ? cyclesAt(path, gait, ms) % 1 : ((ms / 1000) / clip.duration) % 1
      action.time = cycle * clip.duration
    }
    rig.mixer.update(0)
  }
  const STILL = { idle: 1 } as Record<ClipName, number>

  /**
   * The model's file holds its shape at rest, whose back (the arms, the feet) reaches 27 units behind the origin; in the standing
   * pose that is shown it is 7. A body lifted by the first lay 20 units above the floor (2026-11-04, "still floating"). The depth
   * of the body in the pose that is drawn is measured once, in the figure's own space, and decides how a body lies.
   */
  let measured = false
  const measureStill = (lying: Group) => {
    if (measured || !real || !moving) return
    measured = true
    const d = depthOf(lying)
    if (d) { real.back = -d.min; real.thick = d.max - d.min }
  }

  // A body lies on the ground, not in the air where the player was when they died: shot in a jump, thrown by an explosion, killed on a ledge
  // (2026-11-05: a body 86 units over the floor on Yucatan). The place of a death is the player's last position; the body is put on the first
  // floor or prop below it, found with a ray down through the map (once for each death). Without a map drawn it stays where it was recorded.
  const ray = new Raycaster()
  const downFrom = new Vector3(), down = new Vector3(0, -1, 0)
  const grounds = new Map<string, number | null>()
  const groundBelow = (x: number, y: number, z: number): number | null => {
    if (groundMeshes.length === 0) return null
    const key = `${x},${y},${z}`
    if (grounds.has(key)) return grounds.get(key)!
    downFrom.set(x, z + 24, -y) // Source's (x, y, z) in three's Y-up world
    ray.set(downFrom, down)
    ray.far = 900
    const sides = groundMeshes.map(m => (m.material as Material).side)
    for (const m of groundMeshes) (m.material as Material).side = DoubleSide // a floor that faces the other way (a prop's top) still counts
    const hit = ray.intersectObjects(groundMeshes, false)[0]
    groundMeshes.forEach((m, i) => { (m.material as Material).side = sides[i]! })
    const z0 = hit ? hit.point.y : null
    grounds.set(key, z0)
    return z0
  }

  interface Look { plain: CanvasTexture, pointer: CanvasTexture, cross: CanvasTexture, label: CanvasTexture }
  interface Marker {
    group: Group, pin: Sprite, label: Sprite, ring: Mesh, trail: Line, corpse: Group, deadPin: Sprite, segs: Segment[]
    body: Group, lying: Group, path: Path, colour: number, looks: Map<number, Look>
    /** When the skeleton was last posed, in ms of the round (it is done thirty times a second, the rate of the animations). */
    posedAt: number
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
    const ring = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: DoubleSide })); ring.position.z = 1.5; ring.visible = false
    const looks = new Map<number, Look>()
    const look = lookOf({ looks }, id, colour)
    const pin = screenSprite(look.plain, PIN, PIN); pin.position.z = real ? real.height + 12 : 86
    const label = screenSprite(look.label, LABEL_H * 4, LABEL_H); label.position.z = real ? real.height + 12 : 86; label.center.set(0.5, -0.55)
    group.add(ring, pin, label)

    const trailGeo = new BufferGeometry()
    trailGeo.setAttribute('position', new BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3))
    const trail = new Line(trailGeo, new LineBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }))
    trail.frustumCulled = false

    // Where a player died: their body lies there, with a cross over it.
    const corpse = new Group()
    const lying = figure(colour, true)
    lying.rotation.y = -Math.PI / 2 // onto its back, head towards -x
    poseRig(lying, STILL, null, 0) // a body is the standing pose, lying down
    measureStill(lying) // how far the back reaches in that pose, which is not what the model's file says of its resting shape
    lying.position.z = real ? real.back : 9 // so the back lies on the floor
    const deadPin = screenSprite(look.cross, PIN, PIN)
    if (real) deadPin.position.set(-real.height / 2, 0, real.thick + 14) // over the middle of the body, which lies along -x from where it died
    else deadPin.position.z = 50
    corpse.add(lying, deadPin)
    corpse.visible = false

    world.add(group, trail, corpse)
    markers.set(id, { group, pin, label, ring, trail, corpse, deadPin, segs: data.players.get(id) ?? [], body, lying, path: pathOf(data.players.get(id) ?? [], moving?.strides ?? null), colour, looks, posedAt: -1e9 })
  }
  // The shot: a line of the width of a few pixels (a `Line` is one pixel wide in WebGL, which is too faint to see), as a thin
  // bright beam with a wider faint one around it, drawn over the map so a wall does not hide where the shot came from.
  const beamGeo = new CylinderGeometry(1, 1, 1, 8, 1, true)
  const beamPart = (radius: number, opacity: number) => {
    const m = new Mesh(beamGeo, new MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity, depthTest: false, depthWrite: false }))
    m.userData.radius = radius; m.renderOrder = 9; m.frustumCulled = false
    return m
  }
  const killBeam = new Group()
  killBeam.add(beamPart(2.2, 1), beamPart(6, 0.28))
  killBeam.visible = false
  world.add(killBeam)
  const up = new Vector3(0, 1, 0), along = new Vector3(), middle = new Vector3()
  /** Stretches the beam from `a` to `b` (Source's coordinates, in the group of the world). */
  const aimBeam = (beam: Group, a: Vector3, b: Vector3) => {
    along.copy(b).sub(a)
    const length = along.length()
    if (length < 1e-3) { beam.visible = false; return }
    middle.copy(a).add(b).multiplyScalar(0.5)
    for (const part of beam.children) {
      part.position.copy(middle)
      part.quaternion.setFromUnitVectors(up, along.clone().divideScalar(length))
      part.scale.set(part.userData.radius, length, part.userData.radius)
    }
  }

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
  const shown = () => shownLevels(upTo, followLevel, camMode) // what is drawn: the chosen level and below, or everything for the follow camera that follows the player's level
  const showLevels = () => {
    const upto = shown()
    for (const l of levelNodes) l.node.visible = upto === 'all' || l.index <= upto
    cut.constant = cutHeight(levels, upto, CUT_ABOVE)
    markLevels()
  }
  const follow = { x: 0, y: 0, z: 0, yaw: 0, at: 0, ms: 0, who: null as string | null } // where the follow camera is settled

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
      if (chip) setText(chip.role, st.role ? (st.was.length ? `${st.role} (was ${st.was[0]})` : st.role) : '')
      const p = poseAt(m.segs, ms)
      // A player on a level above the one shown would float in the air; one below is hidden by the floor, so its name is dimmed.
      const lv = p && levels.length > 0 && bg.kind !== 'none' ? levelOf(levels, p.z) : 0
      const upto = shown()
      const above = typeof upto === 'number' && lv > upto
      const dim = typeof upto === 'number' && lv > 0 && lv < upto
      // a dead player is the body where they fell, not also the figure of their last sample (the two are both there at the moment of death)
      m.group.visible = p !== null && !above && currentDeath(data.deaths, data.events, id, ms) === null
      ;(m.label.material as SpriteMaterial).opacity = dim ? 0.35 : 1
      ;(m.pin.material as SpriteMaterial).opacity = dim ? 0.35 : 1
      if (p) {
        m.group.position.set(p.x, p.y, p.z)
        const look = (p.yaw / 256) * Math.PI * 2
        if (moving) {
          // the body looks where the player looks, as in the game; its legs walk the way the player goes relative to that (forward, back, sideways)
          const v = velocityAt(m.segs, ms)
          m.group.rotation.z = look
          if (Math.abs(ms - m.posedAt) >= (slow ? 33 : 12)) { m.posedAt = ms; poseRig(m.body, clipWeights(v.speed, v.heading - look, (moveAt(m.segs, ms) & MOVE.crouching) !== 0), m.path, ms) }
        } else m.group.rotation.z = look
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
      m.corpse.visible = !!death && !(typeof upto === 'number' && deathLevel > upto)
      if (death) {
        m.corpse.position.set(death.at[0], death.at[1], groundBelow(death.at[0], death.at[1], death.at[2]) ?? death.at[2])
        const last = lastPoseAt(m.segs, death.t)
        m.corpse.rotation.z = last ? (last.yaw / 256) * Math.PI * 2 : 0
      }
      const trail = trailBetween(m.segs, ms - TRAIL_MS, ms)
      const count = trail.length >= 6 ? Math.min(trail.length / 3, TRAIL_POINTS) : 0
      const attr = m.trail.geometry.getAttribute('position') as BufferAttribute
      for (let i = 0; i < count * 3; i++) attr.array[i] = trail[i]!
      attr.needsUpdate = true
      m.trail.geometry.setDrawRange(0, count)
      m.trail.visible = count > 0 && !death
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
      setText(panel, selected && st ? `${nick(selected)}: ${st.role ?? 'role unknown'}${st.was.length ? ' (was ' + st.was.join(', ') + ')' : ''}${st.team ? ', ' + st.team : ''}` : '')
    }
    // the line between victim and attacker while a kill is fresh
    const kill = data.deaths.find(d => d.from && ms >= d.t && ms <= d.t + KILL_LINE_MS)
    killBeam.visible = !!kill?.from
    if (kill?.from) aimBeam(killBeam, new Vector3(kill.from[0], kill.from[1], kill.from[2] + 48), new Vector3(kill.at[0], kill.at[1], kill.at[2] + 48))

    // the selected player's level, when following it
    const sel = selected ? lastPoseAt(data.players.get(selected) ?? [], ms) : null
    if (followLevel && sel && levels.length > 0 && bg.kind !== 'none') {
      if (levelHoldFor !== selected) { levelHold = null; levelHoldFor = selected }
      levelHold = holdLevel(levelHold, levelOf(levels, sel.z), ms)
      if (levelHold.level !== upTo) { upTo = levelHold.level; showLevels() }
    }
    // follow camera: behind and above, looking where the player looks. It follows the player's place between the samples (not the
    // last sample, which changes five times a second) and settles into it, so it glides; a jump in time puts it straight there.
    const mine = selected ? (poseAt(data.players.get(selected) ?? [], ms) ?? sel) : null
    if (camMode === 'follow' && mine) {
      const a = (mine.yaw / 256) * Math.PI * 2
      const now = performance.now(), dt = now - follow.at
      const glide = playing && follow.who === selected && ms >= follow.ms && ms - follow.ms < 600 && dt < 250
      if (glide) {
        follow.x = damp(follow.x, mine.x, dt, 70); follow.y = damp(follow.y, mine.y, dt, 70); follow.z = damp(follow.z, mine.z, dt, 120)
        follow.yaw = dampAngle(follow.yaw, a, dt, 200)
      } else { follow.x = mine.x; follow.y = mine.y; follow.z = mine.z; follow.yaw = a }
      follow.at = now; follow.ms = ms; follow.who = selected
      const px = follow.x, py = follow.y, pz = follow.z
      const dx = Math.cos(follow.yaw), dy = Math.sin(follow.yaw)
      // Source (x, y, z) -> three (x, z, -y)
      persp.position.set(px - dx * 300, pz + 170, -(py - dy * 300))
      lineOfSight.uCam.value.copy(persp.position)
      lineOfSight.uHead.value.set(px, pz + 64, -py)
      tmp.set(px + dx * 90, pz + 50, -(py + dy * 90))
      persp.lookAt(tmp)
    } else lineOfSight.uHead.value.copy(lineOfSight.uCam.value) // no line of sight, nothing is faded
    scrub.value = String(ms)
    setText(timeEl, `${clock(ms)} / ${clock(data.length)}`)
    render()
  }
  function changed() { hooks.paint() }
  hooks.paint = apply
  hooks.level = () => { showLevels(); render() }
  hooks.walls = on => { for (const m of wallMeshes) m.visible = on; render() }
  hooks.leaves = on => { for (const m of leafMeshes) m.visible = on; render() }
  hooks.resize = resize

  const setCam = (mode: 'orbit' | 'top' | 'follow') => {
    if (camMode === 'orbit' && mode !== 'orbit') saved = { pos: persp.position.clone(), target: orbit.target.clone() }
    if (mode === 'orbit' && saved) { persp.position.copy(saved.pos); orbit.target.copy(saved.target) }
    camMode = mode
    showLevels() // the follow camera shows every level while it follows the player's
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
  ;(root as any).__replay = { seek, get ms() { return ms }, select: (id: string) => { selected = id; changed() }, setCam, setPlaying, setTheater, camera: () => [...persp.position.toArray(), follow.x, follow.y, follow.yaw], drawn: () => ({ ...renderer.info.render, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0 }) }
}

document.querySelectorAll<HTMLElement>('[data-replay]').forEach(r => { start(r) })
