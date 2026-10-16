import { formatLastSeen } from '../services/ServerUtils'

/**
 * A server's last heartbeat. The server renders a readable fallback; in the browser Alpine
 * replaces it with the time in the VIEWER's timezone (the backend's own timezone is
 * meaningless to whoever is looking). No timestamp renders "Never".
 */
export const Heartbeat = ({ lastSeen, class: cls }: { lastSeen: string | null, class?: string }) => {
  const parsed = lastSeen ? new Date(lastSeen) : null
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return <span class={cls}>{formatLastSeen(lastSeen)}</span>
  }

  return (
    <time
      datetime={parsed.toISOString()}
      class={cls}
      x-data="{}"
      x-text="new Date($el.getAttribute('datetime')).toLocaleString()"
    >
      {formatLastSeen(lastSeen)}
    </time>
  )
}
