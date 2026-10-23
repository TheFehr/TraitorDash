import { BspError, type BspHeader, type ByteSource, type Placement } from './bsp'

// RFC 18, 4.3: where the static props of a map stand. The game lump `sprp` holds a table of model paths and one record
// per prop (position, angles, which model). Versions 4 to 11 of the record differ in size after the first 28 bytes, which
// are the same in all of them, so the size is taken from the data and a size that is not a whole number is refused.

const GAME_LUMP = 35
const MAX_GAME_LUMP = 16 * 1024 * 1024
const MAX_COORD = 131_072
const MAX_DICT = 4096
const MAX_PROPS = 100_000

export interface StaticProps { placements: Placement[], skipped: number }

/** The static props. `skipped` counts records that name a model outside the table or stand at an impossible place. */
export async function readStaticProps(src: ByteSource, header: BspHeader): Promise<StaticProps> {
  const out: StaticProps = { placements: [], skipped: 0 }
  const lump = header.lumps[GAME_LUMP]!
  if (lump.length < 4 || lump.compressed) return out
  if (lump.length > MAX_GAME_LUMP) throw new BspError(`the game lump is ${lump.length} bytes, over the limit of ${MAX_GAME_LUMP}`)
  const dirBytes = await src.read(lump.offset, lump.length)
  if (dirBytes.length !== lump.length) throw new BspError('short read of the game lump')
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength)
  const n = dv.getInt32(0, true)
  if (n < 0 || 4 + n * 16 > dirBytes.length) throw new BspError('the game lump directory does not fit in the game lump')
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 16
    const id = String.fromCharCode(dv.getUint8(o + 3), dv.getUint8(o + 2), dv.getUint8(o + 1), dv.getUint8(o))
    if (id !== 'sprp') continue
    const at = dv.getInt32(o + 8, true), len = dv.getInt32(o + 12, true)
    if (at < 0 || len < 0 || at + len > src.size || len > MAX_GAME_LUMP) throw new BspError('the static prop lump reaches outside the file')
    if (len < 12) return out
    const b = await src.read(at, len)
    if (b.length !== len) throw new BspError('short read of the static prop lump')
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let p = 0
    const dict = v.getInt32(p, true); p += 4
    if (dict < 0 || dict > MAX_DICT || p + dict * 128 > len) throw new BspError('the static prop model table does not fit')
    const names: string[] = []
    for (let k = 0; k < dict; k++) { names.push(Buffer.from(b.subarray(p, p + 128)).toString('latin1').replace(/\0[\s\S]*/, '').toLowerCase()); p += 128 }
    if (p + 4 > len) throw new BspError('the static prop lump is cut off')
    const leaves = v.getInt32(p, true); p += 4
    if (leaves < 0 || p + leaves * 2 > len) throw new BspError('the static prop leaf table does not fit')
    p += leaves * 2
    if (p + 4 > len) throw new BspError('the static prop lump is cut off')
    const props = v.getInt32(p, true); p += 4
    if (props < 0 || props > MAX_PROPS) throw new BspError(`${props} static props is more than is read (${MAX_PROPS})`)
    if (props === 0) return out
    const stride = (len - p) / props
    if (!Number.isInteger(stride) || stride < 32 || stride > 128) throw new BspError(`the static prop records are not a whole number of bytes (${len - p} for ${props})`)
    for (let k = 0; k < props; k++) {
      const r = p + k * stride
      const num = [0, 1, 2, 3, 4, 5].map(j => v.getFloat32(r + j * 4, true))
      const model = names[v.getUint16(r + 24, true)]
      if (!model || !/^models\/.+\.mdl$/.test(model) || !num.every(x => Number.isFinite(x)) || Math.abs(num[0]!) > MAX_COORD || Math.abs(num[1]!) > MAX_COORD || Math.abs(num[2]!) > MAX_COORD) { out.skipped++; continue }
      out.placements.push({ model, x: num[0]!, y: num[1]!, z: num[2]!, pitch: num[3]!, yaw: num[4]!, roll: num[5]! })
    }
    return out
  }
  return out
}
