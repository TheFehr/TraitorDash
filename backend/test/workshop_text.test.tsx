import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 15: which Workshop addon a role comes from (the bridge reports it), and the text of that addon's
// Workshop page as the description of a role the addon does not describe.

let api: any, mod: any, Store: any, wt: any, rv: any, db: any, token: string, serverId: string

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  mod = await import('../src/index')
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  wt = await import('../src/services/workshopText')
  rv = await import('../src/services/roleview')
})

let calls: string[][] = []
const page = (id: string, title: string, description: string, result = 1) => ({ publishedfileid: id, result, title, description })
/** What Steam answers: only the items in `known`. */
const steam = (known: Record<string, { title: string, description: string }>, fail = false) => wt.setFetcher(async (_url: string, init: any) => {
  const ids = [...new URLSearchParams(init.body).entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v)
  calls.push(ids)
  if (fail) return { ok: false, json: async () => ({}) }
  return { ok: true, json: async () => ({ response: { publishedfiledetails: ids.map(id => known[id] ? page(id, known[id].title, known[id].description) : { publishedfileid: id, result: 9 }) } }) }
})

beforeEach(async () => {
  const added = Store.addServer('Addons') as any
  serverId = added.id; token = added.token
  ;(await import('../src/routes/api')).roleAddonsLimiter.reset()
  mod.resetRolePages()
  db.run('DELETE FROM workshop_text')
  calls = []
  steam({})
  Store.saveSchema(serverId, 'arsonist', 'traitors', false, -1, [], 'h', null)
  Store.saveSchema(serverId, 'pyro', 'traitors', false, -1, [], 'h', null)
  Store.saveSchema(serverId, 'documented', 'innocents', false, -1, [], 'h', 'The addon says this.')
})

const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
  api.request('/v1/roleaddons', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
const settle = () => new Promise(r => setTimeout(r, 20))
const html = async (role: string, q = '') => (await mod.app.fetch(new Request(`http://localhost/servers/${serverId}/roles/${role}${q}`))).text()

describe('cleaning a Workshop description', () => {
  test('BBCode and HTML become plain text; links and images go; list items become lines', () => {
    const raw = '[h1]Arsonist[/h1]\r\n[b]Burns[/b] [i]things[/i] with [url=https://x.example/a]a lighter[/url].\n[img]https://i.example/a.png[/img]\n[list]\n[*] First\n[*] Second\n[/list]\nSee https://example.com/page &amp; &quot;more&quot;<br/>done'
    const t = wt.cleanWorkshopText(raw)
    expect(t).toBe('Arsonist\nBurns things with a lighter.\n- First\n- Second\nSee & "more"\ndone')
    expect(t).not.toMatch(/https?:|\[|\]|<|>/)
  })
  test('nothing left means null; long text is cut on a word with an ellipsis; control characters go', () => {
    expect(wt.cleanWorkshopText('[img]x[/img] [b][/b]')).toBeNull()
    expect(wt.cleanWorkshopText(null)).toBeNull()
    expect(wt.cleanWorkshopText('a\u0000b\u0007c')).toBe('abc')
    const long = wt.cleanWorkshopText('word '.repeat(2000))!
    expect(long.length).toBeLessThanOrEqual(1501)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('POST /api/v1/roleaddons', () => {
  test('needs the server token', async () => {
    expect((await post({ roles: {} }, null)).status).toBe(401)
  })
  test('stores the list and replaces the earlier one', async () => {
    expect((await post({ roles: { arsonist: [{ wsid: '111', title: 'Arsonist Addon' }], pyro: [{ wsid: '111', title: 'Arsonist Addon' }] } })).status).toBe(200)
    expect(Store.getRoleAddons(serverId, 'arsonist')).toEqual([{ wsid: '111', title: 'Arsonist Addon', roles: ['pyro'] }])
    await post({ roles: { arsonist: [{ wsid: '222', title: 'New' }] } })
    expect(Store.getRoleAddons(serverId, 'arsonist').map((a: any) => a.wsid)).toEqual(['222'])
    expect(Store.getRoleAddons(serverId, 'pyro')).toEqual([])
  })
  test('refuses what is not a name, an id or a list', async () => {
    const bads: unknown[] = [
      {}, { roles: [] }, { roles: 'x' },
      { roles: { 'bad name': [{ wsid: '1', title: 't' }] } },
      { roles: { a: [{ wsid: 'abc', title: 't' }] } },
      { roles: { a: [{ wsid: '1234567890123', title: 't' }] } },
      { roles: { a: 'nope' } },
      { roles: { a: Array.from({ length: 11 }, () => ({ wsid: '1', title: 't' })) } },
    ]
    const limiter = (await import('../src/routes/api')).roleAddonsLimiter
    for (const b of bads) { limiter.reset(); expect((await post(b)).status, JSON.stringify(b)).toBe(400) }
    expect(Store.getRoleAddons(serverId, 'a')).toEqual([])
  })
  test('titles are cleaned and cut', async () => {
    await post({ roles: { arsonist: [{ wsid: '5', title: `  A\u0000B${'x'.repeat(300)} ` }] } })
    const t = Store.getRoleAddons(serverId, 'arsonist')[0].title
    expect(t.startsWith('AB')).toBe(true)
    expect(t.length).toBe(200)
  })
  test('is limited per server', async () => {
    let last = 200
    for (let i = 0; i < 8; i++) last = (await post({ roles: {} })).status
    expect(last).toBe(429)
  })
  test('starts reading the Workshop pages, without waiting for them', async () => {
    steam({ '111': { title: 'Arsonist Addon', description: 'Sets fire.' } })
    await post({ roles: { arsonist: [{ wsid: '111', title: 't' }] } })
    await settle()
    expect(calls).toEqual([['111']])
    expect(Store.getWorkshopText('111')).toMatchObject({ title: 'Arsonist Addon', description: 'Sets fire.', status: 'ok' })
  })
})

describe('reading the pages', () => {
  test('a page already read is not read again within a week; a missing one is retried after an hour', async () => {
    steam({ '1': { title: 'A', description: 'text' } })
    const now = Date.now()
    await wt.refreshWorkshopText(['1', '2'], now)
    expect(calls).toEqual([['1', '2']])
    expect(Store.getWorkshopText('2').status).toBe('missing')
    await wt.refreshWorkshopText(['1', '2'], now + 30 * 60_000)
    expect(calls.length).toBe(1)
    await wt.refreshWorkshopText(['1', '2'], now + 2 * 3600_000)
    expect(calls[1]).toEqual(['2'])
    await wt.refreshWorkshopText(['1'], now + 8 * 24 * 3600_000)
    expect(calls[2]).toEqual(['1'])
  })
  test('twenty at a time; ids that are not ids are never sent', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => String(100 + i))
    await wt.refreshWorkshopText([...ids, 'x; drop', '', '12345678901234'])
    expect(calls.map(c => c.length)).toEqual([20, 20, 5])
  })
  test('a failing Steam stores a failure and never throws', async () => {
    steam({}, true)
    await wt.refreshWorkshopText(['7'])
    expect(Store.getWorkshopText('7').status).toBe('failed')
    steam({ '7': { title: 'T', description: 'back' } })
    await wt.refreshWorkshopText(['7'], Date.now() + 2 * 3600_000)
    expect(Store.getWorkshopText('7')).toMatchObject({ status: 'ok', description: 'back' })
  })
  test('a failure does not overwrite a page that was read', async () => {
    steam({ '8': { title: 'T', description: 'kept' } })
    await wt.refreshWorkshopText(['8'])
    steam({}, true)
    await wt.refreshWorkshopText(['8'], Date.now() + 8 * 24 * 3600_000)
    expect(Store.getWorkshopText('8')).toMatchObject({ status: 'ok', description: 'kept' })
  })
})

describe('on the role page', () => {
  const report = async (roles: Record<string, string[]>) => {
    steam({ '111': { title: 'Arsonist Addon', description: '[b]Sets[/b] fire to players.' } })
    await post({ roles: Object.fromEntries(Object.entries(roles).map(([r, ids]) => [r, ids.map(id => ({ wsid: id, title: 'Local title' }))])) })
    await settle()
    mod.resetRolePages()
  }
  test('a role without a description shows its addon page text, where it came from, and a link outside the game', async () => {
    await report({ arsonist: ['111'] })
    const h = await html('arsonist')
    expect(h).toContain('Sets fire to players.')
    expect(h).toContain('From the Workshop page of Arsonist Addon')
    expect(h).toContain('href="https://steamcommunity.com/sharedfiles/filedetails/?id=111"')
    const e = await html('arsonist', '?embed=1')
    expect(e).toContain('Sets fire to players.')
    expect(e).not.toContain('steamcommunity.com')
  })
  test('an addon that holds a few roles says which others it covers', async () => {
    await report({ arsonist: ['111'], pyro: ['111'] })
    expect(await html('arsonist')).toContain('which also covers pyro')
  })
  test('an addon that holds many roles is a collection: its page is not shown', async () => {
    await report({ arsonist: ['111'], pyro: ['111'], a: ['111'], b: ['111'] })
    const h = await html('arsonist')
    expect(h).not.toContain('Sets fire')
    expect(h).toContain('Plays for the Traitors team.')
  })
  test("the addon's own description wins over the Workshop page", async () => {
    await report({ documented: ['111'] })
    const h = await html('documented')
    expect(h).toContain('The addon says this.')
    expect(h).not.toContain('Sets fire')
  })
  test('the page text is escaped, never HTML', async () => {
    steam({ '111': { title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)> hello & <b>bold</b>' } })
    await post({ roles: { arsonist: [{ wsid: '111', title: 't' }] } })
    await settle()
    mod.resetRolePages()
    const h = await html('arsonist')
    expect(h).not.toContain('<script>alert')
    expect(h).not.toContain('<img')
    expect(h).toContain('hello &amp;')
  })
  test('with no page read yet, only the team line shows', async () => {
    steam({}, true)
    await post({ roles: { arsonist: [{ wsid: '111', title: 't' }] } })
    await settle()
    mod.resetRolePages()
    expect(await html('arsonist')).not.toContain('From the Workshop page')
  })
})
