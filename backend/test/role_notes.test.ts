import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { run } from './helpers/bridge_harness'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

let api: any, mod: any, Store: any, rv: any, token: string, serverId: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  mod = await import('../src/index')
  Store = (await import('../src/services/Store')).Store
  rv = await import('../src/services/roleview')
})

// The descriptions an admin wrote in a role-description addon: read from its data file by the bridge,
// stored by the backend, shown before every other description.
const lua = (body: string) => run(`util.TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end\n${body}`).result
const FILE = 'role_descriptions_v3.json'

describe('TraitorDash.PushRoleNotes', () => {
  test('sends the non-empty descriptions by role name to /api/v1/roledescriptions', () => {
    const r = lua(`DATA["${FILE}"] = "x" JSON_NEXT = { innocent = { description = "Hi" }, rat = { description = "  " }, ghost = {}, junk = "no" }
      TraitorDash.PushRoleNotes()
      local q = SENT[1]
      local n = 0 for _ in pairs(LAST_PAYLOAD.roles) do n = n + 1 end
      RESULT = q.url .. "|" .. q.headers.Authorization .. "|" .. n .. "|" .. LAST_PAYLOAD.roles.innocent`)
    expect(r).toBe('https://td.test/api/v1/roledescriptions|Bearer tok|1|Hi')
  })
  test('nothing is sent without the file, with unreadable JSON, or with no text', () => {
    expect(lua(`TraitorDash.PushRoleNotes() RESULT = #SENT`)).toBe('0')
    expect(lua(`DATA["${FILE}"] = "x" JSON_NEXT = nil TraitorDash.PushRoleNotes() RESULT = #SENT`)).toBe('0')
    expect(lua(`DATA["${FILE}"] = "x" JSON_NEXT = { a = { description = "" } } TraitorDash.PushRoleNotes() RESULT = #SENT`)).toBe('0')
  })
  test('at most 500 roles', () => {
    expect(lua(`DATA["${FILE}"] = "x" local t = {} for i = 1, 520 do t["r" .. i] = { description = "d" } end JSON_NEXT = t
      TraitorDash.PushRoleNotes() local n = 0 for _ in pairs(LAST_PAYLOAD.roles) do n = n + 1 end RESULT = n`)).toBe('500')
  })
})

describe('POST /api/v1/roledescriptions', () => {
  beforeEach(async () => {
    const added = Store.addServer('Notes') as any
    serverId = added.id; token = added.token
    ;(await import('../src/routes/api')).roleNotesLimiter.reset()
    mod.resetRolePages()
    Store.saveSchema(serverId, 'innocent', 'innocents', false, -1, [], 'h', 'From the language file.')
    Store.saveSchema(serverId, 'rat', 'innocents', false, -1, [], 'h', 'Rat from the language file.')
  })
  const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
    api.request('/v1/roledescriptions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })

  test('the admin text is shown before the language file text; a role without one keeps the language file text', async () => {
    expect((await post({ roles: { innocent: '  You are an innocent terrorist.\n\nFind the traitors!  ' } })).status).toBe(200)
    expect(rv.buildRoleView(serverId, 'innocent')!.description).toBe('You are an innocent terrorist.\n\nFind the traitors!')
    expect(rv.buildRoleView(serverId, 'rat')!.description).toBe('Rat from the language file.')
  })
  test('a new report replaces the old one, and an empty text drops the role', async () => {
    await post({ roles: { innocent: 'one', rat: 'two' } })
    await post({ roles: { innocent: '   ' } })
    expect(rv.buildRoleView(serverId, 'innocent')!.description).toBe('From the language file.')
    expect(rv.buildRoleView(serverId, 'rat')!.description).toBe('Rat from the language file.')
  })
  test('a change reaches the public page at once (it is part of the page version)', async () => {
    const page = async () => (await mod.app.fetch(new Request(`http://localhost/servers/${serverId}/roles/innocent`))).text()
    expect(await page()).toContain('From the language file.')
    await post({ roles: { innocent: 'Written by an admin.' } })
    expect(await page()).toContain('Written by an admin.')
  })
  test('needs the server token; bad shapes, names and sizes are refused', async () => {
    expect((await post({ roles: {} }, null)).status).toBe(401)
    expect((await post({ roles: [] })).status).toBe(400)
    expect((await post({ roles: { 'bad name': 'x' } })).status).toBe(400)
    expect((await post({ roles: { innocent: 5 } })).status).toBe(400)
    expect((await post({ roles: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`r${i}`, 'x'])) })).status).toBe(400)
  })
  test('a text is cut at 4000 characters and stripped of control characters', async () => {
    await post({ roles: { innocent: 'a\u0001b' + 'x'.repeat(5000) } })
    const d = Store.getRoleNote(serverId, 'innocent')
    expect(d.length).toBe(4000)
    expect(d.startsWith('ab')).toBe(true)
  })
})
