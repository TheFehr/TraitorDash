import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddonFetcher } from '../../src/services/workshop'
import type { HttpPost } from '../../src/services/workshopCollection'

/** A fake download: addons by id (an archive, or an error text), each fetch in a job directory of its own that `cleanup` removes. */
export function fakeAddons(addons: Record<string, Buffer | string>, opts: { onFetch?: (id: string) => void | Promise<void>, delayMs?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ws-fake-'))
  const log: { id: string, at: number, dir: string | null }[] = []
  let active = 0, peak = 0, n = 0
  const fetcher: AddonFetcher = async (id) => {
    active++; peak = Math.max(peak, active)
    const entry = { id, at: Date.now(), dir: null as string | null }
    log.push(entry)
    try {
      await opts.onFetch?.(id)
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      const a = addons[id]
      if (a === undefined) return { error: 'The download failed (the helper said: Error: no such item)' }
      if (typeof a === 'string') return { error: a }
      const dir = join(base, `job-${++n}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'addon.gma'), a)
      entry.dir = dir
      return { paths: [join(dir, 'addon.gma')], bytes: a.length, cleanup: async () => { rmSync(dir, { recursive: true, force: true }) } }
    } finally { active-- }
  }
  return { fetcher, log, peak: () => peak, base, jobsLeft: () => log.filter(l => l.dir && existsSync(l.dir)).length, done: () => rmSync(base, { recursive: true, force: true }) }
}

type Child = { publishedfileid: string, sortorder: number, filetype: number }
/** A fake Steam: collections by id (children), details by item id. */
export function fakeSteam(collections: Record<string, Child[]>, details: Record<string, { title: string, time_updated: number }> = {}) {
  const calls: { name: string, ids: string[] }[] = []
  const post: HttpPost = async (url, form) => {
    const name = url.split('/').slice(-3, -2)[0]!
    const ids = Object.entries(form).filter(([k]) => k.startsWith('publishedfileids[')).map(([, v]) => v)
    calls.push({ name, ids })
    if (name === 'GetCollectionDetails') return { status: 200, text: JSON.stringify({ response: { result: 1, collectiondetails: ids.map(id => collections[id] ? { publishedfileid: id, result: 1, children: collections[id] } : { publishedfileid: id, result: 9 }) } }) }
    return { status: 200, text: JSON.stringify({ response: { result: 1, publishedfiledetails: ids.map(id => details[id] ? { publishedfileid: id, result: 1, file_type: 0, ...details[id] } : { publishedfileid: id, result: 9 }) } }) }
  }
  return { post, calls, details, collections }
}
export const items = (...ids: string[]): Child[] => ids.map((id, i) => ({ publishedfileid: id, sortorder: i, filetype: 0 }))
