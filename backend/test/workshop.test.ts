import { expect, test, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildBsp, buildGma, flatQuad } from './helpers/bsp_builder'
import { bspFingerprint } from '../src/services/bsp'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'

// RFC 11, 3.2: the Workshop fetcher runs the download helper as a separate process, looks for the
// map's exact version in the server's mounted map addons, and leaves nothing behind.

let Store: any, db: any, geo: any, ws: any, dir: string, fix: string, log: string, scratch: string, serverId: string

beforeAll(async () => {
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  geo = await import('../src/services/mapgeometry')
  ws = await import('../src/services/workshop')
})

const bspA = buildBsp({ ...flatQuad(0), revision: 1 })
const bspB = buildBsp({ ...flatQuad(0), revision: 2 })
const bspC = buildBsp({ ...flatQuad(64), revision: 3 })
const fp = (b: Buffer) => bspFingerprint(b.subarray(0, 1036), b.length)

/** A stand-in for DepotDownloader: copies fixtures/<id>.gma into the -dir it is given. */
function installHelper() {
  const script = join(dir, 'helper.sh')
  writeFileSync(script, `#!/bin/bash
echo "$@" >> "${log}/args"
env > "${log}/env-$$"
while [ $# -gt 0 ]; do case "$1" in -pubfile) ID="$2"; shift 2;; -dir) OUT="$2"; shift 2;; *) shift;; esac; done
[ -f "${fix}/$ID.fail" ] && exit 1
[ -f "${fix}/$ID.sleep" ] && exec sleep 30
mkdir -p "$OUT/sub"
if [ -f "${fix}/$ID.big" ]; then dd if=/dev/zero of="$OUT/sub/big.gma" bs=1M count=3 2>/dev/null; exec sleep 30; fi
cp "${fix}/$ID.gma" "$OUT/sub/gmpublisher.gma"
`)
  chmodSync(script, 0o755)
  return script
}
const addon = (id: string, g: Buffer) => writeFileSync(join(fix, `${id}.gma`), g)
const downloads = () => (existsSync(join(log, 'args')) ? readFileSync(join(log, 'args'), 'utf8').trim().split('\n').filter(Boolean) : [])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-test-'))
  fix = join(dir, 'fix'); log = join(dir, 'log'); scratch = join(dir, 'scratch')
  for (const d of [fix, log, scratch]) spawnSync('mkdir', ['-p', d])
  process.env.MAP_GEOMETRY = '1'
  db.run('DELETE FROM map_geometry'); db.run('DELETE FROM map_geometry_requests'); db.run('DELETE FROM addon_maps'); db.run('DELETE FROM addon_scans')
  serverId = (Store.addServer('WS') as any).id
})
afterEach(() => { delete process.env.MAP_GEOMETRY; rmSync(dir, { recursive: true, force: true }) })

function report(maps: [string, Buffer][], mapAddons: string[]) {
  Store.setMaps(serverId, {
    current: null, next: null, gamemode: 'terrortown', pattern: '^ttt_', poolBasis: 'gamemode', configSource: 'none', voteAddon: false,
    mapAddons,
    maps: maps.map(([name, b]) => ({ name, size: b.length, fingerprint: fp(b), matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true })),
  })
}
const want = (map: string) => Store.setGeometryRequested(serverId, map, true, null)
const fetcher = (o: Record<string, unknown> = {}) => ws.workshopFetcher({ binary: installHelper(), scratch, ...o })
const status = (map: string) => Store.getGeometryStates(serverId).get(map)

describe('finding the addon', () => {
  test('tries the mounted map addons until one holds this exact version, then stores the mesh and leaves nothing behind', async () => {
    addon('111', buildGma({ 'maps/ttt_other.bsp': bspC }))
    addon('222', buildGma({ 'maps/ttt_a.bsp': bspA, 'lua/x.lua': 'x' }))
    report([['ttt_a', bspA], ['ttt_other', bspC]], ['111', '222'])
    want('ttt_a')

    expect(await geo.runGeometryQueue(fetcher())).toBe(1)
    expect(status('ttt_a')).toMatchObject({ status: 'parsed', info: { triangles: 2 } })
    expect(downloads().map(l => l.split(' ')[3])).toEqual(['111', '222'])
    expect(readdirSync(scratch)).toEqual([])
    // Everything found on the way is remembered, including the map nobody asked for.
    expect(db.prepare('SELECT wsid, map_name FROM addon_maps ORDER BY wsid').all()).toEqual([
      { wsid: '111', map_name: 'ttt_other' }, { wsid: '222', map_name: 'ttt_a' },
    ])
  })

  test('a map found earlier on the way is fetched from where it was seen, without a search', async () => {
    addon('111', buildGma({ 'maps/ttt_other.bsp': bspC }))
    addon('222', buildGma({ 'maps/ttt_a.bsp': bspA }))
    report([['ttt_a', bspA], ['ttt_other', bspC]], ['111', '222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    rmSync(join(log, 'args'))

    want('ttt_other')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_other').status).toBe('parsed')
    expect(downloads().map(l => l.split(' ')[3])).toEqual(['111'])
  })

  test('an addon with another version of the map is not taken, and the failure says what is true', async () => {
    addon('111', buildGma({ 'maps/ttt_a.bsp': bspB }))
    report([['ttt_a', bspA]], ['111'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a')).toMatchObject({ status: 'failed', detail: 'None of the mounted map addons holds this version of the map.' })
    expect(readdirSync(scratch)).toEqual([])
  })

  test('addons already searched are not downloaded again for the next map', async () => {
    addon('111', buildGma({ 'maps/ttt_x.bsp': bspC }))
    report([['ttt_a', bspA]], ['111'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').status).toBe('failed')
    rmSync(join(log, 'args'))
    await geo.runGeometryQueue(fetcher()) // a failed map is not retried by itself
    await Store.setGeometryRequested(serverId, 'ttt_a', false, null); want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(downloads()).toEqual([]) // 111 was searched already; nothing left to try
    expect(status('ttt_a').detail).toBe('No mounted map addon is known to hold this version of the map.')
  })

  test('a server that reported no addons gives the job nothing to search', async () => {
    report([['ttt_a', bspA]], [])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').detail).toBe('No mounted map addon is known to hold this version of the map.')
    expect(downloads()).toEqual([])
  })

  test('an addon that fails to download is skipped and the next is tried', async () => {
    writeFileSync(join(fix, '111.fail'), '')
    addon('222', buildGma({ 'maps/ttt_a.bsp': bspA }))
    report([['ttt_a', bspA]], ['111', '222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').status).toBe('parsed')
  })

  test('at most maxCandidates addons are tried', async () => {
    for (const id of ['1', '2', '3']) addon(id, buildGma({ 'maps/ttt_z.bsp': bspC }))
    report([['ttt_a', bspA]], ['1', '2', '3'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher({ maxCandidates: 2 }))
    expect(downloads()).toHaveLength(2)
  })
})

describe('running the helper', () => {
  test('gets exactly the app, the item and a directory of its own, and none of this program\'s environment', async () => {
    process.env.TD_SECRET_FOR_TEST = 'hunter2'
    addon('222', buildGma({ 'maps/ttt_a.bsp': bspA }))
    report([['ttt_a', bspA]], ['222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    delete process.env.TD_SECRET_FOR_TEST
    const [line] = downloads()
    expect(line).toMatch(new RegExp(`^-app 4000 -pubfile 222 -dir ${scratch}/job-[^/]+/a-222/out$`))
    const env = readdirSync(log).filter(f => f.startsWith('env-')).map(f => readFileSync(join(log, f), 'utf8')).join('')
    expect(env).not.toContain('hunter2')
    expect(env).not.toContain('SESSION_SECRET')
    expect(env).not.toContain('TRAITORDASH_DB')
    expect(env).toContain('DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1')
  })

  test('a helper that is not installed is said so in words, and is not a crash', async () => {
    addon('222', buildGma({ 'maps/ttt_a.bsp': bspA }))
    report([['ttt_a', bspA]], ['222'])
    want('ttt_a')
    await geo.runGeometryQueue(ws.workshopFetcher({ binary: join(dir, 'missing'), scratch }))
    expect(status('ttt_a')).toMatchObject({ status: 'failed', detail: 'The download helper (DepotDownloader) is not installed.' })
    expect(readdirSync(scratch)).toEqual([])
    expect(await ws.helperAvailable(join(dir, 'missing'))).toBe(false)
  })

  test('a download that grows past the size limit is killed', async () => {
    writeFileSync(join(fix, '222.big'), '')
    report([['ttt_a', bspA]], ['222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher({ maxBytes: 1024 * 1024 }))
    expect(status('ttt_a')).toMatchObject({ status: 'failed', detail: 'The addon is larger than the limit.' })
    expect(readdirSync(scratch)).toEqual([])
  }, 15000)

  test('a download that takes too long is killed', async () => {
    writeFileSync(join(fix, '222.sleep'), '')
    report([['ttt_a', bspA]], ['222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher({ timeoutMs: 300 }))
    expect(status('ttt_a')).toMatchObject({ status: 'failed', detail: 'The download took too long.' })
  })

  test('an archive that is not one is a failure, not a crash', async () => {
    addon('222', Buffer.from('this is not an archive, just text of some length'))
    report([['ttt_a', bspA]], ['222'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').status).toBe('failed')
    expect(readdirSync(scratch)).toEqual([])
  })
})

describe('old items (one LZMA stream around the archive)', () => {
  const xz = spawnSync('xz', ['--version']).status === 0
  // Workshop items declare their unpacked size in the stream header; xz writes "unknown" there.
  const lzma = (plain: Buffer, pad = 0) => {
    const packed = Buffer.from(spawnSync('xz', ['--format=lzma', '-c'], { input: plain }).stdout)
    packed.writeBigUInt64LE(BigInt(plain.length), 5)
    return Buffer.concat([packed, Buffer.alloc(pad, 7)])
  }

  test.skipIf(!xz)('are opened with the system xz, trailing padding and all', async () => {
    addon('333', lzma(buildGma({ 'maps/ttt_a.bsp': bspA }), 6))
    report([['ttt_a', bspA]], ['333'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').status).toBe('parsed')
    expect(readdirSync(scratch)).toEqual([])
  })

  test.skipIf(!xz)('one that unpacks to more than the limit is refused before it is unpacked', async () => {
    addon('333', lzma(buildGma({ 'maps/ttt_a.bsp': bspA })))
    report([['ttt_a', bspA]], ['333'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher({ maxBytes: 100 }))
    expect(status('ttt_a').detail).toBe('The addon is larger than the limit.')
  })

  test.skipIf(!xz)('one that is damaged is a failure', async () => {
    const good = lzma(buildGma({ 'maps/ttt_a.bsp': bspA }))
    addon('333', Buffer.concat([good.subarray(0, 30), Buffer.alloc(good.length - 30, 0xff)]))
    report([['ttt_a', bspA]], ['333'])
    want('ttt_a')
    await geo.runGeometryQueue(fetcher())
    expect(status('ttt_a').status).toBe('failed')
  })
})
