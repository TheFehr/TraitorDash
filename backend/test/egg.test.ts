import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

// The Pelican egg (pelican/egg-traitordash.json) must stay in step with the app it starts.
const root = path.join(import.meta.dir, '../..')
const egg = JSON.parse(fs.readFileSync(path.join(root, 'pelican/egg-traitordash.json'), 'utf8'))
const index = fs.readFileSync(path.join(root, 'backend/src/index.tsx'), 'utf8')
const vars: Record<string, any> = Object.fromEntries(egg.variables.map((v: any) => [v.env_variable, v]))

describe('pelican/egg-traitordash.json', () => {
  test('is in the panel\'s export format', () => {
    expect(egg.meta.version).toBe('PLCN_v3')
    expect(typeof egg.uuid).toBe('string')
    expect(Object.keys(egg.docker_images).length).toBeGreaterThan(0)
    expect(typeof egg.config.startup).toBe('string')
    expect(() => JSON.parse(egg.config.startup)).not.toThrow()
    for (const v of egg.variables) expect(Array.isArray(v.rules)).toBe(true)
  })

  test('the server is marked running by a line the app really prints', () => {
    const done: string[] = JSON.parse(egg.config.startup).done
    expect(done.length).toBeGreaterThan(0)
    const line = /STARTUP_LOG_LINE = '([^']+)'/.exec(index)![1]!
    for (const d of done) expect(line.startsWith(d) || d.startsWith(line)).toBe(true)
  })

  test('every variable the app reads is declared, and the secrets are admin-only', () => {
    for (const name of ['BASE_URL', 'ADMIN_STEAM_IDS', 'SESSION_SECRET', 'NODE_ENV', 'MAIN_FILE']) {
      expect(vars[name]).toBeDefined()
    }
    for (const name of ['BASE_URL', 'ADMIN_STEAM_IDS', 'SESSION_SECRET']) {
      expect(vars[name].rules).toContain('required')
    }
    expect(vars.SESSION_SECRET.rules).toContain('min:32')
    expect(fs.readFileSync(path.join(root, 'backend/src/middleware/session.ts'), 'utf8')).toContain('MIN_SECRET_LENGTH = 32')
    expect(vars.SESSION_SECRET.user_viewable).toBe(false)
    expect(vars.SESSION_SECRET.user_editable).toBe(false)
  })

  test('the startup command only uses declared variables and runs a file that exists', () => {
    const cmd: string = egg.startup_commands.Default
    for (const [, name] of cmd.matchAll(/\{\{(\w+)\}\}/g)) expect(vars[name!]).toBeDefined()
    expect(cmd).toContain('bun run {{MAIN_FILE}}')
    expect(fs.existsSync(path.join(root, 'backend', vars.MAIN_FILE.default_value))).toBe(true)
  })

  test('no secret value is shipped in the egg', () => {
    expect(vars.SESSION_SECRET.default_value).toBe('')
    expect(vars.ADMIN_STEAM_IDS.default_value).toBe('')
  })
})

describe('the installer script (exact map geometry, RFC 11)', () => {
  const script: string = egg.scripts.installation.script
  const run = (env: Record<string, string>, curl?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-install-'))
    const bin = path.join(dir, 'fakebin')
    fs.mkdirSync(bin)
    if (curl) { fs.writeFileSync(path.join(bin, 'curl'), curl); fs.chmodSync(path.join(bin, 'curl'), 0o755) }
    const server = path.join(dir, 'server')
    const r = spawnSync('bash', ['-c', script], {
      env: { PATH: `${bin}:${process.env.PATH}`, SERVER_DIR: server, ...env }, encoding: 'utf8',
    })
    return { ...r, server, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  test('is valid shell, and the variable that gates it is declared with a safe default', () => {
    expect(spawnSync('bash', ['-n', '-c', script]).status).toBe(0)
    expect(vars.MAP_GEOMETRY.default_value).toBe('0')
    expect(vars.MAP_GEOMETRY.rules).toContain('in:0,1')
  })

  test('the sign-in variables are declared with safe defaults, and the app reads the same names', () => {
    expect(vars.OPEN_SIGNIN.default_value).toBe('0')
    expect(vars.OPEN_SIGNIN.rules).toContain('in:0,1')
    expect(vars.BLOCKED_STEAM_IDS.default_value).toBe('')
    expect(vars.BLOCKED_STEAM_IDS.rules).toContain('nullable')
    expect(vars.VIEW_LOG_DAYS.default_value).toBe('90')
    const session = fs.readFileSync(path.join(root, 'backend/src/middleware/session.ts'), 'utf8')
    expect(session).toContain('process.env.OPEN_SIGNIN')
    expect(session).toContain('process.env.BLOCKED_STEAM_IDS')
    expect(fs.readFileSync(path.join(root, 'backend/src/services/Store.ts'), 'utf8')).toContain('process.env.VIEW_LOG_DAYS')
  })

  test('the app reads the same variable', () => {
    expect(fs.readFileSync(path.join(root, 'backend/src/services/mapgeometry.ts'), 'utf8')).toContain("process.env.MAP_GEOMETRY === '1'")
  })

  test('with the feature off it downloads nothing and installs nothing', () => {
    const r = run({ MAP_GEOMETRY: '0' }, '#!/bin/bash\ntouch "$(dirname "$0")/curl-was-called"\nexit 1\n')
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(r.server, 'bin'))).toBe(false)
    expect(fs.existsSync(path.join(r.server, '../fakebin/curl-was-called'))).toBe(false)
    r.cleanup()
  })

  test('pins a version and a 64-digit checksum for each architecture, from the project\'s own release', () => {
    expect(script).toMatch(/VERSION="\d+\.\d+\.\d+"/)
    const sums = [...script.matchAll(/SUM="([0-9a-f]+)"/g)].map(m => m[1]!)
    expect(sums).toHaveLength(3)
    for (const s of sums) expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(script).toContain('https://github.com/SteamRE/DepotDownloader/releases/download/')
  })

  test('a download that does not match the checksum is discarded and installs nothing', () => {
    const r = run({ MAP_GEOMETRY: '1' }, '#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUT="$2"; shift; done\necho tampered > "$OUT"\n')
    expect(r.status).toBe(0) // the installer does not fail the server
    expect(r.stdout).toContain('does not match the pinned checksum')
    expect(fs.existsSync(path.join(r.server, 'bin', 'DepotDownloader'))).toBe(false)
    r.cleanup()
  })

  test('a failed download says so and does not fail the install', () => {
    const r = run({ MAP_GEOMETRY: '1' }, '#!/bin/bash\nexit 22\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('the download failed')
    r.cleanup()
  })
})

describe('the egg\'s author', () => {
  test('is an email address, which is what the panel\'s import form requires', () => {
    expect(egg.author).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  })
})
