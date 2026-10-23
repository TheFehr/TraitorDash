import { expect, test, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySource, readHeader } from '../src/maps/bsp'
import { readVpkIndex, readVpkFile, vpkArchiveName, VpkError } from '../src/maps/vpk'
import { buildPropSet } from '../src/maps/propset'
import { gameContent, modelBase } from '../src/services/gameContent'
import { buildBsp, flatQuad } from './helpers/bsp_builder'
import { buildModel, buildZip } from './helpers/model_builder'
import { buildVpk } from './helpers/vpk_builder'

// RFC 18, 4.5: the game's own models, from a Valve package index and the archive that holds them.

const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [10, 0, 0], C: [number, number, number] = [0, 10, 0]
const crate = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2] }] })
const drum = buildModel({ meshes: [{ vertices: [A, B, C], tris: [0, 1, 2, 0, 2, 1] }] })
const modelFiles = (name: string, m: typeof crate, archive = 0, preload = 0) => [
  { name: `${name}.mdl`, data: m.mdl, archive, preload },
  { name: `${name}.vvd`, data: m.vvd, archive },
  { name: `${name}.dx90.vtx`, data: m.vtx, archive },
]

describe('the package reader', () => {
  test('reads names, archives, offsets and the bytes preloaded into the index', async () => {
    const { dir, archives } = buildVpk([...modelFiles('models/props_c17/crate', crate, 0, 8), { name: 'readme', data: Buffer.from('hello'), archive: 0x7fff }])
    const index = await readVpkIndex(memorySource(dir))
    expect([...index.keys()].sort()).toEqual(['models/props_c17/crate.dx90.vtx', 'models/props_c17/crate.mdl', 'models/props_c17/crate.vvd', 'readme'])
    const mdl = await readVpkFile(index.get('models/props_c17/crate.mdl')!, memorySource(archives.get(0)!))
    expect(Buffer.from(mdl).equals(crate.mdl)).toBe(true) // preload and archive part joined
    expect(Buffer.from(await readVpkFile(index.get('readme')!, memorySource(dir))).toString()).toBe('hello')
  })

  test('names the archive that goes with an index file', () => {
    expect(vpkArchiveName('cstrike/cstrike_pak_dir.vpk', 12)).toBe('cstrike/cstrike_pak_012.vpk')
  })

  test('refuses what is not a package, an unknown version, a cut-off index, and a file outside its archive', async () => {
    await expect(readVpkIndex(memorySource(Buffer.alloc(64)))).rejects.toThrow(VpkError)
    const { dir } = buildVpk(modelFiles('models/a', crate))
    const wrongVersion = Buffer.from(dir); wrongVersion.writeUInt32LE(7, 4)
    await expect(readVpkIndex(memorySource(wrongVersion))).rejects.toThrow('not supported')
    await expect(readVpkIndex(memorySource(dir.subarray(0, 60)))).rejects.toThrow(VpkError)
    await expect(readVpkIndex(memorySource(dir), { maxTreeBytes: 10 })).rejects.toThrow(VpkError)
    await expect(readVpkIndex(memorySource(dir), { maxEntries: 1 })).rejects.toThrow('too many')
    const index = await readVpkIndex(memorySource(dir))
    await expect(readVpkFile(index.get('models/a.mdl')!, memorySource(Buffer.alloc(4)))).rejects.toThrow('outside')
    await expect(readVpkFile(index.get('models/a.mdl')!, memorySource(Buffer.alloc(4)), 4)).rejects.toThrow('too large')
  })
})

describe('model names', () => {
  test('are normalised, and anything that is not a model path is refused', () => {
    expect(modelBase('models/props_c17/Crate.mdl')).toBe('models/props_c17/crate')
    expect(modelBase('./models\\props_c17\\crate.mdl')).toBe('models/props_c17/crate')
    for (const bad of ['../etc/passwd.mdl', 'models/../x.mdl', 'models/a.vvd', 'props/a.mdl', '/models/a.mdl', 'models/a\0.mdl', 'models//a.mdl']) expect(modelBase(bad)).toBeNull()
  })
})

describe('the content cache', () => {
  let dir: string, fix: string, log: string, root: string, scratch: string
  /** A stand-in for DepotDownloader: copies the files of -filelist from fixtures/<app>/ into -dir. */
  function helper() {
    const script = join(dir, 'helper.sh')
    writeFileSync(script, `#!/bin/bash
echo "$@" >> "${log}/args"
while [ $# -gt 0 ]; do case "$1" in -app) APP="$2"; shift 2;; -dir) OUT="$2"; shift 2;; -filelist) LIST="$2"; shift 2;; *) shift;; esac; done
[ -f "${fix}/fail" ] && { echo "Error: the account may not download this"; exit 1; }
while read -r f; do [ -z "$f" ] && continue; mkdir -p "$OUT/$(dirname "$f")"; cp "${fix}/$APP/$f" "$OUT/$f" 2>/dev/null || true; done < "$LIST"
`)
    chmodSync(script, 0o755)
    return script
  }
  const put = (app: string, path: string, data: Buffer) => { mkdirSync(join(fix, app, path, '..'), { recursive: true }); writeFileSync(join(fix, app, path), data) }
  const calls = () => (existsSync(join(log, 'args')) ? readFileSync(join(log, 'args'), 'utf8').trim().split('\n').filter(Boolean) : [])
  const content = (o: Record<string, unknown> = {}) => gameContent({ binary: helper(), root, scratch, sources: [{ app: '4020', dir: 'sourceengine/hl2_misc_dir.vpk' }, { app: '232330', dir: 'cstrike/cstrike_pak_dir.vpk' }], ...o })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gc-test-'))
    fix = join(dir, 'fix'); log = join(dir, 'log'); root = join(dir, 'root'); scratch = join(dir, 'scratch')
    for (const d of [fix, log, scratch]) mkdirSync(d, { recursive: true })
    const misc = buildVpk(modelFiles('models/props_c17/crate', crate))
    put('4020', 'sourceengine/hl2_misc_dir.vpk', misc.dir)
    put('4020', 'sourceengine/hl2_misc_000.vpk', misc.archives.get(0)!)
    const css = buildVpk(modelFiles('models/props/cs_office/drum', drum, 3))
    put('232330', 'cstrike/cstrike_pak_dir.vpk', css.dir)
    put('232330', 'cstrike/cstrike_pak_003.vpk', css.archives.get(3)!)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('fetches the index files and the archives that hold the wanted models, keeps the models and deletes the archives', async () => {
    const { models } = content()
    const answer = await models(['models/props_c17/crate.mdl', 'models/props/cs_office/drum.mdl', 'models/nobody/has/this.mdl'])
    expect(answer.error).toBeUndefined()
    expect([...answer.models.keys()].sort()).toEqual(['models/props/cs_office/drum.mdl', 'models/props_c17/crate.mdl'])
    expect(Buffer.from(answer.models.get('models/props_c17/crate.mdl')!.mdl).equals(crate.mdl)).toBe(true)
    // one call for each app's index, one for each archive
    expect(calls()).toHaveLength(4)
    expect(readdirSync(scratch)).toEqual([]) // nothing is left of the downloads
  })

  test('asks for nothing again once the models are cached, also after a restart', async () => {
    await content().models(['models/props_c17/crate.mdl'])
    const before = calls().length
    const again = await content().models(['./Models\\props_c17\\CRATE.mdl'])
    expect(again.models.size).toBe(1)
    expect(calls()).toHaveLength(before)
    // a model that is not in the game costs a look into the (kept) index, not a download
    await content().models(['models/nobody/has/this.mdl'])
    expect(calls()).toHaveLength(before)
  })

  test('a failed download is an answer, not an exception, and models that were fetched stay', async () => {
    const first = content()
    await first.models(['models/props_c17/crate.mdl']) // index and archive
    writeFileSync(join(fix, 'fail'), '')
    const answer = await content().models(['models/props_c17/crate.mdl', 'models/props/cs_office/drum.mdl'])
    expect([...answer.models.keys()]).toEqual(['models/props_c17/crate.mdl'])
    expect(answer.error).toBeTruthy()
    expect(existsSync(join(root, 'models'))).toBe(true)
  })

  test('an archive larger than the limit is not fetched', async () => {
    const answer = await content({ maxArchiveBytes: 10 }).models(['models/props_c17/crate.mdl'])
    expect(answer.models.size).toBe(0)
    expect(answer.error).toContain('larger than the limit')
  })

  test('names that are not model paths are never looked up', async () => {
    const answer = await content().models(['../../etc/passwd.mdl', 'models/../../x.mdl'])
    expect(answer.models.size).toBe(0)
    expect(calls()).toHaveLength(0)
  })
})

describe('in a map', () => {
  const pack = (m: typeof crate) => buildZip({ 'models/test/house.mdl': m.mdl, 'models/test/house.vvd': m.vvd, 'models/test/house.dx90.vtx': m.vtx })
  const around = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
  const open = async () => {
    const models = ['models/test/house.mdl', 'models/props_c17/crate.mdl', 'models/gone.mdl']
    const src = memorySource(buildBsp({ ...flatQuad(0), pak: pack(crate), staticProps: { models, props: models.map((_, i) => ({ model: i, x: 100 + i * 50, y: 100, z: 0, yaw: 0 })) } }))
    return { src, header: await readHeader(src) }
  }

  test('the models the game has are drawn, counted apart, and the rest stays unavailable', async () => {
    const { src, header } = await open()
    let asked: string[] = []
    const { set, report } = await buildPropSet(src, header, [], around, undefined, async names => { asked = names; return { models: new Map([['models/props_c17/crate.mdl', { mdl: new Uint8Array(crate.mdl), vvd: new Uint8Array(crate.vvd), vtx: new Uint8Array(crate.vtx) }]]) } })
    expect(asked.sort()).toEqual(['models/gone.mdl', 'models/props_c17/crate.mdl']) // only what the pack lacks
    expect(set.models.map(m => m.name).sort()).toEqual(['models/props_c17/crate.mdl', 'models/test/house.mdl'])
    expect(report).toMatchObject({ drawnModels: 2, fromGame: 1, unavailable: 1 })
  })

  test('without a source, nothing changes; a source that failed says why and the map still builds', async () => {
    const { src, header } = await open()
    const plain = await buildPropSet(src, header, [], around)
    expect(plain.report).toMatchObject({ drawnModels: 1, fromGame: 0, unavailable: 2 })
    const failed = await buildPropSet(src, header, [], around, undefined, async () => ({ models: new Map(), error: 'the download failed' }))
    expect(failed.report).toMatchObject({ drawnModels: 1, unavailable: 2, stockError: 'the download failed' })
  })
})
