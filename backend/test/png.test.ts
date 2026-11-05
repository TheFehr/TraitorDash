import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { encodePng } from '../src/maps/png'

// RFC 18, 4.6: the PNG writer for the textures of a map's mesh: valid chunks, the pixels back out, and nothing else.

const chunks = (png: Uint8Array) => {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: { type: string, data: Uint8Array, crc: number, ok: boolean }[] = []
  for (let at = 8; at < png.length;) {
    const n = v.getUint32(at), type = String.fromCharCode(...png.subarray(at + 4, at + 8)), data = png.subarray(at + 8, at + 8 + n)
    const crc = v.getUint32(at + 8 + n)
    out.push({ type, data, crc, ok: Bun.hash.crc32(png.subarray(at + 4, at + 8 + n)) === crc })
    at += 12 + n
  }
  return out
}

test('a PNG with a header, one block of data and an end, each with its checksum, whose pixels come back', () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8])
  const png = encodePng(3, 2, rgba)
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const cs = chunks(png)
  expect(cs.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  expect(cs.every(c => c.ok)).toBe(true)
  const head = new DataView(cs[0]!.data.buffer, cs[0]!.data.byteOffset)
  expect([head.getUint32(0), head.getUint32(4), cs[0]!.data[8], cs[0]!.data[9]]).toEqual([3, 2, 8, 6]) // 3 by 2, 8 bits, RGBA
  const raw = inflateSync(cs[1]!.data)
  expect(raw.length).toBe((3 * 4 + 1) * 2)
  expect(raw[0]).toBe(0); expect(raw[13]).toBe(0) // no filter on either row
  expect(Array.from(raw.subarray(1, 13))).toEqual(Array.from(rgba.subarray(0, 12)))
  expect(Array.from(raw.subarray(14, 26))).toEqual(Array.from(rgba.subarray(12, 24)))
})

test('pixels that are not width by height, or a size of nothing, are refused', () => {
  expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(RangeError)
  expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(RangeError)
  expect(() => encodePng(2, 0, new Uint8Array(0))).toThrow(RangeError)
})

test('a large plain texture is small, and the browser can read it', () => {
  const png = encodePng(256, 256, new Uint8Array(256 * 256 * 4).fill(7))
  expect(png.length).toBeLessThan(2000)
})
