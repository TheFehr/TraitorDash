import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBsp, flatQuad } from './helpers/bsp_builder'
import * as bsp from '../src/maps/bsp'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 11, 3.1-3.4: an admin switches exact geometry on for a map; a queue fetches the file, checks
// its fingerprint, stores the mesh and deletes the file; the mesh is served to admins.

let app: any, Store: any, db: any, geo: any, cookie: string, serverId: string, scratch: string

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  geo = await import('../src/services/mapgeometry')
  cookie = (await serializeSigned('steam_id', '76561198000000000', 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

const file = buildBsp({ ...flatQuad(0), entities: '{ "classname" "worldspawn" }' })
const fpOf = (b: Buffer) => bsp.bspFingerprint(b.subarray(0, 1036), b.length)
const FP = fpOf(file)

beforeEach(() => {
  process.env.MAP_GEOMETRY = '1'
  geo.setGeometryFetcher(null)
  db.run('DELETE FROM map_geometry') // geometry is shared by design; each test starts without any
  db.run('DELETE FROM map_geometry_requests')
  scratch = mkdtempSync(join(tmpdir(), 'geo-test-'))
  serverId = (Store.addServer('Geo') as any).id
  report(serverId)
})
afterEach(() => { delete process.env.MAP_GEOMETRY; rmSync(scratch, { recursive: true, force: true }) })

const M = (name: string, fingerprint: string | null = FP) => ({
  name, size: file.length, fingerprint, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true,
})
function report(id: string, maps = [M('ttt_a')]) {
  Store.setMaps(id, { current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: '^ttt_', poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps })
}

const req = (path: string, init: RequestInit = {}, auth = true) =>
  app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(auth ? { Cookie: cookie } : {}), ...(init.headers as any) } }))
const toggle = (id: string, map: string, on: boolean, auth = true, headers: Record<string, string> = {}) =>
  req(`/servers/${id}/maps/${map}/geometry`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: `on=${on ? 1 : 0}`,
  }, auth)

/** A fetcher that writes `bytes` to a scratch file; counts its calls. */
const writer = (bytes: Buffer | ((map: string) => Buffer)) => {
  const f: any = async (map: string) => {
    f.calls++
    const path = join(scratch, `${map}-${f.calls}.bsp`)
    writeFileSync(path, typeof bytes === 'function' ? bytes(map) : bytes)
    return { path, cleanup: async () => rmSync(path) }
  }
  f.calls = 0
  return f
}
const state = (id = serverId, map = 'ttt_a') => Store.getGeometryStates(id).get(map)

describe('buildGeometry', () => {
  test('a file with the reported fingerprint becomes a GLB', async () => {
    const r = await geo.buildGeometry(bsp.memorySource(file), 'ttt_a', FP)
    expect(r.ok).toBe(true)
    expect(new TextDecoder().decode(r.glb.subarray(0, 4))).toBe('glTF')
    expect(r.info.triangles).toBe(2)
  })

  test('a file of another version of the map is refused, without being parsed', async () => {
    const r = await geo.buildGeometry(bsp.memorySource(file), 'ttt_a', 'cd'.repeat(32))
    expect(r).toEqual({ ok: false, error: expect.stringContaining('fingerprint') })
  })

  test('a file that is not a map, and a map with nothing to draw, are errors and not exceptions', async () => {
    const junk = Buffer.alloc(2000, 7)
    expect((await geo.buildGeometry(bsp.memorySource(junk), 'x', fpOf(junk))).ok).toBe(false)
    const empty = buildBsp({})
    const r = await geo.buildGeometry(bsp.memorySource(empty), 'x', fpOf(empty))
    expect(r).toEqual({ ok: false, error: 'The map has no surfaces to draw.' })
  })
})

describe('asking for geometry', () => {
  test('an admin turns it on: the map is queued, and the audit log says who', async () => {
    const res = await toggle(serverId, 'ttt_a', true)
    expect(res.status).toBe(302)
    expect(state()).toMatchObject({ status: 'queued', fingerprint: FP })
    const row = db.prepare("SELECT steam_id, details FROM audit_log WHERE action = 'MAP_GEOMETRY_REQUESTED'").get()
    expect(row).toEqual({ steam_id: '76561198000000000', details: 'ttt_a' })
  })

  test('turning it off forgets the request but keeps the mesh others may use', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(writer(file))
    await toggle(serverId, 'ttt_a', false)
    expect(state()).toBeUndefined()
    expect(db.prepare("SELECT status FROM map_geometry").get()).toEqual({ status: 'parsed' })
    expect(db.prepare("SELECT action FROM audit_log WHERE action = 'MAP_GEOMETRY_WITHDRAWN'").get()).toBeTruthy()
  })

  test('without the operator switch there is nothing to ask: 404, and nothing stored', async () => {
    delete process.env.MAP_GEOMETRY
    expect((await toggle(serverId, 'ttt_a', true)).status).toBe(404)
    expect(state()).toBeUndefined()
  })

  test('not an admin: 401. A page from another site: refused. A map the server does not have: 404', async () => {
    expect((await toggle(serverId, 'ttt_a', true, false)).status).toBe(401)
    expect((await toggle(serverId, 'ttt_a', true, true, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await toggle(serverId, 'ttt_nope', true)).status).toBe(404)
    expect(state()).toBeUndefined()
  })

  test('a map without a fingerprint cannot be fetched against: unknown, and never queued', async () => {
    report(serverId, [M('ttt_a', null)])
    await toggle(serverId, 'ttt_a', true)
    expect(state().status).toBe('unknown')
    expect(Store.getGeometryQueue()).toEqual([])
  })
})

describe('the queue', () => {
  test('fetches, parses, stores, serves, and deletes the file', async () => {
    await toggle(serverId, 'ttt_a', true)
    const f = writer(file)
    expect(await geo.runGeometryQueue(f)).toBe(1)
    expect(state()).toMatchObject({ status: 'parsed', info: { triangles: 2, levels: 1 } })
    expect(readdirSync(scratch)).toEqual([])

    const res = await req(`/servers/${serverId}/maps/ttt_a/mesh.glb`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('model/gltf-binary')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).subarray(0, 4))).toBe('glTF')
  })

  test('the mesh is for admins: 401 for a guest, 404 before it exists', async () => {
    expect((await req(`/servers/${serverId}/maps/ttt_a/mesh.glb`)).status).toBe(404)
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(writer(file))
    expect((await req(`/servers/${serverId}/maps/ttt_a/mesh.glb`, {}, false)).status).toBe(401)
  })

  test('two servers with the same map version share one fetch and one mesh', async () => {
    const other = (Store.addServer('Geo 2') as any).id
    report(other)
    await toggle(serverId, 'ttt_a', true)
    await toggle(other, 'ttt_a', true)
    const f = writer(file)
    expect(await geo.runGeometryQueue(f)).toBe(1)
    expect(f.calls).toBe(1)
    expect(state(other).status).toBe('parsed')
    expect((await req(`/servers/${other}/maps/ttt_a/mesh.glb`)).status).toBe(200)
  })

  test('a failed download is recorded with a reason, the file is gone, and asking again retries', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(async () => ({ error: 'The addon could not be found.' }))
    expect(state()).toMatchObject({ status: 'failed', detail: 'The addon could not be found.' })
    expect(Store.getGeometryQueue()).toEqual([])

    await toggle(serverId, 'ttt_a', false)
    await toggle(serverId, 'ttt_a', true)
    expect(state().status).toBe('queued')
    await geo.runGeometryQueue(writer(file))
    expect(state().status).toBe('parsed')
  })

  test('a fetcher that throws is a failed attempt, not a crashed queue', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(async () => { throw new Error('secret path /srv/x') })
    expect(state()).toMatchObject({ status: 'failed', detail: 'The download failed.' })
  })

  test('a file of the wrong version fails, and is deleted all the same', async () => {
    await toggle(serverId, 'ttt_a', true)
    const other = buildBsp({ ...flatQuad(0), revision: 99 })
    await geo.runGeometryQueue(writer(other))
    expect(state()).toMatchObject({ status: 'failed' })
    expect(state().detail).toContain('fingerprint')
    expect(readdirSync(scratch)).toEqual([])
  })

  test('a new version of the map (new fingerprint) is queued again; the old mesh is not served for it', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(writer(file))
    const v2 = buildBsp({ ...flatQuad(0), revision: 2 })
    report(serverId, [M('ttt_a', fpOf(v2))])
    expect(state().status).toBe('queued')
    expect((await req(`/servers/${serverId}/maps/ttt_a/mesh.glb`)).status).toBe(404)
    await geo.runGeometryQueue(writer(v2))
    expect(state().status).toBe('parsed')
  })

  test('a job that was running when the process stopped goes back in the queue', async () => {
    await toggle(serverId, 'ttt_a', true)
    expect(Store.startGeometry('ttt_a', FP)).toBe(true)
    expect(state().status).toBe('fetching')
    expect(Store.startGeometry('ttt_a', FP)).toBe(false) // a second worker does not take it
    Store.resetStaleGeometry()
    expect(state().status).toBe('queued')
  })

  test('without a fetcher, requested maps stay queued and the kick does nothing', async () => {
    await toggle(serverId, 'ttt_a', true)
    geo.kickGeometryQueue()
    await Bun.sleep(10)
    expect(state().status).toBe('queued')
  })

  test('deleting the server removes its requests', async () => {
    await toggle(serverId, 'ttt_a', true)
    Store.deleteServer(serverId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM map_geometry_requests WHERE server_id = ?').get(serverId).n).toBe(0)
  })
})

describe('the map page', () => {
  const page = async () => (await req(`/servers/${serverId}/maps/ttt_a`)).text()

  test('shows the switch and each status only when the operator has the feature on', async () => {
    expect(await page()).toContain('Turn on')
    await toggle(serverId, 'ttt_a', true)
    expect(await page()).toContain('Queued')
    await geo.runGeometryQueue(writer(file))
    const html = await page()
    expect(html).toContain('Parsed')
    expect(html).toContain('2 triangles, 1 level')
    expect(html).toContain('mesh.glb')
    delete process.env.MAP_GEOMETRY
    expect(await page()).not.toContain('Exact geometry')
  })

  test('says why a map failed, in words the backend chose', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(async () => ({ error: 'The addon could not be found.' }))
    const html = await page()
    expect(html).toContain('Failed')
    expect(html).toContain('The addon could not be found.')
  })
})

describe('the 3D view on the map page', () => {
  const page = async () => (await req(`/servers/${serverId}/maps/ttt_a`)).text()

  test('appears once the mesh exists, with one button per level, and loads the viewer script', async () => {
    await toggle(serverId, 'ttt_a', true)
    expect(await page()).not.toContain('data-mapview')
    await geo.runGeometryQueue(writer(file))
    const html = await page()
    expect(html).toContain('data-mapview')
    expect(html).toContain(`data-src="/servers/${serverId}/maps/ttt_a/mesh.glb"`)
    expect(html).toContain('src="/public/mapview.js"')
    expect(html.match(/data-level="\d+"/g)).toHaveLength(1) // this map has one level
    expect(html).toContain('data-level="all"')
  })

  test('is not on the page when the operator has the feature off, and the script is not loaded elsewhere', async () => {
    await toggle(serverId, 'ttt_a', true)
    await geo.runGeometryQueue(writer(file))
    delete process.env.MAP_GEOMETRY
    expect(await page()).not.toContain('data-mapview')
    expect(await (await req(`/servers/${serverId}/maps`)).text()).not.toContain('mapview.js')
  })
})
