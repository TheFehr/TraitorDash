import { expect, test, describe, beforeAll } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { computeSourceHash, checkHealth, readBuildInfo } from '../src/services/version'

let app: any
beforeAll(async () => { app = (await import('../src/index')).default })

describe('GET /health', () => {
  test('is public, answers 200 and identifies the running code', async () => {
    const res = await app.fetch(new Request('http://x/health'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.sourceHash).toMatch(/^[0-9a-f]{12}$/)
    expect(body.sourceHash).toBe(computeSourceHash())
    expect(typeof body.startedAt).toBe('string')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.schemaVersion).toBeGreaterThan(0)
  })

  test('carries no secrets, environment values or file paths', async () => {
    const text = await (await app.fetch(new Request('http://x/health'))).text()
    for (const secret of [process.env.SESSION_SECRET!, process.env.ADMIN_STEAM_IDS!, '/home/', 'api_token']) {
      expect(text).not.toContain(secret)
    }
  })

  test('a failing database is a 503 with no error details', () => {
    const h = checkHealth(() => { throw new Error('SQLITE_CORRUPT: /secret/path/db') })
    expect(h.status).toBe('error')
    expect(h.schemaVersion).toBeNull()
    expect(JSON.stringify(h)).not.toContain('secret')
  })
})

describe('source hash', () => {
  const tree = (files: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-hash-'))
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), content)
    }
    return root
  }
  const base = { 'src/a.ts': 'one', 'src/sub/b.ts': 'two', 'package.json': '{}', 'bun.lock': 'lock' }

  test('is stable and does not depend on where the tree lives', () => {
    expect(computeSourceHash(tree(base))).toBe(computeSourceHash(tree(base)))
  })

  test('changes when a source file, the manifest or the lockfile changes, or a file is added or renamed', () => {
    const original = computeSourceHash(tree(base))
    expect(computeSourceHash(tree({ ...base, 'src/a.ts': 'ONE' }))).not.toBe(original)
    expect(computeSourceHash(tree({ ...base, 'package.json': '{"x":1}' }))).not.toBe(original)
    expect(computeSourceHash(tree({ ...base, 'bun.lock': 'other' }))).not.toBe(original)
    expect(computeSourceHash(tree({ ...base, 'src/new.ts': '' }))).not.toBe(original)
    const { 'src/a.ts': content, ...rest } = base
    expect(computeSourceHash(tree({ ...rest, 'src/renamed.ts': content }))).not.toBe(original)
  })

  test('ignores built assets, tests, the database and node_modules', () => {
    const original = computeSourceHash(tree(base))
    const noise = tree({
      ...base,
      'src/public/style.css': 'built',
      'src/public/frontend.js': 'built',
      'test/x.test.ts': 'a test',
      'traitordash.sqlite': 'data',
      'node_modules/pkg/index.js': 'dep',
      'build.json': '{}',
    })
    expect(computeSourceHash(noise)).toBe(original)
  })

  test('the script prints the same value the endpoint reports', async () => {
    const proc = Bun.spawn([process.execPath, 'run', 'scripts/source-hash.ts'], { cwd: path.join(import.meta.dir, '..'), stdout: 'pipe' })
    expect((await new Response(proc.stdout).text()).trim()).toBe(computeSourceHash())
  })
})

describe('build.json', () => {
  test('is optional, and only known string/boolean fields are read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-build-'))
    expect(readBuildInfo(root)).toBeNull()
    fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({ commit: 'abc1234', dirty: false, builtAt: '2026-10-17T00:00:00Z', secret: 'x' }))
    expect(readBuildInfo(root)).toEqual({ commit: 'abc1234', dirty: false, builtAt: '2026-10-17T00:00:00Z' })
    fs.writeFileSync(path.join(root, 'build.json'), 'not json')
    expect(readBuildInfo(root)).toBeNull()
  })
})
