// RFC 18, 4.6: a Source texture (`.vtf`) as pixels, for the leaves of plants. The base texture of a foliage material carries the shape of
// the leaves in its alpha channel; without it a plant is a pile of opaque sheets. Only what is needed is read: one mip level, the first
// frame, a few of the formats the game's textures are in (the DXT ones and the plain ones). The file is untrusted: every size is checked,
// and anything this does not understand gives `null`, never an error.

export interface Pixels { width: number, height: number, /** RGBA, 8 bits each, the top row first. */ rgba: Uint8Array }

const MAX_SIDE = 8192
const MAX_MIPS = 16

// The image formats of the file (the numbers are the game's), and how many bytes a width by height image takes in each.
const FORMAT = { RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, I8: 5, IA88: 6, A8: 8, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, DXT1_ONEBITALPHA: 20 } as const

function imageBytes(format: number, w: number, h: number): number | null {
  const blocks = Math.ceil(w / 4) * Math.ceil(h / 4)
  switch (format) {
    case FORMAT.DXT1: case FORMAT.DXT1_ONEBITALPHA: return blocks * 8
    case FORMAT.DXT3: case FORMAT.DXT5: return blocks * 16
    case FORMAT.RGBA8888: case FORMAT.ABGR8888: case FORMAT.ARGB8888: case FORMAT.BGRA8888: case FORMAT.BGRX8888: return w * h * 4
    case FORMAT.RGB888: case FORMAT.BGR888: return w * h * 3
    case FORMAT.IA88: return w * h * 2
    case FORMAT.I8: case FORMAT.A8: return w * h
    default: return null
  }
}

/** A colour in 5-6-5 bits as 8 bits for each. */
const r565 = (c: number): [number, number, number] => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31].map(Math.round) as [number, number, number]

/**
 * The 4 colours of a DXT colour block (8 bytes), as RGBA. A DXT1 block with the first colour not above the second has three colours and
 * a fourth that is black, or clear when the texture has one bit of alpha; the blocks of DXT3 and DXT5 always have four colours.
 */
function colourBlock(b: Uint8Array, at: number, mode: 'dxt1' | 'dxt1-alpha' | 'four'): number[][] {
  const c0 = b[at]! | (b[at + 1]! << 8), c1 = b[at + 2]! | (b[at + 3]! << 8)
  const a = r565(c0), z = r565(c1)
  if (c0 > c1 || mode === 'four') {
    return [[...a, 255], [...z, 255],
      [Math.round((2 * a[0] + z[0]) / 3), Math.round((2 * a[1] + z[1]) / 3), Math.round((2 * a[2] + z[2]) / 3), 255],
      [Math.round((a[0] + 2 * z[0]) / 3), Math.round((a[1] + 2 * z[1]) / 3), Math.round((a[2] + 2 * z[2]) / 3), 255]]
  }
  return [[...a, 255], [...z, 255], [Math.round((a[0] + z[0]) / 2), Math.round((a[1] + z[1]) / 2), Math.round((a[2] + z[2]) / 2), 255], mode === 'dxt1-alpha' ? [0, 0, 0, 0] : [0, 0, 0, 255]]
}

function decodeDxt(b: Uint8Array, at: number, w: number, h: number, kind: 1 | 3 | 5, oneBit: boolean): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), size = kind === 1 ? 8 : 16
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = at + (by * bw + bx) * size
    const colours = colourBlock(b, o + (kind === 1 ? 0 : 8), kind !== 1 ? 'four' : oneBit ? 'dxt1-alpha' : 'dxt1')
    const alpha = new Uint8Array(16)
    if (kind === 3) {
      for (let i = 0; i < 16; i++) alpha[i] = (((b[o + (i >> 1)]! >> ((i & 1) * 4)) & 15) * 17)
    } else if (kind === 5) {
      const a0 = b[o]!, a1 = b[o + 1]!
      const ramp = a0 > a1
        ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map(k => Math.round(((7 - k) * a0 + k * a1) / 7))]
        : [a0, a1, ...[1, 2, 3, 4].map(k => Math.round(((5 - k) * a0 + k * a1) / 5)), 0, 255]
      // 16 three-bit indices in 6 bytes
      let bits = 0n
      for (let i = 0; i < 6; i++) bits |= BigInt(b[o + 2 + i]!) << BigInt(8 * i)
      for (let i = 0; i < 16; i++) alpha[i] = ramp[Number((bits >> BigInt(3 * i)) & 7n)]!
    }
    const cb = o + (kind === 1 ? 0 : 8)
    const idx = b[cb + 4]! | (b[cb + 5]! << 8) | (b[cb + 6]! << 16) | (b[cb + 7]! << 24)
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py
      if (x >= w || y >= h) continue
      const c = colours[(idx >>> (2 * (py * 4 + px))) & 3]!
      const p = (y * w + x) * 4
      out[p] = c[0]!; out[p + 1] = c[1]!; out[p + 2] = c[2]!
      out[p + 3] = kind === 1 ? c[3]! : alpha[py * 4 + px]!
    }
  }
  return out
}

function decodePlain(b: Uint8Array, at: number, w: number, h: number, format: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    switch (format) {
      case FORMAT.RGBA8888: { const o = at + i * 4; out[p] = b[o]!; out[p + 1] = b[o + 1]!; out[p + 2] = b[o + 2]!; out[p + 3] = b[o + 3]!; break }
      case FORMAT.ABGR8888: { const o = at + i * 4; out[p] = b[o + 3]!; out[p + 1] = b[o + 2]!; out[p + 2] = b[o + 1]!; out[p + 3] = b[o]!; break }
      case FORMAT.ARGB8888: { const o = at + i * 4; out[p] = b[o + 1]!; out[p + 1] = b[o + 2]!; out[p + 2] = b[o + 3]!; out[p + 3] = b[o]!; break }
      case FORMAT.BGRA8888: { const o = at + i * 4; out[p] = b[o + 2]!; out[p + 1] = b[o + 1]!; out[p + 2] = b[o]!; out[p + 3] = b[o + 3]!; break }
      case FORMAT.BGRX8888: { const o = at + i * 4; out[p] = b[o + 2]!; out[p + 1] = b[o + 1]!; out[p + 2] = b[o]!; out[p + 3] = 255; break }
      case FORMAT.RGB888: { const o = at + i * 3; out[p] = b[o]!; out[p + 1] = b[o + 1]!; out[p + 2] = b[o + 2]!; out[p + 3] = 255; break }
      case FORMAT.BGR888: { const o = at + i * 3; out[p] = b[o + 2]!; out[p + 1] = b[o + 1]!; out[p + 2] = b[o]!; out[p + 3] = 255; break }
      case FORMAT.IA88: { const o = at + i * 2; out[p] = out[p + 1] = out[p + 2] = b[o]!; out[p + 3] = b[o + 1]!; break }
      case FORMAT.I8: out[p] = out[p + 1] = out[p + 2] = b[at + i]!; out[p + 3] = 255; break
      case FORMAT.A8: out[p] = out[p + 1] = out[p + 2] = 255; out[p + 3] = b[at + i]!; break
    }
  }
  return out
}

/**
 * The texture as pixels, at the largest mip level that is at most `maxSide` on its longer side (or the smallest there is), or null for a file
 * that is not a texture, is cut off, is a kind this does not read (a cube map, a volume, a float or a bump format) or is too large to trust.
 */
export function readVtf(file: Uint8Array, maxSide = 256): Pixels | null {
  try { return read(file, maxSide) } catch (e) { if (e instanceof RangeError) return null; throw e }
}

function read(b: Uint8Array, maxSide: number): Pixels | null {
  if (b.length < 64 || b[0] !== 0x56 || b[1] !== 0x54 || b[2] !== 0x46 || b[3] !== 0) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const major = v.getUint32(4, true), minor = v.getUint32(8, true)
  if (major !== 7 || minor > 6) return null
  const headerSize = v.getUint32(12, true)
  const width = v.getUint16(16, true), height = v.getUint16(18, true)
  const flags = v.getUint32(20, true), frames = Math.max(1, v.getUint16(24, true))
  const format = v.getInt32(52, true), mips = b[56]!
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || mips < 1 || mips > MAX_MIPS || headerSize < 64 || headerSize > b.length) return null
  if (flags & 0x4000) return null // an environment map: six faces
  const depth = minor >= 2 ? Math.max(1, v.getUint16(63, true)) : 1
  if (depth > 1) return null
  if (imageBytes(format, 1, 1) === null) return null

  // Where the image data of the largest mip starts: from the resource list (7.3 and later) or after the low-resolution thumbnail.
  let dataAt = -1
  if (minor >= 3) {
    const n = v.getUint32(68, true)
    if (n > 64) return null
    for (let i = 0; i < n; i++) {
      const o = 80 + i * 8
      if (o + 8 > b.length) return null
      if (b[o] === 0x30 && b[o + 1] === 0 && b[o + 2] === 0) dataAt = v.getUint32(o + 4, true)
    }
  } else {
    const lowFormat = v.getInt32(57, true), lw = b[61]!, lh = b[62]!
    const low = lw && lh ? imageBytes(lowFormat, lw, lh) : 0
    if (low === null) return null
    dataAt = headerSize + low
  }
  if (dataAt < 0 || dataAt > b.length) return null

  // The mips are stored from the smallest to the largest; take the largest that fits.
  const dims = (level: number) => [Math.max(1, width >> level), Math.max(1, height >> level)] as const
  let level = 0
  while (level < mips - 1 && Math.max(...dims(level)) > maxSide) level++
  let at = dataAt
  for (let l = mips - 1; l > level; l--) {
    const [w, h] = dims(l)
    at += imageBytes(format, w, h)! * frames
  }
  const [w, h] = dims(level)
  const size = imageBytes(format, w, h)!
  if (at + size > b.length) return null
  const rgba = format === FORMAT.DXT1 || format === FORMAT.DXT1_ONEBITALPHA ? decodeDxt(b, at, w, h, 1, format === FORMAT.DXT1_ONEBITALPHA)
    : format === FORMAT.DXT3 ? decodeDxt(b, at, w, h, 3, false)
    : format === FORMAT.DXT5 ? decodeDxt(b, at, w, h, 5, false)
    : decodePlain(b, at, w, h, format)
  return { width: w, height: h, rgba }
}
