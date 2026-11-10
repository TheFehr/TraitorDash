import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

// The Pelican egg for the voice chat's media server (pelican/egg-livekit.json, RFC 27): the file, its installer and the command it
// starts must stay what they claim. The server itself is not run here: a fake stands in for it.
const root = path.join(import.meta.dir, '../..')
const egg = JSON.parse(fs.readFileSync(path.join(root, 'pelican/egg-livekit.json'), 'utf8'))
const vars: Record<string, any> = Object.fromEntries(egg.variables.map((v: any) => [v.env_variable, v]))
const script: string = egg.scripts.installation.script
const startup: string = egg.startup_commands.Default

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lk-egg-'))

describe('pelican/egg-livekit.json', () => {
  test('is in the panel\'s export format, with its own id and update address', () => {
    const other = JSON.parse(fs.readFileSync(path.join(root, 'pelican/egg-traitordash.json'), 'utf8'))
    expect(egg.meta.version).toBe('PLCN_v3')
    expect(egg.uuid).not.toBe(other.uuid)
    expect(egg.meta.update_url).toContain('pelican/egg-livekit.json')
    expect(egg.author).toBe(other.author)
    expect(Object.keys(egg.docker_images).length).toBeGreaterThan(0)
    expect(() => JSON.parse(egg.config.startup)).not.toThrow()
    expect(JSON.parse(egg.config.startup).done.length).toBeGreaterThan(0)
    for (const v of egg.variables) expect(Array.isArray(v.rules)).toBe(true)
  })

  test('the startup command uses only declared variables and the panel\'s own SERVER_PORT', () => {
    for (const [, name] of startup.matchAll(/\{\{(\w+)\}\}/g)) expect(name === 'SERVER_PORT' || vars[name!] !== undefined).toBe(true)
    for (const name of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'RTC_TCP_PORT', 'RTC_UDP_PORT', 'NODE_IP']) expect(vars[name]).toBeDefined()
  })

  test('no secret is shipped; the secret is long enough and admin-only', () => {
    expect(vars.LIVEKIT_API_KEY.default_value).toBe('')
    expect(vars.LIVEKIT_API_SECRET.default_value).toBe('')
    expect(vars.LIVEKIT_API_SECRET.rules).toContain('min:32')
    expect(vars.LIVEKIT_API_SECRET.user_viewable).toBe(false)
    expect(vars.LIVEKIT_API_SECRET.user_editable).toBe(false)
    expect(JSON.stringify(egg)).not.toMatch(/api[_-]?secret["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/i)
  })

  test('the ports are the ones the dashboard documents, and the secret never goes into the config file', () => {
    expect(vars.RTC_TCP_PORT.default_value).toBe('7881')
    expect(vars.RTC_UDP_PORT.default_value).toBe('7882')
    expect(startup).toContain('LIVEKIT_KEYS=')
    expect(startup.split('> config.yaml')[0]).not.toContain('LIVEKIT_API_SECRET')
  })
})

describe('the startup command', () => {
  const run = (values: Record<string, string>) => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'bin'))
    // a stand-in for the server: records what it was started with
    fs.writeFileSync(path.join(dir, 'bin/livekit-server'), '#!/bin/sh\necho "KEYS=$LIVEKIT_KEYS"\necho "ARGS=$*"\n')
    fs.chmodSync(path.join(dir, 'bin/livekit-server'), 0o755)
    let cmd = startup.replace('cd /home/container', `cd ${dir}`)
    for (const [k, v] of Object.entries(values)) cmd = cmd.replaceAll(`{{${k}}}`, v)
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' })
    const config = fs.existsSync(path.join(dir, 'config.yaml')) ? fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8') : ''
    fs.rmSync(dir, { recursive: true, force: true })
    return { ...r, config }
  }
  const base = { SERVER_PORT: '7880', RTC_TCP_PORT: '7881', RTC_UDP_PORT: '7882', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'a'.repeat(32), NODE_IP: '' }

  test('writes a config with the three ports, finding the public address itself, and starts the server with the keys from the environment', () => {
    const r = run(base)
    expect(r.status).toBe(0)
    expect(r.config).toBe('port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: true\n')
    expect(r.config).not.toContain('port_range')
    expect(r.stdout).toContain(`KEYS=devkey: ${'a'.repeat(32)}`)
    expect(r.stdout).toContain('ARGS=--config config.yaml')
  })

  test('with a public address given, uses it and does not ask STUN', () => {
    const r = run({ ...base, NODE_IP: '203.0.113.7' })
    expect(r.config).toBe('port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: 203.0.113.7\n')
  })

  test('the config is valid YAML of the shape LiveKit reads', () => {
    const r = run(base)
    const parsed = Bun.YAML.parse(r.config) as any
    expect(parsed).toEqual({ port: 7880, rtc: { tcp_port: 7881, udp_port: 7882, use_external_ip: true } })
  })
})

describe('the installer', () => {
  const run = (curl: string) => {
    const dir = tmp()
    const bin = path.join(dir, 'fakebin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'curl'), curl)
    fs.chmodSync(path.join(bin, 'curl'), 0o755)
    const server = path.join(dir, 'server')
    const r = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:${process.env.PATH}`, SERVER_DIR: server }, encoding: 'utf8' })
    const installed = fs.existsSync(path.join(server, 'bin/livekit-server'))
    fs.rmSync(dir, { recursive: true, force: true })
    return { ...r, installed }
  }

  test('is valid shell', () => {
    expect(spawnSync('bash', ['-n', '-c', script]).status).toBe(0)
  })

  test('pins a version and a 64-digit checksum for each architecture, from the project\'s own release', () => {
    expect(script).toMatch(/VERSION="\d+\.\d+\.\d+"/)
    expect(script).toContain('https://github.com/livekit/livekit/releases/download/v${VERSION}/')
    const sums = [...script.matchAll(/SUM="([0-9a-f]+)"/g)].map(m => m[1]!)
    expect(sums).toHaveLength(3)
    for (const s of sums) expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(sums).size).toBe(3)
  })

  test('a failed download fails the install, and says so', () => {
    const r = run('#!/bin/sh\nexit 22\n')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('the download failed')
    expect(r.installed).toBe(false)
  })

  test('a download that does not match the checksum is discarded and fails the install', () => {
    const r = run('#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then echo not-the-release > "$2"; fi; shift; done\n')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('does not match the pinned checksum')
    expect(r.installed).toBe(false)
  })
})
