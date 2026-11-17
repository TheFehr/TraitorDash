import { expect, test, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extractMapEntities, extractSurfaces, readHeader, memorySource, bspFingerprint, FIXTURE_CLASSES, MOVABLE_CLASSES, WATER_CLASSES, DECORATION_CLASSES, SURFACE_FLAGS, flagSetName } from '../src/maps/bsp'
import { COVERAGE, STATUSES, KINDS, alternatives, lookup, cleanName, buildCoverage, asRecord, pointFeature, MAX_BRUSH_CLASSES, MAX_POINT_CLASSES, type CoverageRecord } from '../src/maps/coverage'
import { MESH_VERSION, MESH_VERSION_GAME, meshVersion } from '../src/maps/meshVersion'
import { buildGeometry } from '../src/services/mapgeometry'
import { buildBsp, flatQuads, LUMP } from './helpers/bsp_builder'
import { coverageMap, F } from './helpers/coverage_map'

// RFC 32, 9: the registry, the record on a constructed map, the stored info with and without a record, the mesh versions, and the proof that
// the record only counts (the mesh of the same input is the same bytes). The page and the document have their own files (coverage_page, coverage_doc).

/** The record of a map as the geometry job makes it. */
async function recordOf(file: Buffer, limits = {}): Promise<CoverageRecord> {
  const src = memorySource(file)
  const header = await readHeader(src)
  const ents = await extractMapEntities(src, limits)
  const surfaces = await extractSurfaces(src, {}, ents.fixtureModels)
  return buildCoverage(src, header, surfaces.tally, ents.census)
}
const entitiesOf = (...blocks: string[]) => ['{ "classname" "worldspawn" }', ...blocks].join('\n')
const brush = (cls: string, model = 1, extra = '') => `{ "classname" "${cls}" "model" "*${model}" ${extra} }`

describe('the registry', () => {
  test('every entry has a kind, a key, a status of the five (never unknown) and a note of one sentence', () => {
    expect(COVERAGE.length).toBeGreaterThan(40)
    for (const e of COVERAGE) {
      expect(KINDS, `${e.kind}:${e.key}`).toContain(e.kind)
      expect(e.key.length, 'a key').toBeGreaterThan(0)
      expect(STATUSES, `${e.kind}:${e.key}`).toContain(e.status)
      expect(e.status, `${e.kind}:${e.key} is unknown: that is what a lookup returns, not a status an entry has`).not.toBe('unknown')
      expect(e.note.trim().length, `${e.kind}:${e.key} has a note`).toBeGreaterThan(20)
      expect(e.note, `${e.kind}:${e.key}: a note is one sentence`).toMatch(/[.!?]$/)
    }
    expect([...STATUSES]).toEqual(['drawn', 'invisible', 'gap', 'not read', 'unknown'])
  })

  test('no (kind, key) twice', () => {
    const seen = COVERAGE.map(e => `${e.kind}:${e.key}`)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('every surface flag of the BSP format is there, by its own name, with the value the format gives it', () => {
    const FORMAT: [number, string][] = [[0x1, 'LIGHT'], [0x2, 'SKY2D'], [0x4, 'SKY'], [0x8, 'WARP'], [0x10, 'TRANS'], [0x20, 'NOPORTAL'], [0x40, 'TRIGGER'], [0x80, 'NODRAW'], [0x100, 'HINT'], [0x200, 'SKIP'],
      [0x400, 'NOLIGHT'], [0x800, 'BUMPLIGHT'], [0x1000, 'NOSHADOWS'], [0x2000, 'NODECALS'], [0x4000, 'NOCHOP'], [0x8000, 'HITBOX']]
    expect(SURFACE_FLAGS.map(([b, n]) => [b, n])).toEqual(FORMAT)
    for (const [, name] of FORMAT) expect(lookup('flag', name).entry, name).not.toBeNull()
    expect(COVERAGE.filter(e => e.kind === 'flag').map(e => e.key).sort()).toEqual(FORMAT.map(f => f[1]).sort())
  })

  test('the flags the extractor leaves out are invisible, liquid is drawn as water, and the ones that only name lighting are drawn', () => {
    for (const f of ['SKY', 'SKY2D', 'TRIGGER', 'NODRAW', 'HINT', 'SKIP']) expect(lookup('flag', f).status, f).toBe('invisible')
    for (const f of ['WARP', 'TRANS', 'BUMPLIGHT', 'NOLIGHT']) expect(lookup('flag', f).status, f).toBe('drawn')
  })

  test('every class the extractor draws is drawn, and every drawn class is one the extractor draws (the lists of the code are the source)', () => {
    const drawn = COVERAGE.filter(e => e.kind === 'class' && e.status === 'drawn').map(e => e.key)
    expect(drawn.length).toBeGreaterThanOrEqual(12)
    const lists = [FIXTURE_CLASSES, MOVABLE_CLASSES, WATER_CLASSES, DECORATION_CLASSES]
    for (const k of drawn) expect(lists.some(re => re.test(k)), `${k} is drawn in the registry but the extractor does not list it`).toBe(true)
    for (const k of ['func_brush', 'func_wall', 'func_breakable', 'func_lod', 'func_wall_toggle', 'func_door', 'func_door_rotating', 'func_movelinear', 'func_rotating', 'func_tracktrain', 'func_physbox', 'func_physbox_multiplayer',
      // RFC 33: buttons, a tank train, glass, screens, a belt, a mirror, the water brush and the decoration
      'func_button', 'func_rot_button', 'momentary_rot_button', 'func_tanktrain', 'func_breakable_surf', 'func_monitor', 'func_conveyor', 'func_reflective_glass', 'func_water_analog', 'func_illusionary']) {
      expect(lists.some(re => re.test(k)), k).toBe(true)
      expect(lookup('class', k), k).toMatchObject({ status: 'drawn' })
    }
  })

  test('a class that is added to the extractor lists is drawn in the registry without anyone adding a line, and the document test then asks for its row', () => {
    // the registry is made from the regexes; this is the property the test above leans on
    for (const k of [FIXTURE_CLASSES, MOVABLE_CLASSES, WATER_CLASSES, DECORATION_CLASSES].flatMap(alternatives)) expect(COVERAGE.some(e => e.kind === 'class' && e.key === k && e.status === 'drawn'), k).toBe(true)
  })

  test('the classes the pipeline does not draw: triggers, clips, area portals, occluders, weather and the zones of RFC 33, 4.6 are invisible, with a note each', () => {
    for (const k of ['trigger_teleport', 'trigger_multiple', 'trigger_hurt', 'trigger_soundscape', 'trigger_anything_new', 'func_clip_vphysics', 'func_areaportal', 'func_areaportalwindow', 'func_occluder', 'func_precipitation',
      'func_dustcloud', 'func_buyzone', 'func_bomb_target', 'game_zone_player', 'ttt_traitor_check', 'env_embers']) expect(lookup('class', k).status, k).toBe('invisible')
    for (const k of ['func_dustcloud', 'func_buyzone', 'func_bomb_target', 'game_zone_player', 'ttt_traitor_check', 'env_embers']) expect(lookup('class', k).note.length, k).toBeGreaterThan(20)
  })

  test('RFC 33 leaves no class of its table a gap or unknown: each is drawn or invisible, and the registry has no gap entry left', () => {
    const table = ['func_illusionary', 'func_button', 'func_rot_button', 'momentary_rot_button', 'func_water_analog', 'func_breakable_surf', 'func_tanktrain', 'func_monitor', 'func_conveyor', 'func_reflective_glass',
      'func_dustcloud', 'func_buyzone', 'func_bomb_target', 'game_zone_player', 'ttt_traitor_check', 'env_embers']
    for (const k of table) expect(['drawn', 'invisible'], k).toContain(lookup('class', k).status)
    expect(COVERAGE.filter(e => e.status === 'gap').map(e => e.key)).toEqual([])
  })

  test('a lookup: the exact entry first, then the longest `*` prefix, else unknown with no entry (and unknown is never an entry)', () => {
    expect(lookup('class', 'func_door')).toMatchObject({ status: 'drawn' })
    expect(lookup('class', 'trigger_made_up').entry!.key).toBe('trigger_*')
    expect(lookup('class', 'func_areaportalwindow').entry!.key).toBe('func_areaportal*')
    for (const k of ['func_mystery_box', 'func_buttons', 'func_', 'trigger', 'ttt_traitor_checks', 'xtrigger_hurt', '_']) expect(lookup('class', k), k).toMatchObject({ status: 'unknown', entry: null })
    expect(lookup('flag', 'OTHER').status).toBe('unknown')
    expect(lookup('flag', 'light').status, 'flag names are exact').toBe('unknown')
    expect(lookup('material', 'tools/*').status).toBe('invisible')
    expect(lookup('class', 'func_mystery_box').note).toContain('registry')
    // a prefix entry is for classes only: a flag called `trigger_x` is not a trigger
    expect(lookup('flag', 'trigger_x').status).toBe('unknown')
  })

  test('the features of the file: what is drawn, what is not read, the 3D skybox is invisible', () => {
    for (const k of ['displacements', 'static props', 'textures from the pak']) expect(lookup('feature', k).status, k).toBe('drawn')
    for (const k of ['lighting', 'overlays', 'cubemaps', 'detail props', 'visibility', 'fog and light entities']) expect(lookup('feature', k).status, k).toBe('not read')
    expect(lookup('feature', '3D skybox').status).toBe('invisible')
  })

  test('a point entity belongs to a feature the pipeline does not read by its class', () => {
    expect(pointFeature('light')).toBe('fog and light entities')
    expect(pointFeature('light_spot')).toBe('fog and light entities')
    expect(pointFeature('env_fog_controller')).toBe('fog and light entities')
    expect(pointFeature('info_overlay')).toBe('overlays')
    expect(pointFeature('env_cubemap')).toBe('cubemaps')
    expect(pointFeature('lightning_rod'), 'light is a word, not a prefix').toBeNull()
    expect(pointFeature('info_player_start')).toBeNull()
  })

  test('the name of a flag set is by the bits, `-` for none, and OTHER for a bit the format does not name', () => {
    expect(flagSetName(0)).toBe('-')
    expect(flagSetName(F.SKY | F.NOLIGHT)).toBe('SKY|NOLIGHT')
    expect(flagSetName(F.BUMPLIGHT | F.NOLIGHT)).toBe('NOLIGHT|BUMPLIGHT')
    expect(flagSetName(0x10000 | F.WARP)).toBe('WARP|OTHER')
  })
})

describe('the record of a small constructed map, against a hand count', () => {
  test('the world faces by flag set, by what became of them, and by the rule of the material', async () => {
    const r = await recordOf(coverageMap())
    expect(r.worldFaces).toBe(10)
    expect(r.flags).toEqual({ '-': 4, 'NOLIGHT|BUMPLIGHT': 1, BUMPLIGHT: 1, WARP: 1, 'SKY|NOLIGHT': 1, TRANS: 1, NOPORTAL: 1 })
    expect(Object.values(r.flags).reduce((a, b) => a + b, 0)).toBe(r.worldFaces)
    expect(r.outcome).toEqual({ floor: 4, wall: 1, ceiling: 1, water: 1, displacement: 0, skippedByFlag: 1, skippedByMaterial: 2 })
    expect(Object.values(r.outcome).reduce((a, b) => a + b, 0)).toBe(r.worldFaces)
    expect(r.material).toEqual({ sky: 1, 'tools/*': 1 })
  })

  test('a displacement of the world is its own outcome', async () => {
    const quads = flatQuads([0, 8])
    const spec = { ...quads, faces: [{ ...quads.faces[0]!, dispinfo: 0 }, quads.faces[1]!], displacements: [{ startPosition: [0, 0, 0] as [number, number, number], vertStart: 0, power: 2 }],
      dispVerts: Array.from({ length: 25 }, () => ({ vec: [0, 0, 1] as [number, number, number], dist: 0 })) }
    const r = await recordOf(buildBsp(spec))
    expect(r.outcome).toMatchObject({ displacement: 1, floor: 1, wall: 0 })
    expect(r.worldFaces).toBe(2)
  })

  test('the brush entities by class: faces from the models, a listed class drawn, a trigger invisible, a class nobody classified unknown', async () => {
    const r = await recordOf(coverageMap())
    expect(r.brush).toEqual([
      { class: 'func_buttox', entities: 1, faces: 2, status: 'unknown' },
      { class: 'func_mystery_box', entities: 1, faces: 1, status: 'unknown' },
      { class: 'func_water_analox', entities: 1, faces: 1, status: 'unknown' },
      { class: 'func_brush', entities: 1, faces: 1, status: 'drawn' },
      { class: 'func_door', entities: 1, faces: 1, status: 'drawn' },
      { class: 'trigger_hurt', entities: 1, faces: 1, status: 'invisible' },
    ])
    expect(r.brushOther).toBeUndefined()
  })

  test('the point entities, counted by class, and the ones that belong to a feature that is not read', async () => {
    const r = await recordOf(coverageMap())
    expect(r.points).toEqual([
      { class: 'info_player_terrorist', count: 2 }, { class: 'light', count: 2 }, { class: 'env_fog_controller', count: 1 }, { class: 'info_overlay', count: 1 }, { class: 'light_spot', count: 1 },
    ])
    expect(r.pointFeatures).toEqual({ 'fog and light entities': 4, overlays: 1 })
    expect(r.pointsOther).toBeUndefined()
    expect(r.points.map(p => p.class)).not.toContain('worldspawn')
  })

  test('the sizes of the lumps the pipeline does not read (lighting is the plain and the HDR lump)', async () => {
    const r = await recordOf(coverageMap({ raw: { [LUMP.PAKFILE]: Buffer.alloc(500), 8: Buffer.alloc(1000), 53: Buffer.alloc(24), 45: Buffer.alloc(352), 42: Buffer.alloc(48), 4: Buffer.alloc(100), [LUMP.GAME_LUMP]: Buffer.alloc(77) } }))
    expect(r.lumps).toEqual({ lighting: 1024, overlays: 352, cubemaps: 48, gameLump: 77, visibility: 100, pakfile: 500 })
    expect((await recordOf(coverageMap())).lumps).toEqual({ lighting: 0, overlays: 0, cubemaps: 0, gameLump: 0, visibility: 0, pakfile: 0 })
  })

  test('an entity with a parent is not drawn, whatever its class: its faces are told apart', async () => {
    const r = await recordOf(coverageMap({ entities: entitiesOf(brush('func_brush', 2, '"parentname" "boss"'), brush('func_brush', 1)) }))
    expect(r.brush).toEqual([{ class: 'func_brush', entities: 2, faces: 2, status: 'drawn', parentedFaces: 1 }])
  })

  test('a model that is not in the file has no faces, and a brush entity of model 0 is a point entity', async () => {
    const r = await recordOf(coverageMap({ entities: entitiesOf(brush('func_button', 99), '{ "classname" "func_x" "model" "*0" }') }))
    expect(r.brush).toEqual([{ class: 'func_button', entities: 1, faces: 0, status: 'drawn' }])
    expect(r.points).toEqual([{ class: 'func_x', count: 1 }])
  })

  test('a map with no brush entities gives an empty but valid record', async () => {
    const r = await recordOf(buildBsp({ ...flatQuads([0]), entities: '{ "classname" "worldspawn" }' }))
    expect(r).toMatchObject({ worldFaces: 1, brush: [], points: [], pointFeatures: {} })
    expect(asRecord(JSON.parse(JSON.stringify(r)))).toEqual(r)
    const none = await recordOf(buildBsp({ ...flatQuads([0]), entities: '' }))
    expect(none).toMatchObject({ brush: [], points: [] })
  })

  test('a flag the format does not name is counted as OTHER, which the registry does not know', async () => {
    const r = await recordOf(buildBsp({ ...flatQuads([0]), texinfoFlags: [0x10000] }))
    expect(r.flags).toEqual({ OTHER: 1 })
    expect(lookup('flag', 'OTHER').status).toBe('unknown')
  })

  test('the faces of a brush entity are not world faces: the tally is of the world model only', async () => {
    const r = await recordOf(coverageMap())
    expect(r.worldFaces).toBe(10) // 17 faces in the file
  })
})

describe('names from the map file (untrusted)', () => {
  test('cleaned: lower case, only a-z 0-9 _ *, cut to 64, and `_` when nothing is left', () => {
    expect(cleanName('Func_Evil<script>alert(1)</script>')).toBe('func_evilscriptalert1script')
    expect(cleanName('a'.repeat(100))).toBe('a'.repeat(64))
    expect(cleanName('trigger_*')).toBe('trigger_*')
    expect(cleanName('<>!"/ \\ ')).toBe('_')
    expect(cleanName('')).toBe('_')
    expect(cleanName('é\u0000x')).toBe('x')
    expect(cleanName('x'.repeat(10) + '<'.repeat(100) + 'y'.repeat(100))).toBe('x'.repeat(10) + 'y'.repeat(54))
  })

  test('in the record: a class is cleaned, two names that become one are one class, a long one is cut', async () => {
    const r = await recordOf(coverageMap({ entities: entitiesOf(brush('FUNC_BUTTON'), brush('func_button!'), brush('func_<b>x</b>'), brush('a'.repeat(100)), brush('<<<'),
      '{ "classname" "Info<Node>" "origin" "0 0 0" }') }))
    expect(r.brush.find(b => b.class === 'func_button')).toMatchObject({ entities: 2, status: 'drawn' })
    for (const b of r.brush) expect(b.class, b.class).toMatch(/^[a-z0-9_*]{1,64}$/)
    expect(r.brush.map(b => b.class)).toContain('a'.repeat(64))
    expect(r.brush.map(b => b.class)).toContain('_')
    expect(r.points.map(p => p.class)).toEqual(['infonode'])
    expect(JSON.stringify(r)).not.toMatch(/[<>]/) // nothing that looks like markup got through
  })

  test('the class __proto__ is a class like any other: it does not reach the prototype of anything', async () => {
    const r = await recordOf(coverageMap({ entities: entitiesOf(brush('__proto__'), '{ "classname" "__proto__" "origin" "0 0 0" }') }))
    expect(r.brush.find(b => b.class === '__proto__')).toMatchObject({ entities: 1, status: 'unknown' })
    expect(({} as any).entities).toBeUndefined()
    expect(asRecord(JSON.parse(JSON.stringify(r)))?.brush.length).toBe(r.brush.length)
  })

  test('at most 200 brush classes are listed; the rest are counted in `brushOther`', async () => {
    const many = Array.from({ length: 250 }, (_, i) => brush(`func_made_up_${String(i).padStart(3, '0')}`))
    const r = await recordOf(coverageMap({ entities: entitiesOf(...many) }))
    expect(r.brush.length).toBe(MAX_BRUSH_CLASSES)
    expect(r.brushOther).toEqual({ classes: 50, entities: 50, faces: 50 })
    expect(r.brush.reduce((a, b) => a + b.entities, 0) + r.brushOther!.entities).toBe(250)
  })

  test('the most numerous 30 point classes are listed; the rest are counted in `pointsOther`', async () => {
    const points = Array.from({ length: 40 }, (_, i) => `{ "classname" "point_${String(i).padStart(2, '0')}" "origin" "0 0 0" }`)
    const r = await recordOf(coverageMap({ entities: entitiesOf(...points, '{ "classname" "point_00" "origin" "0 0 0" }') }))
    expect(r.points.length).toBe(MAX_POINT_CLASSES)
    expect(r.points[0]).toEqual({ class: 'point_00', count: 2 })
    expect(r.pointsOther).toEqual({ classes: 10, entities: 10 })
  })

  test('a map with thousands of different classes is bounded while it is read, and the entities beyond are still counted', async () => {
    const points = Array.from({ length: 5100 }, (_, i) => `{ "classname" "p${i}" "origin" "0 0 0" }`)
    const src = memorySource(coverageMap({ entities: entitiesOf(...points) }))
    const ents = await extractMapEntities(src)
    expect(ents.census.points.size).toBe(5000)
    expect(ents.census.pointsOther).toBe(100)
    const r = await recordOf(coverageMap({ entities: entitiesOf(...points) }))
    expect(r.points.length).toBe(30)
    expect(r.pointsOther!.entities).toBe(5100 - 30)
  })

  test('the record is small: a map with many classes is a few kilobytes at most', async () => {
    const many = Array.from({ length: 250 }, (_, i) => brush(`func_made_up_${i}`))
    const points = Array.from({ length: 500 }, (_, i) => `{ "classname" "point_${i}" "origin" "0 0 0" }`)
    const r = await recordOf(coverageMap({ entities: entitiesOf(...many, ...points) }))
    expect(JSON.stringify(r).length).toBeLessThan(20_000)
  })
})

describe('a stored record, read back', () => {
  test('asRecord takes what the job stored, and refuses everything else (an old mesh has none)', async () => {
    const r = await recordOf(coverageMap())
    expect(asRecord(JSON.parse(JSON.stringify(r)))).toEqual(r)
    for (const bad of [undefined, null, 0, 'x', [], {}, { worldFaces: -1 }, { ...r, flags: { x: 'a' } }, { ...r, brush: [{ class: 1 }] }, { ...r, brush: [{ class: 'a', entities: 1, faces: 1, status: 'weird' }] }, { ...r, lumps: null }, { ...r, points: 'x' }]) {
      expect(asRecord(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull()
    }
  })

  test('a record from an older build that lacks a part is still read, with the part empty', async () => {
    const r = JSON.parse(JSON.stringify(await recordOf(coverageMap())))
    delete r.material; delete r.pointFeatures
    expect(asRecord(r)).toMatchObject({ material: { sky: 0, 'tools/*': 0 }, pointFeatures: {} })
  })
})

describe('the record only counts: the mesh is what it was', () => {
  // These two hashes were taken from the code before the record existed (with only the version numbers raised): the surfaces the extractor gives for the
  // constructed map, without the tally, and the GLB of the whole build. A change to what the extractor draws changes them on purpose; a change to the record must not.
  const SURFACES = '3ce81cfca85e2977eeeb16931db8261b57defa0ecae9c393305cf14d15f7f110'
  // RFC 33 raised the mesh generation from 13 to 14, which the file carries in its header (`meshVersion`): the bytes of this map were 'bf0f5e87de00d0015e409fd417ba05ced73cff6128e76852c30394b2e154132a' at 13
  // (checked: with the number put back to 13 the build of the same map gives that hash again, so RFC 33 changes no byte of a map with none of its classes). This is the hash at 14; RFC 33, 9a raised the generation to 15, and the hash below is the one at 15 (only that number in the header differs).
  // RFC 35 raised it to 16 (a closed `func_door` is among this map's entities, so its models lump is read for the start state: no byte of the mesh changes;
  // checked: with the numbers put back to 15 and 16 the code of RFC 35 gave 'e4311210737322bef02ac43e3639d5cb081586abf6e09c49f2b5df646af12f90' again). The hash below is the one at 16.
  // RFC 36 raised it to 17 (this map has no texture: no byte of the mesh changes; checked: with the numbers put back to 16 and 17 the code of RFC 36 gave
  // '2a5abb5f1c3533a5b88327c2f5084fcbf0323743bc4b55c70c99c2c7fc8842c5' again). The hash below is the one at 17.
  const GLB = '670f50ad10b8f856a831dfe05447302050ed9a42e103f937d62d38e51036220e'
  const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')

  test('the surfaces of the constructed map are the same triangles, faces, mappings and statistics', async () => {
    const file = coverageMap()
    const src = memorySource(file)
    const ents = await extractMapEntities(src)
    const { tally, decoration, decorationFaces, ...rest } = await extractSurfaces(src, {}, ents.fixtureModels)
    expect(tally.worldFaces).toBe(10)
    expect([decoration, decorationFaces]).toEqual([[], []]) // RFC 33: the two new lists are empty for a map with none of its classes; everything else is hashed as it was
    expect(sha(JSON.stringify(rest))).toBe(SURFACES)
    // and the entities the drawing is told about are the ones before
    expect(ents.fixtureModels.map(f => f.model)).toEqual([1, 2])
  })

  test('the GLB of the whole build is the same bytes, twice, and the info carries the record', async () => {
    const file = coverageMap()
    const fp = bspFingerprint(file.subarray(0, 1036), file.length)
    const a = await buildGeometry(memorySource(file), 'ttt_cov', fp)
    const b = await buildGeometry(memorySource(file), 'ttt_cov', fp)
    if (!a.ok || !b.ok) throw new Error('the build failed')
    expect(sha(a.glb)).toBe(GLB)
    expect(sha(b.glb)).toBe(sha(a.glb))
    expect(a.info.coverage).toMatchObject({ worldFaces: 10 })
    expect(JSON.parse(JSON.stringify(a.info)).coverage.brush.length).toBe(6)
  })
})

describe('the mesh generations', () => {
  test('both went up by one (17 and 18) and still differ, and a backend asks for the one that fits it', () => {
    expect(MESH_VERSION).toBe(17)
    expect(MESH_VERSION_GAME).toBe(18)
    expect(MESH_VERSION_GAME).not.toBe(MESH_VERSION)
    expect(meshVersion(false)).toBe(17)
    expect(meshVersion(true)).toBe(18)
  })

  test('the history in meshVersion.ts names this generation and RFC 33 (and the one before it, RFC 32)', () => {
    const text = readFileSync(new URL('../src/maps/meshVersion.ts', import.meta.url), 'utf8')
    expect(text).toMatch(/13 \(14 with the game's own models\).*RFC 32/)
    expect(text).toMatch(/14 \(15 with the game's own models\).*RFC 33/)
    expect(text).toMatch(/16 \(17 with the game's own models\).*RFC 35/)
    expect(text).toMatch(/17 \(18 with the game's own models\).*RFC 36/)
  })
})
