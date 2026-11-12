import { Room, RoomEvent, LocalAudioTrack, createLocalAudioTrack, type RemoteTrack } from 'livekit-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'

// The voice page's code (RFC 27). It joins the server's room with a token from the dashboard, publishes the microphone, and plays
// what the media server sends it. It subscribes to nothing itself (autoSubscribe off): the dashboard decides, from the round, who
// each player hears, so nothing here knows who is alive. The microphone opens by the player's voice (default) or by a held key.

const store = {
  get(k: string): string | null { try { return localStorage.getItem('td_voice_' + k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem('td_voice_' + k, v) } catch { /* private window: the choice is not kept */ } },
}

interface Chain { out: MediaStreamTrack, setFilter(on: boolean): void, setMonitor(on: boolean): void }

// The microphone through the noise filter (RNNoise, in the browser; its files are copied to /public/rnnoise by the build). `dry` and
// `wet` are two ways to the same output and the player's choice opens one of them; the filter runs either way, so switching is at once.
// `monitor` plays the output to the player, to judge the filter on their own (one account cannot join twice). The filter needs 48 kHz.
async function buildChain(c: AudioContext, raw: MediaStreamTrack): Promise<Chain> {
  const src = c.createMediaStreamSource(new MediaStream([raw]))
  const dest = c.createMediaStreamDestination()
  const dry = c.createGain(), wet = c.createGain(), monitor = c.createGain()
  monitor.gain.value = 0
  const wasmBinary = await loadRnnoise({ url: '/public/rnnoise/rnnoise.wasm', simdUrl: '/public/rnnoise/rnnoise_simd.wasm' })
  await c.audioWorklet.addModule('/public/rnnoise/worklet.js')
  const filter = new RnnoiseWorkletNode(c, { maxChannels: 2, wasmBinary })
  src.connect(dry); dry.connect(dest); dry.connect(monitor)
  src.connect(filter); filter.connect(wet); wet.connect(dest); wet.connect(monitor)
  monitor.connect(c.destination)
  return {
    out: dest.stream.getAudioTracks()[0]!,
    setFilter(on) { wet.gain.value = on ? 1 : 0; dry.gain.value = on ? 0 : 1 },
    setMonitor(on) { monitor.gain.value = on ? 1 : 0 },
  }
}

function start(root: HTMLElement) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const join = $<HTMLButtonElement>('[data-join]')
  const status = $('[data-status]')
  const level = $<HTMLElement>('[data-level]')
  const marker = $<HTMLElement>('[data-marker]')
  const speaking = $('[data-speaking]')
  const threshold = $<HTMLInputElement>('[data-threshold]')
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
  let rawMic: LocalAudioTrack | null = null // what the microphone gives; `mic` is what is sent (the same, or the filtered output)
  let chain: Chain | null = null
  const playing = new Map<string, HTMLMediaElement>() // the audio of each player who is being heard, by SteamID64
  let timer = 0
  let open = false
  let heldUntil = 0
  let keyDown = false

  const mode = () => (modes.find(m => m.getAttribute('aria-pressed') === 'true')?.dataset.mode === 'ptt' ? 'ptt' : 'vad')
  const pick = (which: string) => modes.forEach(m => m.setAttribute('aria-pressed', String(m.dataset.mode === which)))
  const filterOn = () => filters.find(f => f.getAttribute('aria-pressed') === 'true')?.dataset.filter !== 'off'
  const pickFilter = (which: string) => filters.forEach(f => f.setAttribute('aria-pressed', String(f.dataset.filter === which)))
  const monitorOn = () => monitorBtn.getAttribute('aria-pressed') === 'true'
  const showMarker = () => { marker.style.left = threshold.value + '%' }
  const showMode = () => { vadBox.style.display = mode() === 'vad' ? '' : 'none'; pttBox.style.display = mode() === 'ptt' ? '' : 'none' }

  // What was chosen last time.
  const savedMode = store.get('mode'); if (savedMode === 'ptt' && !modes.find(m => m.dataset.mode === 'ptt')?.disabled) pick('ptt') // the button is off for now: a saved choice of it is ignored
  const savedThr = store.get('threshold'); if (savedThr && /^\d+$/.test(savedThr)) threshold.value = savedThr
  const savedKey = store.get('key'); if (savedKey && savedKey.length === 1) pttKey.value = savedKey
  if (store.get('filter') === 'off') pickFilter('off')
  showMode(); showMarker()
  filters.forEach(f => f.addEventListener('click', () => { pickFilter(f.dataset.filter!); store.set('filter', filterOn() ? 'on' : 'off'); chain?.setFilter(filterOn()) }))
  monitorBtn.addEventListener('click', () => { monitorBtn.setAttribute('aria-pressed', String(!monitorOn())); chain?.setMonitor(monitorOn()) }) // not remembered: it starts off at every join
  modes.forEach(m => m.addEventListener('click', () => { pick(m.dataset.mode!); store.set('mode', mode()); showMode() }))
  threshold.addEventListener('input', () => { store.set('threshold', threshold.value); showMarker() })
  pttKey.addEventListener('input', () => { pttKey.value = pttKey.value.slice(-1).toLowerCase(); store.set('key', pttKey.value) })

  const setOpen = (want: boolean) => {
    if (want === open || !mic) return
    open = want
    void (want ? mic.unmute() : mic.mute())
    speaking.textContent = want ? 'talking' : ''
  }

  // The microphone's level, 0 to 100, from the time-domain signal (the root mean square, stretched so ordinary speech reaches the middle).
  const watch = async (track: LocalAudioTrack) => {
    const c = ctx! // made by the click that started the join, so the browser lets it run; it may still be asked to resume
    await c.resume().catch(() => {})
    // LiveKit's mute() switches the published track off (enabled = false). The meter, and the voice detection that opens the
    // microphone, must listen to a copy that stays on: on the track itself they heard silence for ever and the microphone never opened.
    tap = track.mediaStreamTrack.clone()
    tap.enabled = true
    const analyser = c.createAnalyser()
    analyser.fftSize = 1024
    c.createMediaStreamSource(new MediaStream([tap])).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const lvl = Math.min(100, Math.sqrt(sum / buf.length) * 400)
      level.style.width = lvl + '%'
      level.classList.toggle('open', open)
      const now = Date.now()
      if (mode() === 'vad') {
        if (lvl > Number(threshold.value)) heldUntil = now + 400 // a short tail, so the ends of words are not cut
        setOpen(now < heldUntil)
      } else {
        setOpen(keyDown)
      }
    }, 50)
  }

  const keyOf = (e: KeyboardEvent) => e.key.length === 1 ? e.key.toLowerCase() : ''
  const typing = (e: Event) => e.target === pttKey
  window.addEventListener('keydown', (e) => { if (!typing(e) && mode() === 'ptt' && keyOf(e) === pttKey.value) keyDown = true })
  window.addEventListener('keyup', (e) => { if (keyOf(e) === pttKey.value) keyDown = false })
  window.addEventListener('blur', () => { keyDown = false })

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
      const name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name || id
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'
      slider.value = String(volumeOf(id)); slider.setAttribute('aria-label', 'Volume of ' + (p.name || id))
      const pct = document.createElement('span'); pct.className = 'pct muted'; pct.textContent = slider.value + '%'
      const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'tog'; mute.textContent = 'Mute'
      mute.setAttribute('aria-pressed', String(mutedOf(id)))
      slider.addEventListener('input', () => { store.set('vol_' + id, slider.value); pct.textContent = slider.value + '%'; applyVolume(id) })
      mute.addEventListener('click', () => { const now = !mutedOf(id); store.set('mute_' + id, now ? '1' : '0'); mute.setAttribute('aria-pressed', String(now)); applyVolume(id) })
      row.appendChild(name); row.appendChild(slider); row.appendChild(pct); row.appendChild(mute)
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
        who.textContent = data.people.length ? 'On now: ' + data.people.map(p => p.name).join(', ') : 'Nobody is on the voice chat.'
      }
    } catch { /* the next look tries again */ }
    if (!room) pollTimer = window.setTimeout(poll, 5000)
  }

  const leave = async () => {
    window.clearInterval(timer)
    setOpen(false)
    mic?.stop(); mic = null
    rawMic?.stop(); rawMic = null; chain = null
    tap?.stop(); tap = null
    monitorBtn.setAttribute('aria-pressed', 'false')
    filters.forEach(f => { f.disabled = false })
    filterNote.textContent = ''
    await ctx?.close().catch(() => {}); ctx = null
    const leaving = room; room = null // before the disconnect, whose event would otherwise call this again
    await leaving?.disconnect()
    audioBox.textContent = ''
    playing.clear()
    level.style.width = '0'
    level.classList.remove('open')
    people()
    join.textContent = 'Join voice'
    status.textContent = 'Not connected.'
    void poll()
  }

  const enter = async () => {
    join.disabled = true
    status.textContent = 'Connecting…'
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
      r.on(RoomEvent.Reconnecting, () => { status.textContent = 'Reconnecting…' })
      r.on(RoomEvent.Reconnected, () => { status.textContent = 'Connected.' })
      r.on(RoomEvent.Disconnected, () => { if (room === r) void leave() })
      await r.connect(url, token, { autoSubscribe: false })
      room = r
      await r.startAudio().catch(() => {})
      rawMic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 })
      try {
        await ctx!.resume().catch(() => {})
        chain = await buildChain(ctx!, rawMic.mediaStreamTrack)
        chain.setFilter(filterOn()); chain.setMonitor(monitorOn())
        mic = new LocalAudioTrack(chain.out, undefined, true)
      } catch (err) {
        // The filter is an extra: when it cannot start (the files, WebAssembly, the sample rate) the microphone goes out as it is.
        console.warn('voice: the noise filter did not start', err)
        chain = null; mic = rawMic
        filters.forEach(f => { f.disabled = true })
        filterNote.textContent = 'The noise filter could not start; your microphone is sent as it is.'
      }
      await r.localParticipant.publishTrack(mic, { name: 'microphone' })
      await mic.mute() // closed until the player speaks or holds the key
      await watch(mic)
      window.clearTimeout(pollTimer)
      who.textContent = ''
      people()
      join.textContent = 'Leave voice'
      status.textContent = 'Connected.'
    } catch (err) {
      await leave()
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
      status.textContent = denied ? 'The microphone is not allowed or not found.' : `Could not connect: ${(err as Error).message}`
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
