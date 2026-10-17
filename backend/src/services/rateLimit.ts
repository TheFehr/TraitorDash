/**
 * A fixed-window limiter, per key, held in memory. Enough to stop a runaway or hostile client
 * from flooding an endpoint; it forgets everything on restart, which is fine for that job.
 * `now` is injectable so the window can be tested without waiting.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number, count: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Forgets all windows (for tests, which share one process and one limiter). */
  reset() { this.windows.clear() }

  /** Records one request for `key`. Returns 0 when allowed, else the seconds until the window resets. */
  hit(key: string): number {
    const t = this.now()
    const w = this.windows.get(key)
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 })
      return 0
    }
    if (w.count < this.limit) {
      w.count++
      return 0
    }
    return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000))
  }
}
