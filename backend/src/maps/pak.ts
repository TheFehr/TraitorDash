import { inflateRawSync } from 'node:zlib'
import { BspError, type ByteSource, type Lump } from './bsp'

// RFC 18, 4.3: the pakfile lump of a map is a ZIP of the content the map carries (models, materials, sounds). It is
// 95% of the file, so it is never read whole: the directory at its end is read, and then only the members that are
// asked for. The map is untrusted, so every offset and size is checked, and a member that does not add up is `null`,
// not an error: one bad model must not cost the map.

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50
const MAX_ENTRIES = 50_000
const MAX_DIRECTORY = 16 * 1024 * 1024

export interface PakEntry { name: string, method: 0 | 8, compressed: number, size: number, offset: number }
export interface Pak { entries: Map<string, PakEntry>, lump: Lump, read: number }

export interface PakLimits {
  /** Largest member, unpacked. Default 32 MB. */
  maxMemberBytes?: number
  /** All the members read from one map, unpacked. Default 64 MB (RFC 18, 7). */
  maxTotalBytes?: number
}

const dir = (n: Uint8Array) => new DataView(n.buffer, n.byteOffset, n.byteLength)

/**
 * The directory of the pack: member name (lower case, `/` for the separator) to where it is. An empty pack, a pack of
 * a kind this does not read (compressed lump, Zip64, no directory) and a directory that does not add up give an empty one.
 */
export async function readPak(src: ByteSource, lump: Lump): Promise<Pak> {
  const none: Pak = { entries: new Map(), lump, read: 0 }
  if (lump.length < 22 || lump.compressed) return none
  if (lump.offset < 0 || lump.offset + lump.length > src.size) throw new BspError('the pakfile lump reaches past the end of the file')
  const tailLen = Math.min(lump.length, 22 + 65535)
  const tail = await src.read(lump.offset + lump.length - tailLen, tailLen)
  if (tail.length !== tailLen) return none
  const tv = dir(tail)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === EOCD) { e = i; break }
  if (e < 0) return none
  const count = tv.getUint16(e + 10, true), size = tv.getUint32(e + 12, true), at = tv.getUint32(e + 16, true)
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) return none // Zip64
  if (count > MAX_ENTRIES || size > MAX_DIRECTORY || at + size > lump.length) return none
  const cd = await src.read(lump.offset + at, size)
  if (cd.length !== size) return none
  const cv = dir(cd)
  const entries = new Map<string, PakEntry>()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== CENTRAL) break
    const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true)
    const compressed = cv.getUint32(p + 20, true), unpacked = cv.getUint32(p + 24, true)
    const nameLen = cv.getUint16(p + 28, true), extraLen = cv.getUint16(p + 30, true), commentLen = cv.getUint16(p + 32, true)
    const offset = cv.getUint32(p + 42, true)
    if (p + 46 + nameLen > cd.length) break
    const name = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen)).toString('latin1').toLowerCase().replace(/\\/g, '/')
    p += 46 + nameLen + extraLen + commentLen
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || name.endsWith('/')) continue
    if (offset + 30 > lump.length) continue
    entries.set(name, { name, method: method as 0 | 8, compressed, size: unpacked, offset })
  }
  return { entries, lump, read: 0 }
}

/**
 * One member, unpacked. `null` when it is not in the pack, is larger than the limits, or does not add up (a local header
 * that is not one, a size that is not the declared one, a stream that does not inflate).
 */
export async function readPakMember(src: ByteSource, pak: Pak, name: string, limits: PakLimits = {}): Promise<Uint8Array | null> {
  const entry = pak.entries.get(name)
  if (!entry) return null
  const maxMember = limits.maxMemberBytes ?? 32 * 1024 * 1024, maxTotal = limits.maxTotalBytes ?? 64 * 1024 * 1024
  if (entry.size > maxMember || pak.read + entry.size > maxTotal) return null
  if (entry.method === 0 && entry.compressed !== entry.size) return null
  const head = await src.read(pak.lump.offset + entry.offset, 30)
  if (head.length !== 30 || dir(head).getUint32(0, true) !== LOCAL) return null
  const hv = dir(head)
  const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true)
  if (start + entry.compressed > pak.lump.length) return null
  const raw = await src.read(pak.lump.offset + start, entry.compressed)
  if (raw.length !== entry.compressed) return null
  let out: Uint8Array
  if (entry.method === 0) out = raw
  else {
    try { out = new Uint8Array(inflateRawSync(raw, { maxOutputLength: entry.size + 1 })) } catch { return null }
  }
  if (out.length !== entry.size) return null
  pak.read += entry.size
  return out
}
