/** Small helpers for tests that build a pattern from text or take markup apart. */

/** The text as a pattern that matches it literally (every character the pattern syntax uses is escaped, the backslash too). */
export const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/=-]/g, '\\$&')

/** The page without the elements of one tag, found by position so a split or nested tag cannot slip through a pattern. */
export function withoutElements(html: string, tag: string): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  let out = ''
  let at = 0
  for (;;) {
    const from = html.indexOf(open, at)
    if (from < 0) return out + html.slice(at)
    out += html.slice(at, from)
    const to = html.indexOf(close, from)
    if (to < 0) return out
    at = to + close.length
  }
}
