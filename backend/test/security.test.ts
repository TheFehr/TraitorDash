import { expect, test, describe, beforeAll } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { Extractor } from '../src/services/Extractor'

// Regression tests for the security review's extractor findings. The role file and the
// language files come from a game server, so they are hostile input.

const probe = (expr: string) => `
  function ROLE:AddToSettingsMenu(p) p:MakeHelp({ label = ${expr} }) end
`
const labelOf = async (expr: string) =>
  (await Extractor.extractSchema(probe(expr), {}, {}, 'probe', [])).schema[0].args.label

describe('the Lua sandbox', () => {
  test('exposes nothing that reaches the host', async () => {
    const names = ['os.execute', 'os.exit', 'os.remove', 'os.rename', 'os.getenv', 'os.tmpname', 'io', 'dofile', 'loadfile', 'load', 'loadstring', 'require', 'debug', 'package', 'collectgarbage']
    for (const n of names) {
      expect(await labelOf(`tostring(${n})`)).toBe('nil')
    }
  })

  test('still has what real role files use', async () => {
    expect(await labelOf(`string.format("%d-%s", 3, "x") .. tostring(math.floor(2.5)) .. #table.concat({"a","b"}) .. type(os.time())`)).toBe('3-x22number')
  })

  test('calling a removed function fails the extraction instead of running anything', async () => {
    const code = `os.execute("touch /tmp/should-never-exist-traitordash") ${probe('"x"')}`
    await expect(Extractor.extractSchema(code, {}, {}, 'probe', [])).rejects.toThrow()
    expect(await Bun.file('/tmp/should-never-exist-traitordash').exists()).toBe(false)
  })

  test('language files are sandboxed too', async () => {
    const lang = `os.exit(7)`
    // A broken language file is skipped, never fatal, and certainly never executes os.exit.
    const out = await Extractor.extractSchema(probe('"alive"'), {}, {}, 'probe', [lang])
    expect(out.schema[0].args.label).toBe('alive')
  })

  test('string.rep cannot allocate gigabytes', async () => {
    const code = `local s = string.rep("a", 2^30) ${probe('"x"')}`
    await expect(Extractor.extractSchema(code, {}, {}, 'probe', [])).rejects.toThrow(/too large/)
  })
})

describe('the extraction deadline', () => {
  const before = Extractor.timeoutMs
  beforeAll(() => { Extractor.timeoutMs = 600 })

  test('an infinite loop is stopped and reported, not left to freeze the backend', async () => {
    const started = Date.now()
    await expect(Extractor.extractSchema('while true do end', {}, {}, 'loop', [])).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('a loop that swallows errors with pcall is stopped too', async () => {
    const code = `while true do pcall(function() while true do end end) end`
    await expect(Extractor.extractSchema(code, {}, {}, 'loop', [])).rejects.toThrow(/timed out/)
  })

  test('the event loop stays responsive while a hostile file spins', async () => {
    let ticks = 0
    const interval = setInterval(() => ticks++, 20)
    await expect(Extractor.extractSchema('while true do end', {}, {}, 'loop', [])).rejects.toThrow(/timed out/)
    clearInterval(interval)
    expect(ticks).toBeGreaterThan(5)
  })

  test('extraction keeps working afterwards', async () => {
    Extractor.timeoutMs = before
    expect(await labelOf('"fine"')).toBe('fine')
  })
})

describe('ingest and save validation', () => {
  let api: any, Store: any, db: any, token: string, serverId: string, cookie: string

  beforeAll(async () => {
    api = (await import('../src/routes/api')).default
    Store = (await import('../src/services/Store')).Store
    db = (await import('../src/services/Database')).default
    const { serializeSigned } = await import('hono/utils/cookie')
    const added = Store.addServer('Sec')
    serverId = added.id
    token = added.token
    cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
  })

  const ingest = (body: unknown, raw = false) =>
    api.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: raw ? (body as string) : JSON.stringify(body),
    })

  const role = (convar: string) => `function ROLE:AddToSettingsMenu(p) p:MakeCheckbox({ label = "x", convar = ${JSON.stringify(convar)} }) end`

  test('role names are restricted to a safe character set and length', async () => {
    for (const bad of ['a b', 'x/../y', 'a?b', '<script>', 'a'.repeat(65), 'ttt_x;quit']) {
      expect((await ingest({ role_code: role('ttt_ok'), role_name: bad })).status).toBe(400)
    }
    expect((await ingest({ role_code: role('ttt_ok'), role_name: 'good_role1' })).status).toBe(200)
  })

  test('role_code has a size cap', async () => {
    const res = await ingest({ role_code: '-- ' + 'a'.repeat(300_000), role_name: 'big' })
    expect(res.status).toBe(413)
  })

  test('a body that is not a JSON object is a 400, not a 500', async () => {
    for (const raw of ['null', '[]', '"str"', '42', 'not json']) {
      expect((await ingest(raw, true)).status).toBe(400)
    }
  })

  test('a hostile Lua error does not come back with host data', async () => {
    process.env.TD_SECRET_PROBE = 'super-secret-value'
    const res = await ingest({ role_code: 'error(os.getenv("TD_SECRET_PROBE"))', role_name: 'leak' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('super-secret-value')
  })

  test('schema entries whose ConVar name is not a plain identifier are dropped, so they can never be saved', async () => {
    const evil = 'ttt_roundtime_minutes 1;quit;ttt_roundtime_minutes'
    const code = `function ROLE:AddToSettingsMenu(p)
      p:MakeCheckbox({ label = "ok", convar = "ttt_fine_toggle" })
      p:MakeCheckbox({ label = "evil", convar = ${JSON.stringify(evil)} })
      p:MakeSlider({ label = "evil2", serverConvar = "ttt_x\\nquit" })
    end`
    const res = await ingest({ role_code: code, role_name: 'poisoned' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.schema.flatMap((e: any) => [e.args?.convar, e.args?.serverConvar]).filter(Boolean)
    expect(names).toEqual(['ttt_fine_toggle'])

    // And even a schema stored by an older build cannot be used to queue a command.
    Store.saveSchema(serverId, 'legacy', 'innocents', false, 0, [
      { type: 'MakeCheckbox', args: { label: 'evil', convar: evil } },
      { type: 'MakeCheckbox', args: { label: 'ok', convar: 'ttt_fine_toggle' } },
    ])
    db.run('DELETE FROM commands WHERE server_id = ?', [serverId])
    const save = await api.request(`/save/${serverId}/legacy`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [evil]: '1', ttt_fine_toggle: '1' }).toString(),
    })
    expect(save.status).toBe(200)
    const queued = (db.query('SELECT args FROM commands WHERE server_id = ?').all(serverId) as any[]).map(r => r.args)
    expect(queued).toEqual(['ttt_fine_toggle 1'])
  })
})
