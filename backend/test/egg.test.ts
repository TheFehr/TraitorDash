import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'

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
