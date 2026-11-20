import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// RFC 40, 5: the card's model search (the admin types part of a name; the index answers with the models and the addons that hold them).

let db: any, W: any, Card: any
beforeAll(async () => {
  db = (await import('../src/services/Database')).default
  W = await import('../src/services/workshopStore')
  Card = (await import('../src/components/MapCoveragePage')).WorkshopCard
})
const addon = (id: string, title: string, updated: number, status = 'indexed') =>
  db.prepare("INSERT INTO workshop_addons (id, title, updated, status, source, ord) VALUES (?, ?, ?, ?, 'collection', 0)").run(id, title, updated, status)
const file = (id: string, path: string) => db.prepare('INSERT INTO workshop_files (addon_id, path, size, crc) VALUES (?, ?, 1, 1)').run(id, path)
beforeEach(() => { for (const t of ['workshop_addons', 'workshop_files', 'workshop_dirs', 'workshop_models', 'workshop_meta']) db.run(`DELETE FROM ${t}`) })

describe('searchModels', () => {
  test('finds .mdl paths that contain the term, with the addon that holds them, in path order', () => {
    addon('1', 'Weapons pack', 10); addon('2', 'Props', 20)
    file('1', 'models/weapons/w_usp.mdl'); file('1', 'models/weapons/w_usp.vvd'); file('1', 'materials/models/weapons/usp.vmt')
    file('2', 'models/props/crate.mdl'); file('2', 'models/weapons/w_knife.mdl')
    expect(W.searchModels('usp').map((h: any) => [h.path, h.addon, h.title])).toEqual([['models/weapons/w_usp.mdl', '1', 'Weapons pack']])
    expect(W.searchModels('WEAPONS').map((h: any) => h.path)).toEqual(['models/weapons/w_knife.mdl', 'models/weapons/w_usp.mdl'])
  })
  test('one row per path: with two holders the most recently updated addon', () => {
    addon('1', 'Old', 10); addon('2', 'New', 20)
    file('1', 'models/weapons/w_usp.mdl'); file('2', 'models/weapons/w_usp.mdl')
    const hits = W.searchModels('usp')
    expect(hits.length).toBe(1); expect(hits[0].addon).toBe('2')
  })
  test('addons that are not indexed are not searched; less than 2 characters finds nothing', () => {
    addon('1', 'Failed', 10, 'failed'); file('1', 'models/weapons/w_usp.mdl')
    expect(W.searchModels('usp')).toEqual([])
    addon('2', 'Ok', 10); file('2', 'models/weapons/w_ak.mdl')
    expect(W.searchModels('a')).toEqual([]); expect(W.searchModels('  ')).toEqual([])
  })
  test('% and _ are taken literally, odd characters cannot break the query, the result is capped', () => {
    addon('1', 'A', 10)
    file('1', 'models/a_b.mdl'); file('1', 'models/axb.mdl'); file('1', 'models/100%.mdl')
    expect(W.searchModels('a_b').map((h: any) => h.path)).toEqual(['models/a_b.mdl'])
    expect(W.searchModels('%').length).toBe(0)
    expect(() => W.searchModels("'; DROP TABLE workshop_files; --")).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM workshop_files').get().n).toBe(3)
    for (let i = 0; i < 60; i++) file('1', `models/many/m${i}.mdl`)
    expect(W.searchModels('many', 40).length).toBe(40)
  })
  test('the model status is carried along', () => {
    addon('1', 'A', 10); file('1', 'models/weapons/w_usp.mdl')
    W.queueModel('models/weapons/w_usp.mdl')
    expect(W.searchModels('usp')[0].model).toBe('queued')
  })
})

describe('the card', () => {
  const panel = (search: any) => ({ collection: '1', status: W.status(), state: { running: false, current: null }, failed: [], search, notes: [], collectionSize: 0, checkedAt: null, mounted: null })
  const html = (search: any) => String(<Card w={panel(search)} serverId="s1" />)
  test('has the search form (GET) and no result table without a term', () => {
    const h = html(null)
    expect(h).toContain('data-workshop-search'); expect(h).toContain('method="get"'); expect(h).not.toContain('data-workshop-hits')
  })
  test('lists hits with a Queue button, or says built / queued, and keeps the term', () => {
    const h = html({ q: 'usp', hits: [
      { path: 'models/weapons/w_usp.mdl', addon: '1', title: 'Weapons pack', model: null },
      { path: 'models/weapons/w_ak.mdl', addon: '1', title: null, model: 'built' },
      { path: 'models/weapons/w_m4.mdl', addon: '2', title: 'M4', model: 'queued' },
    ] })
    expect(h).toContain('data-hit="models/weapons/w_usp.mdl"'); expect(h).toContain('Weapons pack')
    expect(h).toContain('name="path" value="models/weapons/w_usp.mdl"') // only the model that is not built or queued gets a button
    expect(h).not.toContain('name="path" value="models/weapons/w_ak.mdl"')
    expect(h).not.toContain('name="path" value="models/weapons/w_m4.mdl"')
    expect(h).toContain('name="q" value="usp"')
    expect(h).toContain('>built<'); expect(h).toContain('>queued<')
  })
  test('says so when nothing matches', () => {
    expect(html({ q: 'zzz', hits: [] })).toContain('data-workshop-nohits')
  })
})
