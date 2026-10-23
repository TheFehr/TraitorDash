import { expect, test, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 15: the role pages are public and read-only; the form is at /config for admins; the embed has
// no header and no script; every page has the strict headers; nothing private reaches them.

let app: any, Store: any, db: any, mod: any, Extractor: any
const ADMIN = '76561198000000000', USER = '76561198000000042'
let serverId: string, otherId: string
const TOKEN_LIKE = 'td_SECRET_TOKEN_VALUE'

const cookieFor = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
const get = async (path: string, as: string | null = null, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: { ...(as ? { Cookie: await cookieFor(as) } : {}), ...headers } }))

const SCHEMA = [
  { type: 'conVarData', args: { key: 'pct', value: 0.13, convar: 'ttt_haunter_pct' } },
  { type: 'conVarData', args: { key: 'minPlayers', value: 6, convar: 'ttt_haunter_min_players' } },
  { type: 'makecheckbox', args: { label: 'label_haunter_something', convar: 'ttt_haunter_something' } },
  { type: 'conVarData', args: { key: 'togglable', value: 1, convar: 'ttt_haunter_enabled', secretField: TOKEN_LIKE } },
]
const live = (name: string, value: string | null, def: string | null, role = 'haunter', present = true) => ({ name, role, present, value, default: def, min: null, max: null })

beforeAll(async () => {
  app = (await import('../src/index')).app
  mod = await import('../src/index')
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  Extractor = (await import('../src/services/Extractor')).Extractor
})
afterAll(() => { for (const k of ['PUBLIC_ROLES', 'PUBLIC_ROLE_SETTINGS', 'TRUST_PROXY', 'ROLE_PAGE_LIMIT', 'OPEN_SIGNIN']) delete process.env[k] })

beforeEach(() => {
  for (const k of ['PUBLIC_ROLES', 'PUBLIC_ROLE_SETTINGS', 'TRUST_PROXY', 'OPEN_SIGNIN']) delete process.env[k]
  mod.resetRolePages()
  serverId = (Store.addServer('Pub') as any).id
  otherId = (Store.addServer('Other') as any).id
  Store.saveSchema(serverId, 'haunter', 'traitors', false, -1, SCHEMA, 'h1', 'Haunt the living.\n\n<script>alert(1)</script><img src=x onerror=alert(2)>Second   paragraph.')
  Store.saveSchema(serverId, 'plain', 'innocents', false, -1, [], 'p1', null)
  Store.saveSchema(otherId, 'secretrole', 'traitors', false, -1, [], 's1', 'other server text')
  Store.setConVarValues(serverId, [
    live('ttt_haunter_pct', '0.2', '0.13'), live('ttt_haunter_min_players', '8', '6'), live('ttt_haunter_max', '0', null),
    live('ttt_haunter_enabled', '1', '1'), live('ttt_haunter_something', '0', '1'), live('ttt_haunter_random', '35', null),
  ])
})

describe('access', () => {
  test('an anonymous visitor reads the list and a role; no redirect, no cookie set', async () => {
    for (const p of [`/servers/${serverId}/roles`, `/servers/${serverId}/roles/haunter`]) {
      const r = await get(p)
      expect(r.status).toBe(200)
      expect(r.headers.get('set-cookie')).toBeNull()
    }
  })
  test('an unknown server or role, and odd names, are 404 and not redirects', async () => {
    const bad = [`/servers/nope/roles`, `/servers/nope/roles/haunter`, `/servers/${serverId}/roles/ghost`, `/servers/${serverId}/roles/secretrole`,
      `/servers/${serverId}/roles/..%2F..%2Fhealth`, `/servers/${serverId}/roles/${'a'.repeat(200)}`, `/servers/${serverId}/roles/h%00x`, `/servers/${serverId}/roles/ha%20unter`]
    for (const p of bad) expect((await get(p)).status, p).toBe(404)
  })
  test('the form is at /config and admin only; the old address is the read-only page', async () => {
    const cfg = `/servers/${serverId}/roles/haunter/config`
    expect((await get(cfg)).status).toBe(302)
    process.env.OPEN_SIGNIN = '1'
    expect((await get(cfg, USER)).status).toBe(302)
    const admin = await get(cfg, ADMIN)
    expect(admin.status).toBe(200)
    expect(await admin.text()).toContain('config-form')
    expect(await (await get(`/servers/${serverId}/roles/haunter`)).text()).not.toContain('config-form')
  })
  test('only an admin sees the edit link, and never in the embed', async () => {
    process.env.OPEN_SIGNIN = '1'
    const p = `/servers/${serverId}/roles/haunter`
    expect(await (await get(p, ADMIN)).text()).toContain('/roles/haunter/config')
    expect(await (await get(p, USER)).text()).not.toContain('/config')
    expect(await (await get(p)).text()).not.toContain('/config')
    expect(await (await get(p + '?embed=1', ADMIN)).text()).not.toContain('/config')
    expect((await get(p + '?embed=1', ADMIN)).headers.get('cache-control')).toBe('public, max-age=60') // identical for everybody, so shareable
    expect((await get(p, ADMIN)).headers.get('cache-control')).toContain('private')
  })
  test('PUBLIC_ROLES=0 makes the pages admin only again', async () => {
    process.env.PUBLIC_ROLES = '0'
    expect((await get(`/servers/${serverId}/roles/haunter`)).status).toBe(302)
    expect((await get(`/servers/${serverId}/roles`)).status).toBe(302)
    expect((await get(`/servers/${serverId}/roles/haunter`, ADMIN)).status).toBe(200)
  })
})

describe('content', () => {
  const page = async (embed = false) => (await get(`/servers/${serverId}/roles/haunter${embed ? '?embed=1' : ''}`)).text()
  test('name, team, description as text, the numbers, the settings with value and default', async () => {
    const html = await page()
    expect(html).toContain('haunter')
    expect(html).toContain('traitors')
    expect(html).toContain('Haunt the living.')
    expect(html).toContain('Second paragraph.')
    expect(html).toContain('20 %')        // distribution 0.2
    expect(html).toContain('unlimited')   // max 0
    expect(html).toContain('35 %')        // spawn chance
    expect(html).toContain('Role distribution per player')
    expect(html).toContain('off')         // the checkbox, reported 0
  })
  test('a description is plain text: no tags or handlers get through', async () => {
    const html = await page()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=alert')
  })
  test('without a description the page says so; a number the server did not report says so', async () => {
    const html = await (await get(`/servers/${serverId}/roles/plain`)).text()
    expect(html).toContain('The addon does not describe this role.')
    expect(html).toContain('not reported yet')
  })
  test('a role the server has reported other settings for, but not a distribution or limit, says there is no such setting (a Defector is made by a conversion, not dealt)', async () => {
    Store.saveSchema(serverId, 'converted', 'traitors', false, -1, [], 'c1', null)
    Store.setConVarValues(serverId, [live('ttt_conv_credits_starting', '0', '0', 'converted')])
    const html = await (await get(`/servers/${serverId}/roles/converted`)).text()
    expect(html).toContain('no such setting')
    expect(html).not.toContain('not reported yet')
    // a role nothing was reported for is still just "not reported yet"
    expect(await (await get(`/servers/${serverId}/roles/plain`)).text()).toContain('not reported yet')
  })
  test('a role made during a round is its own group on the list, says so, and is not counted as one that can appear', async () => {
    Store.saveSchema(serverId, 'converted', 'traitors', false, -1, [], 'c1', null)
    Store.setConVarValues(serverId, [live('ttt_conv_credits_starting', '0', '0', 'converted')])
    const list = await (await get(`/servers/${serverId}/roles?players=10`)).text()
    expect(list).toContain('Made during the round, not dealt')
    expect(list).toContain('1 made in the round')
    const names = [...list.matchAll(/class="f ([a-z ]*)" style="--c:#[0-9a-f]{6}" href="[^"]*\/roles\/([^?"]+)/g)].map(m => `${m[2]}:${m[1].trim()}`)
    expect(names).toContain('converted:made')
    expect(names).toContain('haunter:')
    expect(names.indexOf('converted:made')).toBeGreaterThan(names.indexOf('haunter:'))
    const page = await (await get(`/servers/${serverId}/roles/converted`)).text()
    expect(page).toContain('Made during a round, not dealt at its start')
    expect(await (await get(`/servers/${serverId}/roles/haunter`)).text()).not.toContain('not dealt at its start')
  })
  test('a disabled role says so and keeps its numbers', async () => {
    Store.setConVarValues(serverId, [live('ttt_haunter_enabled', '0', '1')])
    const html = await page()
    expect(html).toContain('Disabled on this server')
    expect(html).toContain('20 %')
  })
  test('PUBLIC_ROLE_SETTINGS=0 removes the settings and keeps the rest', async () => {
    process.env.PUBLIC_ROLE_SETTINGS = '0'
    const html = await page()
    expect(html).not.toContain('Role distribution per player')
    expect(html).not.toContain('<h2>Settings')
    expect(html).toContain('Haunt the living.')
    expect(html).toContain('20 %')
  })
  test('the list shows the roles with their team, and narrows by a search', async () => {
    const html = await (await get(`/servers/${serverId}/roles`)).text()
    expect(html).toContain('haunter'); expect(html).toContain('plain')
    const narrow = await (await get(`/servers/${serverId}/roles?q=HAU`)).text()
    expect(narrow).toContain('haunter'); expect(narrow).not.toContain('>plain<')
  })
  test('nothing else leaks: token, admin ids, audit rows, the other server, extra fields', async () => {
    Store.audit?.('TEST_ACTION', ADMIN, serverId, 'audit-marker-xyz')
    const all = [await page(), await page(true), await (await get(`/servers/${serverId}/roles`)).text()].join('\n')
    const token = (db.prepare('SELECT api_token_hash FROM servers WHERE id = ?').get(serverId) as any)?.api_token_hash
    for (const secret of [TOKEN_LIKE, ADMIN, 'secretrole', 'other server text', 'audit-marker-xyz', 'SESSION_SECRET', SECRET, ...(token ? [token] : []), 'Other']) {
      expect(all, secret).not.toContain(secret)
    }
  })
})

describe('embed and headers', () => {
  test('both layouts carry the tab icon of the other pages', async () => {
    for (const q of ['', '?embed=1']) {
      for (const path of [`/servers/${serverId}/roles`, `/servers/${serverId}/roles/haunter`]) {
        expect(await (await get(path + q)).text()).toContain('<link rel="icon" href="data:image/svg+xml,')
      }
    }
  })
  test('the embed has no site header and no script; its links keep ?embed=1', async () => {
    const html = await (await get(`/servers/${serverId}/roles?embed=1`)).text()
    expect(html).not.toContain('TraitorDash')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('Sign in')
    expect(html).toContain('noindex')
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]!)
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) { expect(l.startsWith(`/servers/${serverId}/roles`)).toBe(true); expect(l.includes("embed=1")).toBe(true) }
    expect(html).toContain('name="embed"')
  })
  test('the normal layout has the site link and still no script', async () => {
    const html = await (await get(`/servers/${serverId}/roles/haunter`)).text()
    expect(html).toContain('TraitorDash')
    expect(html).not.toContain('<script')
  })
  test('every response, 404 included, has the strict headers; the embed is noindex; the page is cacheable', async () => {
    for (const p of [`/servers/${serverId}/roles`, `/servers/${serverId}/roles/haunter?embed=1`, `/servers/${serverId}/roles/ghost`]) {
      const r = await get(p)
      expect(r.headers.get('content-security-policy'), p).toContain("default-src 'none'")
      expect(r.headers.get('content-security-policy'), p).toContain("frame-ancestors 'none'")
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff')
      expect(r.headers.get('referrer-policy'), p).toBe('same-origin') // never no-referrer: Firefox then posts forms with Origin: null
    }
    const emb = await get(`/servers/${serverId}/roles/haunter?embed=1`)
    expect(emb.headers.get('x-robots-tag')).toBe('noindex')
    expect(emb.headers.get('cache-control')).toBe('public, max-age=60')
    expect(emb.headers.get('etag')).toBeTruthy()
    expect((await get(`/servers/${serverId}/roles/haunter`)).headers.get('x-robots-tag')).toBeNull()
  })
  test('If-None-Match answers 304; changing the role data changes the ETag', async () => {
    const p = `/servers/${serverId}/roles/haunter?embed=1`
    const first = await get(p)
    const etag = first.headers.get('etag')!
    expect((await get(p, null, { 'If-None-Match': etag })).status).toBe(304)
    await Bun.sleep(5)
    Store.setConVarValues(serverId, [live('ttt_haunter_min_players', '9', '6')])
    const second = await get(p)
    expect(second.headers.get('etag')).not.toBe(etag)
    expect(await second.text()).toContain('>9<')
  })
})

describe('limits', () => {
  test('the 121st request in a minute from one address is a 429; another address is not affected', async () => {
    process.env.TRUST_PROXY = '1'
    const p = `/servers/${serverId}/roles/haunter?embed=1`
    for (let i = 0; i < 120; i++) expect((await get(p, null, { 'X-Forwarded-For': '10.0.0.1' })).status).toBe(200)
    const over = await get(p, null, { 'X-Forwarded-For': '10.0.0.1' })
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBeTruthy()
    expect((await get(p, null, { 'X-Forwarded-For': '10.0.0.2' })).status).toBe(200)
  })
})

describe('the description comes from the language files at extraction', () => {
  const lang = (key: string, text: string) => `LANG.AddToLanguage("en", "${key}", "${text}")`
  const role = 'ROLE.defaultTeam = "traitors"'
  test('ttt2_desc_<role> first, then info_popup_<role>, else none', async () => {
    const both = await Extractor.extractSchema(role, {}, {}, 'haunter', [lang('info_popup_haunter', 'popup'), lang('ttt2_desc_haunter', 'desc')])
    expect(both.description).toBe('desc')
    const popup = await Extractor.extractSchema(role, {}, {}, 'haunter', [lang('info_popup_haunter', 'popup')])
    expect(popup.description).toBe('popup')
    const none = await Extractor.extractSchema(role, {}, {}, 'haunter', [lang('ttt2_desc_other', 'x')])
    expect(none.description).toBeNull()
  })
})

describe('migration v16', () => {
  test('adds the description column and clears the role hashes so every role is sent again', async () => {
    const { Database } = await import('bun:sqlite')
    const { migrate, migrations } = await import('../src/services/migrations') as any
    const d = new Database(':memory:')
    for (let i = 0; i < 15; i++) migrations[i](d)
    d.run('PRAGMA user_version = 15')
    d.run("INSERT INTO servers (id, name, api_token_hash) VALUES ('s', 'S', 'h')")
    d.run("INSERT INTO roles (server_id, role_name, team, is_policing, baserole, schema_json, md5_hash) VALUES ('s', 'r', 't', 0, -1, '[]', 'abc')")
    migrate(d)
    expect((d.query('SELECT md5_hash, description FROM roles').get() as any)).toEqual({ md5_hash: null, description: null })
  })
})

describe('migration v17', () => {
  test('adds the colour column, empty, and clears the role hashes again', async () => {
    const { Database } = await import('bun:sqlite')
    const { migrate, migrations } = await import('../src/services/migrations') as any
    const d = new Database(':memory:')
    for (let i = 0; i < 16; i++) migrations[i](d)
    d.run('PRAGMA user_version = 16')
    d.run("INSERT INTO servers (id, name, api_token_hash) VALUES ('s', 'S', 'h')")
    d.run("INSERT INTO roles (server_id, role_name, team, is_policing, baserole, schema_json, md5_hash, description) VALUES ('s', 'r', 't', 0, -1, '[]', 'abc', 'kept')")
    migrate(d)
    expect((d.query('SELECT md5_hash, description, color FROM roles').get() as any)).toEqual({ md5_hash: null, description: 'kept', color: null })
  })
  test('a database without a roles table is left alone', async () => {
    const { Database } = await import('bun:sqlite')
    const { migrations } = await import('../src/services/migrations') as any
    const d = new Database(':memory:')
    expect(() => migrations[16](d)).not.toThrow()
  })
})

describe('GET /api/v1/whoami', () => {
  test('returns the id of the server the token belongs to, and nothing else; 401 without or with a wrong token or a cookie', async () => {
    const created = Store.addServer('Who') as any
    const r = await app.fetch(new Request('http://localhost/api/v1/whoami', { headers: { Authorization: `Bearer ${created.token}` } }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ server_id: created.id })
    expect((await app.fetch(new Request('http://localhost/api/v1/whoami'))).status).toBe(401)
    expect((await app.fetch(new Request('http://localhost/api/v1/whoami', { headers: { Authorization: 'Bearer nope' } }))).status).toBe(401)
    expect((await get('/api/v1/whoami', ADMIN)).status).toBe(401)
  })
})

describe('the description is looked for in more places', () => {
  const lang = (key: string, text: string, l = 'en') => `LANG.AddToLanguage("${l}", "${key}", "${text}")`
  const role = (extra = '') => `ROLE.defaultTeam = "traitors"\nROLE.abbr = "hnt"\n${extra}`
  const desc = async (sources: string[], code = role()) => (await Extractor.extractSchema(code, {}, {}, 'haunter', sources)).description
  test('by the role abbreviation too', async () => {
    expect(await desc([lang('ttt2_desc_hnt', 'by abbr')])).toBe('by abbr')
    expect(await desc([lang('ttt2_desc_haunter', 'by name'), lang('ttt2_desc_hnt', 'by abbr')])).toBe('by name')
  })
  test('with a suffix, as some addons name it', async () => {
    expect(await desc([lang('haunter_description', 'suffix')])).toBe('suffix')
    expect(await desc([lang('hnt_info', 'suffix abbr')])).toBe('suffix abbr')
  })
  test('a language the role file itself registers counts', async () => {
    expect(await desc([], role(lang('ttt2_desc_haunter', 'from the role file'))) ).toBe('from the role file')
  })
  test('any English key that names the role and is about it, if it is a sentence', async () => {
    expect(await desc([lang('role_haunter_explained_long', 'A longer sentence that explains the haunter.')])).toBe('A longer sentence that explains the haunter.')
    expect(await desc([lang('haunter_help_x', 'Short')])).toBeNull() // not a sentence
    expect(await desc([lang('label_haunter_other', 'A longer sentence that has nothing to do with it.')])).toBeNull() // not about the role
  })
  test('English wins; another language is the last resort', async () => {
    expect(await desc([lang('ttt2_desc_haunter', 'Geist', 'de')])).toBe('Geist')
    expect(await desc([lang('ttt2_desc_haunter', 'Geist', 'de'), lang('ttt2_desc_haunter', 'ghost')])).toBe('ghost')
  })
  test('a role of another name is never matched', async () => {
    expect(await desc([lang('ttt2_desc_haunters', 'x'), lang('ttt2_desc_other', 'y')])).toBeNull()
  })
})
