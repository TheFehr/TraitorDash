import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { createHash } from 'node:crypto'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.BASE_URL = 'https://dash.example.com'

let apiMod: any, appFetch: any, Store: any, db: any, pairing: any, cookie: string
const app = { request: (path: string, init?: RequestInit) => appFetch(new Request(`http://td.test${path}`, { redirect: 'manual', ...init })) }
const ADMIN = '76561198000000000'
const MINUTE = 60_000

beforeAll(async () => {
  apiMod = await import('../src/routes/api')
  appFetch = (await import('../src/index')).default.fetch
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  pairing = await import('../src/services/pairing')
  const { SESSION_COOKIE } = await import('../src/middleware/session')
  cookie = (await serializeSigned(SESSION_COOKIE, ADMIN, 'test-secret-test-secret-test-secret-0', { path: '/', secure: SESSION_COOKIE.startsWith('__Host-') })).split(';')[0]!
  process.env.BASE_URL = 'https://dash.example.com' // other test files share this process
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const openRows = (serverId: string) => db.query('SELECT * FROM pairing_codes WHERE server_id = ? AND used_at IS NULL').all(serverId) as any[]

describe('the code', () => {
  test('is 10 characters of the Crockford alphabet, and different every time', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = pairing.generateCode()
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/)
      seen.add(c)
    }
    expect(seen.size).toBe(200)
  })

  test('is shown as two groups of five', () => {
    expect(pairing.formatCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK')
  })

  test('is normalised: case, dashes, spaces and the usual confusions', () => {
    expect(pairing.normalizeCode('abcde-fghjk')).toBe('ABCDEFGHJK')
    expect(pairing.normalizeCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK')
    expect(pairing.normalizeCode('o0i1l-LIO00')).toBe('0011111000')
  })

  test('hashes with sha-256 of the normalised form', () => {
    expect(pairing.hashCode('abcde-fghjk')).toBe(sha('ABCDEFGHJK'))
  })
})

describe('storing and redeeming a code', () => {
  let id: string, token: string
  beforeEach(() => {
    const s = Store.addServer('Pairing')
    id = s.id; token = s.token
  })

  test('only the hash is stored', () => {
    const code = Store.createPairingCode(id, ADMIN)
    const rows = openRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].code_hash).toBe(sha(code))
    expect(rows[0].created_by).toBe(ADMIN)
    expect(JSON.stringify(rows[0])).not.toContain(code)
    expect(rows[0].expires_at - rows[0].created_at).toBe(10 * MINUTE)
  })

  test('creating a new code replaces the open one', () => {
    const first = Store.createPairingCode(id, ADMIN)
    const second = Store.createPairingCode(id, ADMIN)
    expect(openRows(id)).toHaveLength(1)
    expect(Store.redeemPairingCode(first)).toBeNull()
    expect(Store.redeemPairingCode(second)).not.toBeNull()
  })

  test('an unknown server gets no code', () => {
    expect(Store.createPairingCode('no-such-server', ADMIN)).toBeNull()
  })

  test('a valid code returns a working token and rotates the old one', () => {
    const code = Store.createPairingCode(id, ADMIN)
    const out = Store.redeemPairingCode(code)
    expect(out.serverId).toBe(id)
    expect(out.name).toBe('Pairing')
    expect(out.token).toMatch(/^[0-9a-f]{64}$/)
    expect(Store.getServerByToken(out.token)?.id).toBe(id)
    expect(Store.getServerByToken(token)).toBeNull()
  })

  test('accepts the code as the owner typed it', () => {
    const code = Store.createPairingCode(id, ADMIN)
    const typed = pairing.formatCode(code).toLowerCase()
    expect(Store.redeemPairingCode(typed)).not.toBeNull()
  })

  test('works once; the second use fails', () => {
    const code = Store.createPairingCode(id, ADMIN)
    expect(Store.redeemPairingCode(code)).not.toBeNull()
    expect(Store.redeemPairingCode(code)).toBeNull()
  })

  test('works for ten minutes and not a moment longer', () => {
    const t0 = 1_000_000
    const code = Store.createPairingCode(id, ADMIN, t0)
    expect(Store.redeemPairingCode(code, t0 + 10 * MINUTE)).toBeNull()
    const again = Store.createPairingCode(id, ADMIN, t0)
    expect(Store.redeemPairingCode(again, t0 + 10 * MINUTE - 1)).not.toBeNull()
  })

  test('an unknown, malformed or empty code fails', () => {
    for (const bad of ['0000000000', 'short', '', '!!!!!-!!!!!', 'A'.repeat(200)]) {
      expect(Store.redeemPairingCode(bad)).toBeNull()
    }
  })

  test('a failing step leaves the code unused and the token unchanged', () => {
    const code = Store.createPairingCode(id, ADMIN)
    db.run("CREATE TEMP TRIGGER no_token_change BEFORE UPDATE ON servers BEGIN SELECT RAISE(ABORT, 'boom'); END")
    try {
      expect(() => Store.redeemPairingCode(code)).toThrow()
    } finally {
      db.run('DROP TRIGGER no_token_change')
    }
    expect(openRows(id)).toHaveLength(1)
    expect(Store.getServerByToken(token)?.id).toBe(id)
    expect(Store.redeemPairingCode(code)).not.toBeNull()
  })

  test('cleanup removes expired and used codes and keeps live ones', () => {
    const t0 = 5_000_000
    const live = Store.addServer('Live'), old = Store.addServer('Old'), used = Store.addServer('Used')
    const liveCode = Store.createPairingCode(live.id, ADMIN, t0)
    Store.createPairingCode(old.id, ADMIN, t0 - 11 * MINUTE)
    const usedCode = Store.createPairingCode(used.id, ADMIN, t0)
    Store.redeemPairingCode(usedCode, t0)

    Store.cleanupPairingCodes(t0)

    expect(db.query('SELECT server_id FROM pairing_codes WHERE server_id IN (?, ?, ?)').all(live.id, old.id, used.id))
      .toEqual([{ server_id: live.id }])
    expect(Store.redeemPairingCode(liveCode, t0)).not.toBeNull()
  })

  test('deleting a server deletes its codes', () => {
    Store.createPairingCode(id, ADMIN)
    Store.deleteServer(id)
    expect(db.query('SELECT 1 FROM pairing_codes WHERE server_id = ?').all(id)).toHaveLength(0)
  })
})

describe('POST /api/servers/:id/pairing-code', () => {
  let id: string
  beforeEach(() => { id = Store.addServer('Banner').id })
  const create = (headers: Record<string, string> = {}, serverId = id) =>
    app.request(`/api/servers/${serverId}/pairing-code`, { method: 'POST', headers })

  test('needs an admin session', async () => {
    expect((await create()).status).toBe(401)
    expect(openRows(id)).toHaveLength(0)
  })

  test('refuses a cross-site origin', async () => {
    const res = await create({ Cookie: cookie, Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(openRows(id)).toHaveLength(0)
  })

  test('an unknown server is a 404', async () => {
    expect((await create({ Cookie: cookie }, 'no-such-server')).status).toBe(404)
  })

  test('shows the ready-to-paste command with the dashboard address, and never caches it', async () => {
    const res = await create({ Cookie: cookie, Origin: 'https://dash.example.com' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const html = await res.text()
    const m = html.match(/traitordash_connect https:\/\/dash\.example\.com ([0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5})/)
    expect(m).not.toBeNull()
    expect(openRows(id)).toHaveLength(1)
    expect(openRows(id)[0].code_hash).toBe(pairing.hashCode(m![1]!))
  })

  test('is recorded in the audit log without the code', async () => {
    const html = await (await create({ Cookie: cookie })).text()
    const row = db.query("SELECT * FROM audit_log WHERE server_id = ? AND action = 'PAIR_CODE_CREATED'").get(id)
    expect(row.steam_id).toBe(ADMIN)
    const code = html.match(/([0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5})/)![1]!
    expect(JSON.stringify(row)).not.toContain(code)
  })
})

describe('POST /api/v1/pair', () => {
  let id: string, oldToken: string
  beforeEach(() => {
    apiMod.pairLimiter.reset()
    apiMod.pairGlobalLimiter.reset()
    const s = Store.addServer('Redeem')
    id = s.id; oldToken = s.token
  })
  afterEach(() => { delete process.env.TRUST_PROXY })

  const pair = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  test('needs no session or token: the code is the credential', async () => {
    const code = Store.createPairingCode(id, ADMIN)
    const res = await pair({ code })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.server_id).toBe(id)
    expect(body.name).toBe('Redeem')
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(Store.getServerByToken(body.token)?.id).toBe(id)
    expect(Store.getServerByToken(oldToken)).toBeNull()
  })

  test('accepts the code as typed, with dashes and lower case', async () => {
    const code = Store.createPairingCode(id, ADMIN)
    expect((await pair({ code: pairing.formatCode(code).toLowerCase() })).status).toBe(200)
  })

  test('an unknown, an expired and a used code fail in exactly the same way', async () => {
    const used = Store.createPairingCode(id, ADMIN)
    await pair({ code: used })
    const expired = Store.createPairingCode(id, ADMIN, Date.now() - 11 * MINUTE)

    const results = []
    for (const code of ['0123456789', expired, used]) {
      const res = await pair({ code })
      results.push([res.status, await res.text()])
    }
    expect(results[0]![0]).toBe(400)
    expect(results[1]).toEqual(results[0]!)
    expect(results[2]).toEqual(results[0]!)
    expect(JSON.parse(results[0]![1] as string)).toEqual({ error: 'invalid or expired code' })
  })

  test('a bad body is a 400 and nothing else', async () => {
    for (const body of ['not json', '[]', '{}', '{"code":5}', '{"code":null}', JSON.stringify({ code: 'A'.repeat(600) })]) {
      const res = await pair(body)
      expect(res.status).toBe(400)
    }
  })

  test('a redemption is recorded in the audit log, a failure is not', async () => {
    const before = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'PAIR_%'").get().n
    await pair({ code: '0123456789' })
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'PAIR_%'").get().n).toBe(before)

    const code = Store.createPairingCode(id, ADMIN)
    await pair({ code })
    const row = db.query("SELECT * FROM audit_log WHERE server_id = ? AND action = 'PAIR_REDEEMED'").get(id)
    expect(row).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain(code)
  })

  test('without TRUST_PROXY only the global limit applies: 30 attempts a minute, then 429 with Retry-After', async () => {
    for (let i = 0; i < 30; i++) expect((await pair({ code: '0123456789' }, { 'X-Forwarded-For': `10.0.0.${i}` })).status).toBe(400)
    const res = await pair({ code: '0123456789' })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  test('a refused attempt does not reveal whether the code was right', async () => {
    for (let i = 0; i < 30; i++) await pair({ code: '0123456789' })
    const code = Store.createPairingCode(id, ADMIN)
    expect((await pair({ code })).status).toBe(429)
    expect(openRows(id)).toHaveLength(1)
  })

  test('with TRUST_PROXY each client address gets 5 attempts a minute', async () => {
    process.env.TRUST_PROXY = '1'
    const from = (ip: string) => pair({ code: '0123456789' }, { 'X-Forwarded-For': ip })
    for (let i = 0; i < 5; i++) expect((await from('203.0.113.7')).status).toBe(400)
    const refused = await from('203.0.113.7')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await from('203.0.113.8')).status).toBe(400)
  })

  test('X-Forwarded-For is ignored unless the operator opts in', async () => {
    for (let i = 0; i < 8; i++) expect((await pair({ code: '0123456789' }, { 'X-Forwarded-For': '203.0.113.7' })).status).toBe(400)
  })
})

describe('schema', () => {
  test('pairing_codes has one open code per server, enforced by the database', () => {
    const { id } = Store.addServer('Unique')
    const ins = () => db.run('INSERT INTO pairing_codes (code_hash, server_id, created_by, created_at, expires_at) VALUES (?, ?, ?, 1, 2)', [crypto.randomUUID(), id, ADMIN])
    ins()
    expect(ins).toThrow()
  })
})
