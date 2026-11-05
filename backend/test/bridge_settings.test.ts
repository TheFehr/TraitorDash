import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { run } from './helpers/bridge_harness'

// RFC 23, stage 2: the backend's list equals the bridge's, the bridge reports its settings, an admin stages them.
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let api: any, Store: any, db: any, settings: typeof import('../src/services/bridgeSettings')
let server: { id: string, token: string }
let cookie: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  settings = await import('../src/services/bridgeSettings')
  server = Store.addServer('Settings')
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

const queued = () => (db.query('SELECT command, args FROM commands WHERE server_id = ? ORDER BY id').all(server.id) as any[]).map(r => `${r.command}:${r.args}`)
beforeEach(() => { db.run('DELETE FROM commands WHERE server_id = ?', [server.id]); db.run('DELETE FROM bridge_settings WHERE server_id = ?', [server.id]) })
const save = (body: Record<string, string>, ck: string | null = cookie) =>
  api.request(`/bridge-settings/${server.id}`, { method: 'POST', headers: { ...(ck ? { Cookie: ck } : {}), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
const report = (body: unknown, token = server.token) =>
  api.request('/v1/settings', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('the list', () => {
  test('is the bridge\'s list: the same names, in the same order, with the same kinds, ranges and defaults', () => {
    const lua = JSON.parse(run('RESULT = ENC(TraitorDash.SettingList)', `
      local function enc(v)
        if type(v) == "string" then return '"' .. v .. '"' elseif type(v) ~= "table" then return tostring(v) end
        if #v > 0 then local o = {} for i, x in ipairs(v) do o[i] = enc(x) end return "[" .. table.concat(o, ",") .. "]" end
        local k = {} for n in pairs(v) do k[#k + 1] = n end table.sort(k)
        local o = {} for _, n in ipairs(k) do o[#o + 1] = '"' .. n .. '":' .. enc(v[n]) end return "{" .. table.concat(o, ",") .. "}"
      end
      ENC = enc`).result)
    const mine = settings.BRIDGE_SETTINGS.map(s => ({ name: s.name, kind: s.kind, default: s.default, ...(s.min !== undefined ? { min: s.min, max: s.max } : {}) }))
    expect(lua).toEqual(mine)
  })
  test('every setting has its words, and none is a connection setting', () => {
    for (const s of settings.BRIDGE_SETTINGS) { expect(s.label.length).toBeGreaterThan(5); expect(s.explain.length).toBeGreaterThan(40) }
    for (const never of ['traitordash_url', 'traitordash_token', 'traitordash_public_url']) expect(settings.bridgeSetting(never)).toBeUndefined()
  })
  test('both ends take the same values and write them the same way', () => {
    const cases: [string, string][] = [['traitordash_track', '1'], ['traitordash_track', '2'], ['traitordash_track_interval_min', '0.1'], ['traitordash_track_interval_min', '.5'],
      ['traitordash_track_interval_min', '0.50'], ['traitordash_track_interval_min', '0.04'], ['traitordash_track_interval_min', '0.05'], ['traitordash_track_interval_min', '2.1'], ['traitordash_track_interval_max', '5'],
      ['traitordash_track_budget_ms', '0.05'], ['traitordash_track_budget_ms', '1e2'], ['traitordash_token', '1'], ['traitordash_track_budget_ms', '0.1234567'],
      ['traitordash_track_max_ticks', '40000'], ['traitordash_track_max_ticks', '1000'], ['traitordash_track_max_ticks', '100000'], ['traitordash_track_max_ticks', '999'], ['traitordash_track_max_ticks', '100001'],
      ['traitordash_track_max_ticks', '1.5'], ['traitordash_track_max_ticks', '4e4'], ['traitordash_track_max_ticks', '040000']]
    for (const [name, v] of cases) {
      const lua = run(`local ok = TraitorDash.CheckSettingValue("${name}", "${v}") RESULT = tostring(ok)`).result
      const mine = settings.checkSettingValue(name, v)
      expect('value' in mine ? mine.value : 'nil', `${name} ${v}`).toBe(lua)
    }
  })
})

describe('POST /v1/settings (the bridge)', () => {
  test('needs the server\'s token', async () => {
    expect((await report({ format: 1, settings: {} }, 'nope')).status).toBe(401)
  })
  test('stores what is on the list and nothing else, and what the file holds when that differs', async () => {
    const res = await report({ format: 1, settings: { traitordash_track: '1', traitordash_track_interval_min: '0.15', traitordash_token: 'x', ttt_known: '1', traitordash_stats: '7' }, saved: { traitordash_track: '0', rcon_password: 'z' } })
    expect(res.status).toBe(200)
    const got = Store.getBridgeSettings(server.id)
    expect(Object.keys(got.values).sort()).toEqual(['traitordash_track', 'traitordash_track_interval_min'])
    expect(got.values.traitordash_track).toEqual({ value: '1', saved: '0' })
    expect(got.values.traitordash_track_interval_min).toEqual({ value: '0.15', saved: null })
  })
  test('a new report replaces the old one; a malformed one is refused', async () => {
    await report({ format: 1, settings: { traitordash_track: '1' } })
    await report({ format: 1, settings: { traitordash_stats: '0' } })
    expect(Object.keys(Store.getBridgeSettings(server.id).values)).toEqual(['traitordash_stats'])
    for (const bad of [null, [], 'x', { format: 2, settings: {} }, { format: 1 }, { format: 1, settings: 'x' }]) expect((await report(bad)).status).toBe(400)
  })
  test('is kept apart for each server and removed with the server', async () => {
    const other = Store.addServer('Other')
    await report({ format: 1, settings: { traitordash_track: '1' } })
    expect(Store.getBridgeSettings(other.id)).toBeNull()
    await report({ format: 1, settings: { traitordash_track: '0' } }, other.token)
    expect(Store.getBridgeSettings(server.id).values.traitordash_track.value).toBe('1')
    Store.deleteServer(other.id)
    expect(Store.getBridgeSettings(other.id)).toBeNull()
  })
})

describe('POST /bridge-settings/:serverId (an admin)', () => {
  test('needs an admin session', async () => {
    expect((await save({ traitordash_track: '1' }, null)).status).toBe(401)
    expect(queued()).toEqual([])
  })
  test('stages one setting command for each, in the form the bridge parses, and writes an audit entry', async () => {
    const res = await save({ traitordash_track: '1', traitordash_track_interval_min: '.15' })
    expect(res.status).toBe(200)
    expect((await res.json()).commands_staged).toBe(2)
    expect(queued()).toEqual(['setting:traitordash_track 1', 'setting:traitordash_track_interval_min 0.15'])
    const row = db.query("SELECT details FROM audit_log WHERE server_id = ? AND action = 'SAVE_BRIDGE_SETTINGS' ORDER BY rowid DESC").get(server.id) as any
    expect(row.details).toBe('traitordash_track=1, traitordash_track_interval_min=0.15')
  })
  test('all or none: one bad name or value stages nothing', async () => {
    for (const body of <Record<string, string>[]>[{ traitordash_track: '1', traitordash_token: 'x' }, { traitordash_track: '1', traitordash_track_interval_min: '9' }, { traitordash_track: 'on' },
        { traitordash_url: 'https://evil.example' }, { traitordash_public_url: 'https://evil.example' }, { ttt_known: '1' }, { traitordash_track: '1; quit' }]) {
      const res = await save(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(queued()).toEqual([])
  })
  test('the longest sampling time may not be under the shortest, counting what the server runs with', async () => {
    expect((await save({ traitordash_track_interval_min: '1.5' })).status).toBe(400) // default max is 1
    expect((await save({ traitordash_track_interval_min: '1.5', traitordash_track_interval_max: '3' })).status).toBe(200)
    db.run('DELETE FROM commands WHERE server_id = ?', [server.id])
    await report({ format: 1, settings: { traitordash_track_interval_min: '0.2', traitordash_track_interval_max: '0.5' } })
    expect((await save({ traitordash_track_interval_min: '0.6' })).status).toBe(400)
    expect((await save({ traitordash_track_interval_max: '0.3' })).status).toBe(200)
  })
  test('an unknown server is refused, and nothing is staged', async () => {
    const res = await api.request('/bridge-settings/nope', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'traitordash_track=1' })
    expect(res.status).toBe(404)
  })
  test('an empty save stages nothing and is not audited', async () => {
    const before = (db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'SAVE_BRIDGE_SETTINGS'").get() as any).n
    expect((await save({})).status).toBe(200)
    expect((db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'SAVE_BRIDGE_SETTINGS'").get() as any).n).toBe(before)
  })
})
