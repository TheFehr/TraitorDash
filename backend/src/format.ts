/** How the pages write numbers: durations, percentages, sizes, ratios. Pure, so the browser bundle can use them too. */

/** "m:ss" for a time in ms; never negative. */
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "m:ss" for a length in seconds, "–" when it is not known. */
export const duration = (seconds: number | null): string => (seconds === null ? '–' : clock(seconds * 1000))

/** "42%" for part of whole, "–" when there is no whole. */
export const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–')

/** Kills per death with two decimals; no deaths counts as one. */
export const kd = (kills: number, deaths: number): string => (kills / Math.max(deaths, 1)).toFixed(2)

const MB = 1024 * 1024
/** Megabytes without the unit: one decimal under 10 MB, none above. */
export const mb = (bytes: number): string => (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)

/** "23 MB" for a file size in whole megabytes, "–" when it is not known. */
export const mapSize = (bytes: number | null): string => (bytes === null ? '–' : `${Math.round(bytes / MB)} MB`)

/** "just now", "5 min ago", "2 h ago", "3 d ago" for an ISO instant; "–" when it is not known. `now` is in ms. */
export const ago = (iso: string | null, now: number = Date.now()): string => {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return '–'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
