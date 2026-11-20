import { WSID } from './validators'

// RFC 40, 3.1: the server's Workshop collection as the list of addons. The collection is resolved with Steam's public Web API
// (`ISteamRemoteStorage`, no key), through sub-collections, into addon ids with titles and update times. Everything is bounded: a
// hostile or looping collection costs a few requests and ends with a note, never a hang or a huge list.

/** The Workshop id of the collection (`WORKSHOP_COLLECTION`, digits only), or null: the feature is off. */
export function workshopCollectionId(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env.WORKSHOP_COLLECTION ?? '').trim()
  return WSID.test(v) ? v : null
}
/** Is the feature on? Off with no setting or one that is not digits (nothing changes then). */
export const workshopEnabled = () => workshopCollectionId() !== null

export interface CollectionLimits {
  /** How deep sub-collections are followed (the collection itself is depth 0). */
  maxDepth: number
  /** How many collections (the first and its sub-collections) are read. */
  maxCollections: number
  /** How many addons are kept. A safety ceiling far above any real server; when it bites the result says so. */
  maxItems: number
  /** The biggest response body that is read, in bytes. */
  maxResponseBytes: number
}
export const COLLECTION_LIMITS: CollectionLimits = { maxDepth: 6, maxCollections: 100, maxItems: 20_000, maxResponseBytes: 16 * 1024 * 1024 }

/** One POST of a form; the answer's text. Injected, so tests give constructed responses and nothing touches the network. */
export type HttpPost = (url: string, form: Record<string, string>) => Promise<{ status: number, text: string }>

export interface CollectionAddon { id: string, title: string | null, updated: number, order: number }
export interface CollectionResult {
  addons: CollectionAddon[]
  /** Collections read (the first one and its sub-collections). */
  collections: number
  /** What was left out or went wrong, in words, for the page. */
  notes: string[]
}

const API = 'https://api.steampowered.com/ISteamRemoteStorage'

/** The real POST: one request with a time limit, the body read with a size limit. */
export function steamPost(maxBytes = COLLECTION_LIMITS.maxResponseBytes, timeoutMs = 30_000): HttpPost {
  return async (url, form) => {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(form), signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('the response is too large')
    const reader = res.body?.getReader()
    if (!reader) return { status: res.status, text: '' }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('the response is too large') }
      chunks.push(value)
    }
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8') }
  }
}

async function call(post: HttpPost, name: string, form: Record<string, string>, maxBytes: number): Promise<any> {
  const r = await post(`${API}/${name}/v1/`, form)
  if (r.status !== 200) throw new Error(`Steam answered ${r.status} to ${name}`)
  if (r.text.length > maxBytes) throw new Error('the response is too large')
  let json: any
  try { json = JSON.parse(r.text) } catch { throw new Error(`Steam's answer to ${name} is not JSON`) }
  return json?.response ?? null
}

/** The details (title, update time, kind) of up to `ids.length` Workshop items, 100 to a request. Items the answer lacks are left out. */
export async function itemDetails(post: HttpPost, ids: string[], maxBytes = COLLECTION_LIMITS.maxResponseBytes): Promise<Map<string, { title: string | null, updated: number, collection: boolean }>> {
  const out = new Map<string, { title: string | null, updated: number, collection: boolean }>()
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const form: Record<string, string> = { itemcount: String(batch.length) }
    batch.forEach((id, k) => { form[`publishedfileids[${k}]`] = id })
    const res = await call(post, 'GetPublishedFileDetails', form, maxBytes)
    const list: unknown = res?.publishedfiledetails
    if (!Array.isArray(list)) continue
    for (const d of list.slice(0, 100)) {
      const id = String(d?.publishedfileid ?? '')
      if (!WSID.test(id) || !batch.includes(id) || d?.result !== 1) continue
      const title = typeof d.title === 'string' ? d.title.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : null
      const updated = Number.isSafeInteger(d.time_updated) && d.time_updated >= 0 ? d.time_updated : 0
      out.set(id, { title, updated, collection: d.file_type === 2 })
    }
  }
  return out
}

/**
 * The addons of a collection, through its sub-collections (a child that is itself a collection is expanded), deduplicated, in the order the
 * collection lists them. A loop (a collection that contains itself, or two that contain each other) is read once; the depth, the number of
 * collections, the number of addons and the size of an answer are bounded, and what a bound left out is said in `notes`.
 */
export async function resolveCollection(id: string, post: HttpPost, limits: CollectionLimits = COLLECTION_LIMITS): Promise<CollectionResult> {
  const notes: string[] = []
  const seenCollections = new Set<string>([id])
  const items: string[] = []
  const seenItems = new Set<string>()
  let level = [id]
  let depth = 0
  let read = 0
  let truncated = false
  while (level.length > 0) {
    const next: string[] = []
    // Collections of one level go in one request each (the API takes several; one keeps an answer small).
    for (const cid of level) {
      if (read >= limits.maxCollections) { notes.push(`More than ${limits.maxCollections} collections: the rest were not read.`); level = []; next.length = 0; break }
      read++
      const res = await call(post, 'GetCollectionDetails', { collectioncount: '1', 'publishedfileids[0]': cid }, limits.maxResponseBytes)
      const details = res?.collectiondetails?.[0]
      if (!details || details.result !== 1 || !Array.isArray(details.children)) {
        notes.push(cid === id ? 'The collection could not be read (it is private, removed, or not a collection).' : `The sub-collection ${cid} could not be read.`)
        continue
      }
      const children = [...details.children].filter((c: any) => c && typeof c === 'object')
        .sort((a: any, b: any) => (Number(a.sortorder) || 0) - (Number(b.sortorder) || 0))
      for (const child of children) {
        const cidn = String(child.publishedfileid ?? '')
        if (!WSID.test(cidn)) continue
        if (child.filetype === 2) {
          if (seenCollections.has(cidn)) continue // a loop, or a collection listed twice
          if (depth + 1 > limits.maxDepth) { notes.push(`A sub-collection is nested deeper than ${limits.maxDepth} levels: it was not read.`); continue }
          seenCollections.add(cidn)
          next.push(cidn)
        } else if (!seenItems.has(cidn)) {
          if (items.length >= limits.maxItems) { truncated = true; continue }
          seenItems.add(cidn)
          items.push(cidn)
        }
      }
    }
    level = next
    depth++
  }
  if (truncated) notes.push(`More than ${limits.maxItems} addons: the rest were left out (a safety ceiling).`)

  const details = items.length ? await itemDetails(post, items, limits.maxResponseBytes).catch(e => { notes.push(`Titles and update times could not be read: ${e instanceof Error ? e.message : e}`); return new Map<string, { title: string | null, updated: number, collection: boolean }>() }) : new Map()
  const addons: CollectionAddon[] = items.map((aid, order) => ({ id: aid, title: details.get(aid)?.title ?? null, updated: details.get(aid)?.updated ?? 0, order }))
  return { addons, collections: read, notes }
}
