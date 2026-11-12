// Copies the noise filter (RNNoise, from @sapphi-red/web-noise-suppressor) to src/public/rnnoise/ and patches the COPY of its audio worklet
// so it reports what RNNoise already computes for every 10 ms frame and the package throws away: the probability that the frame is
// speech (RFC 29, 4.4). The worklet then posts { vad } to the page about every 10.7 ms: the highest value of the frames since the last
// message; no message means 0 (digital silence posts nothing). node_modules is never touched.
// Each edit must match exactly once in the packaged file; if the package changes and one does not, this throws and the build fails.
import { mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'

export const EDITS: readonly { name: string, from: string, to: string }[] = [
  { name: 'frame',
    from: 'n=e=>{u(e),t.processFrame(e),d(e)}',
    to: 'n=e=>{u(e);let v=t.processFrame(e);v>(globalThis.__rnnoiseVad||0)&&(globalThis.__rnnoiseVad=v);d(e)}' },
  { name: 'process',
    from: 'this.processor.process(e[0],t[0]),!0)',
    to: 'this.processor.process(e[0],t[0]),this.tickVad(),!0)' },
  { name: 'post',
    from: 'destroy(){this.destroyed=!0,this.processor?.destroy(),this.processor=void 0}};registerProcessor',
    to: 'tickVad(){this.vadBlocks=(this.vadBlocks||0)+1;if(this.vadBlocks%4===0){const v=globalThis.__rnnoiseVad;if(v!==void 0){this.port.postMessage({vad:v});globalThis.__rnnoiseVad=0}}}destroy(){this.destroyed=!0,this.processor?.destroy(),this.processor=void 0}};registerProcessor' },
]

const count = (hay: string, needle: string) => { let n = 0, at = hay.indexOf(needle); while (at !== -1) { n++; at = hay.indexOf(needle, at + needle.length) } return n }

/** The worklet's source with the three edits made; throws when one of them does not match exactly once. */
export function patchWorklet(src: string): string {
  let out = src
  for (const e of EDITS) {
    const n = count(out, e.from)
    if (n !== 1) throw new Error(`copy-rnnoise: the edit "${e.name}" matches ${n} times in the packaged worklet (expected exactly once); the package has changed, update scripts/copy-rnnoise.ts`)
    out = out.replace(e.from, () => e.to)
  }
  return out
}

/** Copies the files from `pkg` (the package's directory) into `dest`, patching the worklet's copy. */
export async function copyRnnoise(pkg: string, dest: string): Promise<void> {
  // The edit comes before any file is written: a failed edit leaves nothing half-made.
  const worklet = patchWorklet(await Bun.file(join(pkg, 'dist/rnnoise/workletProcessor.js')).text())
  await mkdir(dest, { recursive: true })
  await Bun.write(join(dest, 'worklet.js'), worklet)
  await copyFile(join(pkg, 'dist/rnnoise.wasm'), join(dest, 'rnnoise.wasm'))
  await copyFile(join(pkg, 'dist/rnnoise_simd.wasm'), join(dest, 'rnnoise_simd.wasm'))
  await copyFile(join(pkg, 'LICENSE'), join(dest, 'LICENSE'))
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  await copyRnnoise(join(root, 'node_modules/@sapphi-red/web-noise-suppressor'), join(root, 'src/public/rnnoise'))
}
