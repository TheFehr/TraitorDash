import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Box3, Plane, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { extractMapEntities, extractSurfaces, memorySource, bspFingerprint, PART_CLASS_LIST } from '../src/maps/bsp'
import { surfacesToGlb } from '../src/maps/meshGlb'
import { buildGeometry } from '../src/services/mapgeometry'
import { boxWithout, isTemplatedPart, movablePart, prepareMovable } from '../src/sceneKit'
import { buildBsp, flatQuads } from './helpers/bsp_builder'

// RFC 37, 11: a template source of a class the bridge records as parts is kept in the mesh as a hidden `movable-<model>` node (the copies the map spawns share its model
// number, and RFC 20 stage 3 needs the geometry to draw them). It is never drawn at its stored place, and not counted among the visible parts.

const text = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const tpl = (name: string, names: string[], extra = '"spawnflags" "2"') => `{ "classname" "point_template" "targetname" "${name}" ${extra} ${names.map((n, i) => `"Template${String(i + 1).padStart(2, '0')}" "${n}"`).join(' ')} }`
const brush = (cls: string, model: number, name: string | null, extra = '') => `{ "classname" "${cls}" "model" "*${model}" ${name === null ? '' : `"targetname" "${name}"`} "origin" "${model * 100} 0 0" ${extra} }`
const WORLD = '{ "classname" "worldspawn" }'
function map(entities: string[], models = 8): Buffer {
  const quads = flatQuads([0, ...Array.from({ length: models }, (_, i) => 100 + i)])
  return buildBsp({ ...quads, entities: [WORLD, ...entities].join('\n'), models: [{ firstFace: 0, numFaces: 1 }, ...Array.from({ length: models }, (_, i) => ({ firstFace: i + 1, numFaces: 1, maxs: [10, 10, 10] as [number, number, number] }))] })
}
const read = async (entities: string[]) => {
  const src = memorySource(map(entities))
  const ents = await extractMapEntities(src)
  return { ents, s: await extractSurfaces(src, {}, ents.fixtureModels) }
}
const drawn = (r: { ents: { fixtureModels: { templated?: boolean, model: number }[] } }) => r.ents.fixtureModels.filter(f => !f.templated).map(f => f.model)
const kept = (r: { ents: { fixtureModels: { templated?: boolean, model: number }[] } }) => r.ents.fixtureModels.filter(f => f.templated).map(f => f.model)

describe('the class list is the bridge\'s', () => {
  test('PART_CLASS_LIST in bsp.ts equals PART_CLASSES in addon/lua/traitordash/track.lua (they must not drift)', () => {
    const lua = text('../../addon/lua/traitordash/track.lua')
    const body = /local PART_CLASSES = \{([^}]*)\}/.exec(lua)![1]!
    const luaClasses = [...body.matchAll(/([a-z_]+)\s*=\s*true/g)].map(m => m[1]!).sort()
    expect(luaClasses.length).toBeGreaterThan(5)
    expect(([...PART_CLASS_LIST] as string[]).sort()).toEqual(luaClasses)
  })
})

describe('the extractor keeps a templated part, hidden', () => {
  test('a templated func_physbox (Hammer spelling) is emitted as a templated part: not drawn, kept', async () => {
    const r = await read([brush('func_physbox', 1, 'DiaBlock'), brush('func_physbox', 2, 'Other'), tpl('Furnace_Template', ['DiaBlock'])])
    expect(drawn(r)).toEqual([2])
    expect(kept(r)).toEqual([1])
    const f = r.ents.fixtureModels.find(x => x.model === 1)! as any
    expect(f).toMatchObject({ movable: true, class: 'func_physbox', name: 'DiaBlock', templated: true, x: 100 })
    expect(r.ents.census.templated).toMatchObject({ templates: 1, entities: 1, keptAsParts: 1 })
    // the same entity with no template is drawn, not kept
    const free = await read([brush('func_physbox', 1, 'DiaBlock')])
    expect(drawn(free)).toEqual([1]); expect(kept(free)).toEqual([])
  })
  test('every class the bridge records is kept; every other class stays dropped (a templated func_brush, a button, a train of the other kind)', async () => {
    const all = PART_CLASS_LIST.map((c, i) => brush(c, i + 1, `n${i}`))
    const names = PART_CLASS_LIST.map((_, i) => `n${i}`)
    const r = await read([...all, tpl('t', names)])
    expect(kept(r)).toEqual(PART_CLASS_LIST.map((_, i) => i + 1) as number[])
    expect(drawn(r)).toEqual([])
    const others = ['func_brush', 'func_breakable', 'func_wall', 'func_illusionary', 'func_button', 'func_tanktrain', 'func_water_analog'].map((c, i) => brush(c, i + 1, `o${i}`))
    const o = await read([...others, tpl('t', others.map((_, i) => `o${i}`))])
    expect(o.ents.fixtureModels).toEqual([])
    expect(o.ents.census.templated).toMatchObject({ entities: 7, keptAsParts: 0 })
    expect(o.s.movableParts).toEqual([])
  })
  test('a templated door is a hidden part too, wherever it starts (a door that starts open is not left out: its pose does not matter, the node is hidden)', async () => {
    const r = await read([brush('func_door', 1, 'D', '"spawnpos" "1"'), brush('func_door', 2, 'free', '"spawnpos" "1"'), tpl('t', ['D'])])
    expect(kept(r)).toEqual([1])
    expect(r.ents.census.startStates).toMatchObject({ closed: 0, openPlaced: 0, openLeftOut: 1 }) // only the free door counts
  })
  test('what keeps a part out stays: a parent, a missing model, StartDisabled/hidden, a templated name of a template that keeps its entities', async () => {
    const r = await read([
      brush('func_physbox', 1, 'p', '"parentname" "x"'), '{ "classname" "func_physbox" "targetname" "nomodel" "origin" "0 0 0" }', brush('func_physbox', 3, 'hid', '"StartDisabled" "1"'),
      brush('func_physbox', 4, 'bit1'), tpl('t', ['p', 'nomodel', 'hid']), tpl('u', ['bit1'], '"spawnflags" "1"'),
    ])
    expect(kept(r)).toEqual([])
    expect(drawn(r)).toEqual([4])
  })
  test('the round-start exception is unchanged: a template the map spawns itself keeps its entities drawn (not as hidden parts)', async () => {
    const r = await read([brush('func_physbox', 1, 'Plug'), '{ "classname" "ttt_map_settings" "RoundPreparation" "T,ForceSpawn,,0,-1" }', tpl('T', ['Plug'])])
    expect(drawn(r)).toEqual([1]); expect(kept(r)).toEqual([])
    expect(r.ents.census.templated).toMatchObject({ entities: 0, keptAsParts: 0, spawnedAtStart: 1 })
  })
  test('the surfaces: a kept part has its triangles, local to its origin, and none of them are in the world-space movable soup', async () => {
    const r = await read([brush('func_physbox', 1, 'DiaBlock'), tpl('t', ['DiaBlock'])])
    expect(r.s.movableParts.length).toBe(1)
    expect(r.s.movableParts[0]).toMatchObject({ model: 1, templated: true, class: 'func_physbox', name: 'DiaBlock' })
    expect(r.s.movableParts[0]!.triangles.length).toBeGreaterThan(0)
    expect(r.s.movable).toEqual([])
  })
})

describe('the mesh', () => {
  const MAP = map([brush('func_physbox', 1, 'DiaBlock'), brush('func_physbox', 2, 'Other'), brush('func_brush', 3, 'b'), brush('func_door', 4, 'D', '"spawnpos" "1"'), brush('func_wall', 5, 'free'), tpl('t', ['DiaBlock', 'b', 'D'])])
  const build = async () => { const r = await buildGeometry(memorySource(MAP), 'ttt_k', bspFingerprint(MAP.subarray(0, 1036), MAP.length)); if (!r.ok) throw new Error(r.error); return r }
  const load = (glb: Uint8Array) => new Promise<any>((ok, fail) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '', g => ok(g.scene), fail))

  test('the hidden parts are `movable-<model>` nodes with extras templated: the physbox and the door; the visible ones are counted apart', async () => {
    const r = await build()
    const model = await load(r.glb)
    const dia = model.getObjectByName('movable-1')!, door = model.getObjectByName('movable-4')!, other = model.getObjectByName('movable-2')!
    expect(dia.userData.templated).toBe(true); expect(door.userData.templated).toBe(true)
    expect(dia.userData).toMatchObject({ model: 1, class: 'func_physbox', name: 'DiaBlock' })
    expect(other.userData.templated).toBeUndefined()
    expect(model.getObjectByName('movable-3')).toBeUndefined() // a templated func_brush is still dropped
    const group = model.getObjectByName('movable')!
    expect(group.userData).toMatchObject({ group: 'movable', parts: 1, templatedParts: 2 })
    // counts: `movable` is the visible triangles only
    expect(r.info.templatedParts).toBe(2)
    const parts = group.children.filter((c: any) => !c.userData.templated)
    expect(parts.map((c: any) => c.name)).toEqual(['movable-2'])
    expect(group.userData.triangles).toBe(2) // one quad of the visible part
    expect(r.info.movable).toBe(2)
    expect(r.info.coverage!.templated).toMatchObject({ keptAsParts: 3 - 1 })
  })
  test('GlbInfo: templated counts the hidden parts and their triangles apart; a map with no templated part has none and a group exactly as before', async () => {
    const m = map([brush('func_physbox', 1, 'a'), brush('func_physbox', 2, 'b'), tpl('t', ['a'])])
    const src = memorySource(m)
    const ents = await extractMapEntities(src)
    const s = await extractSurfaces(src, {}, ents.fixtureModels)
    const out = (await surfacesToGlb({ ...s }, { map: 'x' }))!
    expect(out.info.templated).toEqual({ parts: 1, triangles: 2 })
    expect(out.info.movable).toBe(2)
    const plain = map([brush('func_physbox', 2, 'b')])
    const s2 = await extractSurfaces(memorySource(plain), {}, (await extractMapEntities(memorySource(plain))).fixtureModels)
    const out2 = (await surfacesToGlb({ ...s2 }, { map: 'x' }))!
    expect(out2.info.templated).toEqual({ parts: 0, triangles: 0 })
    const model = await load(out2.glb)
    const { name: _n, ...extras } = model.getObjectByName('movable')!.userData // three adds the node's name
    expect(extras).toEqual({ group: 'movable', triangles: 2, parts: 1 })
    expect(model.getObjectByName('movable-2')!.userData.templated).toBeUndefined()
    expect(JSON.stringify(model.getObjectByName('movable-2')!.userData)).not.toContain('templated')
  })
  test('only hidden parts: the group is still written (the nodes are there for stage 3), and the visible count is zero', async () => {
    const m = map([brush('func_physbox', 1, 'a'), tpl('t', ['a'])])
    const src = memorySource(m)
    const s = await extractSurfaces(src, {}, (await extractMapEntities(src)).fixtureModels)
    const out = (await surfacesToGlb({ ...s }, { map: 'x' }))!
    expect(out.info.movable).toBe(0); expect(out.info.templated.parts).toBe(1)
    const model = await load(out.glb)
    expect(model.getObjectByName('movable-1')).toBeTruthy()
  })
  test('the viewer: prepareMovable keeps the node hidden whether the group is shown or not (the "Movable parts" switch) and movablePart finds it by name; stage 3 can show it', async () => {
    const model = await load((await build()).glb)
    const cut = new Plane(new Vector3(0, -1, 0), 1e9)
    const group = prepareMovable(model, cut)!
    const dia = movablePart(model, 1)!, other = movablePart(model, 2)!
    expect(dia.name).toBe('movable-1'); expect(movablePart(model, 99)).toBeNull()
    expect(isTemplatedPart(dia)).toBe(true); expect(isTemplatedPart(other)).toBe(false)
    // the switch sets the group's visibility only: shown, the hidden node is hidden, the visible one is not
    for (const on of [true, false, true]) {
      group.visible = on
      expect(dia.visible).toBe(false); expect(movablePart(model, 4)!.visible).toBe(false)
      expect(other.visible).toBe(true)
    }
    // what stage 3 does from a copy's first keyframe
    dia.visible = true
    group.visible = true
    expect(dia.visible).toBe(true)
    let seen = 0; dia.traverse((o: any) => { if (o.isMesh) seen++ })
    expect(seen).toBeGreaterThan(0)
    // cut like the others
    dia.traverse((o: any) => { if (o.isMesh) expect(o.material.clippingPlanes).toEqual([cut]) })
  })
  test('the camera does not look at a hidden part: boxWithout leaves it out, though a plain box would include it', async () => {
    const far = map(['{ "classname" "func_physbox" "model" "*8" "targetname" "Far" "origin" "90000 0 0" }', brush('func_physbox', 2, 'near'), tpl('t', ['Far'])])
    const g = await buildGeometry(memorySource(far), 'ttt_far', bspFingerprint(far.subarray(0, 1036), far.length)); if (!g.ok) throw new Error(g.error)
    const model = await load(g.glb)
    prepareMovable(model, new Plane(new Vector3(0, -1, 0), 1e9))
    model.updateMatrixWorld(true)
    const hidden = movablePart(model, 8)!
    expect(isTemplatedPart(hidden)).toBe(true)
    const plain = new Box3().setFromObject(model)
    const boxed = boxWithout(model, [])
    // the part stands at x 90000 in Source space; the model is turned to Y-up, so compare the sizes of the boxes
    expect(plain.getSize(new Vector3()).length()).toBeGreaterThan(boxed.getSize(new Vector3()).length() + 10000)
    expect(boxed.getSize(new Vector3()).length()).toBeLessThan(5000)
  })
  test('the map page: the switch toggles the group only (a hidden child stays hidden), and the replay calls prepareMovable on the model', () => {
    expect(text('../src/mapview.ts')).toContain('if (movable) movable.visible = (e.target as HTMLInputElement).checked')
    expect(text('../src/replay.ts')).toContain('prepareMovable(model, cut)')
    expect(text('../src/sceneKit.ts')).toMatch(/isTemplatedPart\(c\)\) c\.visible = false/)
  })
})
