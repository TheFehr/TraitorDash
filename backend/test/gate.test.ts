import { expect, test, describe } from 'bun:test'
import { GATE, GateState, GainRamp, LevelMeter, GateEngine, FloorTracker, calibrate, thresholdsFromFloor, percentile, clampDb, toDb } from '../src/gate'

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
