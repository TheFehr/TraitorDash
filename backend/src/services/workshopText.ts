import { Store } from './Store'
import { WSID } from './validators'

/**
 * The text of Workshop pages, for roles whose addon ships no description (RFC 15). Fetched from
 * Steam's public API (no key), cached per addon, shown as plain text only. Untrusted: it is cleaned
 * here and rendered as text, never as HTML.
 */

const API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
const BATCH = 20
const OK_AGE_MS = 7 * 24 * 3600 * 1000       // a page that was read is read again after a week
const RETRY_AGE_MS = 3600 * 1000            // one that failed or was missing, after an hour
const MAX_RAW = 20000
const MAX_TEXT = 1500

export type Fetch = (url: string, init: { method: string, headers: Record<string, string>, body: string, signal: AbortSignal }) => Promise<{ ok: boolean, json: () => Promise<any> }>
let fetcher: Fetch = (url, init) => fetch(url, init) as any
/** For tests. */
export const setFetcher = (f: Fetch | null) => { fetcher = f ?? ((url, init) => fetch(url, init) as any) }

const ENTITIES: Record<string, string> = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

/**
 * A Workshop description (BBCode and a little HTML) as plain text: formatting tags dropped, list items
 * as "- " lines, links and images removed, blank runs collapsed, cut at a limit on a word. Null when
 * nothing readable is left.
 */
export function cleanWorkshopText(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = raw.slice(0, MAX_RAW)
    .replace(/\r/g, '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
    .replace(/\[(?:previewyoutube|video|img)[^\]]*\]/gi, '')
    .replace(/\[\*\]/g, '\n- ')
    .replace(/\[\/?(?:h[1-6]|p|list|olist|quote|table|tr|td|th|hr)[^\]]*\]/gi, '\n')
    .replace(/\[url(?:=[^\]]*)?\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z0-9]+(?:=[^\]]*)?\]/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/&(?:quot|amp|lt|gt|#39|apos|nbsp);/g, e => ENTITIES[e]!)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (t === '') return null
  if (t.length > MAX_TEXT) {
    const cut = t.slice(0, MAX_TEXT)
    t = cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_TEXT / 2)).trimEnd() + '…'
  }
  return t
}

/** The details of up to `BATCH` items: id to { title, description }, absent for an item Steam does not know. */
export async function fetchDetails(ids: string[]): Promise<Map<string, { title: string, description: string }>> {
  const body = new URLSearchParams({ itemcount: String(ids.length) })
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id))
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const r = await fetcher(API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: ctl.signal })
    if (!r.ok) throw new Error('Steam answered an error')
    const json = await r.json()
    const out = new Map<string, { title: string, description: string }>()
    for (const d of json?.response?.publishedfiledetails ?? []) {
      if (d?.result === 1 && typeof d.publishedfileid === 'string' && ids.includes(d.publishedfileid)) {
        out.set(d.publishedfileid, { title: String(d.title ?? '').slice(0, 200), description: typeof d.description === 'string' ? d.description : '' })
      }
    }
    return out
  } finally { clearTimeout(timer) }
}

/** Reads the pages that are missing or old, one batch at a time. Never throws: a failure is stored and retried later. */
export async function refreshWorkshopText(ids: string[], now = Date.now()): Promise<number> {
  const due = [...new Set(ids)].filter(id => WSID.test(id)).filter(id => {
    const known = Store.getWorkshopText(id)
    if (!known) return true
    return now - Date.parse(known.fetchedAt) > (known.status === 'ok' ? OK_AGE_MS : RETRY_AGE_MS)
  })
  let fetched = 0
  for (let i = 0; i < due.length; i += BATCH) {
    const batch = due.slice(i, i + BATCH)
    try {
      const found = await fetchDetails(batch)
      for (const id of batch) {
        const d = found.get(id)
        if (d) { Store.setWorkshopText(id, d.title, cleanWorkshopText(d.description), 'ok'); fetched++ }
        else Store.setWorkshopText(id, null, null, 'missing')
      }
    } catch (e) {
      console.warn(`[Workshop] Could not read ${batch.length} page(s): ${(e as Error).message}`)
      for (const id of batch) if (!Store.getWorkshopText(id)) Store.setWorkshopText(id, null, null, 'failed')
    }
  }
  return fetched
}
