import { GateEngine, GATE } from './gate'

// The voice gate as an audio worklet (RFC 29), built to /public/gate.js as one file with no imports (a worklet cannot import from
// the page). The sound goes in after the noise filter and comes out delayed by the look-ahead and gated by a ramped gain; the
// level and whether the gate is open go to the page about 20 times a second, and at once when the state changes.
//
// From the page: { type: 'set', open, close } (thresholds in dBFS) and { type: 'force', open: true | false | null }.
// To the page:   { t, level, open } (t: seconds of sound so far; level: dBFS before the gate).

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: { postMessage(m: unknown): void, onmessage: ((e: { data: any }) => void) | null }
  constructor(options?: { processorOptions?: any })
}
declare function registerProcessor(name: string, ctor: new (options?: any) => AudioWorkletProcessor): void

const POST_EVERY = 0.05 // seconds

class GateProcessor extends AudioWorkletProcessor {
  private engine: GateEngine
  private frames = 0
  private lastPost = -1
  private lastOpen = false
  constructor(options?: { processorOptions?: { open?: number, close?: number } }) {
    super(options)
    const o = options?.processorOptions
    this.engine = new GateEngine(sampleRate, typeof o?.open === 'number' ? o.open : GATE.openDb, typeof o?.close === 'number' ? o.close : GATE.openDb - GATE.gapDb)
    this.port.onmessage = (e) => {
      const m = e.data
      if (m?.type === 'set' && Number.isFinite(m.open) && Number.isFinite(m.close)) this.engine.setThresholds(m.open, m.close)
      else if (m?.type === 'force') this.engine.force = m.open === true ? true : m.open === false ? false : null
    }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (!out || !out.length) return true
    const inp = inputs[0] ?? []
    this.engine.process(inp, out)
    this.frames += out[0]!.length
    const t = this.frames / sampleRate
    const open = this.engine.open
    if (open !== this.lastOpen || t - this.lastPost >= POST_EVERY) {
      this.lastOpen = open; this.lastPost = t
      this.port.postMessage({ t, level: this.engine.levelDb, open })
    }
    return true
  }
}

registerProcessor('td-gate', GateProcessor)
