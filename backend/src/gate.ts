// The voice gate (RFC 29): the pure core. No browser objects: it works on numbers and Float32Arrays, so the audio worklet
// (src/gate-worklet.ts) and the tests run the very same code, and the page uses its small parts (the calibration, the floor
// tracker, the state machine for the fallback).
//
// The chain of one block of sound: the level is measured in 10 ms windows (dBFS, fast up, slow down) on the sound as it comes in;
// the state machine decides open or closed from that level (two thresholds, so no chatter, and a hold, so the ends of words stay);
// the sound itself is delayed by the look-ahead, so the gate has opened by the time the first syllable comes out of the delay;
// and the gain moves to 1 or 0 in a ramp, never in a step, so there are no clicks.

/** The starting values and limits. Starting values from other programs (RFC 29, 3), to be tuned on the real server. */
export const GATE = {
  minDb: -70, maxDb: -20, // the slider's range, and what the calibration is kept inside
  openDb: -50, gapDb: 6, // before the room is measured: opens at -50, closes 6 dB lower
  holdMs: 250,
  lookaheadMs: 25,
  openRampMs: 3, closeRampMs: 80,
  windowMs: 10,
  releaseDbPerS: 120, // how fast the envelope falls (it rises at once)
  silenceDb: -100, // the level of digital silence; nothing is reported below it
  // the room measurement (4.2)
  calibrateMs: 3000, minSamples: 20, floorPercentile: 90, openAboveFloorDb: 10, closeAboveFloorDb: 6, maxSpreadDb: 12,
  // the automatic mode (4.3)
  floorWindowMs: 5000, floorBucketMs: 500, floorRiseDbPerS: 2, floorFallDbPerS: 20,
} as const

export const clampDb = (db: number, lo: number = GATE.minDb, hi: number = GATE.maxDb) => Math.min(hi, Math.max(lo, db))

/** Mean power (the mean of squares of samples between -1 and 1) in dBFS, never below the level of digital silence. */
export const toDb = (power: number) => (power > 1e-10 ? Math.max(GATE.silenceDb, 10 * Math.log10(power)) : GATE.silenceDb)

/** The level of the sound: the mean power of each window, as an envelope that follows loudness up at once and falls slowly. */
export class LevelMeter {
  private sum = 0
  private n = 0
  private readonly size: number
  private readonly fall: number
  /** The envelope in dBFS, as of the last window. */
  env: number = GATE.silenceDb
  /** The last window's own level in dBFS (no smoothing). */
  window: number = GATE.silenceDb
  constructor(sampleRate: number, windowMs: number = GATE.windowMs, releaseDbPerS: number = GATE.releaseDbPerS) {
    this.size = Math.max(1, Math.round(sampleRate * windowMs / 1000))
    this.fall = releaseDbPerS * windowMs / 1000
  }
  /** Adds one sample's power; true when that completed a window (the envelope has a new value then). */
  add(power: number): boolean {
    this.sum += power; this.n++
    if (this.n < this.size) return false
    this.window = toDb(this.sum / this.n)
    this.env = this.window > this.env ? this.window : Math.max(this.window, this.env - this.fall)
    this.sum = 0; this.n = 0
    return true
  }
}

/** Open or closed, from a level and the time that passed. Between the two thresholds nothing changes: that is the hysteresis. */
export class GateState {
  open = false
  private holdLeft = 0
  constructor(public openDb: number = GATE.openDb, public closeDb: number = GATE.openDb - GATE.gapDb, public holdMs: number = GATE.holdMs) { this.set(openDb, closeDb) }
  /** The close threshold is never above the open one. */
  set(openDb: number, closeDb: number) { this.openDb = openDb; this.closeDb = Math.min(closeDb, openDb) }
  /** One look at the level, `dtMs` after the last. Opens at the open threshold or above; closes only when the level has been
   *  below the close threshold for the whole hold (a level above it, even below the open one, starts the hold again). */
  step(levelDb: number, dtMs: number): boolean {
    if (!this.open) {
      if (levelDb >= this.openDb) { this.open = true; this.holdLeft = this.holdMs }
    } else if (levelDb > this.closeDb) {
      this.holdLeft = this.holdMs
    } else {
      this.holdLeft -= dtMs
      if (this.holdLeft <= 0) { this.open = false; this.holdLeft = 0 }
    }
    return this.open
  }
  reset() { this.open = false; this.holdLeft = 0 }
}

/** A gain that moves towards 0 or 1 by at most a fixed step per sample: fast up, slower down, and never a jump. */
export class GainRamp {
  gain = 0
  private readonly up: number
  private readonly down: number
  constructor(sampleRate: number, openMs: number = GATE.openRampMs, closeMs: number = GATE.closeRampMs) {
    this.up = 1000 / (openMs * sampleRate)
    this.down = 1000 / (closeMs * sampleRate)
  }
  next(target: number): number {
    if (this.gain < target) this.gain = Math.min(target, this.gain + this.up)
    else if (this.gain > target) this.gain = Math.max(target, this.gain - this.down)
    return this.gain
  }
}

/** The whole gate for blocks of samples. `process` reads the input channels and writes the same number of output channels:
 *  the input delayed by the look-ahead, times the gain. The decision is made on the input as it arrives, so the gain is already
 *  up by the time the first syllable comes out of the delay. */
export class GateEngine {
  readonly meter: LevelMeter
  readonly state: GateState
  readonly ramp: GainRamp
  readonly delay: number
  private readonly windowMs: number
  private rings: Float32Array[] = []
  private at = 0
  /** null: the gate decides; true or false: held open or closed (push to talk, where the gate is not used). */
  force: boolean | null = null
  constructor(readonly sampleRate: number, openDb: number = GATE.openDb, closeDb: number = GATE.openDb - GATE.gapDb) {
    this.meter = new LevelMeter(sampleRate)
    this.state = new GateState(openDb, closeDb)
    this.ramp = new GainRamp(sampleRate)
    this.delay = Math.round(sampleRate * GATE.lookaheadMs / 1000)
    this.windowMs = GATE.windowMs
  }
  setThresholds(openDb: number, closeDb: number) { this.state.set(openDb, closeDb) }
  /** The level of the sound as it comes in (the envelope), and whether the gate is open. */
  get levelDb() { return this.meter.env }
  get open() { return this.force ?? this.state.open }

  process(input: ArrayLike<number>[], output: Float32Array[]): void {
    const chans = Math.min(input.length, output.length)
    const n = output[0]?.length ?? 0
    for (let c = 0; c < output.length; c++) if (c >= chans) output[c]!.fill(0)
    if (chans === 0) return
    while (this.rings.length < chans) this.rings.push(new Float32Array(this.delay))
    const D = this.delay
    for (let i = 0; i < n; i++) {
      let p = 0
      for (let c = 0; c < chans; c++) { const x = input[c]![i]!; p += x * x }
      // The state follows the window's own level, not the envelope: the envelope falls slowly (it is for the meter), and a hold that
      // only began once it had fallen below the close threshold was 350 to 600 ms long instead of the 250 it is meant to be.
      if (this.meter.add(p / chans)) this.state.step(this.meter.window, this.windowMs)
      const g = this.ramp.next(this.open ? 1 : 0)
      for (let c = 0; c < chans; c++) {
        const x = input[c]![i]!
        let y = x
        if (D > 0) { const ring = this.rings[c]!; y = ring[this.at]!; ring[this.at] = x }
        output[c]![i] = y * g
      }
      if (D > 0) this.at = (this.at + 1) % D
    }
  }
}

/** The percentile (0 to 100) of a list of numbers, by linear interpolation between the neighbours. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN
  const v = [...values].sort((a, b) => a - b)
  const at = (p / 100) * (v.length - 1)
  const lo = Math.floor(at), hi = Math.ceil(at)
  return v[lo]! + (v[hi]! - v[lo]!) * (at - lo)
}

export type Calibration =
  | { ok: true, floor: number, open: number, close: number, clamped: boolean }
  | { ok: false, reason: 'few' | 'noisy', spread?: number }

/** Room measurement (4.2): the levels heard while the player stayed quiet, after the noise filter. The floor is the 90th
 *  percentile (a few bangs do not raise it); open = floor + 10 dB, close = floor + 6 dB, kept inside the slider's range. If the
 *  levels vary a lot (speech, a bang, a door) the measurement is refused instead of setting something bad. */
export function calibrate(levels: number[]): Calibration {
  const v = levels.filter(Number.isFinite)
  if (v.length < GATE.minSamples) return { ok: false, reason: 'few' }
  const floor = percentile(v, GATE.floorPercentile)
  const spread = floor - percentile(v, 100 - GATE.floorPercentile)
  // Near digital silence the levels in dB swing wildly for no audible reason: that is not a noisy room.
  if (spread > GATE.maxSpreadDb && floor > -80) return { ok: false, reason: 'noisy', spread }
  const wantOpen = floor + GATE.openAboveFloorDb
  const open = clampDb(wantOpen)
  const close = clampDb(floor + GATE.closeAboveFloorDb, GATE.minDb, open)
  return { ok: true, floor, open, close, clamped: open !== wantOpen }
}

/** Automatic mode (4.3): follows the room's floor from the levels, while the gate is closed. The floor is the running minimum over
 *  about 5 seconds; it falls fast and rises slowly, and never moves while the gate is open (speech must not raise it). */
export class FloorTracker {
  floor: number | null = null
  private buckets: number[] = []
  private cur = Infinity
  private curMs = 0
  constructor(private readonly windowMs: number = GATE.floorWindowMs, private readonly bucketMs: number = GATE.floorBucketMs,
    private readonly riseDbPerS: number = GATE.floorRiseDbPerS, private readonly fallDbPerS: number = GATE.floorFallDbPerS) {}
  /** One level, `dtMs` after the last; whether the gate is open. Returns the floor so far (null before the first bucket is full). */
  feed(levelDb: number, dtMs: number, gateOpen: boolean): number | null {
    if (gateOpen || !Number.isFinite(levelDb)) return this.floor
    this.cur = Math.min(this.cur, levelDb); this.curMs += dtMs
    if (this.curMs >= this.bucketMs) {
      this.buckets.push(this.cur)
      while (this.buckets.length > Math.max(1, Math.round(this.windowMs / this.bucketMs))) this.buckets.shift()
      this.cur = Infinity; this.curMs = 0
    }
    if (!this.buckets.length) return this.floor
    const candidate = Math.min(this.cur, ...this.buckets)
    const dt = dtMs / 1000
    if (this.floor === null) this.floor = candidate
    else if (candidate < this.floor) this.floor = Math.max(candidate, this.floor - this.fallDbPerS * dt)
    else this.floor = Math.min(candidate, this.floor + this.riseDbPerS * dt)
    return this.floor
  }
  /** The thresholds the floor gives (open = floor + 10 dB, close = floor + 6 dB, inside the range), or null before there is a floor. */
  thresholds(): { open: number, close: number } | null {
    if (this.floor === null) return null
    const open = clampDb(this.floor + GATE.openAboveFloorDb)
    return { open, close: clampDb(this.floor + GATE.closeAboveFloorDb, GATE.minDb, open) }
  }
  /** Starts from a known floor (the room measurement just made). */
  seed(floor: number) { this.floor = floor; this.buckets = []; this.cur = Infinity; this.curMs = 0 }
}
