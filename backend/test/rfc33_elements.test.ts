import { expect, test, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import validator from 'gltf-validator'
import { extractSurfaces, extractMapEntities, memorySource, bspFingerprint, waterOrigin, hiddenAtStart, type Fixture } from '../src/maps/bsp'
import { aboveTheMap, surfacesToGlb } from '../src/maps/meshGlb'
import { buildGeometry } from '../src/services/mapgeometry'
import { buildBsp, flatQuads, SURF } from './helpers/bsp_builder'

// RFC 33, 7: what the extractor, the mesh writer and the geometry job do with the classes the RFC draws. The maps are constructed: face 0 is the floor of the
// world (z 0); then each face is a quad of 64 by 64 at its own height, facing up unless `down` or `side`, in the model the list names (a model has `faces` faces).

interface Q { z: number, flags?: number, down?: boolean, side?: boolean, material?: string }
const world = { z: 0 }

/** A map of the faces given and the models over them (model 1 owns the first of the faces after the world's, ...), and its entities. */
function map(faces: Q[], models: number[], entities: string[]): Buffer {
  const quads = flatQuads([world, ...faces].map(f => f.z))
  ;[world as Q, ...faces].forEach((f, i) => {
    if (f.down) quads.planes[i] = { nx: 0, ny: 0, nz: -1, dist: -f.z }
    if (f.side) quads.planes[i] = { nx: 1, ny: 0, nz: 0, dist: 0 }
  })
  let first = 1
  return buildBsp({
    ...quads, texinfoFlags: [world, ...faces].map(f => (f as Q).flags ?? 0), materials: [world, ...faces].map((f, i) => (f as Q).material ?? `m/face${i}`),
    entities: ['{ "classname" "worldspawn" }', ...entities].join('\n'),
    models: [{ firstFace: 0, numFaces: 1 }, ...models.map(n => { const m = { firstFace: first, numFaces: n }; first += n; return m })],
  })
}
const ent = (cls: string, model: number, extra = '') => `{ "classname" "${cls}" "model" "*${model}" ${extra} }`
const read = async (file: Buffer) => {
  const src = memorySource(file)
  const ents = await extractMapEntities(src)
  return { ents, s: await extractSurfaces(src, {}, ents.fixtureModels) }
}
const fixtures = async (file: Buffer) => (await extractMapEntities(memorySource(file))).fixtureModels
const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')

describe('stage A: the classes, and the rules every brush entity follows (section 3)', () => {
  const MOVABLE = ['func_button', 'func_rot_button', 'momentary_rot_button', 'func_tanktrain']
  const FIXED = ['func_breakable_surf', 'func_monitor', 'func_conveyor', 'func_reflective_glass']

  test('buttons, levers and the tank train are parts that can move: in the movable list and its parts, never in the floors', async () => {
    const file = map(MOVABLE.map((_, i) => ({ z: 100 + i * 10 })), MOVABLE.map(() => 1), MOVABLE.map((c, i) => ent(c, i + 1, `"origin" "${i} 0 0"`)))
    const { ents, s } = await read(file)
    expect(ents.fixtureModels.map(f => [f.class, f.movable])).toEqual(MOVABLE.map(c => [c, true]))
    expect(s.movable.length / 9).toBe(MOVABLE.length * 2)
    expect(s.movableParts.map(p => p.class)).toEqual(MOVABLE)
    expect(s.floors.length / 9).toBe(2) // only the world's quad
    expect(s.stats.movableFaces).toBe(MOVABLE.length)
  })

  test('breakable glass, a screen, a belt and a mirror stand still: their faces are drawn with the world, as the fixtures are', async () => {
    const file = map(FIXED.map((_, i) => ({ z: 100 + i * 10 })), FIXED.map(() => 1), FIXED.map((c, i) => ent(c, i + 1)))
    const { ents, s } = await read(file)
    expect(ents.fixtureModels.map(f => f.model)).toEqual([1, 2, 3, 4])
    expect(ents.fixtureModels.every(f => !f.movable && !f.water && !f.decoration)).toBe(true)
    expect(s.floors.length / 9).toBe(2 + FIXED.length * 2)
    expect(s.movable).toEqual([])
  })

  test('a class that only has such a name in it is none of them', async () => {
    const file = map([{ z: 10 }, { z: 20 }, { z: 30 }], [1, 1, 1], [ent('func_breakable_surfx', 1), ent('xfunc_monitor', 2), ent('func_buttons', 3)])
    expect(await fixtures(file)).toEqual([])
  })

  test('an entity with a parent is not drawn, whatever its class (the new ones too)', async () => {
    const all = [...MOVABLE, ...FIXED, 'func_water_analog', 'func_illusionary']
    const file = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1, '"parentname" "boss"')))
    expect(await fixtures(file)).toEqual([])
    const { s } = await read(file)
    expect(s.movable).toEqual([]); expect(s.water).toEqual([]); expect(s.decoration).toEqual([])
    // and without the parent every one of them is
    const free = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1)))
    expect((await fixtures(free)).map(f => f.model)).toEqual(all.map((_, i) => i + 1))
  })

  test('an entity that is hidden at the start is not drawn: startdisabled 1 or rendermode 10, read as numbers', async () => {
    const all = [...MOVABLE, ...FIXED, 'func_water_analog', 'func_illusionary', 'func_brush', 'func_door']
    for (const hidden of ['"startdisabled" "1"', '"rendermode" "10"', '"startdisabled" " 1 "', '"startdisabled" "1.0"', '"rendermode" "10.0"', '"startdisabled" "1" "rendermode" "0"']) {
      const file = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1, hidden)))
      expect(await fixtures(file), hidden).toEqual([])
    }
  })

  test('what is not hidden is drawn: startdisabled 0, rendermode 1, 2 and 5 (colour, texture, additive), and anything that is not a number', async () => {
    const all = [...MOVABLE, ...FIXED, 'func_water_analog', 'func_illusionary']
    for (const shown of ['"startdisabled" "0"', '"rendermode" "1"', '"rendermode" "2"', '"rendermode" "5"', '"rendermode" "0"', '"startdisabled" "abc"', '"rendermode" "ten"', '"startdisabled" ""', '"rendermode" "1e999"', '"startdisabled" "2"']) {
      const file = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1, shown)))
      expect((await fixtures(file)).length, shown).toBe(all.length)
    }
  })

  test('keys are read in any case: Hammer writes StartDisabled (found on a real map: the lava trap was drawn over its floor, because only the lower case spelling was read)', async () => {
    const all = [...MOVABLE, ...FIXED, 'func_water_analog', 'func_illusionary', 'func_brush']
    for (const hidden of ['"StartDisabled" "1"', '"STARTDISABLED" "1"', '"RenderMode" "10"', '"startDisabled" "1.0"']) {
      const file = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1, hidden)))
      expect(await fixtures(file), hidden).toEqual([])
    }
    for (const shown of ['"StartDisabled" "0"', '"RenderMode" "0"']) {
      const file = map(all.map((_, i) => ({ z: 10 + i })), all.map(() => 1), all.map((c, i) => ent(c, i + 1, shown)))
      expect((await fixtures(file)).length, shown).toBe(all.length)
    }
  })

  test('hiddenAtStart: the two keys, as finite numbers', () => {
    expect(hiddenAtStart({ startdisabled: '1' })).toBe(true)
    expect(hiddenAtStart({ rendermode: '10' })).toBe(true)
    expect(hiddenAtStart({})).toBe(false)
    expect(hiddenAtStart({ startdisabled: 'NaN', rendermode: 'Infinity' })).toBe(false)
    expect(hiddenAtStart({ rendermode: '11' })).toBe(false)
  })
})

describe('stage B: the water brush (4.2)', () => {
  // model 1: the surface (up, liquid) at z 72 and the underside (down, liquid) at z -72, around its origin, as in the pool of ttt_67thway_rework_b1
  const pool = (extra: string, faces: Q[] = [{ z: 72, flags: SURF.WARP }, { z: -72, flags: SURF.WARP, down: true }]) => map(faces, [faces.length], [ent('func_water_analog', 1, extra)])
  const waterZ = (w: number[]) => { const z = new Set<number>(); for (let i = 2; i < w.length; i += 3) z.add(w[i]!); return [...z] }

  test('a two-face model (surface and underside) gives one water quad at the entity\'s origin, and nothing in floors, walls or storeys', async () => {
    const { s } = await read(pool('"origin" "-768 40 -528"'))
    expect(s.water.length / 9).toBe(2) // one quad
    expect(waterZ(s.water)).toEqual([-528 + 72]) // the surface only; the underside (z -600) is dropped
    expect(Math.min(...s.water.filter((_, i) => i % 3 === 0))).toBe(-768 + 100) // placed by the origin (the quad is at x 100 around it)
    expect(Math.min(...s.water.filter((_, i) => i % 3 === 1))).toBe(40)
    expect(s.floors.length / 9).toBe(2) // the world's quad and nothing of the pool
    expect(s.walls).toEqual([])
    expect(s.floorFaces.length + s.wallFaces.length).toBe(2)
    expect(s.stats.waterFaces).toBe(2) // both liquid faces were seen
  })

  test('a face of the model that is not liquid, and a liquid side, are dropped too (never a floor or a wall)', async () => {
    const { s } = await read(pool('', [{ z: 50, flags: SURF.WARP }, { z: 60 }, { z: 70, flags: SURF.WARP, side: true }, { z: 80, down: true }]))
    expect(s.water.length / 9).toBe(2)
    expect(waterZ(s.water)).toEqual([50])
    expect(s.floors.length / 9).toBe(2); expect(s.walls).toEqual([])
  })

  test('startposition x movedistance along movedir: -90 0 0 is up (pitch -90 is up in Source), 90 0 0 down', async () => {
    const at = async (extra: string) => waterZ((await read(pool(extra))).s.water)[0]!
    expect(await at('"startposition" "0.5" "movedistance" "100" "movedir" "-90 0 0"')).toBe(72 + 50)
    expect(await at('"startposition" "0.5" "movedistance" "100" "movedir" "90 0 0"')).toBe(72 - 50)
    expect(await at('"startposition" "1" "movedistance" "140" "movedir" "-90 0 0" "origin" "0 0 -528"')).toBe(-528 + 72 + 140)
    expect(await at('"startposition" "0" "movedistance" "140" "movedir" "-90 0 0" "origin" "0 0 -528"')).toBe(-528 + 72) // the pool of the real map: where the mapper put it
  })

  test('movedir is an angle: the forward vector turned by it (a yaw of 90 moves along +y, 0 0 0 along +x)', () => {
    const near = (a: { x: number, y: number, z: number }, x: number, y: number, z: number) => { expect(a.x).toBeCloseTo(x, 6); expect(a.y).toBeCloseTo(y, 6); expect(a.z).toBeCloseTo(z, 6) }
    const o = { x: 10, y: 20, z: 30 }
    near(waterOrigin({ startposition: '1', movedistance: '100', movedir: '0 90 0' }, o), 10, 120, 30)
    near(waterOrigin({ startposition: '1', movedistance: '100', movedir: '0 0 0' }, o), 110, 20, 30)
    near(waterOrigin({ startposition: '1', movedistance: '100', movedir: '-90 0 0' }, o), 10, 20, 130)
    near(waterOrigin({ startposition: '1', movedistance: '100', movedir: '90 0 0' }, o), 10, 20, -70)
    near(waterOrigin({ startposition: '1', movedistance: '100', movedir: '-45 180 0' }, o), 10 - 100 * Math.SQRT1_2, 20, 30 + 100 * Math.SQRT1_2)
  })

  test('startposition is limited to 0..1 and movedistance to 0..16384; anything malformed counts as 0', () => {
    const o = { x: 0, y: 0, z: 0 }
    const up = (e: Record<string, string>) => waterOrigin({ movedir: '-90 0 0', ...e }, o).z
    expect(up({ startposition: '5', movedistance: '100' })).toBe(100) // more than 1 is 1
    expect(up({ startposition: '-3', movedistance: '100' })).toBe(0) // less than 0 is 0
    expect(up({ startposition: '1', movedistance: '99999' })).toBe(16384)
    expect(up({ startposition: '1', movedistance: '-50' })).toBe(0)
    expect(up({ startposition: 'abc', movedistance: '100' })).toBe(0)
    expect(up({ startposition: '1', movedistance: 'x' })).toBe(0)
    expect(up({ startposition: 'NaN', movedistance: '100' })).toBe(0)
    expect(up({ startposition: '1', movedistance: 'Infinity' })).toBe(0)
    expect(up({ startposition: '', movedistance: '100' })).toBe(0)
    expect(up({ movedistance: '100' })).toBe(0) // startposition missing
    expect(up({ startposition: '1' })).toBe(0) // movedistance missing
    expect(waterOrigin({ startposition: '1', movedistance: '100' }, o)).toEqual({ x: 100, y: 0, z: 0 }) // movedir missing: 0 0 0, along +x
    expect(waterOrigin({ startposition: '1', movedistance: '100', movedir: 'a b c' }, o).x).toBe(100) // malformed angles count as 0
  })

  test('the faces are placed by the entity\'s angles as the fixtures\' are, then moved by the start position', async () => {
    const { s } = await read(pool('"origin" "0 0 0" "angles" "0 0 0" "startposition" "1" "movedistance" "10" "movedir" "-90 0 0"', [{ z: 5, flags: SURF.WARP }]))
    expect(waterZ(s.water)).toEqual([15])
  })

  test('the water of a func_brush with a liquid texture is still water, and a liquid face of a door is not (no regression)', async () => {
    const file = map([{ z: 100, flags: SURF.WARP }, { z: 200, flags: SURF.WARP }], [1, 1], [ent('func_brush', 1), ent('func_door', 2)])
    const { s } = await read(file)
    expect(waterZ(s.water)).toEqual([100]) // the brush's; the door's liquid face is not drawn at all
    expect(s.movable).toEqual([])
  })

  test('with the geometry job: the pool is in the water list of the mesh, near the floors it is kept, far from them it goes', async () => {
    const wet = async (origin: string) => {
      const file = map([{ z: 72, flags: SURF.WARP }, { z: -72, flags: SURF.WARP, down: true }], [2], [ent('func_water_analog', 1, `"origin" "${origin}"`)])
      const r = await buildGeometry(memorySource(file), 'm', bspFingerprint(file.subarray(0, 1036), file.length))
      if (!r.ok) throw new Error(r.error)
      return r.info
    }
    // the floors are the quad of 64 by 64 at the origin; the pool's quad is 64 by 64 too (its vertices are at x 100, 100 + 64 around its origin)
    expect((await wet('0 0 0')).water).toBe(2)
    expect((await wet('400 0 0')).water).toBe(2) // 400 units from the floors: inside the 512 of the rule, so it is kept
    expect((await wet('5000 0 0')).water).toBe(0) // far away (a 3D skybox has water of its own): left out, as before
  })
})

describe('stage C: decoration, func_illusionary (4.4)', () => {
  const deco = (faces: Q[], extra = '') => map(faces, [faces.length], [ent('func_illusionary', 1, extra)])

  test('its faces, whatever the slope, are in the decoration list and are no floors, walls, water or parts', async () => {
    const { s } = await read(deco([{ z: 10 }, { z: 20, down: true }, { z: 30, side: true }]))
    expect(s.decoration.length / 9).toBe(6) // three quads
    expect(s.decorationFaces.length).toBe(6)
    expect(s.floors.length / 9).toBe(2); expect(s.walls).toEqual([]) // only the world's floor
    expect(s.floorFaces.length).toBe(2); expect(s.wallFaces.length).toBe(0)
    expect(s.water).toEqual([]); expect(s.movable).toEqual([]); expect(s.movableParts).toEqual([])
    expect(s.stats.floorFaces).toBe(1); expect(s.stats.wallFaces).toBe(0); expect(s.stats.ceilingFaces).toBe(0)
  })

  test('each triangle has the face it came from, and the face has the texture mapping of its material placed with the entity', async () => {
    const { s } = await read(deco([{ z: 10, material: 'minecraft/torch' }, { z: 20, material: 'minecraft/planks' }], '"origin" "5 6 7"'))
    expect(s.decorationFaces.length).toBe(s.decoration.length / 9)
    expect(new Set(s.decorationFaces).size).toBe(2)
    const mats = s.decorationFaces.map(f => s.mappings[s.faces[f]!.mapping]!.material)
    expect([...new Set(mats)]).toEqual(['minecraft/torch', 'minecraft/planks'])
    expect(s.mappings[s.faces[s.decorationFaces[0]!]!.mapping]!.placed?.origin).toEqual([5, 6, 7])
    expect(Math.min(...s.decoration.filter((_, i) => i % 3 === 2))).toBe(10 + 7)
  })

  test('a liquid face of it is not drawn; a parent or a hidden start keeps all of it out', async () => {
    const { s } = await read(deco([{ z: 10, flags: SURF.WARP }, { z: 20 }]))
    expect(s.decoration.length / 9).toBe(2)
    expect((await read(deco([{ z: 10 }], '"parentname" "p"'))).s.decoration).toEqual([])
    expect((await read(deco([{ z: 10 }], '"rendermode" "10"'))).s.decoration).toEqual([])
    expect((await read(deco([{ z: 10 }], '"startdisabled" "1"'))).s.decoration).toEqual([])
  })

  test('the levels and storeys of the mesh are the same with and without the decoration, and the group is its own node', async () => {
    const without = await surfacesToGlb({ floors: quad(0).concat(quad(300)), walls: [], fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' })
    const withIt = await surfacesToGlb({ floors: quad(0).concat(quad(300)), walls: [], decoration: quad(150).concat(quad(10)), decorationFaces: [0, 0, 1, 1], fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' })
    expect(withIt!.info.levels).toEqual(without!.info.levels)
    expect(withIt!.info.storeys).toBe(without!.info.storeys)
    expect(withIt!.info.triangles).toBe(without!.info.triangles)
    expect(withIt!.info.decoration).toBe(4)
    expect(without!.info.decoration).toBe(0)
    const doc = await new NodeIO().readBinary(withIt!.glb)
    const report = await validator.validateBytes(withIt!.glb)
    expect(report.issues.numErrors).toBe(0)
    const node = doc.getRoot().listNodes().find(n => n.getName() === 'decoration')!
    expect(node.getExtras()).toEqual({ group: 'decoration', triangles: 4 })
    expect(doc.getRoot().listNodes().filter(n => /^level-/.test(n.getName())).length).toBe(without!.info.levels.length)
  })

  test('decoration without textures is drawn plain; one tag for each triangle is needed when there are textures (a count that does not fit is refused)', async () => {
    const surface = { floorFaces: [0, 0], wallFaces: [], faces: [{ mapping: 0 }], mappings: [{ material: 'a', s: [1, 0, 0, 0], t: [0, 1, 0, 0], width: 64, height: 64 }], materialOf: [-1], materials: [], textures: [] }
    const ok = await surfacesToGlb({ floors: quad(0), walls: [], surface, decoration: quad(5), decorationFaces: [0, 0], fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' })
    expect(ok!.info.decoration).toBe(2)
    await expect(surfacesToGlb({ floors: quad(0), walls: [], surface, decoration: quad(5), decorationFaces: [0], fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' })).rejects.toThrow(RangeError)
  })

  test('aboveTheMap: a face whose highest point is below the lowest floor minus 64 is dropped, one at or above it is kept, a face is never cut in two', () => {
    const floors = quad(100) // the lowest floor is at 100: the limit is 36
    const slab = (z: number, z2 = z) => [0, 0, z, 10, 0, z, 10, 10, z2]
    const soup = [...slab(35), ...slab(36), ...slab(-1280), ...slab(-1256), ...slab(-1300, 40), ...slab(500)]
    const faces = [0, 1, 2, 3, 4, 5]
    const r = aboveTheMap(soup, faces, floors)
    expect(r.faces).toEqual([1, 4, 5]) // 35 is below 36 (dropped), 36 is on the limit (kept), the lava slab is dropped, the face that reaches 40 is kept whole
    expect(r.soup.length).toBe(27)
    // a face of two triangles goes or stays as one
    const two = aboveTheMap([...slab(-500), ...slab(-500, -100), ...slab(-500), ...slab(-500, 60)], [7, 7, 8, 8], floors)
    expect(two.faces).toEqual([8, 8])
  })

  test('aboveTheMap with no floors keeps everything, and the margin is 64 by default', () => {
    const soup = [0, 0, -9999, 1, 0, -9999, 0, 1, -9999]
    expect(aboveTheMap(soup, [0], [])).toEqual({ soup, faces: [0] })
    expect(aboveTheMap(soup, [0], quad(-9999 + 64)).faces).toEqual([0]) // on the limit
    expect(aboveTheMap(soup, [0], quad(-9999 + 65)).faces).toEqual([]) // one unit below it
  })

  test('with the geometry job: the lava below the map goes, the torches above stay, and the registry and record call the class drawn', async () => {
    const faces: Q[] = [{ z: 40, material: 'minecraft/torch' }, { z: -1256, material: 'minecraft/trap_lava' }, { z: -30, material: 'minecraft/planks' }, { z: -80, material: 'minecraft/trap_lava' }]
    const file = map(faces, [faces.length], [ent('func_illusionary', 1)])
    const r = await buildGeometry(memorySource(file), 'm', bspFingerprint(file.subarray(0, 1036), file.length))
    if (!r.ok) throw new Error(r.error)
    // the floor is at 0: the limit is -64; z 40 and -30 are kept, -80 and -1256 are dropped (two quads kept, two triangles each)
    expect(r.info.decoration).toBe(4)
    expect(r.info.coverage!.brush).toEqual([{ class: 'func_illusionary', entities: 1, faces: 4, status: 'drawn' }])
    expect(r.info.triangles).toBe(2) // the decoration is not counted with the map's triangles
    expect(r.info.levels).toBe(1)
  })
})

/** Two triangles of a square at height z. */
function quad(z: number): number[] { return [0, 0, z, 64, 0, z, 64, 64, z, 0, 0, z, 64, 64, z, 0, 64, z] }

describe('a mesh with one of each new class (the bytes are pinned)', () => {
  // Face by face: a button, a tank train, a pane of glass, a screen, a belt, a mirror, the pool (surface and underside), a decoration of two faces, and a parented and a hidden one.
  const file = () => map(
    [{ z: 10 }, { z: 20 }, { z: 30, material: 'glass/window' }, { z: 40 }, { z: 50 }, { z: 60 }, { z: 72, flags: SURF.WARP }, { z: -72, flags: SURF.WARP, down: true }, { z: 90 }, { z: 95, side: true }, { z: 100 }, { z: 110 }],
    [1, 1, 1, 1, 1, 1, 2, 2, 1, 1],
    [ent('func_button', 1, '"origin" "1 2 3"'), ent('func_tanktrain', 2), ent('func_breakable_surf', 3), ent('func_monitor', 4), ent('func_conveyor', 5), ent('func_reflective_glass', 6),
      ent('func_water_analog', 7, '"origin" "300 0 -40" "startposition" "0.5" "movedistance" "80" "movedir" "-90 0 0"'), ent('func_illusionary', 8, '"origin" "0 200 0"'),
      ent('func_illusionary', 9, '"parentname" "x"'), ent('func_button', 10, '"startdisabled" "1"')])

  test('every class lands where RFC 33 says', async () => {
    const { s } = await read(file())
    expect(s.movableParts.map(p => p.class)).toEqual(['func_button', 'func_tanktrain'])
    expect(s.floors.length / 9).toBe(2 + 4 * 2) // the world's quad, the glass, the screen, the belt, the mirror
    expect(s.water.length / 9).toBe(2)
    expect(Math.max(...s.water.filter((_, i) => i % 3 === 2))).toBe(72 - 40 + 40) // surface 72 around the origin at -40, moved up half of 80
    expect(s.decoration.length / 9).toBe(4)
    expect(s.stats.otherModelFaces).toBe(2) // the parented and the hidden entity are not drawn: their two faces are counted, not drawn
  })

  test('the GLB of this map is the same bytes, twice, and equal to the pinned hash', async () => {
    const f = file()
    const fp = bspFingerprint(f.subarray(0, 1036), f.length)
    const a = await buildGeometry(memorySource(f), 'ttt_rfc33', fp), b = await buildGeometry(memorySource(f), 'ttt_rfc33', fp)
    if (!a.ok || !b.ok) throw new Error('the build failed')
    expect(sha(a.glb)).toBe(sha(b.glb))
    expect(a.info).toMatchObject({ water: 2, decoration: 4, movable: 4 })
    expect(sha(a.glb)).toBe(PINNED)
  })
})

// Taken from the first build of this map with RFC 33 (generation 14); a change to what the writer or the extractor makes of these classes changes it on purpose.
const PINNED = 'b2d2c23f84cceef8778cc0ffb6423a14eea071811f5468dfe8f213658cdc24d5'
