import { expect, test, describe } from 'bun:test'
import { readVtf } from '../src/maps/vtf'

// RFC 18, 4.6: a Source texture as pixels (the leaves of plants): the DXT formats and the plain ones, one mip, the sizes checked.

const FORMAT = { RGBA8888: 0, BGR888: 3, I8: 5, IA88: 6, A8: 8, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, DXT1A: 20 }
const bytes = (format: number, w: number, h: number) => {
  const blocks = Math.ceil(w / 4) * Math.ceil(h / 4)
  switch (format) {
    case FORMAT.DXT1: case FORMAT.DXT1A: return blocks * 8
    case FORMAT.DXT3: case FORMAT.DXT5: return blocks * 16
    case FORMAT.RGBA8888: case FORMAT.BGRA8888: return w * h * 4
    case FORMAT.BGR888: return w * h * 3
    case FORMAT.IA88: return w * h * 2
    default: return w * h
  }
}

interface Spec {
  width: number, height: number, format: number
  /** The image data of each mip level from the largest (level 0) down; filled with zeros when not given. */
  levels?: Uint8Array[]
  mips?: number
  minor?: number
  flags?: number
  frames?: number
  depth?: number
  /** A thumbnail of 16 by 16 in DXT1 after the header, as the game's files have. */
  thumbnail?: boolean
  version?: number
}
function vtf(s: Spec): Uint8Array {
  const minor = s.minor ?? 2, mips = s.mips ?? 1, frames = s.frames ?? 1
  const header = minor >= 3 ? 80 + 16 : minor === 2 ? 80 : 64 // 7.2 has the depth at byte 63, and its header is padded to 80, as the game's files are
  const thumb = s.thumbnail ? 128 : 0
  const dims = (l: number) => [Math.max(1, s.width >> l), Math.max(1, s.height >> l)] as const
  const levels = Array.from({ length: mips }, (_, l) => s.levels?.[l] ?? new Uint8Array(bytes(s.format, ...dims(l)) * frames))
  const data = Buffer.concat([...levels].reverse().map(l => Buffer.from(l))) // smallest first
  const out = Buffer.alloc(header + thumb + data.length)
  out.write('VTF\0', 0, 'latin1'); out.writeUInt32LE(s.version ?? 7, 4); out.writeUInt32LE(minor, 8); out.writeUInt32LE(header, 12)
  out.writeUInt16LE(s.width, 16); out.writeUInt16LE(s.height, 18); out.writeUInt32LE(s.flags ?? 0, 20); out.writeUInt16LE(frames, 24)
  out.writeInt32LE(s.format, 52); out.writeUInt8(mips, 56)
  out.writeInt32LE(s.thumbnail ? FORMAT.DXT1 : -1, 57); out.writeUInt8(s.thumbnail ? 16 : 0, 61); out.writeUInt8(s.thumbnail ? 16 : 0, 62)
  out.writeUInt16LE(s.depth ?? 1, 63)
  if (minor >= 3) {
    out.writeUInt32LE(2, 68)
    out.writeUInt32LE(0x01, 80); out.writeUInt32LE(header, 84) // the thumbnail's resource (tag 0x01)
    out.writeUInt32LE(0x30, 88); out.writeUInt32LE(header + thumb, 92) // the image data (tag 0x30)
  }
  data.copy(out, header + thumb)
  return out
}
const px = (p: { rgba: Uint8Array, width: number } | null, x: number, y: number) => Array.from(p!.rgba.subarray((y * p!.width + x) * 4, (y * p!.width + x) * 4 + 4))
const le16 = (v: number) => [v & 255, v >> 8]

describe('the DXT formats', () => {
  const colour = (c0: number, c1: number, indices: number[]) => { // 8 bytes: two 565 colours and 16 two-bit indices
    let bits = 0
    indices.forEach((v, i) => { bits |= v << (2 * i) })
    return [...le16(c0), ...le16(c1), bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]
  }
  const RED = 0xf800, BLUE = 0x001f, GREEN = 0x07e0

  test('DXT1: the four colours of a block, and the pixels in their places', () => {
    const idx = [0, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 0, 3, 2, 1, 0]
    const p = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT1, levels: [Uint8Array.from(colour(RED, BLUE, idx))] }))
    expect(p).toMatchObject({ width: 4, height: 4 })
    expect(px(p, 0, 0)).toEqual([255, 0, 0, 255]); expect(px(p, 1, 0)).toEqual([0, 0, 255, 255])
    expect(px(p, 2, 0)).toEqual([170, 0, 85, 255]); expect(px(p, 3, 0)).toEqual([85, 0, 170, 255]) // two thirds red and one third blue, and the other way
    expect(px(p, 0, 3)).toEqual([85, 0, 170, 255]); expect(px(p, 3, 3)).toEqual([255, 0, 0, 255])
  })

  test('DXT1: with the first colour not above the second there are three colours; the fourth is black, and clear in the format with one bit of alpha', () => {
    const block = Uint8Array.from(colour(BLUE, RED, [0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]))
    const plain = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT1, levels: [block] }))
    expect(px(plain, 2, 0)).toEqual([128, 0, 128, 255]) // half way
    expect(px(plain, 3, 0)).toEqual([0, 0, 0, 255])
    const cut = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT1A, levels: [block] }))
    expect(px(cut, 3, 0)).toEqual([0, 0, 0, 0])
    expect(px(cut, 0, 0)[3]).toBe(255)
  })

  test('DXT3: the alpha of each pixel is 4 bits, the colour block has four colours', () => {
    const alpha = Array.from({ length: 8 }, (_, i) => ((2 * i + 1) << 4) | (2 * i)) // pixel i has alpha i: 0, 1, 2 ... 15 in nibbles
    const p = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT3, levels: [Uint8Array.from([...alpha, ...colour(GREEN, BLUE, Array(16).fill(0))])] }))
    expect(px(p, 0, 0)).toEqual([0, 255, 0, 0])
    expect(px(p, 1, 0)).toEqual([0, 255, 0, 17])
    expect(px(p, 3, 3)).toEqual([0, 255, 0, 255])
  })

  test('DXT5: the alpha is a ramp of eight values from two end points, in either form', () => {
    const indices = (list: number[]) => { let bits = 0n; list.forEach((v, i) => { bits |= BigInt(v) << BigInt(3 * i) }); return Array.from({ length: 6 }, (_, i) => Number((bits >> BigInt(8 * i)) & 255n)) }
    const eight = indices([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]) // 255 .. 0 with 6 steps in between
    const a = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT5, levels: [Uint8Array.from([255, 0, ...eight, ...colour(RED, BLUE, Array(16).fill(0))])] }))
    expect([0, 1, 2, 3, 0, 1, 2, 3].map((x, i) => px(a, i < 4 ? i : i - 4, i < 4 ? 0 : 1)[3])).toEqual([255, 0, 219, 182, 146, 109, 73, 36])
    // a0 <= a1: six values and the two ends 0 and 255
    const six = indices([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0])
    const b = readVtf(vtf({ width: 4, height: 4, format: FORMAT.DXT5, levels: [Uint8Array.from([0, 250, ...six, ...colour(RED, BLUE, Array(16).fill(0))])] }))
    expect([px(b, 0, 0)[3], px(b, 1, 0)[3], px(b, 2, 0)[3], px(b, 3, 0)[3], px(b, 0, 1)[3], px(b, 1, 1)[3], px(b, 2, 1)[3], px(b, 3, 1)[3]]).toEqual([0, 250, 50, 100, 150, 200, 0, 255])
  })

  test('a size that is not a multiple of 4 decodes the pixels that are there', () => {
    const blocks = [colour(RED, BLUE, Array(16).fill(0)), colour(BLUE, RED, Array(16).fill(1))].flat() // 6 by 2: two blocks side by side
    const p = readVtf(vtf({ width: 6, height: 2, format: FORMAT.DXT1, levels: [Uint8Array.from(blocks)] }))
    expect(p).toMatchObject({ width: 6, height: 2 })
    expect(px(p, 3, 1)).toEqual([255, 0, 0, 255]); expect(px(p, 4, 0)).toEqual([255, 0, 0, 255])
  })
})

describe('the plain formats', () => {
  test('the order of the bytes of each', () => {
    const one = (format: number, b: number[]) => px(readVtf(vtf({ width: 1, height: 1, format, levels: [Uint8Array.from(b)] })), 0, 0)
    expect(one(FORMAT.BGRA8888, [10, 20, 30, 40])).toEqual([30, 20, 10, 40])
    expect(one(FORMAT.RGBA8888, [10, 20, 30, 40])).toEqual([10, 20, 30, 40])
    expect(one(FORMAT.BGR888, [10, 20, 30])).toEqual([30, 20, 10, 255])
    expect(one(FORMAT.I8, [77])).toEqual([77, 77, 77, 255])
    expect(one(FORMAT.IA88, [77, 99])).toEqual([77, 77, 77, 99])
    expect(one(FORMAT.A8, [55])).toEqual([255, 255, 255, 55])
  })
})

describe('which mip, which header', () => {
  const levels = [4, 2, 1].map((n, i) => Uint8Array.from(Array.from({ length: n * n }, () => [i * 100, 0, 0, 255]).flat())) // 4x4 (red 0), 2x2 (red 100), 1x1 (red 200), as RGBA
  const four = { width: 4, height: 4, format: FORMAT.RGBA8888, mips: 3, levels }

  test('the largest that fits the size asked for, else the smallest there is', () => {
    expect(readVtf(vtf(four), 256)).toMatchObject({ width: 4, height: 4 })
    expect(px(readVtf(vtf(four), 256), 0, 0)[0]).toBe(0)
    expect(readVtf(vtf(four), 2)).toMatchObject({ width: 2, height: 2 })
    expect(px(readVtf(vtf(four), 2), 1, 1)[0]).toBe(100)
    expect(px(readVtf(vtf(four), 1), 0, 0)[0]).toBe(200)
    expect(readVtf(vtf({ ...four, mips: 1, levels: [levels[0]!] }), 1)).toMatchObject({ width: 4, height: 4 }) // no smaller one to take
  })

  test('the thumbnail in front of the image, a header with a list of resources (7.3 and later), and many frames, are stepped over', () => {
    expect(px(readVtf(vtf({ ...four, thumbnail: true }), 2), 0, 0)[0]).toBe(100)
    expect(px(readVtf(vtf({ ...four, minor: 4, thumbnail: true }), 2), 0, 0)[0]).toBe(100)
    expect(px(readVtf(vtf({ ...four, minor: 1 }), 256), 0, 0)[0]).toBe(0)
    const twoFrames = vtf({ width: 2, height: 2, format: FORMAT.RGBA8888, mips: 2, frames: 2, levels: [Uint8Array.from([...Array(16).fill(50)]), Uint8Array.from([...Array(8).fill(9)])] })
    expect(px(readVtf(twoFrames, 256), 0, 0)).toEqual([50, 50, 50, 50]) // the first frame of the largest
    expect(px(readVtf(twoFrames, 1), 0, 0)).toEqual([9, 9, 9, 9])
  })
})

describe('files that are not what was expected', () => {
  const good = () => vtf({ width: 4, height: 4, format: FORMAT.RGBA8888 })
  test('not a texture, another version, a cut-off file, a cube map, a volume, a format that is not read, sizes that are not credible', () => {
    expect(readVtf(new Uint8Array(0))).toBeNull()
    expect(readVtf(Uint8Array.from(Buffer.from('not a texture at all, '.repeat(10))))).toBeNull()
    expect(readVtf(vtf({ width: 4, height: 4, format: FORMAT.RGBA8888, version: 8 }))).toBeNull()
    expect(readVtf(vtf({ width: 4, height: 4, format: FORMAT.RGBA8888, minor: 9 }))).toBeNull()
    expect(readVtf(good().subarray(0, 70))).toBeNull()
    expect(readVtf(vtf({ width: 4, height: 4, format: FORMAT.RGBA8888, flags: 0x4000 }))).toBeNull() // an environment map
    expect(readVtf(vtf({ width: 4, height: 4, format: FORMAT.RGBA8888, depth: 4 }))).toBeNull() // a volume
    expect(readVtf(vtf({ width: 4, height: 4, format: 24, levels: [new Uint8Array(32)] }))).toBeNull() // 16 bit floats
    const wide = Buffer.from(good()); wide.writeUInt16LE(60_000, 16)
    expect(readVtf(wide)).toBeNull()
    const zero = Buffer.from(good()); zero.writeUInt16LE(0, 16)
    expect(readVtf(zero)).toBeNull()
    const noMips = Buffer.from(good()); noMips.writeUInt8(0, 56)
    expect(readVtf(noMips)).toBeNull()
    const manyMips = Buffer.from(good()); manyMips.writeUInt8(99, 56)
    expect(readVtf(manyMips)).toBeNull()
    const reach = Buffer.from(vtf({ width: 4, height: 4, format: FORMAT.RGBA8888, minor: 4 })); reach.writeUInt32LE(0x7fffffff, 92)
    expect(readVtf(reach)).toBeNull() // the image data is said to start past the end
  })
  test('never throws, whatever the bytes', () => {
    let seed = 3
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 300; i++) {
      const b = Buffer.from(good())
      for (let k = 0; k < 6; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256)
      expect(() => readVtf(b)).not.toThrow()
    }
  })
})
