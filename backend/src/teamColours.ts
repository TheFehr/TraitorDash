/**
 * Teams and colours in one place, for the replay (browser), the overview and the public pages.
 * Plain data and functions, nothing that needs a DOM or the database.
 */

/** A colour as the database and the pages carry it: `#rrggbb`, lower case. */
export const HEX6 = /^#[0-9a-f]{6}$/

/** 0xRRGGBB as `#rrggbb`. */
export const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0')

/** What a team is called and what colour it gets; the order is the order the overview lists them in. */
export const TEAMS: Record<string, { label: string, colour: number }> = {
  innocents: { label: 'Innocents', colour: 0x22c55e },
  traitors: { label: 'Traitors', colour: 0xdc2626 },
  detectives: { label: 'Detectives', colour: 0x1f4dbf },
  necromancers: { label: 'Necromancers', colour: 0xa855f7 },
  jackals: { label: 'Jackals', colour: 0xf97316 },
  infecteds: { label: 'Infected', colour: 0x14b8a6 },
  nones: { label: 'Neutral / Other', colour: 0x9ca3af },
  unknown: { label: 'Uncategorized', colour: 0x9ca3af },
}

const SINGULAR: Record<string, string> = {
  innocent: 'innocents', traitor: 'traitors', detective: 'detectives', necromancer: 'necromancers',
  jackal: 'jackals', infected: 'infecteds', none: 'nones',
}

/** The table's key for a team name, or null when the table does not know it. */
const keyOf = (team: string | null): string | null => {
  const t = (team ?? '').toLowerCase()
  const k = SINGULAR[t] ?? t
  return Object.prototype.hasOwnProperty.call(TEAMS, k) ? k : null
}

/** The label of a team, or the name itself when it is not in the table. */
export const teamLabel = (team: string): string => TEAMS[keyOf(team) ?? '']?.label ?? team

/** A colour (0xRRGGBB) for a team: the ones in the table are fixed, others get a stable hue from their name. */
export function teamColour(team: string | null): number {
  const t = (team ?? '').toLowerCase()
  if (t === '') return TEAMS.unknown!.colour
  const k = keyOf(t)
  if (k) return TEAMS[k]!.colour
  let h = 0
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 360
  // hsl(h, 65%, 55%) as RGB
  const s = 0.65, l = 0.55, kk = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(kk(n) - 3, Math.min(9 - kk(n), 1)))))
  return (f(0) << 16) | (f(8) << 8) | f(4)
}

/** The role's own colour (ROLE.color, as TTT2 shows it) as `#rrggbb`, else its team's. */
export const roleColour = (own: unknown, team: string | null): string =>
  typeof own === 'string' && HEX6.test(own) ? own : hex(teamColour(team))

/** A player's colour (0xRRGGBB): the colour of their role if `colours` (role name to `#rrggbb`) has one, else their team's. */
export function playerColour(colours: Record<string, string>, role: string | null, team: string | null): number {
  const own = role !== null && Object.prototype.hasOwnProperty.call(colours, role) ? colours[role] : undefined
  return typeof own === 'string' && HEX6.test(own) ? parseInt(own.slice(1), 16) : teamColour(team)
}
