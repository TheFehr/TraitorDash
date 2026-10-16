import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

// Must be set before the app modules are imported (they read env at load time).
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let api: any, Store: any, db: any
let serverId: string
let cookie: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default

  serverId = Store.addServer('Test').id
  Store.saveSchema(serverId, 'survivalist', 'innocents', true, 0, [
    { type: 'conVarData', args: { key: 'pct', value: 0.15, convar: 'ttt_survivalist_pct' } },
    { type: 'conVarData', args: { key: 'shopFallback', value: 'detective', convar: 'ttt_surv_shop_fallback' } },
    { type: 'conVarData', args: { key: 'togglable', value: true, convar: 'ttt_survivalist_enabled' } },
  ])
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret')).split(';')[0]!
})

const save = (body: Record<string, string>) =>
  api.request(`/save/${serverId}/survivalist`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

const queued = () => (db.query('SELECT args FROM commands ORDER BY id').all() as any[]).map(r => r.args)
const clear = () => db.run('DELETE FROM commands')

describe('POST /save', () => {
  test('requires an admin session', async () => {
    const res = await api.request(`/save/${serverId}/survivalist`, { method: 'POST', body: 'a=b' })
    expect(res.status).toBe(401)
  })

  test('queues only what was sent, including an explicit off', async () => {
    clear()
    const res = await save({ ttt_survivalist_pct: '1', ttt_survivalist_enabled: '0' })
    expect(res.status).toBe(200)
    expect(queued()).toEqual(['ttt_survivalist_pct 1', 'ttt_survivalist_enabled 0'])
  })

  test('a value that would start a second console command is refused and nothing is queued', async () => {
    clear()
    const res = await save({ ttt_survivalist_pct: '0.5', ttt_surv_shop_fallback: 'detective\nquit' })
    expect(res.status).toBe(400)
    expect(queued()).toEqual([])
  })

  test('unknown ConVar names are ignored', async () => {
    clear()
    const res = await save({ ttt_survivalist_pct: '0.2', rcon_password: 'x' })
    expect((await res.json()).commands_staged).toBe(1)
    expect(queued()).toEqual(['ttt_survivalist_pct 0.2'])
  })

  test('a saved change is audited with who and what', async () => {
    clear()
    await save({ ttt_survivalist_pct: '0.3' })
    const row = db.query("SELECT steam_id, details FROM audit_log WHERE action = 'SAVE_CONFIG' ORDER BY id DESC LIMIT 1").get() as any
    expect(row.steam_id).toBe('76561198000000000')
    expect(row.details).toContain('ttt_survivalist_pct=0.3')
  })
})

describe('POST /v1/values (live ConVar state from the bridge)', () => {
  let token: string
  beforeAll(() => {
    const created = Store.addServer('Live')
    token = created.token
    ;(globalThis as any).__liveServerId = created.id
  })

  const post = (body: unknown, auth = true) =>
    api.request('/v1/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })

  test('needs the server token', async () => {
    expect((await post({ convars: [] }, false)).status).toBe(401)
  })

  test('stores value, default, bounds and missing ConVars, and reads them back', async () => {
    const res = await post({ convars: [
      { name: 'ttt_survivalist_pct', role: 'survivalist', present: true, value: '1', default: '0.15', min: 0, max: 1 },
      { name: 'ttt_survivalist_random', role: 'survivalist', present: true, value: '25', default: '100', min: 0, max: 100 },
      { name: 'ttt_surv_nonexistent', role: 'survivalist', present: false },
    ] })
    expect(res.status).toBe(200)

    const live = Store.getConVarValues((globalThis as any).__liveServerId)
    expect(live.ttt_survivalist_pct).toMatchObject({ present: true, value: '1', default: '0.15', min: 0, max: 1, role: 'survivalist' })
    expect(live.ttt_survivalist_random.value).toBe('25')
    expect(live.ttt_surv_nonexistent.present).toBe(false)
  })

  test('a later report overwrites the value (this is how a change on the server shows up)', async () => {
    await post({ convars: [{ name: 'ttt_survivalist_pct', present: true, value: '0.5', default: '0.15', min: 0, max: 1 }] })
    const live = Store.getConVarValues((globalThis as any).__liveServerId)
    expect(live.ttt_survivalist_pct.value).toBe('0.5')
    expect(live.ttt_survivalist_pct.role).toBe('survivalist') // not lost when a later report omits it
  })

  test('rejects bad ConVar names and oversized batches', async () => {
    expect((await post({ convars: [{ name: 'a b; quit', present: true }] })).status).toBe(400)
    expect((await post({ convars: Array.from({ length: 401 }, (_, i) => ({ name: `ttt_x_${i}`, present: true })) })).status).toBe(400)
    expect((await post({ nope: 1 })).status).toBe(400)
  })

  test("one server's report never lands on another server", async () => {
    const other = Store.addServer('Other')
    expect(Object.keys(Store.getConVarValues(other.id))).toEqual([])
  })
})

describe('POST /save for settings the server reported', () => {
  test('a ConVar the bridge reported for this role can be saved; an unreported one cannot', async () => {
    Store.setConVarValues(serverId, [
      { name: 'ttt_survivalist_random', role: 'survivalist', present: true, value: '25', default: '100', min: 0, max: 100 },
      { name: 'ttt_survivalist_gone', role: 'survivalist', present: false },
      { name: 'ttt_detective_hats', role: 'detective', present: true, value: '0' },
    ])
    clear()
    const res = await save({ ttt_survivalist_random: '50', ttt_survivalist_gone: '1', ttt_detective_hats: '1' })
    expect((await res.json()).commands_staged).toBe(1)
    expect(queued()).toEqual(['ttt_survivalist_random 50'])
  })
})
