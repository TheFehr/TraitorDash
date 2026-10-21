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

/** Sections of a Workshop page that are about the addon's upkeep, not about the role. */
const SKIP_HEADING = /convar|changelog|change log|install|requirement|credit|link|faq|donat|support|contact|discord|bug|report|workshop|collection|related|other roles|todo|how to|usage|command|setting|config|source|known issue|update/i
/** A link that was only a pointer ("here", "this page"): the sentence around it points at something that is gone. */
const POINTER = '\uE001', LINKED = '\uE000'

/** Drops the sections whose heading says they are about the addon's upkeep. The text before the first heading stays. */
function withoutUpkeep(raw: string): string {
  const heading = /\[h([1-6])\]([\s\S]*?)\[\/h\1\]/gi
  const marks = [...raw.matchAll(heading)]
  if (marks.length === 0) return raw
  let out = raw.slice(0, marks[0]!.index)
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : raw.length
    if (!SKIP_HEADING.test(m[2]!)) out += raw.slice(m.index!, end)
  })
  return out
}

/**
 * A Workshop description (BBCode and a little HTML) as plain text about the role: the sections about
 * the addon's upkeep (convars, links, changelog) and lines that only pointed at a link are dropped,
 * formatting tags go, list items become "- " lines, paragraphs stay apart, and the text is cut at a
 * limit on a word. Null when nothing readable is left.
 */
export function cleanWorkshopText(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = withoutUpkeep(raw.slice(0, MAX_RAW).replace(/\r/g, ''))
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
    .replace(/\[(?:previewyoutube|video|img)[^\]]*\]/gi, '')
    .replace(/\s*\[\*\]\s*/g, '\n- ')
    .replace(/\[\/?(?:list|olist)[^\]]*\]/gi, '\n')
    .replace(/\[\/?(?:h[1-6]|p|quote|table|tr|td|th|hr)[^\]]*\]/gi, '\n\n')
    .replace(/\[url(?:=[^\]]*)?\]([\s\S]*?)\[\/url\]/gi, (_m, label: string) => (/^\s*(here|this|link|this link|this page|click here|page)\s*$/i.test(label) ? POINTER : label))
    .replace(/\[\/?[a-z0-9]+(?:=[^\]]*)?\]/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/gi, LINKED)
    .replace(/&(?:quot|amp|lt|gt|#39|apos|nbsp);/g, e => ENTITIES[e]!)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const lines = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(l => {
    if (l.includes(POINTER)) return false
    if (/^(todo|tbd)$/i.test(l.replace(/^- /, ''))) return false
    if (/convar/i.test(l) || /^(#|ttt_)/.test(l)) return false
    if (l.includes(LINKED)) {
      const rest = l.split(LINKED).join('').trim()
      if (rest.length < 25 || rest.endsWith(':')) return false
    }
    return true
  }).map(l => l.split(LINKED).join('').trim())
  // a label with nothing under it ("Play Best With:" once its entries are gone)
  const kept = lines.filter((l, i) => {
    if (!l.endsWith(':')) return true
    const next = lines.slice(i + 1).find(x => x !== '')
    return next !== undefined && !next.endsWith(':')
  })
  t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
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

/** The pages of every addon any server reported that are missing or old: at start, and once a day, so a role does not wait for the next sync. */
export const refreshAllWorkshopText = () => refreshWorkshopText(Store.getAllRoleAddonIds())

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
        if (d) { Store.setWorkshopText(id, d.title, d.description.slice(0, MAX_RAW), 'ok'); fetched++ }
        else Store.setWorkshopText(id, null, null, 'missing')
      }
    } catch (e) {
      console.warn(`[Workshop] Could not read ${batch.length} page(s): ${(e as Error).message}`)
      for (const id of batch) if (!Store.getWorkshopText(id)) Store.setWorkshopText(id, null, null, 'failed')
    }
  }
  return fetched
}
