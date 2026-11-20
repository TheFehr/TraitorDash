import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { buildGma } from './helpers/bsp_builder'
import { fakeAddons, fakeSteam, items } from './helpers/workshop_fake'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'

// RFC 40, 5 and 6: the card "Workshop content" of the coverage page and its buttons.

const ADMIN = '76561198000000000', USER = '76561198000000099'
let app: any, Store: any, db: any, W: any, Q: any, serverId: string
beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  W = await import('../src/services/workshopStore')
  Q = await import('../src/services/workshopQueue')
  serverId = (Store.addServer('Card') as any).id
})
beforeEach(() => {
  for (const t of ['workshop_addons', 'workshop_files', 'workshop_dirs', 'workshop_models', 'workshop_meta', 'server_map_state']) db.run(`DELETE FROM ${t}`)
  process.env.WORKSHOP_COLLECTION = '3415635566'
})
afterEach(async () => {
  delete process.env.WORKSHOP_COLLECTION
  ;(await import('../src/services/workshopRuntime')).setWorkshopDeps(null)
})

const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = ADMIN) => app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))
const post = async (path: string, as: string | null = ADMIN, body = '', headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(as ? { Cookie: await cookie(as) } : {}), ...headers }, body }))
const page = async () => { const r = await get(`/servers/${serverId}/map-coverage`); expect(r.status).toBe(200); return r.text() as Promise<string> }
const card = (html: string) => /<div class="f c-violet" id="workshop-content"[\s\S]*?<p class="foot dark">RFC 40\.[\s\S]*?<\/div>/.exec(html)?.[0] ?? ''
const val = (html: string, key: string) => new RegExp(`data-w="${key}">(.*?)</td>`, 's').exec(card(html))?.[1]?.replace(/<[^>]*>/g, '').trim()

describe('the card', () => {
  test('it is there for an admin when the collection is set, with the numbers of the index', async () => {
    const fake = fakeAddons({ '10': buildGma({ 'models/a.mdl': 'x', 'lua/a.lua': 'x' }), '20': 'The download failed (the helper said: Error: access denied)', '30': buildGma({ 'models/b.mdl': 'y' }) })
    const steam = fakeSteam({ '3415635566': items('10', '20', '30', '40') }, { '10': { title: 'Ten', time_updated: 1 }, '20': { title: 'Twenty', time_updated: 1 }, '30': { title: 'Thirty', time_updated: 1 }, '40': { title: 'Forty', time_updated: 1 } })
    // 40 is in the collection and 99 is mounted, and the fake download has neither: they fail
    await Q.runWorkshopQueue({ fetcher: fake.fetcher, http: steam.post, collection: '3415635566', delayMs: 0, mounted: () => ['10', '99'] }, {})
    W.metaSet('collection_size', '4')
    db.prepare("INSERT INTO workshop_models (path, status, queued_at) VALUES ('models/a.mdl', 'built', 1), ('models/b.mdl', 'queued', 2), ('models/c.mdl', 'failed', 3)").run()
    Store.setMaps(serverId, { current: null, next: null, gamemode: null, pattern: null, poolBasis: null, configSource: null, voteAddon: false, maps: [], mapAddons: [], addons: ['10', '99', '77'] })
    const html = await page()
    expect(card(html)).not.toBe('')
    expect(val(html, 'collection')).toBe('3415635566')
    expect(val(html, 'indexed')).toBe('2') // 10 and 30
    expect(val(html, 'failed')).toBe('3') // 20 (denied), 40 and 99 (no such item)
    expect(val(html, 'pending')).toBe('0')
    expect(val(html, 'built')).toBe('1')
    expect(val(html, 'queued')).toMatch(/^1 \(1 failed/)
    expect(val(html, 'mounted')).toBe('2 of 3 mounted: 99, 77')
    expect(val(html, 'lastrun')).toMatch(/2 indexed, 3 failed/)
    expect(card(html)).toContain('data-failed-addon="20"')
    expect(card(html)).toContain('access denied')
    fake.done()
  })

  test('the numbers are the same rows whatever the state: nothing moves when a run starts or something fails', async () => {
    const empty = card(await page())
    const keys = (h: string) => [...h.matchAll(/data-w="([a-z]+)"/g)].map(m => m[1])
    W.upsertAddons([{ id: '1', title: null, updated: 0, order: 0 }], 'collection'); W.finishFailed('1', 'x')
    W.queueModel('models/a.mdl')
    const busy = card(await page())
    expect(keys(busy)).toEqual(keys(empty))
    expect(keys(empty)).toHaveLength(12)
    // the markup uses the existing card, table and button styles only: no inline style, no colour of its own
    expect(empty).not.toContain('style=')
    expect(empty).toContain('class="f c-violet"')
    expect(empty).toContain('class="actions"')
    expect(empty).toContain('class="btn"')
  })

  test('it says so when the bridge has not reported its addons', async () => {
    expect(val(await page(), 'mounted')).toMatch(/not reported/)
  })

  test('with the setting empty, or not digits, the page has no card and nothing changes', async () => {
    for (const v of ['', 'abc']) { process.env.WORKSHOP_COLLECTION = v; expect(card(await page())).toBe('') }
    delete process.env.WORKSHOP_COLLECTION
    expect(card(await page())).toBe('')
    for (const path of ['run', 'retry', 'model']) expect((await post(`/servers/${serverId}/workshop-content/${path}`)).status).toBe(404)
    expect((await get(`/servers/${serverId}/workshop-content/model.glb?path=models/a.mdl`)).status).toBe(404)
  })
})

describe('the buttons', () => {
  const setDeps = async (calls: string[]) => {
    const rt = await import('../src/services/workshopRuntime')
    rt.setWorkshopDeps({ fetcher: async id => { calls.push(id); return { error: 'offline' } }, http: async () => ({ status: 500, text: '' }), collection: '3415635566', delayMs: 0 })
  }

  test('admins only: nobody else can start a run, retry, queue a model or read a GLB', async () => {
    for (const path of ['run', 'retry', 'model']) {
      expect((await post(`/servers/${serverId}/workshop-content/${path}`, null)).status).toBe(401)
      expect((await post(`/servers/${serverId}/workshop-content/${path}`, USER)).status).toBe(401)
    }
    expect([401, 302]).toContain((await get(`/servers/${serverId}/workshop-content/model.glb?path=models/a.mdl`, USER)).status)
  })

  test('a post from another site is refused (the same Origin rule as every form)', async () => {
    const r = await post(`/servers/${serverId}/workshop-content/run`, ADMIN, '', { Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
  })

  test('run now starts the queue and goes back to the card; retry failed makes the failed ones pending', async () => {
    const calls: string[] = []
    await setDeps(calls)
    W.upsertAddons([{ id: '5', title: null, updated: 0, order: 0 }], 'collection'); W.finishFailed('5', 'old reason')
    const retry = await post(`/servers/${serverId}/workshop-content/retry`)
    expect(retry.status).toBe(302)
    expect(retry.headers.get('location')).toBe(`/servers/${serverId}/map-coverage#workshop-content`)
    await Bun.sleep(100)
    expect(calls).toEqual(['5'])
    const run = await post(`/servers/${serverId}/workshop-content/run`)
    expect(run.status).toBe(302)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'WORKSHOP_RUN' AND steam_id = ?").get(ADMIN).n).toBe(1)
  })

  test('queue a model by path: queued once, refused when it is not a model path', async () => {
    const calls: string[] = []
    await setDeps(calls)
    const ok = await post(`/servers/${serverId}/workshop-content/model`, ADMIN, 'path=models%2Fweapons%2Fw_x.mdl')
    expect(ok.headers.get('location')).toContain('model=queued')
    expect(W.modelStatus('models/weapons/w_x.mdl')).not.toBeNull()
    const again = await post(`/servers/${serverId}/workshop-content/model`, ADMIN, 'path=models%2Fweapons%2Fw_x.mdl')
    expect(again.headers.get('location')).toContain('model=refused')
    const bad = await post(`/servers/${serverId}/workshop-content/model`, ADMIN, 'path=..%2F..%2Fetc%2Fpasswd')
    expect(bad.headers.get('location')).toContain('model=refused')
    expect(await (await get(`/servers/${serverId}/map-coverage?model=refused`)).text()).toContain('data-workshop-model-note')
  })

  test('the GLB route serves only a built model, with no sniffing and no scripts', async () => {
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'ws-glb-'))
    process.env.WORKSHOP_CONTENT_DIR = dir
    try {
      expect((await get(`/servers/${serverId}/workshop-content/model.glb?path=models/weapons/w_x.mdl`)).status).toBe(404)
      const { createHash } = await import('node:crypto')
      const key = createHash('sha1').update('models/weapons/w_x').digest('hex')
      await Bun.write(`${dir}/glb/${key}.glb`, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]))
      const r = await get(`/servers/${serverId}/workshop-content/model.glb?path=models/weapons/w_x.mdl`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('model/gltf-binary')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await get(`/servers/${serverId}/workshop-content/model.glb?path=models/../w_x.mdl`)).status).toBe(404)
    } finally { delete process.env.WORKSHOP_CONTENT_DIR }
  })
})
