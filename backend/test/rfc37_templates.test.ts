import { expect, test, describe } from 'bun:test'
import { extractSurfaces, extractMapEntities, memorySource, parseEntities, templatedNamesOf, bspFingerprint } from '../src/maps/bsp'
import { asRecord, templatedRecord, type CoverageRecord } from '../src/maps/coverage'
import { buildGeometry } from '../src/services/mapgeometry'
import { buildBsp, flatQuads } from './helpers/bsp_builder'

// RFC 37: an entity that a point_template names (Template01 to Template16) is not in the world when the round starts, so it is not drawn, not placed, not a spawn.
// Keys are written as Hammer writes them (`Template01`, `TargetName`, `SpawnFlags`); the extractor lower-cases them when it reads the lump.

const tpl = (name: string, names: string[], extra = '"spawnflags" "2"') => `{ "classname" "point_template" "targetname" "${name}" ${extra} ${names.map((n, i) => `"Template${String(i + 1).padStart(2, '0')}" "${n}"`).join(' ')} }`
const brush = (cls: string, model: number, name: string | null, extra = '') => `{ "classname" "${cls}" "model" "*${model}" ${name === null ? '' : `"targetname" "${name}"`} "origin" "${model * 100} 0 0" ${extra} }`
const physbox = (model: number, name: string | null) => brush('func_physbox', model, name)
const WORLD = '{ "classname" "worldspawn" }'

/** A map whose models 1..n each own a quad of their own (a box of 10), so a model's face turns up in the mesh groups when its entity is drawn. */
function map(entities: string[], models = 8): Buffer {
  const quads = flatQuads([0, ...Array.from({ length: models }, (_, i) => 100 + i)])
  return buildBsp({ ...quads, entities: [WORLD, ...entities].join('\n'), models: [{ firstFace: 0, numFaces: 1 }, ...Array.from({ length: models }, (_, i) => ({ firstFace: i + 1, numFaces: 1, maxs: [10, 10, 10] as [number, number, number] }))] })
}
const read = async (entities: string[]) => {
  const src = memorySource(map(entities))
  const all = await extractMapEntities(src)
  // `ents.fixtureModels` is what is DRAWN; the templated parts kept hidden for RFC 37, 11 are in `kept`.
  const ents = { ...all, fixtureModels: all.fixtureModels.filter(f => !f.templated) }
  return { ents, kept: all.fixtureModels.filter(f => f.templated), s: await extractSurfaces(src, {}, all.fixtureModels) }
}
const names = (r: { ents: { fixtureModels: { name?: string }[] } }) => r.ents.fixtureModels.map(f => f.name)

describe('parseEntities: keys in lower case, the whole lump before any decision', () => {
  test('Hammer\'s capitals are lower case; values keep theirs', () => {
    const [e] = parseEntities('{ "ClassName" "Point_Template" "Template01" "DiaBlock" }')
    expect(e).toEqual({ classname: 'Point_Template', template01: 'DiaBlock' })
  })
})

describe('templatedNamesOf: which names the templates take out of the world', () => {
  const set = (...lumps: string[]) => [...templatedNamesOf(parseEntities(lumps.join('\n')))].sort()

  test('Template01 to Template16 in Hammer\'s spelling are all read (a reader of Template01 alone, or of case-sensitive keys, fails here)', () => {
    const all = Array.from({ length: 16 }, (_, i) => `n${i + 1}`)
    expect(set(tpl('t', all))).toEqual(all.slice().sort())
    expect(set('{ "classname" "point_template" "template01" "low" "TEMPLATE02" "UP" "Template03" "Mixed" }')).toEqual(['low', 'mixed', 'up'])
  })
  test('names are lower-cased and trimmed; an empty or blank value names nothing', () => {
    expect(set('{ "classname" "point_template" "Template01" "  DiaBlock " "Template02" "" "Template03" "   " }')).toEqual(['diablock'])
  })
  test('keys that are not Template01..16 are not read (00, 17, 1, a prefix, another class)', () => {
    expect(set('{ "classname" "point_template" "Template00" "a" "Template17" "b" "Template1" "c" "Template001" "d" "Templates01" "e" "template" "f" }')).toEqual([])
    expect(set('{ "classname" "env_entity_maker" "Template01" "a" "EntityTemplate" "b" }')).toEqual([])
  })
  test('spawnflags: bit 1 ("don\'t remove template entities") keeps the names in the world; bit 2 ("preserve names") and the rest do not', () => {
    expect(set(tpl('t', ['a'], '"spawnflags" "1"'))).toEqual([])
    expect(set(tpl('t', ['a'], '"spawnflags" "3"'))).toEqual([])
    expect(set(tpl('t', ['a'], '"SpawnFlags" "2"'))).toEqual(['a'])
    expect(set(tpl('t', ['a'], '"spawnflags" "0"'))).toEqual(['a'])
    expect(set(tpl('t', ['a'], ''))).toEqual(['a'])
    expect(set(tpl('t', ['a'], '"spawnflags" "4"'))).toEqual(['a'])
    expect(set(tpl('t', ['a'], '"spawnflags" "not a number"'))).toEqual(['a'])
  })
  test('several templates add up; the same name twice is one; the order of the lump does not matter', () => {
    const a = tpl('t1', ['x', 'y']), b = tpl('t2', ['y', 'z']), keep = tpl('t3', ['w'], '"spawnflags" "1"')
    expect(set(a, b, keep)).toEqual(['x', 'y', 'z'])
    expect(set(keep, b, a)).toEqual(['x', 'y', 'z'])
  })
})

describe('the extractor: an entity a template names is not in the world', () => {
  test('the diamond block pattern: a func_physbox named by a template (spawnflags 2) is in no fixture, no movable triangle and no part', async () => {
    const { ents, s } = await read([physbox(1, 'DiaBlock'), physbox(2, 'Other'), tpl('Furnace_Template', ['DiaBlock'])])
    expect(names({ ents })).toEqual(['Other'])
    expect(ents.fixtureModels.map(f => f.model)).toEqual([2])
    expect(s.movableParts.filter(p => !p.templated).map(p => p.model)).toEqual([2])
    const alone = await read([physbox(2, 'Other')])
    expect(s.movable.length).toBeGreaterThan(0)
    expect(s.movable).toEqual(alone.s.movable) // the world-space soup has only the one that is drawn: the template source is not in the world
    expect(s.movableParts.filter(p => p.templated).map(p => p.model)).toEqual([1]) // its geometry is kept, hidden (RFC 37, 11)
  })
  test('the same entity with a template of spawnflags 1, or with no template at all, is drawn', async () => {
    expect(names(await read([physbox(1, 'DiaBlock'), tpl('t', ['DiaBlock'], '"spawnflags" "1"')]))).toEqual(['DiaBlock'])
    expect(names(await read([physbox(1, 'DiaBlock')]))).toEqual(['DiaBlock'])
    expect(names(await read([physbox(1, 'DiaBlock'), tpl('t', ['SomethingElse'])]))).toEqual(['DiaBlock'])
  })
  test('it is not one class that is hidden: a fixture, a decoration, a water brush and a door are left out too', async () => {
    const lump = [brush('func_brush', 1, 'a'), brush('func_illusionary', 2, 'b'), brush('func_water_analog', 3, 'c'), brush('func_door', 4, 'd'), brush('func_button', 5, 'e'), brush('func_wall', 6, 'free'), tpl('t', ['a', 'b', 'c', 'd', 'e'])]
    const { ents } = await read(lump)
    expect(ents.fixtureModels.map(f => f.model)).toEqual([6])
    const none = await read(lump.slice(0, -1))
    expect(none.ents.fixtureModels.map(f => f.model).sort()).toEqual([1, 2, 3, 4, 5, 6])
  })
  test('a prop the entity lump places is not placed; a spawn point is not a spawn; another prop and another spawn are', async () => {
    const lump = [
      '{ "classname" "prop_dynamic" "model" "models/props/ammo.mdl" "origin" "1 2 3" "targetname" "I3_Ammo" }',
      '{ "classname" "prop_physics" "model" "models/props/free.mdl" "origin" "4 5 6" "targetname" "FreeProp" }',
      '{ "classname" "info_player_start" "origin" "7 8 9" "targetname" "T_Spawn" }',
      '{ "classname" "info_player_terrorist" "origin" "10 11 12" }',
      tpl('I3_Point', ['I3_Ammo', 'T_Spawn']),
    ]
    const { ents } = await read(lump)
    expect(ents.entityProps.map(p => p.model)).toEqual(['models/props/free.mdl'])
    expect(ents.spawns.map(p => p.class)).toEqual(['info_player_terrorist'])
    const free = await read(lump.slice(0, -1))
    expect(free.ents.entityProps.length).toBe(2); expect(free.ents.spawns.length).toBe(2)
  })
  test('a template that comes AFTER the entity in the lump still takes it out, and so does one before it (a decision at the closing brace fails this)', async () => {
    const later = await read([physbox(1, 'DiaBlock'), tpl('t', ['DiaBlock'])])
    expect(later.ents.fixtureModels).toEqual([])
    const earlier = await read([tpl('t', ['DiaBlock']), physbox(1, 'DiaBlock')])
    expect(earlier.ents.fixtureModels).toEqual([])
    const spawnLater = await read(['{ "classname" "info_player_start" "origin" "1 1 1" "targetname" "S" }', tpl('t', ['S'])])
    expect(spawnLater.ents.spawns).toEqual([])
  })
  test('the match is without regard to case, and a name in the 16th slot or from a second template counts', async () => {
    const lump = [physbox(1, 'DiaBLOCK'), physbox(2, 'last'), physbox(3, 'twice'), tpl('a', ['diablock', ...Array(14).fill(''), 'LAST']), tpl('b', ['twice']), tpl('c', ['twice'])]
    expect((await read(lump)).ents.fixtureModels).toEqual([])
  })
  test('an entity with no targetname is never hidden, whatever a template holds (an empty name in the template is no name)', async () => {
    const { ents } = await read([physbox(1, null), '{ "classname" "info_player_start" "origin" "1 1 1" }', brush('func_physbox', 2, ''), '{ "classname" "point_template" "spawnflags" "2" "Template01" "" "Template02" "   " }'])
    expect(ents.fixtureModels.map(f => f.model)).toEqual([1, 2])
    expect(ents.spawns.length).toBe(1)
    expect(ents.census.templated).toMatchObject({ templates: 1, entities: 0 })
  })
  test('a part hidden at the start is still dropped, templated or not', async () => {
    const { ents } = await read([physbox(1, 'p'), brush('func_physbox', 2, 'q', '"StartDisabled" "1"'), tpl('t', ['p'])])
    expect(ents.fixtureModels).toEqual([])
  })
  test('a templated door that starts open is not counted in the start states (it is not in the world to start)', async () => {
    const { ents } = await read([brush('func_door', 1, 'D', '"spawnpos" "1"'), brush('func_door', 2, 'free', '"spawnpos" "1"'), tpl('t', ['D'])])
    expect(ents.census.startStates).toMatchObject({ closed: 0, openPlaced: 0, openLeftOut: 1 })
  })
})

describe('a template the map spawns itself when the round starts keeps its entities in the world (T2_Blocks of b7_summer: the plug of the traitor room)', () => {
  const settings = (lines: string) => `{ "classname" "ttt_map_settings" "targetname" "settings" ${lines} }`
  const plug = (name = 'Plug') => brush('func_breakable', 1, name)

  test('RoundPreparation with ForceSpawn on the template: its entities are drawn (the real map\'s line, repeated outputs included)', async () => {
    const lump = [plug(), settings('"RoundPreparation" "T2_Template,ForceSpawn,,0,-1"'), tpl('T2_Template', ['Plug'])]
    expect((await read(lump)).ents.fixtureModels.map(f => f.model)).toEqual([1])
    // the same without the line: left out
    expect((await read([plug(), tpl('T2_Template', ['Plug'])])).ents.fixtureModels).toEqual([])
    // two lines of the same output on one entity: an earlier one is not lost to a later one
    const twice = [plug(), settings('"RoundPreparation" "T2_Template,ForceSpawn,,0,-1" "RoundPreparation" "Other,Kill,,0,-1"'), tpl('T2_Template', ['Plug'])]
    expect((await read(twice)).ents.fixtureModels.length).toBe(1)
  })
  test('the other round-start outputs count (RoundStart, logic_auto OnMapSpawn, OnNewGame, OnMultiNewRound); name, input and output in any case; the old separator too', async () => {
    for (const line of ['"RoundStart" "T,ForceSpawn,,0,-1"', '"OnMapSpawn" "t,forcespawn,,0,-1"', '"OnNewGame" "T,ForceSpawn,,0,-1"', '"OnMultiNewRound" " T ,ForceSpawn,,0,-1"', '"ROUNDPREPARATION" "T\x1bForceSpawn\x1b\x1b0\x1b-1"']) {
      expect((await read([plug(), settings(line), tpl('T', ['Plug'])])).ents.fixtureModels.length, line).toBe(1)
    }
  })
  test('anything else does not: a button\'s OnPressed, a counter\'s OnHitMax, another input than ForceSpawn, another template\'s name', async () => {
    for (const line of ['"OnPressed" "T,ForceSpawn,,0,-1"', '"OnHitMax" "T,ForceSpawn,,0,-1"', '"OnTrigger" "T,ForceSpawn,,0,-1"', '"RoundStart" "T,Kill,,0,-1"', '"RoundStart" "T,Enable,,0,-1"', '"RoundStart" "Other,ForceSpawn,,0,-1"', '"RoundStart" "T"', '"RoundStart" ",ForceSpawn,,0,-1"']) {
      expect((await read([plug(), settings(line), tpl('T', ['Plug'])])).ents.fixtureModels, line).toEqual([])
    }
  })
  test('only the template that is spawned is spared: another template\'s entity is still left out; a template without a name is never spared', async () => {
    const { ents } = await read([brush('func_brush', 1, 'A'), brush('func_brush', 2, 'B'), settings('"RoundPreparation" "TA,ForceSpawn,,0,-1"'), tpl('TA', ['A']), tpl('TB', ['B'])])
    expect(ents.fixtureModels.map(f => f.model)).toEqual([1])
    expect(ents.census.templated).toMatchObject({ templates: 2, entities: 1, spawnedAtStart: 1 })
    const noName = await read([brush('func_brush', 1, 'A'), settings('"RoundPreparation" ",ForceSpawn,,0,-1"'), '{ "classname" "point_template" "spawnflags" "2" "Template01" "A" }'])
    expect(noName.ents.fixtureModels).toEqual([])
  })
  test('templatedNamesOf takes the names of the spawned templates out of the set; a template that keeps its entities anyway (bit 1) is not counted as spawned', async () => {
    const es = parseEntities([tpl('T1', ['a']), tpl('T2', ['b']), tpl('T3', ['c'], '"spawnflags" "1"')].join('\n'))
    expect([...templatedNamesOf(es, new Set(['t1']))]).toEqual(['b'])
    expect([...templatedNamesOf(es, new Set(['t1', 't2', 't3']))]).toEqual([])
    const r = await read([settings('"RoundStart" "T3,ForceSpawn,,0,-1"'), tpl('T3', ['c'], '"spawnflags" "1"')])
    expect(r.ents.census.templated!.spawnedAtStart).toBe(0)
  })
})

describe('the census: counted, apart from the classes', () => {
  test('templated entities stay in the brush and point counts (they are in the file) and are counted as templated, by class', async () => {
    const { ents } = await read([
      physbox(1, 'a'), physbox(2, 'b'), brush('func_brush', 3, 'c'), physbox(4, 'free'),
      '{ "classname" "prop_dynamic" "model" "models/p.mdl" "origin" "1 2 3" "targetname" "A" }',
      '{ "classname" "info_player_start" "origin" "1 2 3" "targetname" "S" }',
      tpl('t1', ['a', 'b', 'c', 'A', 'S']), tpl('t2', ['b']), tpl('t3', ['free'], '"spawnflags" "1"'),
    ])
    expect(ents.census.brush.filter(b => b.class === 'func_physbox').length).toBe(3)
    expect(ents.census.points.get('prop_dynamic')).toBe(1)
    expect(ents.census.points.get('point_template')).toBe(3)
    const t = ents.census.templated!
    expect(t.templates).toBe(3); expect(t.entities).toBe(5)
    expect([...t.byClass].sort()).toEqual([['func_brush', 1], ['func_physbox', 2], ['info_player_start', 1], ['prop_dynamic', 1]])
  })
  test('a map without a template counts nothing and its output is what it was', async () => {
    const { ents } = await read([physbox(1, 'a'), physbox(2, 'b')])
    expect(ents.census.templated).toEqual({ templates: 0, entities: 0, byClass: new Map(), keptAsParts: 0, spawnedAtStart: 0 })
    expect(ents.fixtureModels.length).toBe(2)
  })
})

describe('the record', () => {
  const MAP = map([physbox(1, 'a'), physbox(2, 'b'), brush('func_brush', 3, 'c'), brush('func_wall', 4, 'free'), '{ "classname" "prop_dynamic" "model" "models/p.mdl" "origin" "1 2 3" "targetname" "A" }', tpl('t1', ['a', 'b', 'c', 'A']), tpl('t2', ['b'], '"spawnflags" "1"')])
  const build = async () => { const r = await buildGeometry(memorySource(MAP), 'ttt_s37', bspFingerprint(MAP.subarray(0, 1036), MAP.length)); if (!r.ok) throw new Error(r.error); return r }

  test('templated has the templates read, the entities left out and the classes, largest first', async () => {
    const r = await build()
    expect(r.info.coverage!.templated).toEqual({ templates: 2, entities: 4, byClass: [{ class: 'func_physbox', count: 2 }, { class: 'func_brush', count: 1 }, { class: 'prop_dynamic', count: 1 }], keptAsParts: 2 })
  })
  test('the drawn mesh has no part of the templated entities: no movable part, and the model of the one that is free is the wall', async () => {
    const { ents, s } = await read([physbox(1, 'a'), brush('func_wall', 2, 'free'), tpl('t1', ['a'])])
    expect(s.movableParts.filter(p => !p.templated)).toEqual([]); expect(ents.fixtureModels.map(f => f.model)).toEqual([2])
  })
  test('a template the map spawns itself is counted in the record, apart from the entities left out', async () => {
    const m = map([physbox(1, 'a'), '{ "classname" "ttt_map_settings" "RoundPreparation" "Keep,ForceSpawn,,0,-1" }', tpl('Keep', ['a'])])
    const r = await buildGeometry(memorySource(m), 'ttt_s37k', bspFingerprint(m.subarray(0, 1036), m.length)); if (!r.ok) throw new Error(r.error)
    expect(r.info.coverage!.templated).toEqual({ templates: 1, entities: 0, byClass: [], spawnedAtStart: 1 })
  })
  test('it survives the JSON the mesh stores, and a record from before RFC 37 loads without it', async () => {
    const stored = JSON.parse(JSON.stringify((await build()).info.coverage))
    expect(asRecord(stored)!.templated).toEqual(stored.templated)
    delete stored.templated
    const old = asRecord(stored)
    expect(old).not.toBeNull(); expect(old!.templated).toBeUndefined(); expect('templated' in old!).toBe(false)
  })
  test('numbers are checked: a record whose templated is damaged loads without it; counts are whole numbers, names are cleaned', async () => {
    const base: any = JSON.parse(JSON.stringify((await build()).info.coverage))
    const withT = (t: unknown): CoverageRecord | null => asRecord({ ...base, templated: t })
    for (const bad of [null, 'x', 5, { templates: -1, entities: 1, byClass: [] }, { templates: 1, entities: NaN, byClass: [] }, { templates: 1, entities: 1, byClass: 'x' }, { templates: 1, entities: 1, byClass: [{ class: 'a', count: -3 }] }, { templates: 1, entities: 1, byClass: [{ class: 5, count: 3 }] }, { templates: '1', entities: 1, byClass: [] }]) {
      const r = withT(bad)
      expect(r, JSON.stringify(bad)).not.toBeNull(); expect(r!.templated, JSON.stringify(bad)).toBeUndefined()
    }
    const r = withT({ templates: 2.7, entities: 3.2, byClass: [{ class: 'Func_PhysBox<script>', count: 2.9 }, { class: 'func_physbox<b>', count: 1 }], other: { classes: -1, entities: 4 } })!
    expect(r.templated).toEqual({ templates: 2, entities: 3, byClass: [{ class: 'func_physboxscript', count: 2 }, { class: 'func_physboxb', count: 1 }] })
    expect(withT({ templates: 2, entities: 3, byClass: [], spawnedAtStart: 2.6 })!.templated).toEqual({ templates: 2, entities: 3, byClass: [], spawnedAtStart: 2 })
    expect(withT({ templates: 2, entities: 3, byClass: [], spawnedAtStart: -1 })!.templated).toEqual({ templates: 2, entities: 3, byClass: [] })
  })
  test('templatedRecord: at most 30 classes, ranked by count then name, the rest counted together; names that become one are one', () => {
    const byClass = new Map<string, number>(Array.from({ length: 35 }, (_, i) => [`c${String(i).padStart(2, '0')}`, i === 34 ? 9 : 1]))
    byClass.set('Dup', 1); byClass.set('dup', 1)
    const r = templatedRecord({ templates: 3, entities: 46, byClass, keptAsParts: 0, spawnedAtStart: 0 })
    expect(r.byClass.length).toBe(30)
    expect(r.byClass[0]).toEqual({ class: 'c34', count: 9 })
    expect(r.byClass[1]).toEqual({ class: 'dup', count: 2 })
    expect(r.byClass[2]).toEqual({ class: 'c00', count: 1 })
    expect(r.other).toEqual({ classes: 6, entities: 6 })
  })
})
