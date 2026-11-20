import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { buildGma } from './helpers/bsp_builder'
import { fakeAddons, fakeSteam, items } from './helpers/workshop_fake'
import { migrate, migrations } from '../src/services/migrations'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// RFC 40, 3.2 and 6: the index queue on a fake fetcher and a fake Steam.

let db: any, W: any, Q: any
beforeAll(async () => {
  db = (await import('../src/services/Database')).default
  W = await import('../src/services/workshopStore')
  Q = await import('../src/services/workshopQueue')
})
let fake: ReturnType<typeof fakeAddons>
beforeEach(() => {
  for (const t of ['workshop_addons', 'workshop_files', 'workshop_dirs', 'workshop_models', 'workshop_meta']) db.run(`DELETE FROM ${t}`)
  delete process.env.WORKSHOP_COLLECTION
})
afterEach(() => { fake?.done() })

const weapon = buildGma({
  'models/weapons/w_test.mdl': 'MDL', 'models/weapons/w_test.vvd': 'VVD', 'models/weapons/w_test.dx90.vtx': 'VTX',
  'Materials/Models/Test/WALL.VMT': 'vmt', 'materials/models/test/wall.vtf': 'vtf',
  'lua/autorun/a.lua': 'print(1)', 'lua/autorun/b.lua': 'print(2)', 'sound/shot.wav': 'wav', 'readme.txt': 'hi',
  'models/../evil.mdl': 'x', '/abs/models/x.mdl': 'x',
})
const props = buildGma({ 'models/props/crate.mdl': 'M2', 'materials/models/props/crate.vtf': 'T2', 'models/weapons/w_test.mdl': 'MDL-OTHER' })
const empty = buildGma({ 'lua/x.lua': 'x' })
const rowsOf = (id: string) => db.prepare('SELECT path, size FROM workshop_files WHERE addon_id = ? ORDER BY path').all(id)
const statusOf = (id: string) => db.prepare('SELECT status, error, indexed_at, updated FROM workshop_addons WHERE id = ?').get(id)
const deps = (f: any, steam = fakeSteam({ '1': items('10', '20', '30') }, { '10': { title: 'Weapon', time_updated: 100 }, '20': { title: 'Props', time_updated: 200 }, '30': { title: 'Empty', time_updated: 300 } }), extra: any = {}) =>
  ({ fetcher: f.fetcher, http: steam.post, collection: '1', delayMs: 0, ...extra })

describe('the migration', () => {
  const tables = (d: Database) => (d.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workshop_%' AND name != 'workshop_text' ORDER BY name").all() as any[]).map(r => r.name)
  test('a fresh database has the tables and the addons column', () => {
    const d = new Database(':memory:')
    migrate(d)
    expect(tables(d)).toEqual(['workshop_addons', 'workshop_dirs', 'workshop_files', 'workshop_meta', 'workshop_models'])
    expect((d.query('PRAGMA table_info(server_map_state)').all() as any[]).map(c => c.name)).toContain('addons')
    expect((d.query('PRAGMA index_list(workshop_files)').all() as any[]).some(i => i.name === 'idx_workshop_files_path')).toBe(true)
  })
  test('an upgrade from the version before keeps what was there and adds the tables', () => {
    const d = new Database(':memory:')
    for (const m of migrations.slice(0, migrations.length - 1)) m(d)
    d.run(`PRAGMA user_version = ${migrations.length - 1}`)
    d.run("INSERT INTO servers (id, name, api_token_hash) VALUES ('s1', 'Live', 'h')")
    d.run("INSERT INTO server_map_state (server_id, map_addons, reported_at) VALUES ('s1', '[\"12\"]', 'now')")
    expect(tables(d)).toEqual([])
    migrate(d)
    expect(tables(d)).toHaveLength(5)
    expect(d.query("SELECT map_addons AS m, addons AS a FROM server_map_state WHERE server_id = 's1'").get()).toEqual({ m: '["12"]', a: null })
    expect((d.query('PRAGMA user_version').get() as any).user_version).toBe(migrations.length)
  })
})

describe('the rows of an addon', () => {
  test('models and materials in full (lower case), the rest counted per top directory, unsafe names counted and never stored', async () => {
    fake = fakeAddons({ '10': weapon })
    await Q.runWorkshopQueue(deps(fake, fakeSteam({ '1': items('10') }, { '10': { title: 'W', time_updated: 5 } })))
    expect(rowsOf('10').map((r: any) => r.path)).toEqual([
      'materials/models/test/wall.vmt', 'materials/models/test/wall.vtf',
      'models/weapons/w_test.dx90.vtx', 'models/weapons/w_test.mdl', 'models/weapons/w_test.vvd',
    ])
    const dirs = db.prepare('SELECT dir, files FROM workshop_dirs WHERE addon_id = ? ORDER BY dir').all('10')
    expect(dirs).toEqual([{ dir: '(root)', files: 1 }, { dir: '(unsafe names)', files: 2 }, { dir: 'lua', files: 2 }, { dir: 'sound', files: 1 }])
    expect(db.prepare('SELECT status, file_count AS n, bytes FROM workshop_addons WHERE id = ?').get('10')).toMatchObject({ status: 'indexed', n: 11 })
    // nothing with '..' or an absolute name is in the index, whatever its directory
    expect(db.prepare("SELECT COUNT(*) AS n FROM workshop_files WHERE path LIKE '%..%' OR path LIKE '/%'").get().n).toBe(0)
  })

  test('the same path in two addons is two rows; the lookup lists both, the most recently updated first', async () => {
    fake = fakeAddons({ '10': weapon, '20': props })
    await Q.runWorkshopQueue(deps(fake))
    expect(W.holders('models/weapons/w_test.mdl')).toEqual(['20', '10']) // 20 was updated at 200, 10 at 100
    expect(W.holders('models/props/crate.mdl')).toEqual(['20'])
    expect(W.holders('models/none.mdl')).toEqual([])
  })

  test('the crc of the table is kept', async () => {
    const g = buildGma({ 'models/a.mdl': 'x' })
    fake = fakeAddons({ '10': g })
    await Q.runWorkshopQueue(deps(fake, fakeSteam({ '1': items('10') })))
    expect(db.prepare('SELECT crc FROM workshop_files WHERE addon_id = ?').get('10')).toEqual({ crc: 0 }) // the test archive lists 0
  })
})

describe('the queue', () => {
  test('addons are indexed in the collection\'s order, one at a time', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty }, { delayMs: 15 })
    const r = await Q.runWorkshopQueue(deps(fake))
    expect(r).toMatchObject({ started: true, indexed: 3, failed: 0 })
    expect(fake.log.map(l => l.id)).toEqual(['10', '20', '30'])
    expect(fake.peak()).toBe(1)
  })

  test('a second run while one is going does nothing (and never downloads at the same time)', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty }, { delayMs: 20 })
    const first = Q.runWorkshopQueue(deps(fake))
    const second = await Q.runWorkshopQueue(deps(fake))
    expect(second.started).toBe(false)
    await first
    expect(fake.peak()).toBe(1)
    expect(fake.log).toHaveLength(3)
  })

  test('a model build and an index job share the one slot', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty }, { delayMs: 15 })
    let overlapped = false, building = false
    const build = async (p: string) => { building = true; await fake.fetcher('10').then((r: any) => r.cleanup?.()); building = false; W.setModel(p, 'built') }
    const wrapped = { ...fake, fetcher: async (id: string) => { if (building) overlapped = true; return fake.fetcher(id) } }
    W.queueModel('models/a.mdl')
    await Q.runWorkshopQueue(deps(wrapped, undefined, { build }))
    expect(overlapped).toBe(false)
    expect(W.modelStatus('models/a.mdl').status).toBe('built')
    expect(fake.peak()).toBe(1)
  })

  test('there is a pause between downloads', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty })
    await Q.runWorkshopQueue(deps(fake, undefined, { delayMs: 60 }))
    const gaps = fake.log.slice(1).map((l, i) => l.at - fake.log[i]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(55)
  })

  test('stopped, it resumes where it was: what is indexed is not downloaded again', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty }, { onFetch: id => { if (id === '20') Q.stopWorkshopQueue() } })
    const a = await Q.runWorkshopQueue(deps(fake))
    expect(a.indexed).toBe(2) // the job it was on finishes
    expect(statusOf('30').status).toBe('pending')
    const b = await Q.runWorkshopQueue(deps(fake))
    expect(b.indexed).toBe(1)
    expect(fake.log.map(l => l.id)).toEqual(['10', '20', '30'])
  })

  test('a run that died in the middle (an addon left "indexing") is resumed', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty })
    await Q.runWorkshopQueue(deps(fake, undefined, { sync: true }))
    db.run("UPDATE workshop_addons SET status = 'indexing' WHERE id = '20'")
    fake.log.length = 0
    await Q.runWorkshopQueue(deps(fake))
    expect(fake.log.map(l => l.id)).toEqual(['20'])
    expect(statusOf('20').status).toBe('indexed')
  })

  test('a failure is recorded on the addon and the queue goes on; it is retried at the next scheduled run, not by a plain run', async () => {
    fake = fakeAddons({ '10': 'The download failed (the helper said: Error: access denied)', '20': props, '30': buildGma({ 'lua/a.lua': 'x' }).subarray(0, 12) as Buffer })
    const a = await Q.runWorkshopQueue(deps(fake))
    expect(a).toMatchObject({ indexed: 1, failed: 2 })
    expect(statusOf('10')).toMatchObject({ status: 'failed', error: expect.stringContaining('access denied') })
    expect(statusOf('30').status).toBe('failed') // an archive that cannot be read
    expect(fake.jobsLeft()).toBe(0)
    fake.log.length = 0
    await Q.runWorkshopQueue(deps(fake))
    expect(fake.log).toHaveLength(0) // a plain run leaves the failed alone
    await Q.runWorkshopQueue(deps(fake), { retryFailed: true })
    expect(fake.log.map(l => l.id)).toEqual(['10', '30'])
    expect(W.status().failed).toBe(2)
  })

  test('a fetcher that throws is a failure of that addon only', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty })
    const thrower = { ...fake, fetcher: async (id: string) => { if (id === '10') throw new Error('boom'); return fake.fetcher(id) } }
    const r = await Q.runWorkshopQueue(deps(thrower))
    expect(r).toMatchObject({ indexed: 2, failed: 1 })
    expect(statusOf('10')).toMatchObject({ status: 'failed', error: 'boom' })
  })

  test('the download is deleted after the file table is read, also when it cannot be read', async () => {
    fake = fakeAddons({ '10': weapon, '20': buildGma({ 'models/a.mdl': 'x' }).subarray(0, 20) as Buffer })
    await Q.runWorkshopQueue(deps(fake, fakeSteam({ '1': items('10', '20') })))
    expect(fake.log.filter(l => l.dir)).toHaveLength(2)
    for (const l of fake.log) expect(existsSync(l.dir!)).toBe(false)
  })

  test('an addon updated on the Workshop after it was indexed is indexed again; one that did not change is not', async () => {
    fake = fakeAddons({ '10': weapon, '20': props, '30': empty })
    const steam = fakeSteam({ '1': items('10', '20', '30') }, { '10': { title: 'W', time_updated: 100 }, '20': { title: 'P', time_updated: 200 }, '30': { title: 'E', time_updated: 300 } })
    await Q.runWorkshopQueue(deps(fake, steam))
    // indexed "now" (2026): Steam's old times are not newer
    fake.log.length = 0
    await Q.runWorkshopQueue(deps(fake, steam))
    expect(fake.log).toHaveLength(0)
    // a new version of 20, as Steam would say it: its time is after the index
    steam.details['20']!.time_updated = Math.floor(Date.now() / 1000) + 60
    await Q.runWorkshopQueue(deps(fake, steam))
    expect(fake.log.map(l => l.id)).toEqual(['20'])
    expect(statusOf('20').status).toBe('indexed')
  })

  test('the rows of a re-indexed addon replace the old ones', async () => {
    fake = fakeAddons({ '10': weapon })
    const steam = fakeSteam({ '1': items('10') }, { '10': { title: 'W', time_updated: 100 } })
    await Q.runWorkshopQueue(deps(fake, steam))
    expect(rowsOf('10')).toHaveLength(5)
    ;(fake as any).fetcher = fakeAddons({ '10': buildGma({ 'models/new.mdl': 'n' }) }).fetcher
    steam.details['10']!.time_updated = Math.floor(Date.now() / 1000) + 60
    await Q.runWorkshopQueue({ ...deps(fake, steam), fetcher: (fake as any).fetcher })
    expect(rowsOf('10').map((r: any) => r.path)).toEqual(['models/new.mdl'])
  })

  test('addons the servers mount that the collection lacks are listed, indexed too, and told apart', async () => {
    fake = fakeAddons({ '10': weapon, '99': props })
    const steam = fakeSteam({ '1': items('10') }, { '10': { title: 'W', time_updated: 1 }, '99': { title: 'Extra', time_updated: 2 } })
    await Q.runWorkshopQueue(deps(fake, steam, { mounted: () => ['10', '99'] }))
    expect(W.notInCollection(['10', '99'])).toEqual(['99'])
    expect(statusOf('99').status).toBe('indexed')
    expect(db.prepare('SELECT source, title FROM workshop_addons WHERE id = ?').get('99')).toEqual({ source: 'server', title: 'Extra' })
    expect(db.prepare('SELECT source FROM workshop_addons WHERE id = ?').get('10')).toEqual({ source: 'collection' })
  })

  test('a Steam that fails costs only the list refresh: what is pending is still indexed', async () => {
    fake = fakeAddons({ '10': weapon })
    W.upsertAddons([{ id: '10', title: null, updated: 0, order: 0 }], 'collection')
    const r = await Q.runWorkshopQueue({ fetcher: fake.fetcher, http: async () => { throw new Error('offline') }, collection: '1', delayMs: 0 })
    expect(r.indexed).toBe(1)
    expect(JSON.parse(W.metaGet('list_notes'))[0]).toMatch(/offline/)
  })

  test('the status counts and the last run are recorded', async () => {
    fake = fakeAddons({ '10': weapon, '20': 'private', '30': empty })
    await Q.runWorkshopQueue(deps(fake))
    const s = W.status()
    expect(s).toMatchObject({ addons: 3, indexed: 2, failed: 1, pending: 0 })
    expect(s.bytes).toBe(weapon.length + empty.length)
    expect(s.files).toBe(5)
    expect(s.lastRun).toMatchObject({ indexed: 2, failed: 1 })
    expect(W.failedAddons()[0]).toMatchObject({ id: '20', error: 'private' })
  })

  test('the nightly run is at 04:00 local time', () => {
    const at = (h: number, m = 0) => { const d = new Date(2026, 10, 20, h, m, 0, 0); return Q.msUntilHour(d, 4) }
    expect(at(3, 0)).toBe(3600_000)
    expect(at(4, 0)).toBe(24 * 3600_000)
    expect(at(5, 30)).toBe(22.5 * 3600_000)
  })

  test('the pause for a round report: the queue waits for a quiet moment', async () => {
    fake = fakeAddons({ '10': weapon })
    Q.noteRoundReport()
    const t = Date.now()
    await Q.runWorkshopQueue(deps(fake, fakeSteam({ '1': items('10') })))
    expect(Date.now() - t).toBeGreaterThanOrEqual(2800)
  }, 15_000)
})
