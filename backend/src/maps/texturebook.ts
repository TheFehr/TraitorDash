// RFC 18, 4.6 and 5: the textures of one map's mesh. A texture is read from the map's pack, or from the game's own files (`stock`, put there
// by the caller), decoded to a small size and kept as a PNG; each is read once for the whole map, and the whole book is held to limits (how
// many, how many bytes of PNG, the size of one file) so that no map can make a mesh of any size. Reading a texture that is not there, or
// is over a limit, gives null: whatever needed it is drawn without.

import type { ByteSource } from './bsp'
import { encodePng } from './png'
import { readPakMember, type Pak } from './pak'
import { readVtf, type Pixels } from './vtf'

export interface TextureLimits {
  /** Textures in the book. */
  textures: number
  /** The longer side of a texture, in pixels, unless a call asks for another. */
  side: number
  /** All the PNG in the book. */
  pngBytes: number
  /** One file read, unpacked. */
  memberBytes: number
}

export interface BookTexture { name: string, width: number, height: number, png: Uint8Array }

export class TextureBook {
  textures: BookTexture[] = []
  /** Textures of the game's own files, by path (`materials/<name>.vtf`); the pack's are looked at first. */
  stock = new Map<string, Uint8Array>()
  /** How many of the textures written came from the game's own files. */
  fromGame = 0
  private index = new Map<string, number | null>()
  private alpha = new Map<number, boolean>()
  private averages = new Map<string, [number, number, number] | null>()
  private bytes = 0

  constructor(private src: ByteSource, private pak: Pak, private limits: TextureLimits) {}

  /** Whether the file of a texture can be had: in the pack, or already fetched from the game. */
  has(name: string): boolean {
    const path = `materials/${name}.vtf`
    return this.pak.entries.has(path) || this.stock.has(path)
  }

  /** The decoded pixels of a texture at the largest size of at most `side`, or null. */
  async pixels(name: string, side: number): Promise<{ pixels: Pixels, inPack: boolean } | null> {
    const path = `materials/${name}.vtf`
    const inPack = this.pak.entries.has(path)
    if (!inPack && !this.stock.has(path)) return null
    const file = inPack ? await readPakMember(this.src, this.pak, path, { maxMemberBytes: this.limits.memberBytes }) : this.stock.get(path)!
    const pixels = file && file.length <= this.limits.memberBytes ? readVtf(file, side) : null
    return pixels ? { pixels, inPack } : null
  }

  /**
   * The texture as a PNG in the book: its index and whether it has any alpha (some pixel under 250). `additive`: the texture is a glow, so its
   * brightness is made its alpha (dark is nothing, bright is a soft glow). Null when it cannot be had or the book is full.
   */
  async texture(name: string, additive = false, side = this.limits.side): Promise<{ index: number, hasAlpha: boolean } | null> {
    const key = `${name}${side !== this.limits.side ? `|${side}` : ''}${additive ? '|additive' : ''}`
    const known = this.index.get(key)
    if (known !== undefined) return known === null ? null : { index: known, hasAlpha: this.alpha.get(known)! }
    let index: number | null = null
    if (this.textures.length < this.limits.textures) {
      const got = await this.pixels(name, side)
      if (got) {
        const { pixels } = got
        let clear = false
        for (let i = 3; i < pixels.rgba.length; i += 4) if (pixels.rgba[i]! < 250) { clear = true; break }
        if (additive) for (let i = 0; i < pixels.rgba.length; i += 4) { pixels.rgba[i + 3] = Math.round(Math.max(pixels.rgba[i]!, pixels.rgba[i + 1]!, pixels.rgba[i + 2]!) * 0.7); clear = true }
        const png = encodePng(pixels.width, pixels.height, pixels.rgba)
        if (this.bytes + png.length <= this.limits.pngBytes) {
          this.bytes += png.length
          if (!got.inPack) this.fromGame++
          index = this.textures.length
          this.alpha.set(index, clear)
          this.textures.push({ name: key, width: pixels.width, height: pixels.height, png })
        }
      }
    }
    this.index.set(key, index)
    return index === null ? null : { index, hasAlpha: this.alpha.get(index)! }
  }

  /** The average colour of a texture (sRGB, 0 to 1), over its opaque pixels; for a surface that is not worth a texture of its own. Null when it cannot be had. */
  async average(name: string): Promise<[number, number, number] | null> {
    if (this.averages.has(name)) return this.averages.get(name)!
    const got = await this.pixels(name, 8)
    let out: [number, number, number] | null = null
    if (got) {
      let r = 0, g = 0, b = 0, w = 0
      const p = got.pixels.rgba
      for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]! / 255; r += p[i]! * a; g += p[i + 1]! * a; b += p[i + 2]! * a; w += a }
      if (w > 0) out = [r / w / 255, g / w / 255, b / w / 255]
    }
    this.averages.set(name, out)
    return out
  }
}
