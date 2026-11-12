import { expect, test, describe } from 'bun:test'
import { GATE, GateState, SpeechDetector, GainRamp, LevelMeter, GateEngine, FloorTracker, calibrate, thresholdsFromFloor, percentile, clampDb, toDb } from '../src/gate'

// RFC 29: the voice gate's pure core, and the worklet built from it. Synthetic levels for the state machine, synthetic sound for the
// engine; the real worklet file is bundled and its process() run on blocks, as the browser would.

const SR = 48000
const BLOCK = 128

/** `ms` of a sine of the given dBFS (rms) at `hz`, starting at the given phase (pi/2: starts at its peak, an abrupt start). */
function tone(ms: number, dbfs: number, hz = 200, phase = Math.PI / 2, from = 0): Float32Array {
  const n = Math.round(SR * ms / 1000), a = Math.SQRT2 * Math.pow(10, dbfs / 20)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * hz * (i + from) / SR + phase)
  return x
}
const silence = (ms: number) => new Float32Array(Math.round(SR * ms / 1000))
const peak = (x: ArrayLike<number>) => { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!)); return m }
const concat = (...parts: Float32Array[]) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { o.set(p, at); at += p.length } return o }

/** The whole input through an engine, in blocks of 128, as the audio thread does. Also returns the open state after each block. */
function run(engine: GateEngine, input: Float32Array) {
  const out = new Float32Array(input.length)
  const open: boolean[] = []
  for (let i = 0; i < input.length; i += BLOCK) {
    const inp = input.subarray(i, Math.min(input.length, i + BLOCK))
    const o = new Float32Array(inp.length)
    engine.process([inp], [o])
    out.set(o, i)
    open.push(engine.open)
  }
  return { out, open }
}

describe('toDb and the level meter', () => {
  test('dBFS: full scale is 0, half the amplitude is -6, digital silence stops at the floor', () => {
    expect(toDb(1)).toBeCloseTo(0, 6)
    expect(toDb(0.25)).toBeCloseTo(-6.02, 2)
    expect(toDb(0)).toBe(GATE.silenceDb)
    expect(toDb(1e-14)).toBe(GATE.silenceDb)
  })

  test('a window of 10 ms gives the level of a sine at its rms, and the envelope rises at once and falls slowly', () => {
    const m = new LevelMeter(SR)
    const loud = tone(30, -30)
    let done = 0
    for (const x of loud) if (m.add(x * x)) done++
    expect(done).toBe(3) // 480 samples a window
    expect(m.env).toBeCloseTo(-30, 0)
    const before = m.env
    for (const x of silence(10)) m.add(x * x) // one silent window
    expect(m.window).toBe(GATE.silenceDb)
    expect(m.env).toBeCloseTo(before - GATE.releaseDbPerS * 0.01, 6) // fell by the release step only, not to the floor
    for (const x of silence(2000)) m.add(x * x)
    expect(m.env).toBe(GATE.silenceDb)
  })
})

describe('the state machine', () => {
  const step = (g: GateState, levels: number[], dt = 10) => levels.map(l => g.step(l, dt))

  test('stays closed below the open threshold, opens at it', () => {
    const g = new GateState(-50, -56)
    expect(step(g, [-80, -60, -51, -50.5])).toEqual([false, false, false, false])
    expect(g.step(-50, 10)).toBe(true)
  })

  test('between the two thresholds: a closed gate stays closed, an open gate stays open (hysteresis)', () => {
    const g = new GateState(-50, -56)
    expect(step(g, [-53, -52, -54, -53])).toEqual([false, false, false, false]) // not open: -53 is not enough
    g.step(-40, 10)
    expect(g.open).toBe(true)
    // far longer than the hold, at a level between the two: still open
    const held = step(g, Array(100).fill(-53))
    expect(held.every(Boolean)).toBe(true)
  })

  test('closes only after the hold, and only while below the close threshold', () => {
    const g = new GateState(-50, -56, 250)
    g.step(-30, 10)
    // 240 ms below the close threshold: still open (hold is 250)
    for (let i = 0; i < 24; i++) expect(g.step(-70, 10)).toBe(true)
    expect(g.step(-70, 10)).toBe(false) // 250 ms: closed
  })

  test('a level back above the close threshold restarts the hold', () => {
    const g = new GateState(-50, -56, 250)
    g.step(-30, 10)
    for (let i = 0; i < 20; i++) g.step(-70, 10) // 200 ms of quiet
    g.step(-54, 10) // between: restarts the hold
    for (let i = 0; i < 24; i++) expect(g.step(-70, 10)).toBe(true)
    expect(g.step(-70, 10)).toBe(false)
  })

  test('no chatter at the edge: a level that wobbles around the open threshold opens once and stays open', () => {
    const g = new GateState(-50, -56, 250)
    let changes = 0, last = false
    for (let i = 0; i < 2000; i++) {
      const l = -50 + (i % 2 ? 1.5 : -1.5) // -48.5, -51.5, ...
      const o = g.step(l, 10)
      if (o !== last) { changes++; last = o }
    }
    expect(changes).toBe(1)
    // and one that wobbles around the close threshold, once open, does not close
    const h = new GateState(-50, -56, 250)
    h.step(-40, 10)
    let closes = 0
    for (let i = 0; i < 2000; i++) if (!h.step(i % 2 ? -54.5 : -57.5, 10)) closes++ // above close half the time: the hold never runs out
    expect(closes).toBe(0)
  })

  test('the close threshold can never be above the open one', () => {
    const g = new GateState(-50, -40)
    expect(g.closeDb).toBe(-50)
    g.set(-60, -30)
    expect(g.closeDb).toBe(-60)
  })
})

describe('the ramp', () => {
  test('opens in about 3 ms and closes in about 80 ms, and never steps', () => {
    const r = new GainRamp(SR)
    let n = 0, prev = 0, worst = 0
    while (r.gain < 1) { const g = r.next(1); worst = Math.max(worst, g - prev); prev = g; n++ }
    expect(Math.abs(n - 0.003 * SR)).toBeLessThanOrEqual(1)
    expect(worst).toBeLessThanOrEqual(1 / (0.003 * SR) + 1e-9)
    let m = 0
    while (r.gain > 0) { const g = r.next(0); worst = Math.max(worst, prev - g); prev = g; m++ }
    expect(Math.abs(m - 0.08 * SR)).toBeLessThanOrEqual(1)
    expect(r.gain).toBe(0)
  })

  test('turning round half way continues from where it is', () => {
    const r = new GainRamp(SR)
    for (let i = 0; i < 70; i++) r.next(1)
    const at = r.gain
    expect(at).toBeGreaterThan(0.4); expect(at).toBeLessThan(0.6)
    expect(r.next(0)).toBeLessThan(at)
    expect(at - r.gain).toBeLessThan(0.001) // a small step down, not a jump
  })
})

describe('the engine on synthetic sound', () => {
  const D = Math.round(SR * GATE.lookaheadMs / 1000)

  test('silence stays closed, and what comes out is silent', () => {
    const e = new GateEngine(SR)
    const { out, open } = run(e, concat(tone(500, -75), silence(200)))
    expect(open.every(o => !o)).toBe(true)
    expect(peak(out)).toBe(0)
  })

  test('the first syllable is passed: the gate is open before the first loud sample comes out of the delay', () => {
    // the speech starts at every kind of place relative to the 10 ms windows, and at a level not far above the threshold
    for (const lead of [500, 503, 507.3, 509.9, 512.5, 517]) {
      const e = new GateEngine(SR)
      const onset = Math.round(SR * lead / 1000)
      const { out } = run(e, concat(silence(lead), tone(400, -40)))
      const a = Math.SQRT2 * Math.pow(10, -40 / 20)
      // the first speech sample comes out D samples later, at full strength (the phase starts at the peak)
      expect(out[onset + D]!, `lead ${lead}`).toBeGreaterThan(0.98 * a)
      // and everything from there on is passed whole
      for (let i = onset + D; i < onset + D + 2000; i++) expect(Math.abs(out[i]!)).toBeLessThanOrEqual(a * 1.0001 + 1e-9)
    }
  })

  test('the delay is exactly the look-ahead, and the passed speech is the speech, not a copy of it', () => {
    const e = new GateEngine(SR)
    const x = concat(silence(300), tone(600, -30, 440, 0.7))
    const { out } = run(e, x)
    const from = Math.round(SR * 0.4) // well inside the speech, long after the ramp
    for (let i = from; i < from + 4000; i++) expect(out[i + D]).toBeCloseTo(x[i]!, 6)
  })

  test('the gain follows a ramp: no step in the output at the opening, at the closing, or anywhere', () => {
    const e = new GateEngine(SR)
    const hz = 200, a = Math.SQRT2 * Math.pow(10, -25 / 20)
    // speech, a pause with nothing, speech again (the sine is continuous inside each burst, abrupt at their edges)
    const { out } = run(e, concat(silence(300), tone(500, -25, hz, 0), silence(600), tone(300, -25, hz, 0)))
    const natural = a * 2 * Math.PI * hz / SR // the largest step a pure sine makes by itself
    let worst = 0
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!))
    // plus what the ramp adds: the amplitude times the gain's step (the opening is the steeper one)
    expect(worst).toBeLessThan(natural + a / (0.003 * SR) + 1e-6)
    expect(worst).toBeLessThan(a / 10) // far below a hard step (which is the whole amplitude)
  })

  test('closes after the speech: the hold and the envelope run out, then the output is silent', () => {
    const e = new GateEngine(SR)
    const { out, open } = run(e, concat(silence(100), tone(500, -25), silence(1500)))
    expect(open[Math.round(SR * 0.4 / BLOCK)]).toBe(true) // open in the middle of the speech
    expect(open.at(-1)).toBe(false)
    // nothing audible in the last 300 ms
    expect(peak(out.subarray(out.length - Math.round(SR * 0.3)))).toBe(0)
    // and the gate did not close while there was still speech
    const a = Math.SQRT2 * Math.pow(10, -25 / 20)
    for (let i = Math.round(SR * 0.15); i < Math.round(SR * 0.6) - 240; i += 240) expect(peak(out.subarray(i + D, i + D + 240))).toBeGreaterThan(0.95 * a)
  })

  test('a level between the two thresholds does not open a closed gate, and does not close an open one', () => {
    const e = new GateEngine(SR, -50, -56)
    const mid = run(e, tone(1000, -53)) // between the two: never opens
    expect(mid.open.every(o => !o)).toBe(true)
    const f = new GateEngine(SR, -50, -56)
    const r = run(f, concat(tone(200, -30), tone(1500, -53))) // opens, then stays at the in-between level
    expect(r.open.at(-1)).toBe(true)
  })

  test('the thresholds can be changed while it runs', () => {
    const e = new GateEngine(SR, -50, -56)
    expect(run(e, tone(300, -40)).open.at(-1)).toBe(true)
    run(e, silence(1500))
    expect(e.open).toBe(false)
    e.setThresholds(-30, -36) // a less sensitive gate: -40 does not open it
    expect(run(e, tone(300, -40)).open.at(-1)).toBe(false)
  })

  test('forced open or closed (push to talk): the gate is not used, and the ramp still applies', () => {
    const e = new GateEngine(SR)
    e.force = true
    const { out, open } = run(e, concat(silence(200), tone(300, -60)))
    expect(open.every(Boolean)).toBe(true)
    expect(Math.abs(out[Math.round(SR * 0.4)]!)).toBeGreaterThan(0) // -60 dBFS would never have opened it
    e.force = false
    expect(run(e, tone(300, -20)).open.every(o => !o)).toBe(true)
  })

  test('two channels and no input channel are handled', () => {
    const e = new GateEngine(SR)
    const a = tone(300, -30), b = tone(300, -30, 300)
    const oa = new Float32Array(a.length), ob = new Float32Array(a.length)
    for (let i = 0; i < a.length; i += BLOCK) e.process([a.subarray(i, i + BLOCK), b.subarray(i, i + BLOCK)], [oa.subarray(i, i + BLOCK), ob.subarray(i, i + BLOCK)])
    expect(e.open).toBe(true)
    expect(peak(oa)).toBeGreaterThan(0.01)
    expect(peak(ob)).toBeGreaterThan(0.01)
    const o = new Float32Array(BLOCK).fill(1)
    e.process([], [o]) // nothing connected
    expect(peak(o)).toBe(0)
  })
})

describe('the room measurement', () => {
  test('the percentile: the ends, the middle, and between two values', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1)
    expect(percentile([5, 1, 3], 100)).toBe(5)
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([0, 10], 90)).toBeCloseTo(9, 9)
    expect(percentile([], 90)).toBeNaN()
  })

  const around = (mid: number, n = 60, wobble = 2) => Array.from({ length: n }, (_, i) => mid + wobble * Math.sin(i * 1.7))

  test('floor = the 90th percentile; open = floor + 10 dB, close = floor + 6 dB', () => {
    const levels = [...Array(95).fill(-62), ...Array(5).fill(-60)] // the 90th percentile is -62 (a twentieth is higher)
    const r = calibrate(levels)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.floor).toBeCloseTo(-62, 6)
    expect(r.open).toBeCloseTo(-52, 6); expect(r.close).toBeCloseTo(-56, 6)
    expect(r.clamped).toBe(false)
    // a few bangs (under a tenth) do not raise the floor
    const b = calibrate([...Array(95).fill(-62), ...Array(5).fill(-15)])
    expect(b.ok && b.floor).toBeCloseTo(-62, 6)
  })

  test('a steady room gives the same answer whatever the little wobble', () => {
    const r = calibrate(around(-55))
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.floor).toBeGreaterThan(-55); expect(r.floor).toBeLessThan(-52.5); expect(r.open - r.floor).toBeCloseTo(10, 6); expect(r.floor + 6).toBeCloseTo(r.close, 6) }
  })

  test('refuses a noisy measurement: speech, or a bang, during it', () => {
    const speech = [...around(-60, 30), ...around(-30, 30, 8)] // half the time speech
    const r = calibrate(speech)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('noisy')
    // syllables: the level jumps up and down by 25 dB
    expect(calibrate(Array.from({ length: 60 }, (_, i) => (i % 6 < 3 ? -60 : -35))).ok).toBe(false)
    // too little data
    const few = calibrate([-60, -61])
    expect(few.ok).toBe(false)
    if (!few.ok) expect(few.reason).toBe('few')
    // nothing usable
    expect(calibrate([NaN, NaN, ...Array(30).fill(NaN)]).ok).toBe(false)
  })

  test('is kept inside the slider range: a very quiet room, and a very loud one', () => {
    // The owner's room measured -93 dBFS after the noise filter: floor + 10 is below the range. Both thresholds used to be cut to the lowest
    // value (open = close = -70, no gap, the gate would flutter); now the open one rises just enough to leave room for the close one.
    const quiet = calibrate(Array(60).fill(-93))
    expect(quiet.ok && quiet.open).toBe(GATE.minDb + GATE.minGapDb)
    expect(quiet.ok && quiet.close).toBe(GATE.minDb) // the lowest the slider goes, and below open by the least gap
    expect(quiet.ok && quiet.clamped).toBe(true)
    const loud = calibrate(Array(60).fill(-22))
    expect(loud.ok && loud.open).toBe(GATE.maxDb)
    expect(loud.ok && loud.close).toBe(GATE.maxDb - GATE.minGapDb) // not equal to open: a gap at the loud end too
    expect(loud.ok && loud.clamped).toBe(true)
    // a room at digital silence swinging between -100 and -85 is quiet, not noisy
    expect(calibrate(Array.from({ length: 60 }, (_, i) => (i % 2 ? -100 : -85))).ok).toBe(true)
  })

  test('the two thresholds are always inside the range and at least the least gap apart, for every floor, in calibration and in automatic mode', () => {
    for (let floor = -120; floor <= 10; floor += 0.5) {
      const t = thresholdsFromFloor(floor)
      expect(t.open, `open at floor ${floor}`).toBeGreaterThanOrEqual(GATE.minDb + GATE.minGapDb)
      expect(t.open).toBeLessThanOrEqual(GATE.maxDb)
      expect(t.close, `close at floor ${floor}`).toBeGreaterThanOrEqual(GATE.minDb)
      expect(t.open - t.close, `gap at floor ${floor}`).toBeGreaterThanOrEqual(GATE.minGapDb)
    }
    // in the middle of the range the numbers are the RFC's: open floor + 10, close floor + 6
    expect(thresholdsFromFloor(-55)).toEqual({ open: -45, close: -49, clamped: false })
    // the floor tracker (automatic mode) gives the same
    const tracker = new FloorTracker(); tracker.seed(-93)
    expect(tracker.thresholds()).toEqual({ open: GATE.minDb + GATE.minGapDb, close: GATE.minDb })
  })

  test('clampDb keeps a value inside the range', () => {
    expect(clampDb(-90)).toBe(-70); expect(clampDb(0)).toBe(-20); expect(clampDb(-45)).toBe(-45)
    expect(clampDb(-40, -70, -50)).toBe(-50)
  })
})

describe('the floor tracker (automatic mode)', () => {
  const feed = (t: FloorTracker, level: number, ms: number, open = false, dt = 50) => { for (let i = 0; i < ms / dt; i++) t.feed(level, dt, open) }

  test('has no floor before the first half second, then the room\'s level', () => {
    const t = new FloorTracker()
    feed(t, -60, 400)
    expect(t.floor).toBeNull(); expect(t.thresholds()).toBeNull()
    feed(t, -60, 200)
    expect(t.floor).toBeCloseTo(-60, 6)
    expect(t.thresholds()).toEqual({ open: -50, close: -54 })
  })

  test('follows the room down quickly', () => {
    const t = new FloorTracker()
    feed(t, -50, 6000)
    expect(t.floor).toBeCloseTo(-50, 6)
    feed(t, -65, 2000)
    expect(t.floor).toBeCloseTo(-65, 6)
  })

  test('follows the room up slowly: not for the first 5 seconds, then at 2 dB a second', () => {
    const t = new FloorTracker()
    feed(t, -60, 6000)
    feed(t, -40, 4000) // the minimum over 5 s is still -60 for most of this
    expect(t.floor!).toBeLessThan(-57)
    feed(t, -40, 4000)
    expect(t.floor!).toBeGreaterThan(-58)
    expect(t.floor!).toBeLessThan(-40) // 2 dB a second: still on its way
    feed(t, -40, 12000)
    expect(t.floor).toBeCloseTo(-40, 6)
  })

  test('does nothing while the gate is open', () => {
    const t = new FloorTracker()
    feed(t, -60, 6000)
    const before = t.floor
    feed(t, -20, 20000, true) // speech
    expect(t.floor).toBe(before)
    feed(t, -90, 20000, true) // even a deep dip, while open, is not taken
    expect(t.floor).toBe(before)
    // speech's loud tail while closed would raise it only slowly: not tested here, the gate is the guard
  })

  test('a short dip in the level lowers the floor only as far as the dip, and a bang raises nothing', () => {
    const t = new FloorTracker()
    feed(t, -60, 6000)
    t.feed(-30, 50, false) // one loud reading (a click): the minimum ignores it
    feed(t, -60, 2000)
    expect(t.floor).toBeCloseTo(-60, 6)
  })

  test('is seeded by a measurement, and the thresholds are kept inside the range', () => {
    const t = new FloorTracker()
    t.seed(-85) // floor + 10 is below the range: open rises just enough to leave the least gap above close
    expect(t.thresholds()).toEqual({ open: GATE.minDb + GATE.minGapDb, close: GATE.minDb })
    t.seed(-25)
    expect(t.thresholds()).toEqual({ open: -20, close: -20 - GATE.minGapDb })
  })
})

describe('the real worklet file', () => {
  /** The worklet's file bundled as the build does it, and run with the globals an AudioWorkletGlobalScope has. */
  async function load(rate = SR) {
    const built = await Bun.build({ entrypoints: [new URL('../src/gate-worklet.ts', import.meta.url).pathname], format: 'iife' })
    expect(built.success).toBe(true)
    const code = await built.outputs[0]!.text()
    expect(code).not.toMatch(/\bimport\s*[({"']/) // a worklet module cannot import anything
    const posted: any[] = []
    let ctor: any = null
    class FakeProcessor { port = { postMessage: (m: unknown) => { posted.push(m) }, onmessage: null as null | ((e: { data: unknown }) => void) }; constructor(public options?: unknown) {} }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', code)(FakeProcessor, (name: string, c: unknown) => { ctor = { name, c } }, rate)
    expect(ctor.name).toBe('td-gate')
    return { make: (processorOptions?: unknown) => new ctor.c({ processorOptions }), posted }
  }

  /** Runs the processor's process() over the sound in blocks of 128 and gathers its output. */
  function through(node: any, input: Float32Array) {
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i += BLOCK) {
      const inp = new Float32Array(BLOCK); inp.set(input.subarray(i, i + BLOCK))
      const o = new Float32Array(BLOCK)
      expect(node.process([[inp]], [[o]])).toBe(true)
      out.set(o.subarray(0, Math.min(BLOCK, input.length - i)), i)
    }
    return out
  }

  test('registers as td-gate, loads without imports, and passes the first syllable whole with no step in the output', async () => {
    const w = await load()
    const node = w.make()
    const a = Math.SQRT2 * Math.pow(10, -30 / 20)
    const lead = 500
    const onset = Math.round(SR * lead / 1000)
    const x = concat(silence(lead), tone(500, -30, 200), silence(1200))
    const out = through(node, x)
    // the same sound starting smoothly (phase 0): the output has no step anywhere, as the gain is ramped
    const smooth = through(w.make(), concat(silence(lead), tone(500, -30, 200, 0), silence(1200)))
    let steps = 0
    for (let i = 1; i < smooth.length; i++) steps = Math.max(steps, Math.abs(smooth[i]! - smooth[i - 1]!))
    expect(steps).toBeLessThan(a * 2 * Math.PI * 200 / SR + a / (0.003 * SR) + 1e-6)
    const D = Math.round(SR * 0.025)
    expect(out[onset + D]!).toBeGreaterThan(0.98 * a) // the very first sample of speech, at full strength
    expect(peak(out.subarray(0, onset + D - 1))).toBe(0) // nothing before it
    expect(peak(out.subarray(out.length - 4000))).toBe(0) // nothing after it, once closed
  })

  test('posts the level and the open state about 20 times a second, and at once when the state changes', async () => {
    const w = await load()
    const node = w.make()
    through(node, silence(2000))
    const quiet = w.posted.length
    expect(quiet).toBeGreaterThanOrEqual(38); expect(quiet).toBeLessThanOrEqual(42) // 20 a second for 2 seconds
    expect(w.posted.every(m => m.open === false && m.level <= -90)).toBe(true)
    w.posted.length = 0
    through(node, tone(100, -30))
    const first = w.posted.find(m => m.open === true)
    expect(first).toBeTruthy()
    expect(first.level).toBeGreaterThan(-35); expect(first.level).toBeLessThan(-25) // the level before the gate, in dBFS
    expect(w.posted.map(m => m.t)).toEqual([...w.posted.map(m => m.t)].sort((a, b) => a - b)) // time only goes forward
  })

  test('takes thresholds from the page, from the options and from messages, and a force message', async () => {
    const w = await load()
    const node = w.make({ open: -30, close: -36 })
    through(node, tone(300, -40)) // not above -30
    expect(w.posted.some(m => m.open)).toBe(false)
    node.port.onmessage({ data: { type: 'set', open: -50, close: -56 } })
    w.posted.length = 0
    through(node, tone(300, -40))
    expect(w.posted.some(m => m.open)).toBe(true)
    through(node, silence(2000))
    node.port.onmessage({ data: { type: 'force', open: true } })
    w.posted.length = 0
    through(node, silence(200))
    expect(w.posted.at(-1).open).toBe(true)
    node.port.onmessage({ data: { type: 'force', open: null } })
    node.port.onmessage({ data: { type: 'set', open: NaN, close: 3 } }) // nonsense is ignored
    through(node, silence(2000))
    expect(w.posted.at(-1).open).toBe(false)
  })

  test('takes the probabilities and the conditions from the page: the same burst opens by loudness, stays closed with a low probability in "both", and opens in speech only below the threshold', async () => {
    const MSGB = 4 * BLOCK
    /** The sound through the worklet's process(), a { type: 'vad', v } message before every fourth block; returns whether it was ever open. */
    const opened = async (conds: { loud: boolean, speech: boolean } | null, db: number, vad: (ms: number) => number | undefined) => {
      const w = await load()
      const node = w.make()
      if (conds) node.port.onmessage({ data: { type: 'conditions', ...conds } })
      const x = concat(silence(300), tone(600, db), silence(1000))
      for (let i = 0; i < x.length; i += BLOCK) {
        if (i % MSGB === 0) { const v = vad(i * 1000 / SR); if (v !== undefined) node.port.onmessage({ data: { type: 'vad', v } }) }
        const inp = new Float32Array(BLOCK); inp.set(x.subarray(i, i + BLOCK))
        node.process([[inp]], [[new Float32Array(BLOCK)]])
      }
      return w.posted.some(m => m.open === true)
    }
    const speechy = (ms: number) => (ms >= 300 && ms < 900 ? 0.95 : 0.05)
    expect(await opened(null, -30, () => 0)).toBe(true) // no conditions sent: loudness, the probability is not looked at
    expect(await opened({ loud: true, speech: false }, -30, () => 0)).toBe(true)
    expect(await opened({ loud: true, speech: true }, -30, () => 0.1)).toBe(false)
    expect(await opened({ loud: true, speech: true }, -30, speechy)).toBe(true)
    expect(await opened({ loud: true, speech: true }, -65, speechy)).toBe(false)
    expect(await opened({ loud: false, speech: true }, -65, speechy)).toBe(true)
    expect(await opened({ loud: false, speech: true }, -20, () => 0)).toBe(false)
    expect(await opened({ loud: false, speech: false }, -30, () => 0)).toBe(true) // neither: loudness
  })

  test('the vad and conditions messages with nonsense in them are ignored without an error', async () => {
    const w = await load()
    const node = w.make()
    for (const data of [{ type: 'vad' }, { type: 'vad', v: 'x' }, { type: 'vad', v: NaN }, { type: 'conditions' }, null, 5, { type: 'nothing' }]) expect(() => node.port.onmessage({ data })).not.toThrow()
    through(node, tone(300, -30))
    expect(w.posted.some(m => m.open)).toBe(true) // still loudness only
  })
})

describe('the hold: closes a hold after the sound ends, not after the slow envelope', () => {
  // The state used to follow the envelope, which falls 120 dB/s: the hold only began once the envelope was below the close threshold,
  // so the gate stayed open 350 to 600 ms after a loud sound ended instead of the 250 ms of the hold.
  for (const db of [-13, -23, -33, -43]) {
    test(`a tone of ${db} dBFS: closed after about ${GATE.holdMs} ms of silence`, () => {
      const engine = new GateEngine(SR, GATE.openDb, GATE.openDb - GATE.gapDb)
      run(engine, tone(1000, db))
      expect(engine.state.open).toBe(true)
      let n = 0
      while (engine.state.open && n < SR) { engine.process([new Float32Array(BLOCK)], [new Float32Array(BLOCK)]); n += BLOCK }
      const ms = n * 1000 / SR
      expect(ms).toBeGreaterThanOrEqual(GATE.holdMs - 15)
      expect(ms).toBeLessThanOrEqual(GATE.holdMs + 40) // one window and a block more, not the 100 to 350 ms more it was
    })
  }

  test('speech with short pauses stays open: a pause shorter than the hold does not close it', () => {
    const engine = new GateEngine(SR)
    const words = concat(tone(300, -25), silence(150), tone(300, -25), silence(200), tone(300, -25))
    const { open } = run(engine, words)
    expect(open.slice(Math.round(0.03 * SR / BLOCK)).every(Boolean)).toBe(true) // open from the first window to the end
  })
})

describe('SpeechDetector (RFC 29, 4.4)', () => {
  test('opens after two messages in a row at 0.9 or above, not after one', () => {
    const d = new SpeechDetector()
    expect(d.opens).toBe(false); expect(d.keeps).toBe(false) // nothing heard yet
    d.feed(0.95); expect(d.opens).toBe(false)
    d.feed(0.9); expect(d.opens).toBe(true) // 0.9 itself counts
    expect(GATE.speechOpenP).toBe(0.9); expect(GATE.speechFrames).toBe(2)
  })
  test('a single frame at 0.92 between low ones (a click) never opens it', () => {
    const d = new SpeechDetector()
    for (const p of [0.1, 0.92, 0.2, 0.92, 0.3, 0.92, 0.1]) { d.feed(p); expect(d.opens, String(p)).toBe(false) }
  })
  test('the two must be in a row: a frame between 0.8 and 0.9 starts the count again', () => {
    const d = new SpeechDetector()
    d.feed(0.95); d.feed(0.89); d.feed(0.95); expect(d.opens).toBe(false)
    d.feed(0.95); expect(d.opens).toBe(true)
  })
  test('keeps while the last message is at 0.8 or above, and lets go below it', () => {
    const d = new SpeechDetector()
    d.feed(0.95); d.feed(0.95)
    d.feed(0.8); expect(d.keeps).toBe(true)
    d.feed(0.85); expect(d.keeps).toBe(true)
    d.feed(0.79); expect(d.keeps).toBe(false)
    d.feed(0.95); expect(d.keeps).toBe(true) // one message is enough to keep (the two are for opening)
    expect(GATE.speechKeepP).toBe(0.8)
  })
  test('a message older than 150 ms counts as 0: the filter posts nothing for silence', () => {
    const d = new SpeechDetector()
    d.feed(0.95); d.feed(0.95)
    d.advance(150); expect(d.opens).toBe(true); expect(d.keeps).toBe(true); expect(d.p).toBe(0.95) // not older than the limit yet
    d.advance(1); expect(d.opens).toBe(false); expect(d.keeps).toBe(false); expect(d.p).toBe(0)
    d.feed(0.95); expect(d.keeps).toBe(true); expect(d.opens).toBe(false) // a new message counts again, but the count began again too
    d.feed(0.95); expect(d.opens).toBe(true)
    expect(GATE.vadStaleMs).toBe(150)
  })
  test('nonsense is ignored, and a reset forgets everything', () => {
    const d = new SpeechDetector()
    d.feed(NaN); d.feed(Infinity); expect(d.keeps).toBe(false)
    d.feed(0.95); d.feed(0.95); d.reset(); expect(d.opens).toBe(false); expect(d.keeps).toBe(false)
  })
})

describe('GateState.stepConditions', () => {
  test('a closed gate opens on openNow and only on it; keepNow alone does not open it', () => {
    const s = new GateState(-50, -56)
    expect(s.stepConditions(false, true, 10)).toBe(false)
    expect(s.stepConditions(true, true, 10)).toBe(true)
  })
  test('an open gate closes after keepNow has been false for the whole hold (250 ms), and openNow does not hold it open', () => {
    const s = new GateState(-50, -56)
    s.stepConditions(true, true, 10)
    let ms = 0
    while (s.open && ms < 1000) { s.stepConditions(true, false, 10); ms += 10 }
    expect(ms).toBe(250)
    expect(s.open).toBe(false)
  })
  test('a keepNow in the middle starts the hold again', () => {
    const s = new GateState(-50, -56)
    s.stepConditions(true, true, 10)
    for (let i = 0; i < 24; i++) s.stepConditions(false, false, 10) // 240 ms: not yet
    expect(s.open).toBe(true)
    s.stepConditions(false, true, 10)
    for (let i = 0; i < 24; i++) s.stepConditions(false, false, 10)
    expect(s.open).toBe(true) // another 240 ms is not enough either
    s.stepConditions(false, false, 10); expect(s.open).toBe(false)
  })
  test('step(level) is the loudness-only case of it, for any sequence of levels', () => {
    const a = new GateState(-50, -56), b = new GateState(-50, -56)
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 3000; i++) {
      const db = -70 + rnd() * 40, dt = 10
      expect(a.step(db, dt)).toBe(b.stepConditions(db >= b.openDb, db > b.closeDb, dt))
    }
  })
})

describe('the engine with conditions (RFC 29, 4.4), on synthetic sound and synthetic probabilities', () => {
  const MSG = 4 * BLOCK // the noise filter's worklet posts every fourth block: 10.67 ms
  /** The input in blocks of 128; before every fourth block the engine is given the probability `vad(ms)` returns for that moment (undefined:
   *  no message, as for digital silence). Returns the output, the open state after each block, and when (ms) it first opened and last closed. */
  function runVad(engine: GateEngine, input: Float32Array, vad: (ms: number) => number | undefined) {
    const out = new Float32Array(input.length)
    const open: boolean[] = []
    for (let i = 0; i < input.length; i += BLOCK) {
      if (i % MSG === 0) { const p = vad(i * 1000 / SR); if (p !== undefined) engine.setVad(p) }
      const inp = input.subarray(i, Math.min(input.length, i + BLOCK))
      const o = new Float32Array(inp.length)
      engine.process([inp], [o])
      out.set(o, i); open.push(engine.open)
    }
    const at = (b: number) => b * BLOCK * 1000 / SR
    const firstOpen = open.indexOf(true)
    const lastTrue = open.lastIndexOf(true)
    return { out, open, firstOpenMs: firstOpen < 0 ? NaN : at(firstOpen), closedMs: lastTrue < 0 || lastTrue === open.length - 1 ? NaN : at(lastTrue + 1),
      openFraction: open.filter(Boolean).length / open.length }
  }
  const engineWith = (loud: boolean, speech: boolean) => { const e = new GateEngine(SR); e.setConditions(loud, speech); return e }
  const ONSET = 300
  /** 300 ms of nothing, a 600 ms tone, a second of nothing. */
  const burst = (db: number) => concat(silence(ONSET), tone(600, db), silence(1000))
  const during = (ms: number) => ms >= ONSET && ms < ONSET + 600

  test('the default is loudness only, and it does not look at the probabilities at all: the output is the same with and without them', () => {
    const x = burst(-30)
    const plain = run(new GateEngine(SR), x)
    for (const vad of [() => 0, () => 0.99, (ms: number) => (during(ms) ? 0.95 : 0), () => undefined]) {
      const r = runVad(new GateEngine(SR), x, vad)
      expect(r.out).toEqual(plain.out)
      expect(r.open).toEqual(plain.open)
    }
    expect(plain.open.some(Boolean)).toBe(true)
    expect(new GateEngine(SR).conditions).toEqual({ loud: true, speech: false })
    expect(engineWith(false, false).conditions).toEqual({ loud: true, speech: false }) // neither means loudness
  })

  test('both: a loud burst with a low probability (a keyboard, a door) stays closed, and the output is silent', () => {
    const r = runVad(engineWith(true, true), burst(-30), () => 0.1)
    expect(r.open.some(Boolean)).toBe(false)
    expect(peak(r.out)).toBe(0)
    // and with no messages at all, as when the filter is not running
    expect(runVad(engineWith(true, true), burst(-30), () => undefined).open.some(Boolean)).toBe(false)
  })

  test('both: loud and speech-like (0.95 for the whole burst) opens, a little after the start, and closes after the hold', () => {
    const r = runVad(engineWith(true, true), burst(-30), ms => (during(ms) ? 0.95 : 0.05))
    expect(r.firstOpenMs).toBeGreaterThanOrEqual(ONSET); expect(r.firstOpenMs).toBeLessThanOrEqual(ONSET + 40) // two messages and a window
    expect(r.closedMs).toBeGreaterThanOrEqual(ONSET + 600 + GATE.holdMs - 20); expect(r.closedMs).toBeLessThanOrEqual(ONSET + 600 + GATE.holdMs + 40)
  })

  test('both: a hum above the open level with a probability of 0.6 stays closed', () => {
    const r = runVad(engineWith(true, true), concat(silence(300), tone(2000, -35, 100)), () => 0.6)
    expect(r.open.some(Boolean)).toBe(false)
  })

  test('both: one frame at 0.92 in a loud burst does not open it; two in a row do', () => {
    const one = runVad(engineWith(true, true), burst(-30), ms => (ms >= 320 && ms < 330 ? 0.92 : 0.2)) // the message at 320 only
    expect(one.open.some(Boolean)).toBe(false)
    const two = runVad(engineWith(true, true), burst(-30), ms => (ms >= 320 && ms < 340 ? 0.92 : 0.2)) // 320 and 330.7
    expect(two.open.some(Boolean)).toBe(true)
  })

  test('both: speech-like but below the open level does not open it (loudness is a condition too)', () => {
    const r = runVad(engineWith(true, true), burst(-62), ms => (during(ms) ? 0.97 : 0))
    expect(r.open.some(Boolean)).toBe(false)
  })

  test('both: once open, it stays while the sound is above the close level and the probability is at least 0.8, and closes when either goes', () => {
    // the probability falls to 0.7 in the middle of a loud tone: speech has ended even though the sound is still loud
    const a = runVad(engineWith(true, true), burst(-30), ms => (ms < 600 ? 0.95 : 0.7))
    expect(a.closedMs).toBeGreaterThanOrEqual(600 + GATE.holdMs - 20); expect(a.closedMs).toBeLessThanOrEqual(600 + GATE.holdMs + 40)
    // 0.85 (between 0.8 and 0.9) keeps it open as long as the tone lasts
    const b = runVad(engineWith(true, true), burst(-30), ms => (ms < 330 ? 0.95 : 0.85))
    expect(b.closedMs).toBeGreaterThanOrEqual(ONSET + 600 + GATE.holdMs - 20)
    // the sound ends while the probability stays high (frames after the end still say speech): it closes by the level
    const c = runVad(engineWith(true, true), burst(-30), () => 0.95)
    expect(c.closedMs).toBeGreaterThanOrEqual(ONSET + 600 + GATE.holdMs - 20); expect(c.closedMs).toBeLessThanOrEqual(ONSET + 600 + GATE.holdMs + 40)
  })

  test('speech only: opens on a probability at a level far below the open threshold, and the output carries the sound', () => {
    const x = burst(-65) // the open threshold is -50
    const loud = runVad(engineWith(true, false), x, ms => (during(ms) ? 0.95 : 0))
    expect(loud.open.some(Boolean)).toBe(false) // by loudness it would not open
    const r = runVad(engineWith(false, true), x, ms => (during(ms) ? 0.95 : 0))
    expect(r.firstOpenMs).toBeGreaterThanOrEqual(ONSET); expect(r.firstOpenMs).toBeLessThanOrEqual(ONSET + 40)
    expect(peak(r.out)).toBeGreaterThan(0.9 * Math.SQRT2 * Math.pow(10, -65 / 20))
  })

  test('speech only: a loud sound with a low probability does not open it', () => {
    expect(runVad(engineWith(false, true), burst(-20), () => 0).open.some(Boolean)).toBe(false)
    expect(runVad(engineWith(false, true), burst(-20), () => 0.7).open.some(Boolean)).toBe(false)
  })

  test('speech only: closes after the hold when the probability falls below 0.8, and stays open at 0.85', () => {
    const x = burst(-65)
    const fall = runVad(engineWith(false, true), x, ms => (ms < 900 ? (ms >= ONSET ? 0.95 : 0) : 0.7))
    expect(fall.closedMs).toBeGreaterThanOrEqual(900 + GATE.holdMs - 20); expect(fall.closedMs).toBeLessThanOrEqual(900 + GATE.holdMs + 40)
    const mid = runVad(engineWith(false, true), x, ms => (ms >= ONSET ? (ms < 330 ? 0.95 : 0.85) : 0))
    expect(mid.open.at(-1)).toBe(true) // 0.85 keeps it open for ever, whatever the level (here: through a second of nothing)
    expect(mid.closedMs).toBeNaN()
  })

  test('speech only: closes after the messages stop (silence posts none): 150 ms until the last one counts as 0, then the hold', () => {
    const r = runVad(engineWith(false, true), burst(-65), ms => (during(ms) ? 0.95 : undefined))
    const lastMsg = Math.floor((ONSET + 600) / (MSG * 1000 / SR)) * (MSG * 1000 / SR)
    expect(r.closedMs).toBeGreaterThanOrEqual(lastMsg + GATE.vadStaleMs + GATE.holdMs - 20)
    expect(r.closedMs).toBeLessThanOrEqual(lastMsg + GATE.vadStaleMs + GATE.holdMs + 40)
  })

  test('speech only: no messages at all (the filter did not start) never opens it', () => {
    expect(runVad(engineWith(false, true), burst(-20), () => undefined).open.some(Boolean)).toBe(false)
  })

  test('the conditions can be changed while it runs: the sound that follows is judged by the new ones', () => {
    const e = new GateEngine(SR)
    const x = concat(tone(500, -30), silence(1000), tone(500, -30), silence(1000))
    const first = run(e, x.subarray(0, 72000))
    expect(first.open.some(Boolean)).toBe(true) // loudness only: opens on a loud tone with no probability
    e.setConditions(true, true)
    const second = runVad(e, x.subarray(72000), () => 0.1)
    expect(second.open.some(Boolean)).toBe(false)
  })

  test('the first samples of speech come out whole in "both" mode if the filter says speech with the sound; the later it says so, the more is cut', () => {
    // Assumption stated: the filter's worklet buffers the sound by one frame (10 ms) before it reaches the gate, and the probability of a frame
    // is posted when that frame leaves it, so the message that says "speech" arrives with the sound it is about, +- one message interval.
    // Two messages are needed (10.67 ms apart) and the state looks every 10 ms, and the look-ahead is 25 ms, so the gate is open 15 to 25 ms
    // after the first message: "whole" holds when that first message is no later than the onset. A message 20 ms late cuts into the start.
    const a = Math.SQRT2 * Math.pow(10, -30 / 20)
    const D = Math.round(SR * GATE.lookaheadMs / 1000)
    const onset = Math.round(SR * ONSET / 1000)
    const x = burst(-30)
    /** Samples of the output after the delayed onset (onset + D) that are below 0.98 of the tone's start: how much of the start was cut. */
    const cutMs = (r: { out: Float32Array }) => {
      let n = 0
      // the tone has its peak at the very first sample and then oscillates at 200 Hz: compare the envelope over each 5 ms (a full cycle) with the tone's own
      for (; n < SR * 0.1; n += Math.round(SR * 0.005)) if (peak(r.out.subarray(onset + D + n, onset + D + n + Math.round(SR * 0.005))) > 0.98 * a) break
      return n * 1000 / SR
    }
    const first = (lateMs: number) => (ms: number) => (ms >= ONSET - 1.4 + lateMs && ms < ONSET + 600 ? 0.95 : 0.05) // 298.67 is the message time before the onset
    const loudOnly = runVad(engineWith(true, false), x, first(0))
    expect(cutMs(loudOnly)).toBe(0) // as before
    expect(loudOnly.out[onset + D]!).toBeGreaterThan(0.98 * a)
    const both0 = runVad(engineWith(true, true), x, first(0))
    expect(both0.out[onset + D]!).toBeGreaterThan(0.98 * a) // the first sample of the sound, at full strength
    expect(cutMs(both0)).toBe(0)
    const cuts = [0, 5, 10, 20].map(d => cutMs(runVad(engineWith(true, true), x, first(d))))
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]!).toBeGreaterThanOrEqual(cuts[i - 1]!) // later is never less cut
    expect(cuts.at(-1)!).toBeGreaterThan(0) // and the 20 ms late one is cut: that is what the look-ahead cannot cover
    expect(cuts.at(-1)!).toBeLessThanOrEqual(25) // but by no more than a syllable's first 25 ms
    // the same in speech only
    expect(runVad(engineWith(false, true), x, first(0)).out[onset + D]!).toBeGreaterThan(0.98 * a)
  })

  test('probabilities are processed per message: the staleness advances with the sound, not with the messages', () => {
    const e = engineWith(false, true)
    e.setVad(0.95); e.setVad(0.95)
    run(e, silence(100)) // 100 ms of sound, no message: still fresh at 100 ms
    expect(e.speech.opens).toBe(true)
    run(e, silence(60)) // 160 ms: stale
    expect(e.speech.opens).toBe(false)
  })
})
