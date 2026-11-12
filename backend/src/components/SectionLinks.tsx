import { publicRoles } from '../services/roleview'
import { voiceConfig } from '../services/voice'

export type Section = 'stats' | 'maps' | 'roles' | 'voice'

/** The public sections of a server, as the links every public page shows so none is a dead end. */
export const sectionsOf = (serverId: string): { key: Section, label: string, href: string }[] => [
  { key: 'stats', label: '📊 Round stats', href: `/servers/${serverId}/stats` },
  { key: 'maps', label: '🗺 Maps', href: `/servers/${serverId}/maps` },
  ...(publicRoles() ? [{ key: 'roles' as const, label: '📖 Roles', href: `/servers/${serverId}/roles` }] : []),
  // The voice chat (RFC 27), only where the dashboard has a media server to join: without one the page says it is not set up, so no link leads to it.
  ...(voiceConfig() ? [{ key: 'voice' as const, label: '🎙 Voice', href: `/servers/${serverId}/voice` }] : []),
]
