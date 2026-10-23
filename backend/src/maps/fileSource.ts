import { open, stat } from 'node:fs/promises'
import type { ByteSource } from './bsp'

/** A `.bsp` on disk (or a range of a larger file, such as a map inside an addon archive), read in ranges; the file is never held in memory as a whole. */
export async function fileSource(path: string, offset = 0, length?: number): Promise<{ src: ByteSource, close: () => Promise<void> }> {
  const fileSize = (await stat(path)).size
  const size = length ?? fileSize - offset
  if (offset < 0 || size < 0 || offset + size > fileSize) throw new Error('range outside the file')
  const fh = await open(path, 'r')
  return {
    src: {
      size,
      async read(at, len) {
        const want = Math.max(0, Math.min(len, size - at))
        const buf = new Uint8Array(want)
        const { bytesRead } = await fh.read(buf, 0, want, offset + at)
        return buf.subarray(0, bytesRead)
      },
    },
    close: () => fh.close(),
  }
}
