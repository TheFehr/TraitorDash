import { expect, test, beforeAll } from 'bun:test'
import { readFileSync } from 'node:fs'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// The site's own scripts: a script with its version in the address is kept for a week, and every one is sent gzipped where the browser accepts it
// (the map view is about 660 KB).

let app: any
beforeAll(async () => { app = (await import('../src/index')).default })
const get = (path: string, enc = 'gzip') => app.fetch(new Request(`http://localhost${path}`, { headers: { 'Accept-Encoding': enc } }))

test('a script with a version is kept for a week; without one it is asked for each time', async () => {
  expect((await get('/public/confirm.js?v=abc')).headers.get('cache-control')).toBe('public, max-age=604800, immutable')
  expect((await get('/public/confirm.js')).headers.get('cache-control')).toBe('no-cache')
})

test('it is sent gzipped, and is the same file once unpacked; a browser without gzip gets it whole', async () => {
  const whole = new Uint8Array(readFileSync(new URL('../src/public/confirm.js', import.meta.url)))
  const zipped = await get('/public/confirm.js?v=1')
  expect(zipped.headers.get('content-encoding')).toBe('gzip')
  expect(zipped.headers.get('vary')).toContain('Accept-Encoding')
  expect(new Uint8Array(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer())))).toEqual(whole)
  const plain = await get('/public/confirm.js?v=1', 'identity')
  expect(plain.headers.get('content-encoding')).toBeNull()
  expect(new Uint8Array(await plain.arrayBuffer())).toEqual(whole)
})

test('a file that is not there is still a 404', async () => {
  expect((await get('/public/nothing.js')).status).toBe(404)
})
