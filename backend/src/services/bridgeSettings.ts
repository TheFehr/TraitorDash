// RFC 23: the bridge's own settings that the dashboard may change. The list is the same as in
// addon/lua/traitordash/settings.lua (a test compares the two): names, kinds, ranges and defaults. The words are only
// here. Not on it, on purpose: traitordash_url, traitordash_token and traitordash_public_url.

export type SettingKind = 'bool' | 'number'
export interface BridgeSetting {
  name: string
  kind: SettingKind
  default: string
  min?: number
  max?: number
  unit?: string
  group: 'Round stats' | 'Position tracking'
  label: string
  /** What it does and what it costs, in plain words. */
  explain: string
  /** When a change takes effect on the game server. */
  applies: 'at once' | 'next round'
}

export const BRIDGE_SETTINGS: BridgeSetting[] = [
  { name: 'traitordash_stats', kind: 'bool', default: '1', group: 'Round stats', applies: 'at once',
    label: 'Record round statistics',
    explain: 'Records who played which role, who won and who died, and sends it to the dashboard when a round ends. Off means no new rounds appear here.' },
  { name: 'traitordash_stats_debug', kind: 'bool', default: '1', group: 'Round stats', applies: 'at once',
    label: 'Print statistics to the console',
    explain: 'The server console says what was recorded at the end of each round. It costs nothing but console lines; switch it off to keep the console quiet.' },
  { name: 'traitordash_stats_bots', kind: 'bool', default: '0', group: 'Round stats', applies: 'next round',
    label: 'Record rounds with bots',
    explain: 'Rounds in which bots played are normally left out of the statistics. On records them too, which is useful for testing and clutters the history on a live server.' },
  { name: 'traitordash_track', kind: 'bool', default: '0', group: 'Position tracking', applies: 'next round',
    label: 'Record positions for the replay',
    explain: 'Samples where every player is, aims and shoots, which is what the round replay is made of. Every round with tracking takes space in the dashboard database, and each sample takes the game server a little time. Off means rounds have no replay.' },
  { name: 'traitordash_track_interval_min', kind: 'number', default: '0.2', min: 0.05, max: 2, unit: 's', group: 'Position tracking', applies: 'at once',
    label: 'Shortest time between samples',
    explain: 'How often positions are sampled while players move. A lower number makes a smoother replay and a bigger track, and costs the game server a little more at each sample. The default (0.2 s) is five samples a second; 0.1 s is ten and 0.05 s is twenty (a round is then cut off after 33 minutes).' },
  { name: 'traitordash_track_interval_max', kind: 'number', default: '1', min: 0.2, max: 5, unit: 's', group: 'Position tracking', applies: 'at once',
    label: 'Longest time between samples',
    explain: 'When nothing much happens (players standing still) the time between samples grows up to this. Keep it at or above the shortest time. A lower number makes a slightly bigger track.' },
  { name: 'traitordash_track_budget_ms', kind: 'number', default: '0.5', min: 0.05, max: 5, unit: 'ms', group: 'Position tracking', applies: 'at once',
    label: 'Time the sampling may take',
    explain: 'How long one sample may take on the game server before the sampling slows itself down. A higher number lets it keep a fast rate on a busy server and costs frame time; a lower one protects the frame rate and may thin out the replay.' },
]

const BY_NAME = new Map(BRIDGE_SETTINGS.map(s => [s.name, s]))
export const bridgeSetting = (name: string) => BY_NAME.get(name)

/** The value as the bridge will take it (the same writing each time), or an error. Mirrors CheckSettingValue in settings.lua. */
export function checkSettingValue(name: string, raw: unknown): { value: string } | { error: string } {
  const s = BY_NAME.get(name)
  if (!s) return { error: 'not a setting the dashboard may change' }
  if (typeof raw !== 'string') return { error: 'not a value' }
  const v = raw.trim()
  if (v.length === 0 || v.length > 8) return { error: 'not a value' }
  if (s.kind === 'bool') return v === '0' || v === '1' ? { value: v } : { error: 'must be on or off' }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return { error: 'not a number' }
  const n = Number(v)
  if (!(n >= s.min! && n <= s.max!)) return { error: `out of range (${s.min} to ${s.max})` }
  return { value: String(Number(n.toPrecision(4))) }
}

/** The command the bridge parses: `name value`. */
export const formatSettingCommand = (name: string, value: string) => `${name} ${value}`

/** What a server reported: only names on the list with a value that passes, nothing else is kept. */
export function cleanReport(body: any): { settings: Record<string, string>, saved: Record<string, string> } | null {
  if (!body || typeof body !== 'object' || body.format !== 1 || !body.settings || typeof body.settings !== 'object') return null
  const pick = (src: any) => {
    const out: Record<string, string> = {}
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out
    for (const [name, v] of Object.entries(src)) {
      const checked = checkSettingValue(name, typeof v === 'string' ? v : '')
      if ('value' in checked) out[name] = checked.value
    }
    return out
  }
  return { settings: pick(body.settings), saved: pick(body.saved) }
}
