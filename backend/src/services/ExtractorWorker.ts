// Worker entry point: runs one extraction and reports the result. It exists so the main
// thread can terminate it at any moment; Lua can loop forever, and nothing inside a
// synchronous interpreter can be interrupted from within.
import { ExtractorCore } from './ExtractorCore'

declare const self: Worker

self.onmessage = async (event: MessageEvent) => {
  const { args } = event.data
  try {
    const result = await ExtractorCore.extractSchema(...(args as Parameters<typeof ExtractorCore.extractSchema>))
    self.postMessage({ ok: true, result })
  } catch (e: any) {
    self.postMessage({ ok: false, error: String(e?.message ?? e) })
  }
}
