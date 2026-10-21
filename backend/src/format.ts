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
