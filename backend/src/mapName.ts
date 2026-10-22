// A map's file name is made for the engine: ttt_community_bowling_re_v1b, ttt_lttp_kakariko_a5_fixed. A
// player reads a name, so pages show a short one made from it and keep the file name beside it.

const PREFIXES = new Set(['ttt', 'gm', 'cs', 'de', 'zm', 'zs', 'ph', 'mu', 'rp', 'dm'])
// tags at the end of a name that say which version it is, not which map: v2, v1b, b5, a5, rc1, a year, final, fixed
const VERSION = /^(v\d+[a-z]?|b\d+[a-z]?|a\d+[a-z]?|rc\d*|\d{4}|final|fixed|fix|beta|alpha)$/i

/** "Community Bowling" from "ttt_community_bowling_v5a"; the file name itself when nothing is left of it. */
export function prettyMap(file: string): string {
  const parts = file.split('_').filter(Boolean)
  if (parts.length > 1 && PREFIXES.has(parts[0]!.toLowerCase())) parts.shift()
  while (parts.length > 1 && VERSION.test(parts[parts.length - 1]!)) parts.pop()
  const name = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  return name === '' ? file : name
}
