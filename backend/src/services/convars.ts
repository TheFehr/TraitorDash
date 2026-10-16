/**
 * Validates a ConVar value coming from the dashboard before it becomes part of a
 * console command on the game server.
 *
 * The ConVar NAME is already whitelisted against the extracted schema; the VALUE
 * used to be passed through verbatim, so a value such as "1\nquit" or "1;quit"
 * would have run a second console command. Only a conservative character set is
 * allowed: letters, digits, space and _ . : -
 *
 * Returns the value to send ("on"/"off" normalised to "1"/"0"), or null if it is unsafe.
 */
export function normalizeConVarValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length > 64) return null
  if (!/^[A-Za-z0-9_.: -]*$/.test(value)) return null

  const lower = value.toLowerCase()
  if (lower === 'on' || lower === 'true') return '1'
  if (lower === 'off' || lower === 'false') return '0'
  return value
}

/** Formats a validated value for a console command: quoted if empty or containing a space. */
export function formatConVarCommand(convar: string, value: string): string {
  return value === '' || value.includes(' ') ? `${convar} "${value}"` : `${convar} ${value}`
}
