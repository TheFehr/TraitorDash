import { BspError, type ByteSource } from './bsp'

// Garry's Mod addon archives (GMA, version 3): "GMAD", a header, a file table, then the files'
// bytes one after another. This reads the table only, so a map can be read in place afterwards
// without unpacking anything (RFC 11, 3.2).

export interface GmaEntry { name: string, offset: number, size: number }
export interface GmaLimits { maxTableBytes?: number, maxFiles?: number }

/** The bytes [offset, offset + length) of `src`, as a source of their own. */
export function sliceSource(src: ByteSource, offset: number, length: number): ByteSource {
  return {
    size: length,
    async read(at, len) {
      if (at < 0 || at >= length) return new Uint8Array(0)
      return src.read(offset + at, Math.min(len, length - at))
    },
  }
}

export async function readGmaIndex(src: ByteSource, limits: GmaLimits = {}): Promise<GmaEntry[]> {
  const maxTable = limits.maxTableBytes ?? 8 * 1024 * 1024
  const maxFiles = limits.maxFiles ?? 100_000
  const buf = await src.read(0, Math.min(src.size, maxTable))
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 0
  const fail = (m: string): never => { throw new BspError(`Not a readable addon archive (${m}).`) }
  const need = (n: number) => { if (p + n > buf.length) fail('the file table is cut off or too large') }
  const u8 = () => { need(1); return dv.getUint8(p++) }
  const u32 = () => { need(4); const v = dv.getUint32(p, true); p += 4; return v }
  const u64 = () => { need(8); const v = dv.getBigUint64(p, true); p += 8; return v }
  const str = (max = 512) => {
    const start = p
    while (p < buf.length && buf[p] !== 0) { if (p - start > max) fail('a name is too long'); p++ }
    need(1)
    const s = Buffer.from(buf.subarray(start, p)).toString('latin1')
    p++
    return s
  }

  if (buf.length < 5 || String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) !== 'GMAD') fail('no GMAD header')
  p = 4
  const version = u8()
  if (version < 1 || version > 3) fail(`version ${version}`)
  u64(); u64() // steam id, timestamp
  if (version > 1) { while (str() !== '') { /* required content */ } }
  str(); str(); str() // title, description, author
  u32() // addon version

  const entries: GmaEntry[] = []
  let offset = 0
  for (;;) {
    if (u32() === 0) break
    if (entries.length >= maxFiles) fail('too many files')
    const name = str()
    const size = Number(u64())
    u32() // crc
    if (!Number.isSafeInteger(size) || size < 0) fail('a file size is invalid')
    entries.push({ name, offset, size })
    offset += size
  }
  // File data starts right after the table; turn running offsets into absolute ones.
  for (const e of entries) {
    e.offset += p
    if (e.offset + e.size > src.size) fail('a file reaches past the end of the archive')
  }
  return entries
}

const MAP_ENTRY = /^maps\/([a-z0-9_.-]{1,64})\.bsp$/

/** The map files in an archive, by map name (lower case, as the game compares them). */
export function mapEntries(entries: GmaEntry[]): { name: string, entry: GmaEntry }[] {
  const out: { name: string, entry: GmaEntry }[] = []
  for (const e of entries) {
    const m = MAP_ENTRY.exec(e.name.toLowerCase())
    if (m) out.push({ name: m[1]!, entry: e })
  }
  return out
}
