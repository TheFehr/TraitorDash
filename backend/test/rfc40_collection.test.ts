import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { itemDetails, resolveCollection, workshopCollectionId, COLLECTION_LIMITS, type HttpPost } from '../src/services/workshopCollection'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// RFC 40, 3.1 and 6: the list. A constructed Steam, never the network.

type Child = { publishedfileid: string, sortorder: number, filetype: number }
const item = (id: string, order = 0): Child => ({ publishedfileid: id, sortorder: order, filetype: 0 })
const sub = (id: string, order = 0): Child => ({ publishedfileid: id, sortorder: order, filetype: 2 })

/** A fake Steam: `collections` by id, `details` by id; records every call. */
function steam(collections: Record<string, Child[]>, details: Record<string, { title: string, time_updated: number }> = {}) {
  const calls: { name: string, ids: string[] }[] = []
  const post: HttpPost = async (url, form) => {
    const name = url.split('/').slice(-3, -2)[0]!
    const ids = Object.entries(form).filter(([k]) => k.startsWith('publishedfileids[')).map(([, v]) => v)
    calls.push({ name, ids })
    if (name === 'GetCollectionDetails') {
      return { status: 200, text: JSON.stringify({ response: { result: 1, resultcount: 1, collectiondetails: ids.map(id => collections[id] ? { publishedfileid: id, result: 1, children: collections[id] } : { publishedfileid: id, result: 9 }) } }) }
    }
    return { status: 200, text: JSON.stringify({ response: { result: 1, resultcount: ids.length, publishedfiledetails: ids.map(id => details[id] ? { publishedfileid: id, result: 1, ...details[id] } : { publishedfileid: id, result: 9 }) } }) }
  }
  return { post, calls }
}

describe('the setting', () => {
  test('digits only; empty or anything else is off', () => {
    expect(workshopCollectionId({ WORKSHOP_COLLECTION: '3415635566' })).toBe('3415635566')
    expect(workshopCollectionId({ WORKSHOP_COLLECTION: ' 42 ' })).toBe('42')
    for (const bad of ['', undefined, 'abc', '12 34', '1234567890123', '-5', '12;rm', '0x10']) expect(workshopCollectionId({ WORKSHOP_COLLECTION: bad })).toBeNull()
  })
})

describe('the collection', () => {
  test('sub-collections are expanded, a duplicate is one addon, the order is the collection\'s', async () => {
    const s = steam({
      '1': [item('100', 2), sub('2', 1), item('101', 3), item('100', 4)],
      '2': [item('200', 1), sub('3', 2), item('101', 3)],
      '3': [item('300', 1)],
    }, { '100': { title: 'First', time_updated: 1000 }, '200': { title: 'Second', time_updated: 2000 } })
    const r = await resolveCollection('1', s.post)
    // level by level: the collection's own addons first, then those of its sub-collections
    expect(r.addons.map(a => a.id)).toEqual(['100', '101', '200', '300'])
    expect(r.collections).toBe(3)
    expect(r.addons[0]).toMatchObject({ id: '100', title: 'First', updated: 1000 })
    expect(r.addons[1]).toMatchObject({ id: '101', title: null, updated: 0 }) // no details: kept, without them
    expect(r.notes).toEqual([])
  })

  test('a loop is read once: a collection that contains itself, and two that contain each other', async () => {
    const s = steam({ '1': [sub('1'), sub('2'), item('10')], '2': [sub('1'), item('20')] })
    const r = await resolveCollection('1', s.post)
    expect(r.addons.map(a => a.id).sort()).toEqual(['10', '20'])
    expect(s.calls.filter(c => c.name === 'GetCollectionDetails')).toHaveLength(2)
  })

  test('a chain deeper than the depth guard stops, with a note, instead of walking on', async () => {
    const chain: Record<string, Child[]> = {}
    for (let i = 1; i <= 30; i++) chain[String(i)] = [item(String(1000 + i)), sub(String(i + 1))]
    const s = steam(chain)
    const r = await resolveCollection('1', s.post, { ...COLLECTION_LIMITS, maxDepth: 3 })
    expect(s.calls.filter(c => c.name === 'GetCollectionDetails').length).toBeLessThanOrEqual(4)
    expect(r.addons.length).toBeLessThanOrEqual(4)
    expect(r.notes.join(' ')).toMatch(/deeper than 3/)
  })

  test('a hostile collection of many sub-collections is bounded by the count guard', async () => {
    const wide: Record<string, Child[]> = { '1': Array.from({ length: 500 }, (_, i) => sub(String(2 + i))) }
    for (let i = 0; i < 500; i++) wide[String(2 + i)] = [item(String(10_000 + i))]
    const s = steam(wide)
    const r = await resolveCollection('1', s.post, { ...COLLECTION_LIMITS, maxCollections: 20 })
    expect(s.calls.filter(c => c.name === 'GetCollectionDetails')).toHaveLength(20)
    expect(r.collections).toBe(20)
    expect(r.notes.join(' ')).toMatch(/More than 20 collections/)
  })

  test('the number of addons is bounded and says so', async () => {
    const s = steam({ '1': Array.from({ length: 50 }, (_, i) => item(String(100 + i))) })
    const r = await resolveCollection('1', s.post, { ...COLLECTION_LIMITS, maxItems: 10 })
    expect(r.addons).toHaveLength(10)
    expect(r.notes.join(' ')).toMatch(/More than 10 addons/)
  })

  test('a huge response is refused by size, not parsed', async () => {
    const huge: HttpPost = async () => ({ status: 200, text: JSON.stringify({ response: { collectiondetails: [{ result: 1, children: [] }], pad: 'x'.repeat(5000) } }) })
    await expect(resolveCollection('1', huge, { ...COLLECTION_LIMITS, maxResponseBytes: 1000 })).rejects.toThrow(/too large/)
  })

  test('ids that are not digits are dropped; an unreadable collection is a note, not a crash', async () => {
    const s = steam({ '1': [item('12'), item('x; rm -rf /'), item('1234567890123'), item('')] })
    expect((await resolveCollection('1', s.post)).addons.map(a => a.id)).toEqual(['12'])
    const r = await resolveCollection('77', s.post)
    expect(r.addons).toEqual([])
    expect(r.notes[0]).toMatch(/could not be read/)
  })

  test('details are asked 100 to a request; titles are plain text', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => String(1000 + i))
    const s = steam({}, Object.fromEntries(ids.map(id => [id, { title: `T\u0007${id}`, time_updated: 5 }])))
    const d = await itemDetails(s.post, ids)
    expect(s.calls.map(c => c.ids.length)).toEqual([100, 100, 30])
    expect(d.size).toBe(230)
    expect(d.get('1000')!.title).toBe('T 1000')
  })

  test('an answer that is not 200 or not JSON is an error', async () => {
    await expect(resolveCollection('1', async () => ({ status: 500, text: '' }))).rejects.toThrow(/500/)
    await expect(resolveCollection('1', async () => ({ status: 200, text: 'nope' }))).rejects.toThrow(/not JSON/)
  })
})

describe('the bridge\'s addons', () => {
  let api: any, Store: any, db: any, WS: any, serverId: string, token: string, mapsLimiter: any
  beforeAll(async () => {
    const mod = await import('../src/routes/api'); api = mod.default; mapsLimiter = mod.mapsLimiter
    Store = (await import('../src/services/Store')).Store
    db = (await import('../src/services/Database')).default
    WS = await import('../src/services/workshopStore')
  })
  beforeEach(() => {
    db.run('DELETE FROM workshop_addons')
    const s = Store.addServer('RFC40') as any
    serverId = s.id; token = s.token; mapsLimiter.reset()
  })
  const post = (body: unknown) => api.request('/v1/maps', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const rows = () => db.prepare('SELECT map_addons, addons FROM server_map_state WHERE server_id = ?').get(serverId)

  test('addons: digits only, deduplicated, 2000 at most; mapAddons stays at 300', async () => {
    const many = Array.from({ length: 2100 }, (_, i) => String(i + 1))
    const r = await post({ maps: [], addons: ['3415635566', '3415635566', 'x; rm', 5, null, '1234567890123', ...many], mapAddons: ['12', '13'] })
    expect(r.status).toBe(200)
    const row = rows()
    expect(JSON.parse(row.addons)).toHaveLength(2000)
    expect(JSON.parse(row.addons)[0]).toBe('3415635566')
    expect(JSON.parse(row.map_addons)).toEqual(['12', '13'])
  })

  test('a bridge from before RFC 40 sends only mapAddons: the map fetch keeps its list, the list of all is unknown, not guessed', async () => {
    await post({ maps: [], mapAddons: ['12', '13'] })
    const row = rows()
    expect(JSON.parse(row.map_addons)).toEqual(['12', '13'])
    expect(row.addons).toBeNull()
    expect(Store.getMountedAddons(serverId)).toEqual({ ids: [], reported: false })
  })

  test('the cross-check: mounted, and not in the collection', async () => {
    await post({ maps: [], addons: ['1', '2', '3', '4'], mapAddons: ['4'] })
    WS.upsertAddons([{ id: '1', title: 'a', updated: 1, order: 0 }, { id: '2', title: 'b', updated: 1, order: 1 }, { id: '9', title: 'c', updated: 1, order: 2 }], 'collection')
    const m = Store.getMountedAddons(serverId)
    expect(m.reported).toBe(true)
    expect(WS.notInCollection(m.ids).sort()).toEqual(['3', '4'])
  })
})
