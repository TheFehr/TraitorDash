import { Room, RoomEvent, createLocalAudioTrack, type LocalAudioTrack, type RemoteTrack } from 'livekit-client'

// The voice page's code (RFC 27). It joins the server's room with a token from the dashboard, publishes the microphone, and plays
// what the media server sends it. It subscribes to nothing itself (autoSubscribe off): the dashboard decides, from the round, who
// each player hears, so nothing here knows who is alive. The microphone opens by the player's voice (default) or by a held key.

const store = {
  get(k: string): string | null { try { return localStorage.getItem('td_voice_' + k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem('td_voice_' + k, v) } catch { /* private window: the choice is not kept */ } },
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

  let room: Room | null = null
  let mic: LocalAudioTrack | null = null
  let ctx: AudioContext | null = null
  let timer = 0
  let open = false
  let heldUntil = 0
  let keyDown = false

  const mode = () => (modes.find(m => m.getAttribute('aria-pressed') === 'true')?.dataset.mode === 'ptt' ? 'ptt' : 'vad')
  const pick = (which: string) => modes.forEach(m => m.setAttribute('aria-pressed', String(m.dataset.mode === which)))
  const showMarker = () => { marker.style.left = threshold.value + '%' }
  const showMode = () => { vadBox.style.display = mode() === 'vad' ? '' : 'none'; pttBox.style.display = mode() === 'ptt' ? '' : 'none' }

  // What was chosen last time.
  const savedMode = store.get('mode'); if (savedMode === 'ptt' && !modes.find(m => m.dataset.mode === 'ptt')?.disabled) pick('ptt') // the button is off for now: a saved choice of it is ignored
  const savedThr = store.get('threshold'); if (savedThr && /^\d+$/.test(savedThr)) threshold.value = savedThr
  const savedKey = store.get('key'); if (savedKey && savedKey.length === 1) pttKey.value = savedKey
  showMode(); showMarker()
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
  const watch = (track: LocalAudioTrack) => {
    ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser)
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

  const people = () => { count.textContent = String(room ? room.remoteParticipants.size + 1 : 0) }

  const leave = async () => {
    window.clearInterval(timer)
    setOpen(false)
    mic?.stop(); mic = null
    await ctx?.close().catch(() => {}); ctx = null
    const leaving = room; room = null // before the disconnect, whose event would otherwise call this again
    await leaving?.disconnect()
    audioBox.textContent = ''
    level.style.width = '0'
    level.classList.remove('open')
    people()
    join.textContent = 'Join voice'
    status.textContent = 'Not connected.'
  }

  const enter = async () => {
    join.disabled = true
    status.textContent = 'Connecting…'
    try {
      const res = await fetch(root.dataset.token!, { method: 'POST', credentials: 'same-origin' })
      if (!res.ok) throw new Error(res.status === 503 ? 'Voice chat is not set up.' : res.status === 401 ? 'Sign in first.' : `The dashboard said ${res.status}.`)
      const { url, token } = await res.json() as { url: string, token: string }
      // The browser's own processing: echo cancellation, noise suppression, level control (RFC 27, 3).
      const r = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { audioBox.appendChild(track.attach()) })
      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach().forEach(el => el.remove()) })
      r.on(RoomEvent.ParticipantConnected, people)
      r.on(RoomEvent.ParticipantDisconnected, people)
      r.on(RoomEvent.Reconnecting, () => { status.textContent = 'Reconnecting…' })
      r.on(RoomEvent.Reconnected, () => { status.textContent = 'Connected.' })
      r.on(RoomEvent.Disconnected, () => { if (room === r) void leave() })
      await r.connect(url, token, { autoSubscribe: false })
      room = r
      await r.startAudio().catch(() => {})
      mic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
      await r.localParticipant.publishTrack(mic, { name: 'microphone' })
      await mic.mute() // closed until the player speaks or holds the key
      watch(mic)
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
  window.addEventListener('pagehide', () => { void room?.disconnect() })
}

// Last, after every top-level `const` above: the bundle runs this file from the top, and `start` uses `store` at once. Called before
// `store` was defined, it crashed with "store is undefined" and the page did nothing.
const root = document.querySelector<HTMLElement>('[data-voice]')
if (root) start(root)
