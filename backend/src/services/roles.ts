import { Store, type LiveConVar } from './Store'
import { roleColour } from '../teamColours'

/**
 * A role is enabled unless the game server says otherwise: its `ttt_<role>_enabled` ConVar
 * has been reported and is off. A role with no report (not synced yet, or a role without
 * that ConVar) counts as enabled, so the "enabled only" filter never hides what it cannot
 * actually tell is disabled.
 */
export function isRoleEnabled(live: Record<string, LiveConVar>, roleName: string): boolean {
  const lv = live[`ttt_${roleName}_enabled`]
  if (!lv || !lv.present || lv.value === null) return true
  return !['0', 'false'].includes(lv.value.trim().toLowerCase())
}

/**
 * What the role overview can sort by. Every value is read from the live ConVars the game
 * server reported, so a role the server has not reported yet has no value (sorts last, shows "—").
 */
export const METRICS = {
  pct: { label: 'Role distribution' },
  max: { label: 'Max players' },
  minPlayers: { label: 'Min players' },
  minKarma: { label: 'Min karma' },
  random: { label: 'Spawn chance' },
  credits: { label: 'Starting credits' },
} as const

export type MetricKey = keyof typeof METRICS
export type RoleMetric = { sort: number | null, text: string }
export type RoleMetrics = Record<MetricKey, RoleMetric>

/** "max" 0 means no limit in TTT2: it sorts as the largest value and reads "unlimited". */
const UNLIMITED = 1e9

export function roleMetrics(live: Record<string, LiveConVar>, roleName: string): RoleMetrics {
  const read = (convar: string): number | null => {
    const lv = live[convar]
    if (!lv || !lv.present || lv.value === null || lv.value.trim() === '') return null
    const n = Number(lv.value)
    return Number.isFinite(n) ? n : null
  }
  const none: RoleMetric = { sort: null, text: '—' }
  const plain = (n: number | null): RoleMetric => (n === null ? none : { sort: n, text: String(n) })
  const percent = (n: number | null): RoleMetric => (n === null ? none : { sort: n, text: `${+n.toFixed(1)} %` })

  // The credits ConVar uses the role's ABBR as prefix (ttt_surv_credits_starting), which
  // the backend does not know, so find it by the role the bridge tagged it with.
  const creditsName = Object.entries(live).find(([name, lv]) => lv.role === roleName && name.endsWith('_credits_starting'))?.[0]

  const pct = read(`ttt_${roleName}_pct`)
  const max = read(`ttt_${roleName}_max`)

  return {
    pct: pct === null ? none : { sort: pct, text: `${+(pct * 100).toFixed(1)} %` },
    max: max === null ? none : max === 0 ? { sort: UNLIMITED, text: 'unlimited' } : plain(max),
    minPlayers: plain(read(`ttt_${roleName}_min_players`)),
    minKarma: plain(read(`ttt_${roleName}_karma_min`)),
    random: percent(read(`ttt_${roleName}_random`)),
    credits: plain(creditsName ? read(creditsName) : null),
  }
}

/** A server's roles, each with whether it is enabled and the values the overview sorts by. */
export function getRolesWithState(serverId: string) {
  const live = Store.getConVarValues(serverId)
  return Store.getRoles(serverId).map(role => ({
    ...role,
    colour: roleColour(role.color, role.team ?? null),
    enabled: isRoleEnabled(live, role.role_name),
    metrics: roleMetrics(live, role.role_name),
  }))
}
