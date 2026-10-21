import { publicRoles } from '../services/roleview'
import { LINK_BTN, TAB_ON } from '../ui'

export type Section = 'stats' | 'maps' | 'roles'

/** The public sections of a server, as the links every public page shows so none is a dead end. */
export const sectionsOf = (serverId: string): { key: Section, label: string, href: string }[] => [
  { key: 'stats', label: '📊 Round stats', href: `/servers/${serverId}/stats` },
  { key: 'maps', label: '🗺 Maps', href: `/servers/${serverId}/maps` },
  ...(publicRoles() ? [{ key: 'roles' as const, label: '📖 Roles', href: `/servers/${serverId}/roles` }] : []),
]

/** Links to the other public pages of the server; the page itself is marked and is not a link to itself. A page inside a section (a player, a replay) passes none: all three are links. */
export const SectionLinks = ({ serverId, current }: { serverId: string, current?: Section }) => (
  <nav data-sections aria-label="Sections" class="flex flex-wrap gap-2 mt-4">
    {sectionsOf(serverId).map(s => s.key === current
      ? <span aria-current="page" class={`${LINK_BTN} ${TAB_ON} border-transparent hover:text-white`}>{s.label}</span>
      : <a href={s.href} class={LINK_BTN}>{s.label}</a>)}
  </nav>
)
