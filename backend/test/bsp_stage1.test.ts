import { expect, test, describe } from 'bun:test'
import { extractSurfaces, extractMapEntities, memorySource, isNotSurfaceMaterial, angleMatrix, type Fixture } from '../src/maps/bsp'
import { buildBsp, flatQuads, SURF } from './helpers/bsp_builder'

// RFC 18, stage 1: what the reader leaves out of the floors, and where it puts it instead.

describe('water and lava (RFC 18, 4.1)', () => {
  test('a liquid surface is water, never a floor', async () => {
    const s = await extractSurfaces(memorySource(buildBsp({ ...flatQuads([0, 100]), texinfoFlags: [0, SURF.WARP] })))
    expect(s.floors.length / 9).toBe(2) // the quad that is not liquid: two triangles
    expect(s.water.length / 9).toBe(2) // the liquid one: two triangles
    expect(s.stats.waterFaces).toBe(1)
    expect(s.stats.floorFaces).toBe(1)
  })

  test('only the surface of a liquid counts (the faces that point down, or sideways, are not drawn)', async () => {
    const quads = flatQuads([0])
    quads.planes[0] = { nx: 0, ny: 0, nz: -1, dist: 0 }
    const s = await extractSurfaces(memorySource(buildBsp({ ...quads, texinfoFlags: [SURF.WARP] })))
    expect(s.water).toEqual([])
    expect(s.floors).toEqual([])
    expect(s.stats.waterFaces).toBe(1)
  })
})

describe('materials that are never a surface (RFC 18, 4.1a)', () => {
  test('the rule: a sky picture, the geometry of a skybox and the helper materials; not buildings that have "sky" in the name', () => {
    for (const m of ['tools/toolsblack', 'tools/locked', 'skybox/park/streets', 'andrewpfjr/skyboxcustom/sunsky', 'cs_assault/assault_skybox_building01', 'water_skybox_-1280_10240_2416', 'sky']) {
      expect(isNotSurfaceMaterial(m)).toBe(true)
    }
    for (const m of ['', 'horizon2018/skyscraper_wallpaper06', 'building_template/building_skybridge_template001b', 'ttt/resort/skynetmountain', 'nature/blendgrass001', 'concrete/concretefloor001a', 'skyppy4/new/tile_floor01']) {
      expect(isNotSurfaceMaterial(m)).toBe(false)
    }
  })

  test('faces with such a material are left out and counted; the others are kept', async () => {
    const materials = ['tools/toolsblack', 'andrewpfjr/skyboxcustom/sunsky', 'horizon2018/skyscraper_wallpaper06', 'nature/blendgrass001']
    const s = await extractSurfaces(memorySource(buildBsp({ ...flatQuads([0, 10, 20, 30]), materials })))
    expect(s.stats.skippedByMaterial).toBe(2)
    expect(s.floors.length / 9).toBe(4) // the two kept quads, two triangles each
  })

  test('a map with no readable material names still reads: nothing is left out for want of a name', async () => {
    const s = await extractSurfaces(memorySource(buildBsp({ ...flatQuads([0, 10]) })))
    expect(s.stats.skippedByMaterial).toBe(0)
    expect(s.floors.length / 9).toBe(4)
  })

  test('a material name that points outside its lump is no name, and no reason to refuse the map', async () => {
    const s = await extractSurfaces(memorySource(buildBsp({ ...flatQuads([0]), materials: ['tools/x'], raw: { 44: Buffer.from([0xff, 0xff, 0xff, 0x7f]) } })))
    expect(s.stats.skippedByMaterial).toBe(0)
    expect(s.floors.length / 9).toBe(2)
  })
})

const fx = (model: number, at: Partial<Fixture> = {}): Fixture => ({ model, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, ...at })

describe('brush entities that stand still (RFC 18, 4.2)', () => {
  const entities = [
    '{ "classname" "worldspawn" }',
    '{ "classname" "func_brush" "model" "*1" }',
    '{ "classname" "func_door" "model" "*2" }',
    '{ "classname" "func_wall" "model" "*3" "parentname" "lift" }',
    '{ "classname" "func_breakable" "model" "*4" }',
    '{ "classname" "func_brush" "model" "not-a-model" }',
  ].join('\n')
  const spec = () => buildBsp({
    ...flatQuads([0, 10, 20, 30, 40]), entities,
    models: [{ firstFace: 0, numFaces: 1 }, { firstFace: 1, numFaces: 1 }, { firstFace: 2, numFaces: 1 }, { firstFace: 3, numFaces: 1 }, { firstFace: 4, numFaces: 1 }],
  })

  test('the entity lump names the models of the brushes, the fixed ones only: not doors, not anything with a parent', async () => {
    expect((await extractMapEntities(memorySource(spec()))).fixtureModels.map(f => f.model)).toEqual([1, 4])
  })

  test('their faces are drawn with the world; the others are counted and left out', async () => {
    const without = await extractSurfaces(memorySource(spec()))
    expect(without.floors.length / 9).toBe(2)
    expect(without.stats.otherModelFaces).toBe(4)
    const withThem = await extractSurfaces(memorySource(spec()), {}, [fx(1), fx(4)])
    expect(withThem.floors.length / 9).toBe(6)
    expect(withThem.stats.otherModelFaces).toBe(2)
    expect(withThem.stats.fixtureModels).toBe(2)
  })

  test('their faces are stored around their own origin: they are moved to where the entity stands, and turned by its angles', async () => {
    const at = await extractSurfaces(memorySource(spec()), {}, [fx(1)])
    const moved = await extractSurfaces(memorySource(spec()), {}, [fx(1, { x: 100, y: -20, z: 5 })])
    expect(moved.floors.length).toBe(at.floors.length)
    const [a, b] = [at.floors.slice(-9), moved.floors.slice(-9)]
    for (let i = 0; i < 9; i += 3) expect([b[i]! - a[i]!, b[i + 1]! - a[i + 1]!, b[i + 2]! - a[i + 2]!]).toEqual([100, -20, 5])
    // turned on its side (roll 90), a floor becomes a wall
    const turned = await extractSurfaces(memorySource(spec()), {}, [fx(1, { roll: 90 })])
    expect(turned.floors.length / 9).toBe(at.floors.length / 9 - 2) // the quad is two triangles
    expect(turned.walls.length / 9).toBe(at.walls.length / 9 + 2)
  })

  test('the entity lump gives origin and angles of a fixed brush, zero when it has none', async () => {
    const bsp = buildBsp({ ...flatQuads([0, 10]), entities: '{ "classname" "worldspawn" }\n{ "classname" "func_brush" "model" "*1" "origin" "10 20 30" "angles" "0 90 0" }\n{ "classname" "func_wall" "model" "*2" }', models: [{ firstFace: 0, numFaces: 1 }, { firstFace: 1, numFaces: 0 }, { firstFace: 1, numFaces: 0 }] })
    expect((await extractMapEntities(memorySource(bsp))).fixtureModels).toEqual([fx(1, { x: 10, y: 20, z: 30, yaw: 90 }), fx(2)])
  })

  test('angleMatrix turns by roll, then pitch, then yaw (yaw 90 sends X to Y)', () => {
    const r = angleMatrix(0, 90, 0)
    expect([r[0]!, r[3]!, r[6]!].map(n => Math.abs(Math.round(n)))).toEqual([0, 1, 0])
    expect(angleMatrix(0, 0, 0).map(n => n + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  test('a model number that does not exist is ignored; one that names faces that do not exist refuses the map', async () => {
    const ok = await extractSurfaces(memorySource(spec()), {}, [fx(1), fx(99), fx(-3), fx(1.5)])
    expect(ok.stats.fixtureModels).toBe(1)
    const broken = buildBsp({ ...flatQuads([0, 10]), models: [{ firstFace: 0, numFaces: 1 }, { firstFace: 1, numFaces: 50 }] })
    await expect(extractSurfaces(memorySource(broken), {}, [fx(1)])).rejects.toThrow('faces that do not exist')
  })
})
