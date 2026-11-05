import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { BRIDGE_SETTINGS } from '../src/services/bridgeSettings'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'
afterAll(() => { delete process.env.OPEN_SIGNIN })

// RFC 23, stage 3: the settings page, for admins.
let app: any, Store: any, db: any
const ADMIN = '76561198000000000', USER = '76561198000000042'
let server: { id: string, token: string }

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
})
beforeEach(() => { server = Store.addServer('Page') })

const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = null) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))
const report = (settings: Record<string, string>, saved?: Record<string, string>) =>
  app.fetch(new Request('http://localhost/api/v1/settings', { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 1, settings, saved }) }))

describe('the page', () => {
  test('is for admins: a visitor and a signed-in user are sent away', async () => {
    for (const as of [null, USER]) {
      const r = await get(`/servers/${server.id}/bridge`, as)
      expect([302, 401, 403]).toContain(r.status)
      expect(await r.text()).not.toContain('traitordash_track')
    }
  })

  test('says so, and offers nothing to change, when the bridge has not reported', async () => {
    const t = await (await get(`/servers/${server.id}/bridge`, ADMIN)).text()
    expect(t).toContain('data-not-reported')
    for (const s of BRIDGE_SETTINGS) expect(t).toContain(`data-setting="${s.name}"`)
    expect(t.match(/disabled/g)!.length).toBeGreaterThanOrEqual(BRIDGE_SETTINGS.length)
    expect(t).not.toContain('Reset to default')
  })

  test('shows each setting with its words, its range and its default, grouped', async () => {
    await report({ traitordash_track: '1', traitordash_track_interval_min: '0.15' })
    const t = await (await get(`/servers/${server.id}/bridge`, ADMIN)).text()
    expect(t).not.toContain('data-not-reported')
    for (const s of BRIDGE_SETTINGS) { expect(t).toContain(s.label); expect(t).toContain(s.explain.slice(0, 40)) }
    expect(t).toContain('Round stats'); expect(t).toContain('Position tracking')
    expect(t).toContain('Range 0.05 to 2 s')
    expect(t).toContain('Reset to default')
    // what runs, as the starting values of the form (the reported ones, the default for the rest)
    expect(t).toContain('&quot;traitordash_track&quot;:true')
    expect(t).toContain('&quot;traitordash_track_interval_min&quot;:0.15')
    expect(t).toContain('&quot;traitordash_track_budget_ms&quot;:0.5')
  })

  test('says where the configuration file holds another value than the one that runs', async () => {
    await report({ traitordash_track: '0' }, { traitordash_track: '1' })
    const t = await (await get(`/servers/${server.id}/bridge`, ADMIN)).text()
    expect(t).toContain('data-file-differs')
    expect(t).toContain('holds 1')
  })

  test('never offers a connection setting', async () => {
    await report({ traitordash_track: '1' })
    const t = await (await get(`/servers/${server.id}/bridge`, ADMIN)).text()
    for (const never of ['traitordash_url', 'traitordash_token', 'traitordash_public_url']) expect(t).not.toContain(never)
  })

  test('is linked from the server page', async () => {
    const t = await (await get(`/servers/${server.id}`, ADMIN)).text()
    expect(t).toContain(`href="/servers/${server.id}/bridge"`)
  })
})

describe('the state the page asks for while it waits', () => {
  const state = async (as: string | null = ADMIN) => get(`/api/bridge-settings/${server.id}`, as)
  test('is for admins', async () => {
    expect((await state(null)).status).toBe(401)
    expect((await state(USER)).status).toBeGreaterThanOrEqual(401)
  })
  test('has what the bridge runs with and the changes that are still on their way', async () => {
    await report({ traitordash_track: '0' })
    Store.stageCommand(server.id, 'setting', 'traitordash_track 1')
    Store.stageCommand(server.id, 'setting', 'traitordash_track_budget_ms 1')
    Store.stageCommand(server.id, 'convar', 'ttt_known 1')
    const r = await state()
    expect(r.headers.get('cache-control')).toBe('no-store')
    const j = await r.json()
    expect(j.values.traitordash_track.value).toBe('0')
    expect(j.pending.sort()).toEqual(['traitordash_track', 'traitordash_track_budget_ms'])
    db.run('DELETE FROM commands WHERE server_id = ?', [server.id])
    expect((await (await state()).json()).pending).toEqual([])
  })
  test('answers for the one server only, and 404 for an unknown one', async () => {
    expect((await get('/api/bridge-settings/nope', ADMIN)).status).toBe(404)
  })
})
