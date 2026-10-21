import { Store, type LiveConVar } from './Store'
import { roleColour, teamLabel } from '../teamColours'
import { cleanWorkshopText } from './workshopText'
import { isRoleEnabled, roleMetrics, METRICS, type MetricKey } from './roles'
import { cleanLabel, conVarDataText, humanizeKey, kindForConVarData, kindForLive, suffixOf, SUFFIX_TO_KEY, type FieldKind } from '../components/RoleConfigForm'
import { NAME, SMALL_INT } from './validators'

/**
 * What the public role page shows about one role (RFC 15, 4.2), built from a fixed selection of
 * fields: a field added to the stored objects later does not reach the page by itself.
 */
export interface RoleView {
  name: string
  team: string
  color: string
  enabled: boolean
  min: number | null
  /** The description from the language files, cleaned; null when the addon has none. */
  description: string | null
  /** What the server itself knows about the role, for a role the addon does not describe: its team, and whether it polices. */
  facts: string | null
  /** For a role the addon does not describe: the text of the Workshop page of the addon it comes from, when that page is about few roles. */
  workshop: { wsid: string, title: string, text: string, alsoCovers: string[] } | null
  numbers: { key: MetricKey, label: string, text: string }[]
  /** Null when the operator hides the settings (PUBLIC_ROLE_SETTINGS=0). */
  settings: { label: string, value: string | null, default: string | null }[] | null
}

/** `min` is the role's minimum player count as a number, null when the server has not reported it. */
export interface RoleListEntry { name: string, team: string, color: string, enabled: boolean, pct: string, minPlayers: string, min: number | null }

export { roleColour }

/** The number of players a page is shown for (`?players=`): a whole number from 1 to 128, else none. */
export function parsePlayers(raw: string | undefined | null): number | null {
  if (!raw || !SMALL_INT.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 128 ? n : null
}

/** An addon that holds more roles than this is a collection (the TTT2 base, a pack): its page is not about one role. */
export const MAX_ROLES_PER_PAGE = 3

/** The Workshop page text to show for a role, or null: its addon's, if read, readable and about few roles. */
export function workshopOf(serverId: string, roleName: string): RoleView['workshop'] {
  for (const a of Store.getRoleAddons(serverId, roleName)) {
    if (a.roles.length + 1 > MAX_ROLES_PER_PAGE) continue
    const t = Store.getWorkshopText(a.wsid)
    // the page is kept as Steam sent it and cleaned when shown, so a better cleaning needs no new fetch
    const text = t?.status === 'ok' ? cleanWorkshopText(t.description) : null
    if (t && text) return { wsid: a.wsid, title: t.title || a.title, text, alsoCovers: a.roles }
  }
  return null
}

/** A plain sentence from what is known without a description: the team, and a policing role says so. */
export function factsOf(team: string, policing: boolean): string | null {
  if (team === '') return policing ? 'It is a policing role.' : null
  return `Plays for the ${teamLabel(team)} team.` + (policing ? ' It is a policing role.' : '')
}

/** Operator switches (RFC 15, 4.2), read at each request. */
export const publicRoles = () => process.env.PUBLIC_ROLES !== '0'
export const publicRoleSettings = () => process.env.PUBLIC_ROLE_SETTINGS !== '0'

/** Role names are validated against the server's own list before anything is read. */
export const KNOWN_ROLE_NAME = NAME

const MAX_DESCRIPTION = 2000

/**
 * A language file's text as plain text: control characters and `<...>` markup removed, runs of
 * blanks collapsed, cut at a limit. It is still rendered as text and never as HTML.
 */
export function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text === '') return null
  return text.length > MAX_DESCRIPTION ? text.slice(0, MAX_DESCRIPTION - 1) + '…' : text
}

const show = (kind: FieldKind, v: string | null | undefined): string | null => {
  if (v === null || v === undefined || v === '') return null
  if (kind === 'toggle') return v === '0' || v.toLowerCase() === 'false' ? 'off' : 'on'
  // 0.170000 reads as 0.17: a ConVar prints its value with the zeros it was stored with
  if (kind === 'number' && /^-?\d+\.\d*0$/.test(v)) return v.replace(/0+$/, '').replace(/\.$/, '')
  return v
}
const showDefault = (kind: FieldKind, v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return show(kind, String(v))
}

type Live = Record<string, LiveConVar>

function settingsOf(schema: any[], live: Live, role: string) {
  const out: RoleView['settings'] & object = []
  const seen = new Set<string>()
  const add = (label: string, kind: FieldKind, convar: string, fallbackDefault: unknown) => {
    const lv = live[convar]
    seen.add(convar)
    out.push({
      label,
      value: lv && lv.present && lv.value !== null ? show(kind, lv.value) : null,
      default: showDefault(kind, lv?.default ?? fallbackDefault),
    })
  }
  for (const item of Array.isArray(schema) ? schema : []) {
    const args = item?.args ?? {}
    const convar = args.convar || args.serverConvar
    if (typeof convar !== 'string' || seen.has(convar)) continue
    const type = String(item?.type || '').toLowerCase()
    if (type === 'convardata') {
      const kind = kindForConVarData(args.key || '', args.value)
      add(conVarDataText(args.key || '').label, kind, convar, args.value)
    } else if (type === 'makecheckbox') add(cleanLabel(args.label || args.key), 'toggle', convar, null)
    else if (type === 'makeslider') add(cleanLabel(args.label || args.key), 'number', convar, null)
    else if (type === 'makecombobox' || type === 'maketextentry') add(cleanLabel(args.label || args.key), 'text', convar, null)
  }
  // settings the server has but the role file does not declare (random, traitor_button, ...)
  for (const [convar, lv] of Object.entries(live)) {
    if (seen.has(convar) || lv.role !== role || !lv.present || lv.value === null) continue
    const key = SUFFIX_TO_KEY[suffixOf(convar)]
    add(key ? conVarDataText(key).label : humanizeKey(suffixOf(convar)), kindForLive(lv), convar, null)
  }
  return out
}

/** The role's page, or null when the server or role is unknown. */
export function buildRoleView(serverId: string, roleName: string): RoleView | null {
  if (!KNOWN_ROLE_NAME.test(roleName)) return null
  const role = Store.getRoles(serverId).find(r => r.role_name === roleName)
  if (!role) return null
  const live = Store.getConVarValues(serverId)
  const metrics = roleMetrics(live, roleName)
  return {
    name: roleName,
    team: String(role.team ?? ''),
    color: roleColour(role.color, String(role.team ?? '')),
    enabled: isRoleEnabled(live, roleName),
    min: metrics.minPlayers.sort,
    description: cleanDescription(Store.getRoleDescription(serverId, roleName)),
    facts: factsOf(String(role.team ?? ''), !!role.is_policing),
    workshop: workshopOf(serverId, roleName),
    numbers: (Object.keys(METRICS) as MetricKey[]).map(key => ({ key, label: METRICS[key].label, text: metrics[key].text })),
    settings: publicRoleSettings() ? settingsOf(Store.getSchema(serverId, roleName) ?? [], live, roleName) : null,
  }
}

/** The server's roles for the list page, optionally narrowed by a search on the name. */
export function listRoles(serverId: string, query = ''): RoleListEntry[] {
  const live = Store.getConVarValues(serverId)
  const q = query.trim().toLowerCase().slice(0, 64)
  return Store.getRoles(serverId)
    .filter(r => q === '' || String(r.role_name).toLowerCase().includes(q))
    .map(r => {
      const m = roleMetrics(live, r.role_name)
      const team = String(r.team ?? '')
      return { name: String(r.role_name), team, color: roleColour(r.color, team), enabled: isRoleEnabled(live, r.role_name), pct: m.pct.text, minPlayers: m.minPlayers.text, min: m.minPlayers.sort }
    })
}
