import { Room, RoomEvent, LocalAudioTrack, createLocalAudioTrack, type RemoteTrack } from 'livekit-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import { GATE, GateState, FloorTracker, calibrate, clampDb, toDb } from './gate'

// The voice page's code (RFC 27). It joins the server's room with a token from the dashboard, publishes the microphone, and plays
// what the media server sends it. It subscribes to nothing itself (autoSubscribe off): the dashboard decides, from the round, who
// each player hears, so nothing here knows who is alive. The microphone opens by the player's voice (default) or by a held key.
// The opening by voice is the gate of RFC 29: an audio worklet (/public/gate.js, from src/gate-worklet.ts) after the noise filter,
// with two thresholds in dBFS, a hold, a look-ahead and a ramped gain. The published track stays on: the gain opens and closes it.

const store = {
  get(k: string): string | null { try { return localStorage.getItem('td_voice_' + k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem('td_voice_' + k, v) } catch { /* private window: the choice is not kept */ } },
}

interface Chain {
  out: MediaStreamTrack
  setFilter(on: boolean): void
  setMonitor(on: boolean): void
  /** null when the gate could not start: the page then decides (a little late) and mutes the track, as before RFC 29. */
  gate: AudioWorkletNode | null
  filterOk: boolean
  /** Set by the page: gets the noise filter's probability that the sound is speech (0 to 1), about every 10 ms; none comes for digital silence. */
  onVad: ((p: number) => void) | null
}

// The microphone through the noise filter (RNNoise, in the browser; its files are copied to /public/rnnoise by the build) and then the
// gate (/public/gate.js). `dry` and `wet` are two ways to the same point and the player's choice opens one of them; the filter runs
// either way, so switching is at once. `monitor` plays what is sent to the player, to judge the filter and the gate on their own (one
// account cannot join twice). The filter needs 48 kHz. Each of the two is an extra: when one cannot start, the other still does.
async function buildChain(c: AudioContext, raw: MediaStreamTrack, at: { open: number, close: number }): Promise<Chain> {
  const src = c.createMediaStreamSource(new MediaStream([raw]))
  const dest = c.createMediaStreamDestination()
  const dry = c.createGain(), wet = c.createGain(), monitor = c.createGain(), pre = c.createGain()
  monitor.gain.value = 0
  src.connect(dry); dry.connect(pre)
  let filterOk = true
  try {
    const wasmBinary = await loadRnnoise({ url: '/public/rnnoise/rnnoise.wasm', simdUrl: '/public/rnnoise/rnnoise_simd.wasm' })
    await c.audioWorklet.addModule('/public/rnnoise/worklet.js')
    const filter = new RnnoiseWorkletNode(c, { maxChannels: 2, wasmBinary })
    // The build patches the filter's worklet (scripts/copy-rnnoise.ts) to post { vad } with the probability of speech (RFC 29, 4.4).
    filter.port.onmessage = (e: MessageEvent) => { const v = e.data?.vad; if (typeof v === 'number') chain.onVad?.(v) }
    src.connect(filter); filter.connect(wet); wet.connect(pre)
  } catch (err) {
    console.warn('voice: the noise filter did not start', err)
    filterOk = false
  }
  let gate: AudioWorkletNode | null = null
  try {
    await c.audioWorklet.addModule('/public/gate.js')
    gate = new AudioWorkletNode(c, 'td-gate', { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: at })
  } catch (err) {
    console.warn('voice: the gate did not start', err)
  }
  if (gate) pre.connect(gate)
  const tail = gate ?? pre
  tail.connect(dest); tail.connect(monitor)
  monitor.connect(c.destination)
  const chain: Chain = {
    out: dest.stream.getAudioTracks()[0]!, gate, filterOk, onVad: null,
    setFilter(on) { const w = on && filterOk; wet.gain.value = w ? 1 : 0; dry.gain.value = w ? 0 : 1 },
    setMonitor(on) { monitor.gain.value = on ? 1 : 0 },
  }
  return chain
}

// The meter shows -80 to 0 dBFS; its zones (quiet, where speech should sit, too loud) are drawn by the stylesheet at the same places.
const METER_MIN = -80, METER_MAX = 0
const pct = (db: number) => Math.min(100, Math.max(0, (db - METER_MIN) / (METER_MAX - METER_MIN) * 100))
const num = (v: string | null): number | null => { if (v === null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

function start(root: HTMLElement) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const join = $<HTMLButtonElement>('[data-join]')
  const status = $('[data-status]')
  // The status and the who-is-on line are one line each (cut with an ellipsis, so a long error cannot grow the row); the title holds the whole text.
  const say = (el: HTMLElement, text: string) => { el.textContent = text; el.title = text }
  const level = $<HTMLElement>('[data-level]')
  const marker = $<HTMLElement>('[data-marker]')
  const markerClose = $<HTMLElement>('[data-marker-close]')
  const speaking = $('[data-speaking]')
  const dbOut = $('[data-db]')
  const threshold = $<HTMLInputElement>('[data-threshold]')
  const thresholdOut = $('[data-threshold-out]')
  const closeThreshold = $<HTMLInputElement>('[data-close-threshold]')
  const closeOut = $('[data-close-out]')
  const measureBtn = $<HTMLButtonElement>('[data-measure]')
  const measureNote = $('[data-measure-note]')
  const autoBtn = $<HTMLButtonElement>('[data-auto]')
  const gateNote = $('[data-gate-note]')
  const condLoud = $<HTMLInputElement>('[data-cond-loud]')
  const condSpeech = $<HTMLInputElement>('[data-cond-speech]')
  const condNote = $('[data-cond-note]')
  const count = $('[data-count]')
  const audioBox = $('[data-audio]')
  const vadBox = $('[data-vad-box]')
  const pttBox = $('[data-ptt-box]')
  const pttKey = $<HTMLInputElement>('[data-ptt-key]')
  const modes = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mode]'))
  const filters = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-filter]'))
  const monitorBtn = $<HTMLButtonElement>('[data-monitor]')
  const filterNote = $('[data-filter-note]')
  const peopleBox = $('[data-people]')
  const who = $('[data-who]')
  const peopleUrl = root.dataset.peopleUrl

  let room: Room | null = null
  let mic: LocalAudioTrack | null = null
  let ctx: AudioContext | null = null
  let tap: MediaStreamTrack | null = null
  let rawMic: LocalAudioTrack | null = null // what the microphone gives; `mic` is what is sent (the same, or the chain's output)
  let chain: Chain | null = null
  let gateNode: AudioWorkletNode | null = null
  const playing = new Map<string, HTMLMediaElement>() // the audio of each player who is being heard, by SteamID64
  let timer = 0
  let talking = false
  let keyDown = false

  const mode = () => (modes.find(m => m.getAttribute('aria-pressed') === 'true')?.dataset.mode === 'ptt' ? 'ptt' : 'vad')
  const pick = (which: string) => modes.forEach(m => m.setAttribute('aria-pressed', String(m.dataset.mode === which)))
  const filterOn = () => filters.find(f => f.getAttribute('aria-pressed') === 'true')?.dataset.filter !== 'off'
  const pickFilter = (which: string) => filters.forEach(f => f.setAttribute('aria-pressed', String(f.dataset.filter === which)))
  const monitorOn = () => monitorBtn.getAttribute('aria-pressed') === 'true'
  const autoOn = () => autoBtn.getAttribute('aria-pressed') === 'true'
  const showMode = () => { vadBox.style.display = mode() === 'vad' ? '' : 'none'; pttBox.style.display = mode() === 'ptt' ? '' : 'none' }

  // What must hold for the microphone to open (RFC 29, 4.4): 'loud' (the default, the gate as it was), 'speech' (the noise filter says it is a
  // voice, whatever the level) or 'both'. Saved as such; anything else saved means 'loud'. The speech part needs the noise filter and the gate
  // worklet: when either could not start it is not offered, the choice that was saved stays saved, and the gate runs on loudness.
  type Cond = 'loud' | 'speech' | 'both'
  const condOf = (v: string | null): Cond => (v === 'speech' || v === 'both' ? v : 'loud')
  let cond: Cond = condOf(store.get('gate_cond'))
  let speechOk = true // false once a join has shown that the speech check cannot run
  const effective = (): Cond => (speechOk ? cond : 'loud')
  const speechOnly = () => effective() === 'speech'

  // The two thresholds, in dBFS. The close one follows the open one at the same distance (6 dB at first); the "Advanced" slider changes the distance.
  let openDb: number = GATE.openDb
  let gap: number = GATE.gapDb
  const closeDb = () => clampDb(openDb - gap, GATE.minDb, openDb)
  const showThresholds = () => {
    marker.style.left = pct(openDb) + '%'; markerClose.style.left = pct(closeDb()) + '%'
    threshold.value = String(openDb); closeThreshold.value = String(closeDb())
    thresholdOut.textContent = openDb + ' dBFS'; closeOut.textContent = closeDb() + ' dBFS'
  }
  const fallback = new GateState(openDb, closeDb()) // the page's own gate, when the worklet could not start
  const pushThresholds = () => { gateNode?.port.postMessage({ type: 'set', open: openDb, close: closeDb() }); fallback.set(openDb, closeDb()) }
  // The player's own setting (what the sliders and the measurement set, and what is saved) is kept apart from what the automatic mode
  // adjusts: that is never saved, and switching it off puts the player's own setting back.
  let manualOpen: number = openDb
  let manualGap: number = gap
  const setThresholds = (open: number, close: number, keep = true) => {
    openDb = clampDb(Math.round(open)); gap = openDb - clampDb(Math.round(close), GATE.minDb, openDb)
    showThresholds(); pushThresholds()
    if (keep) { manualOpen = openDb; manualGap = gap; store.set('gate_open', String(openDb)); store.set('gate_close', String(closeDb())) }
  }

  // What was chosen last time. (The linear 1 to 60 threshold of before RFC 29 is not carried over: another scale.)
  const savedMode = store.get('mode'); if (savedMode === 'ptt' && !modes.find(m => m.dataset.mode === 'ptt')?.disabled) pick('ptt') // the button is off for now: a saved choice of it is ignored
  const savedOpen = num(store.get('gate_open')), savedClose = num(store.get('gate_close'))
  if (savedOpen !== null && savedOpen >= GATE.minDb && savedOpen <= GATE.maxDb) {
    openDb = Math.round(savedOpen)
    if (savedClose !== null && savedClose >= GATE.minDb && savedClose <= openDb) gap = openDb - Math.round(savedClose)
    manualOpen = openDb; manualGap = gap
    measureNote.textContent = ''
  } else {
    measureNote.textContent = 'Not measured yet: join, stay quiet, and press "Measure my room" so the microphone opens at the right level for your room.'
  }
  const savedKey = store.get('key'); if (savedKey && savedKey.length === 1) pttKey.value = savedKey
  if (store.get('filter') === 'off') pickFilter('off')
  if (store.get('gate_auto') === '1') autoBtn.setAttribute('aria-pressed', 'true')
  // The sliders, "Measure my room" and "Adjust by itself" are about loudness: with speech alone they are not used, and are off.
  let measuring: number[] | null = null
  const showAuto = () => {
    threshold.disabled = autoOn() || speechOnly(); closeThreshold.disabled = autoOn() || speechOnly()
    measureBtn.disabled = measuring !== null || speechOnly(); autoBtn.disabled = speechOnly()
  }
  const showCond = () => {
    condLoud.checked = effective() !== 'speech'; condSpeech.checked = effective() !== 'loud'
    condSpeech.disabled = !speechOk || mode() === 'ptt'; condLoud.disabled = mode() === 'ptt'
    if (!speechOk) condNote.textContent = 'The speech check needs the noise filter and the voice gate, and one of them could not start: the microphone opens by loudness.'
    else if (speechOnly()) condNote.textContent = 'Only speech decides now: the sensitivity, "Measure my room" and "Adjust by itself" are not used.'
    else condNote.textContent = ''
    showAuto()
  }
  const pushConditions = () => { const e = effective(); gateNode?.port.postMessage({ type: 'conditions', loud: e !== 'speech', speech: e !== 'loud' }) }
  showMode(); showThresholds(); showCond(); pushThresholds()

  // Held open or closed by the key in the "hold a key" mode, where the gate is not used; the gate decides otherwise.
  const syncForce = () => gateNode?.port.postMessage({ type: 'force', open: mode() === 'ptt' ? keyDown : null })

  filters.forEach(f => f.addEventListener('click', () => { pickFilter(f.dataset.filter!); store.set('filter', filterOn() ? 'on' : 'off'); chain?.setFilter(filterOn()) }))
  monitorBtn.addEventListener('click', () => { monitorBtn.setAttribute('aria-pressed', String(!monitorOn())); chain?.setMonitor(monitorOn()) }) // not remembered: it starts off at every join
  modes.forEach(m => m.addEventListener('click', () => { pick(m.dataset.mode!); store.set('mode', mode()); showMode(); showCond(); syncForce() }))
  // At least one box stays ticked: unticking the last one ticks the other.
  const onCond = (changed: 'loud' | 'speech') => {
    let loud = condLoud.checked, speech = condSpeech.checked && speechOk
    if (!loud && !speech) { if (changed === 'loud' && speechOk) speech = true; else loud = true }
    cond = loud && speech ? 'both' : speech ? 'speech' : 'loud'
    store.set('gate_cond', cond)
    showCond(); pushConditions()
  }
  condLoud.addEventListener('change', () => onCond('loud'))
  condSpeech.addEventListener('change', () => onCond('speech'))
  threshold.addEventListener('input', () => setThresholds(Number(threshold.value), Number(threshold.value) - gap))
  closeThreshold.addEventListener('input', () => setThresholds(openDb, Number(closeThreshold.value)))
  pttKey.addEventListener('input', () => { pttKey.value = pttKey.value.slice(-1).toLowerCase(); store.set('key', pttKey.value) })

  // Adjusting by itself (RFC 29, 4.3): the floor of the room, followed while the gate is closed, and the thresholds kept above it.
  let tracker = new FloorTracker()
  autoBtn.addEventListener('click', () => {
    autoBtn.setAttribute('aria-pressed', String(!autoOn()))
    store.set('gate_auto', autoOn() ? '1' : '0')
    tracker = new FloorTracker(); showCond()
    if (!autoOn()) setThresholds(manualOpen, manualOpen - manualGap, false) // off: the player's own setting is back, and the sliders
  })

  // "Measure my room": 3 seconds of the levels the gate hears (after the filter), then the thresholds are set from them.
  measureBtn.addEventListener('click', () => {
    if (measuring) return
    if (!room || !mic) { measureNote.textContent = 'Join the voice chat first: the room is measured through your microphone.'; return }
    const mine: number[] = []
    measuring = mine
    showAuto()
    measureNote.textContent = 'Stay quiet for 3 seconds…'
    window.setTimeout(() => {
      if (measuring !== mine) return // the player left meanwhile (and may have begun another measurement): this one is over
      const levels = mine
      measuring = null; showAuto()
      const r = calibrate(levels)
      if (!r.ok) {
        measureNote.textContent = r.reason === 'few'
          ? 'Not enough sound came through to measure. Try again.'
          : 'The sound varied too much (speech, a bang, a door?). Stay quiet and try again; nothing was changed.'
        return
      }
      setThresholds(r.open, r.close)
      tracker.seed(r.floor)
      measureNote.textContent = `Your room is at ${Math.round(r.floor)} dBFS. The microphone opens at ${openDb} dBFS and closes at ${closeDb()} dBFS` + (r.clamped ? ' (kept inside the slider\'s range).' : '.')
    }, GATE.calibrateMs)
  })

  // One reading from the gate (the worklet posts about 20 a second; the fallback makes its own): the level before the gate, in dBFS,
  // and whether the gate is open. The meter, the "talking" mark, the room measurement and the automatic mode all follow it.
  let lastT = -1
  const onLevel = (db: number, isOpen: boolean, t: number) => {
    level.style.width = pct(db) + '%'
    level.classList.toggle('open', isOpen)
    dbOut.textContent = db <= GATE.silenceDb ? '' : Math.round(db) + ' dBFS'
    if (isOpen !== talking) { talking = isOpen; speaking.textContent = isOpen ? 'talking' : '' }
    if (measuring) measuring.push(db)
    const dt = lastT < 0 ? 50 : Math.max(0, Math.min(1000, (t - lastT) * 1000))
    lastT = t
    if (autoOn() && !measuring && !speechOnly()) {
      tracker.feed(db, dt, isOpen)
      const th = tracker.thresholds()
      if (th && (Math.round(th.open) !== openDb || Math.round(th.close) !== closeDb())) setThresholds(th.open, th.close, false)
    }
  }

  // The fallback, for when the gate could not start: the page decides from a look at the microphone every 50 ms and switches the track
  // with LiveKit's mute, as before RFC 29 (a little late at the start of a word). It uses the same state machine and thresholds.
  const watchFallback = async (track: LocalAudioTrack) => {
    const c = ctx! // made by the click that started the join, so the browser lets it run; it may still be asked to resume
    await c.resume().catch(() => {})
    // LiveKit's mute() switches the published track off (enabled = false). The level, and the detection that opens the
    // microphone, must listen to a copy that stays on: on the track itself they heard silence for ever and the microphone never opened.
    tap = track.mediaStreamTrack.clone()
    tap.enabled = true
    const analyser = c.createAnalyser()
    analyser.fftSize = 1024
    c.createMediaStreamSource(new MediaStream([tap])).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let isOpen = false
    timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const db = toDb(sum / buf.length)
      const want = mode() === 'vad' ? fallback.step(db, 50) : keyDown
      if (want !== isOpen) { isOpen = want; void (want ? track.unmute() : track.mute()) }
      onLevel(db, isOpen, Date.now() / 1000)
    }, 50)
  }

  const keyOf = (e: KeyboardEvent) => e.key.length === 1 ? e.key.toLowerCase() : ''
  const typing = (e: Event) => e.target === pttKey
  window.addEventListener('keydown', (e) => { if (!typing(e) && mode() === 'ptt' && keyOf(e) === pttKey.value) { keyDown = true; syncForce() } })
  window.addEventListener('keyup', (e) => { if (keyOf(e) === pttKey.value) { keyDown = false; syncForce() } })
  window.addEventListener('blur', () => { keyDown = false; syncForce() })

  // Each player's volume (0 to 100) and mute, kept on this device by SteamID64. The audio element's volume is what is set: the browser
  // does not take more than 100. A track comes and goes as the game lets the player be heard or not; the setting stays with the player.
  const volumeOf = (id: string) => { const v = store.get('vol_' + id); const n = v === null ? 100 : Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100 }
  const mutedOf = (id: string) => store.get('mute_' + id) === '1'
  const applyVolume = (id: string) => { const el = playing.get(id); if (el) el.volume = mutedOf(id) ? 0 : volumeOf(id) / 100 }

  const renderPeople = () => {
    peopleBox.textContent = ''
    if (!room) return
    for (const p of room.remoteParticipants.values()) {
      const id = p.identity
      const row = document.createElement('div'); row.className = 'person'
      const name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name || id; name.title = p.name || id
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'
      slider.value = String(volumeOf(id)); slider.setAttribute('aria-label', 'Volume of ' + (p.name || id))
      const pctOut = document.createElement('span'); pctOut.className = 'pct muted'; pctOut.textContent = slider.value + '%'
      const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'tog'; mute.textContent = 'Mute'
      mute.setAttribute('aria-pressed', String(mutedOf(id)))
      slider.addEventListener('input', () => { store.set('vol_' + id, slider.value); pctOut.textContent = slider.value + '%'; applyVolume(id) })
      mute.addEventListener('click', () => { const now = !mutedOf(id); store.set('mute_' + id, now ? '1' : '0'); mute.setAttribute('aria-pressed', String(now)); applyVolume(id) })
      row.appendChild(name); row.appendChild(slider); row.appendChild(pctOut); row.appendChild(mute)
      peopleBox.appendChild(row)
    }
  }

  const people = () => { count.textContent = String(room ? room.remoteParticipants.size + 1 : 0); renderPeople() }

  // Before the player has joined the page asks the dashboard who is on (the room cannot be read from outside it), every 5 seconds, and
  // stops when they join; it starts again when they leave. A failed look is simply tried again.
  let pollTimer = 0
  const poll = async () => {
    window.clearTimeout(pollTimer)
    if (room || !peopleUrl) return
    try {
      const res = await fetch(peopleUrl, { credentials: 'same-origin' })
      const data = res.ok ? await res.json() as { people?: { id: string, name: string }[] } : null
      if (data && Array.isArray(data.people) && !room) {
        count.textContent = String(data.people.length)
        say(who, data.people.length ? 'On now: ' + data.people.map(p => p.name).join(', ') : 'Nobody is on the voice chat.')
      }
    } catch { /* the next look tries again */ }
    if (!room) pollTimer = window.setTimeout(poll, 5000)
  }

  const leave = async () => {
    window.clearInterval(timer)
    if (gateNode) { gateNode.port.onmessage = null; gateNode = null }
    talking = false; speaking.textContent = ''
    measuring = null
    fallback.reset(); lastT = -1; tracker = new FloorTracker()
    mic?.stop(); mic = null
    rawMic?.stop(); rawMic = null; chain = null
    tap?.stop(); tap = null
    monitorBtn.setAttribute('aria-pressed', 'false')
    filters.forEach(f => { f.disabled = false })
    filterNote.textContent = ''; gateNote.textContent = ''
    speechOk = true; showCond() // not known again until the next join
    await ctx?.close().catch(() => {}); ctx = null
    const leaving = room; room = null // before the disconnect, whose event would otherwise call this again
    await leaving?.disconnect()
    audioBox.textContent = ''
    playing.clear()
    level.style.width = '0'
    level.classList.remove('open')
    dbOut.textContent = ''
    people()
    join.textContent = 'Join voice'
    say(status, 'Not connected.')
    void poll()
  }

  const enter = async () => {
    join.disabled = true
    say(status, 'Connecting…')
    ctx = new AudioContext({ sampleRate: 48000 }) // (the noise filter needs 48 kHz) here, in the click, not after the awaits below: a browser starts an audio context that is made later suspended
    try {
      const res = await fetch(root.dataset.token!, { method: 'POST', credentials: 'same-origin' })
      if (!res.ok) throw new Error(res.status === 503 ? 'Voice chat is not set up.' : res.status === 401 ? 'Sign in first.' : `The dashboard said ${res.status}.`)
      const { url, token } = await res.json() as { url: string, token: string }
      // The browser's own processing: echo cancellation, noise suppression, level control (RFC 27, 3).
      const r = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: unknown, who: { identity: string }) => { const el = track.attach(); audioBox.appendChild(el); playing.set(who.identity, el); applyVolume(who.identity) })
      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: unknown, who: { identity: string }) => { track.detach().forEach(el => el.remove()); playing.delete(who.identity) })
      r.on(RoomEvent.ParticipantConnected, people)
      r.on(RoomEvent.ParticipantDisconnected, people)
      r.on(RoomEvent.ParticipantNameChanged, people) // the dashboard puts a name right after the player has joined (RFC 28)
      r.on(RoomEvent.Reconnecting, () => { say(status, 'Reconnecting…') })
      r.on(RoomEvent.Reconnected, () => { say(status, 'Connected.') })
      r.on(RoomEvent.Disconnected, () => { if (room === r) void leave() })
      await r.connect(url, token, { autoSubscribe: false })
      room = r
      await r.startAudio().catch(() => {})
      rawMic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 })
      try {
        await ctx!.resume().catch(() => {})
        chain = await buildChain(ctx!, rawMic.mediaStreamTrack, { open: openDb, close: closeDb() })
        chain.setFilter(filterOn()); chain.setMonitor(monitorOn())
        mic = new LocalAudioTrack(chain.out, undefined, true)
        gateNode = chain.gate
        chain.onVad = (p) => gateNode?.port.postMessage({ type: 'vad', v: p })
        if (!chain.filterOk) {
          filters.forEach(f => { f.disabled = true })
          filterNote.textContent = 'The noise filter could not start; your microphone is sent without it.'
        }
      } catch (err) {
        // Both are extras: when the chain itself cannot be built the microphone goes out as it is, and the page does the gating.
        console.warn('voice: the audio chain did not start', err)
        chain = null; gateNode = null; mic = rawMic
        filters.forEach(f => { f.disabled = true })
        filterNote.textContent = 'The noise filter could not start; your microphone is sent as it is.'
      }
      speechOk = !!chain && chain.filterOk && !!gateNode // the speech check needs the filter's probability and the gate worklet to use it
      showCond()
      if (!gateNode) gateNote.textContent = 'The voice gate could not start, so the page switches your microphone on and off itself; the first part of a word may be cut.'
      // Silence suppression (DTX) is on by default in LiveKit for a mono track; it is set here so it does not depend on that.
      await r.localParticipant.publishTrack(mic, { name: 'microphone', dtx: true })
      if (gateNode) {
        // The track stays on: the gate's gain closes and opens it, and the worklet tells the page what it hears.
        gateNode.port.onmessage = (e: MessageEvent) => { const m = e.data; if (m && typeof m.level === 'number') onLevel(m.level, !!m.open, Number(m.t) || 0) }
        pushThresholds(); pushConditions(); syncForce()
      } else {
        await mic.mute() // closed until the player speaks or holds the key
        await watchFallback(mic)
      }
      window.clearTimeout(pollTimer)
      say(who, '')
      people()
      join.textContent = 'Leave voice'
      say(status, 'Connected.')
    } catch (err) {
      await leave()
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
      say(status, denied ? 'The microphone is not allowed or not found.' : `Could not connect: ${(err as Error).message}`)
    } finally {
      join.disabled = false
    }
  }

  join.addEventListener('click', () => { void (room ? leave() : enter()) })
  void poll()
  window.addEventListener('pagehide', () => { void room?.disconnect() })
}

// Last, after every top-level `const` above: the bundle runs this file from the top, and `start` uses `store` at once. Called before
// `store` was defined, it crashed with "store is undefined" and the page did nothing.
const root = document.querySelector<HTMLElement>('[data-voice]')
if (root) start(root)
