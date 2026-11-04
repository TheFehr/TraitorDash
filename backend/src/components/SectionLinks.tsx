import { publicRoles } from '../services/roleview'

export type Section = 'stats' | 'maps' | 'roles'

/** The public sections of a server, as the links every public page shows so none is a dead end. */
export const sectionsOf = (serverId: string): { key: Section, label: string, href: string }[] => [
  { key: 'stats', label: '📊 Round stats', href: `/servers/${serverId}/stats` },
  { key: 'maps', label: '🗺 Maps', href: `/servers/${serverId}/maps` },
  ...(publicRoles() ? [{ key: 'roles' as const, label: '📖 Roles', href: `/servers/${serverId}/roles` }] : []),
]
