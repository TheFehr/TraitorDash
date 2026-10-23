import type { ByteSource } from './bsp'

// RFC 18, 4.5: the index of a Valve package (`*_dir.vpk`, versions 1 and 2). The index says which archive file
// (`*_000.vpk`, ...) holds each file and where; the files themselves are read from those archives. The index is read
// in ranges and bounded: it comes from Valve's servers, but a reader that trusts its input is how bugs start.

export interface VpkEntry {
  /** 0x7fff: the data follows the index in the `_dir.vpk` itself. */
  archive: number
  /** Offset in the archive (or, for 0x7fff, in the `_dir.vpk`). */
  offset: number
  length: number
  /** Bytes stored in the index in front of the data (small files). */
  preload: Uint8Array
}
export type VpkIndex = Map<string, VpkEntry>

export interface VpkLimits { maxTreeBytes?: number, maxEntries?: number }

export const VPK_SIGNATURE = 0x55aa1234
const IN_DIR = 0x7fff

export class VpkError extends Error {}

/** Reads the index (names lower-cased, with `/`). */
export async function readVpkIndex(src: ByteSource, limits: VpkLimits = {}): Promise<VpkIndex> {
  const maxTree = limits.maxTreeBytes ?? 64 * 1024 * 1024
  const maxEntries = limits.maxEntries ?? 2_000_000
  const head = await src.read(0, 28)
  if (head.length < 12) throw new VpkError('not a package')
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (dv.getUint32(0, true) !== VPK_SIGNATURE) throw new VpkError('not a package')
  const version = dv.getUint32(4, true)
  const treeSize = dv.getUint32(8, true)
  if (version !== 1 && version !== 2) throw new VpkError(`package version ${version} is not supported`)
  const headerSize = version === 2 ? 28 : 12
  if (head.length < headerSize || treeSize > maxTree || headerSize + treeSize > src.size) throw new VpkError('the package index is damaged')
  const tree = await src.read(headerSize, treeSize)
  if (tree.length !== treeSize) throw new VpkError('the package index is damaged')
  const tv = new DataView(tree.buffer, tree.byteOffset, tree.byteLength)
  const dataStart = headerSize + treeSize

  let p = 0
  const text = (): string => {
    const start = p
    while (p < tree.length && tree[p] !== 0) p++
    if (p >= tree.length) throw new VpkError('the package index is damaged')
    const s = Buffer.from(tree.subarray(start, p)).toString('latin1')
    p++
    return s
  }
  const out: VpkIndex = new Map()
  for (;;) {
    const ext = text()
    if (!ext) break
    for (;;) {
      const dir = text()
      if (!dir) break
      for (;;) {
        const name = text()
        if (!name) break
        if (p + 18 > tree.length) throw new VpkError('the package index is damaged')
        const preloadLength = tv.getUint16(p + 4, true)
        const archive = tv.getUint16(p + 6, true)
        const offset = tv.getUint32(p + 8, true)
        const length = tv.getUint32(p + 12, true)
        p += 18
        if (p + preloadLength > tree.length) throw new VpkError('the package index is damaged')
        const preload = tree.subarray(p, p + preloadLength)
        p += preloadLength
        if (out.size >= maxEntries) throw new VpkError('the package has too many files')
        // The names are stored as a space when empty (a file in the root, or without an extension).
        const full = `${dir === ' ' ? '' : dir + '/'}${name === ' ' ? '' : name}${ext === ' ' ? '' : '.' + ext}`.toLowerCase()
        out.set(full, { archive, offset: archive === IN_DIR ? dataStart + offset : offset, length, preload })
      }
    }
  }
  return out
}

/** The archive file that goes with an index file and an archive number: `x_dir.vpk` and 3 give `x_003.vpk`. */
export function vpkArchiveName(dirName: string, archive: number): string {
  return dirName.replace(/_dir\.vpk$/i, `_${String(archive).padStart(3, '0')}.vpk`)
}

/** One file of the package, from the archive source (or from the index file itself for 0x7fff). */
export async function readVpkFile(entry: VpkEntry, archive: ByteSource, maxBytes = 32 * 1024 * 1024): Promise<Uint8Array> {
  if (entry.preload.length + entry.length > maxBytes) throw new VpkError('the file is too large')
  if (entry.length === 0) return entry.preload
  if (entry.offset + entry.length > archive.size) throw new VpkError('the file lies outside its archive')
  const data = await archive.read(entry.offset, entry.length)
  if (data.length !== entry.length) throw new VpkError('the file lies outside its archive')
  if (entry.preload.length === 0) return data
  const both = new Uint8Array(entry.preload.length + data.length)
  both.set(entry.preload, 0)
  both.set(data, entry.preload.length)
  return both
}
