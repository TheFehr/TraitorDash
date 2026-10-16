import type { ExtractorCore } from './ExtractorCore'

type Args = Parameters<typeof ExtractorCore.extractSchema>
type Result = Awaited<ReturnType<typeof ExtractorCore.extractSchema>>

/**
 * Extracts a role's settings schema from its Lua source.
 *
 * The Lua comes from a game server and is hostile input, so every extraction runs in its
 * own worker with a hard deadline: an infinite loop (or one that swallows errors with
 * pcall) costs one terminated worker instead of freezing the whole backend.
 */
export class Extractor {
  /** Hard limit for one extraction. Real roles take a few milliseconds. */
  static timeoutMs = 5000

  static extractSchema(...args: Args): Promise<Result> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./ExtractorWorker.ts', import.meta.url))
      const finish = (fn: () => void) => {
        clearTimeout(timer)
        worker.terminate()
        fn()
      }

      const timer = setTimeout(
        () => finish(() => reject(new Error(`Extraction timed out after ${Extractor.timeoutMs}ms`))),
        Extractor.timeoutMs
      )

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data
        finish(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))))
      }
      worker.onerror = (event: ErrorEvent) => {
        finish(() => reject(new Error(`Extraction worker failed: ${event.message}`)))
      }

      worker.postMessage({ args })
    })
  }
}
