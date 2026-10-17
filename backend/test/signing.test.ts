import { expect, test, describe, beforeAll } from 'bun:test'
import { createHash } from 'node:crypto'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

let api: any, Store: any, signResponse: any, SIGNATURE_HEADER: string
beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  Store = (await import('../src/services/Store')).Store
  ;({ signResponse, SIGNATURE_HEADER } = await import('../src/services/signing'))
})

describe('signed poll answers', () => {
  const poll = (token: string, body: unknown) =>
    api.request('/v1/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  test('the format is the one commands.lua recomputes', () => {
    expect(signResponse('tok', 'nonce-123', '{"a":1}')).toBe(
      createHash('sha256').update('tok\nnonce-123\n{"a":1}\ntok').digest('hex'))
  })

  test('an answer to a poll with a nonce is signed over the exact body with the presented token', async () => {
    const s = Store.addServer('Signed')
    Store.stageCommand(s.id, 'convar', 'ttt_a 1')
    const res = await poll(s.token, { nonce: 'abcdef0123456789' })
    const body = await res.text()
    expect(res.headers.get(SIGNATURE_HEADER)).toBe(signResponse(s.token, 'abcdef0123456789', body))
    expect(JSON.parse(body).commands).toHaveLength(1)
  })

  test('a different nonce gives a different signature', async () => {
    const s = Store.addServer('Signed2')
    const a = (await poll(s.token, { nonce: 'aaaaaaaaaaaa' })).headers.get(SIGNATURE_HEADER)
    const b = (await poll(s.token, { nonce: 'bbbbbbbbbbbb' })).headers.get(SIGNATURE_HEADER)
    expect(a).not.toBe(b)
  })

  test('no nonce (an older bridge) or a malformed one gets no signature, but still an answer', async () => {
    const s = Store.addServer('Unsigned')
    for (const body of [{}, { nonce: 'x' }, { nonce: 'has space!!' }, { nonce: 'a'.repeat(65) }, { nonce: 5 }]) {
      const res = await poll(s.token, body)
      expect(res.status).toBe(200)
      expect(res.headers.get(SIGNATURE_HEADER)).toBeNull()
      expect(await res.json()).toHaveProperty('commands')
    }
  })
})

describe('missing nonce diagnostics', () => {
  test('a poll without a valid nonce is logged once per server, naming what arrived', async () => {
    const s = Store.addServer('NoNonce')
    const lines: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => { lines.push(a.join(' ')) }
    try {
      for (let i = 0; i < 3; i++) {
        await api.request('/v1/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ active_admins: [], nonce: 5 }),
        })
      }
    } finally { console.warn = orig }
    const mine = lines.filter(l => l.includes('NoNonce'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('nonce is number')
    expect(mine[0]).toContain('active_admins,nonce')
  })
})
