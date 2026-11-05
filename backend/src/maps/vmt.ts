// RFC 18, 5: a material file (`.vmt`) as far as drawing a map needs it: which texture, and whether the texture is cut out or see-through. The
// file is untrusted text. A "patch" material (the one a map makes for a cubemap) says only which material it includes and what it changes.

const SEE_THROUGH = /["']?\$(alphatest|translucent|additive)["']?\s+["']?1/i
const ALPHATEST = /["']?\$alphatest["']?\s+["']?1/i
const ADDITIVE = /["']?\$additive["']?\s+["']?1/i
const BASETEXTURE = /["']?\$basetexture["']?\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'{}]+))/i
const BASETEXTURE2 = /["']?\$basetexture2["']?\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'{}]+))/i
const ALPHA = /["']?\$alpha["']?\s+["']?([0-9.]+)/i

/** What a material says that is needed to draw it. */
export interface Vmt {
  texture: string | null
  /** The second texture of a material that blends two (`$basetexture2`, the one of a displacement's vertex alpha), or null. */
  texture2: string | null
  /** `solid`: nothing cut out; `mask`: the texture's alpha cuts it out; `blend`: it is see-through. */
  kind: 'solid' | 'mask' | 'blend'
  alpha: number
  /** The material says its own `$alpha`; else a translucent texture with no alpha channel of its own gets a default (glass is not opaque). */
  explicitAlpha: boolean
  /** Added to what is behind it (a light shaft, a glow), which a plain blend cannot do: its brightness is made the alpha. */
  additive: boolean
}

const cleanTexture = (raw: string | undefined): string | null => {
  const t = raw?.trim().toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '')
  return t && /^[a-z0-9_ ./-]{1,200}$/.test(t) && !t.includes('..') ? t : null
}

/** The material of a file's text; null when it names no texture and is not see-through. */
export function parseMaterial(text: string): Vmt {
  const found = BASETEXTURE.exec(text)
  const alpha = Number(ALPHA.exec(text)?.[1])
  const seeThrough = SEE_THROUGH.test(text)
  const second = BASETEXTURE2.exec(text)
  return {
    texture: cleanTexture(found?.[1] ?? found?.[2] ?? found?.[3]),
    texture2: /worldvertextransition/i.test(text) ? cleanTexture(second?.[1] ?? second?.[2] ?? second?.[3]) : null,
    kind: !seeThrough ? 'solid' : ALPHATEST.test(text) ? 'mask' : 'blend',
    alpha: Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? alpha : 1,
    explicitAlpha: Number.isFinite(alpha) && alpha >= 0 && alpha <= 1,
    additive: ADDITIVE.test(text) && !ALPHATEST.test(text),
  }
}

/** The material of a file's text if it is see-through (what the props need to know), else null. */
export const parseSeeThrough = (text: string): Vmt | null => { const m = parseMaterial(text); return m.kind === 'solid' ? null : m }

const PATCH = /^\s*["']?patch["']?\s*\{/i
const INCLUDE = /["']?include["']?\s+["']([^"'\r\n]+)["']/i

/** Whether a material file is a patch, and the material it includes (a path as the game writes it, `materials/...vmt`). */
export function patchOf(text: string): string | null {
  if (!PATCH.test(text)) return null
  const raw = INCLUDE.exec(text)?.[1]?.trim().toLowerCase().replace(/\\/g, '/')
  return raw && /^[a-z0-9_ ./-]{1,200}\.vmt$/.test(raw) && !raw.includes('..') ? raw : null
}

/** The text of a patch laid over the text it includes: what it inserts or replaces is put in front, where the first of a key wins. */
export function applyPatch(included: string, patch: string): string {
  const lines: string[] = []
  for (const block of ['insert', 'replace']) {
    const at = new RegExp(`["']?${block}["']?\\s*\\{`, 'i').exec(patch)
    if (!at) continue
    let depth = 1, i = at.index + at[0].length
    const start = i
    for (; i < patch.length && depth > 0; i++) { if (patch[i] === '{') depth++; else if (patch[i] === '}') depth-- }
    lines.push(patch.slice(start, i - 1))
  }
  return `${lines.join('\n')}\n${included}`
}
