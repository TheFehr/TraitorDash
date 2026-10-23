import { expect, test, describe } from 'bun:test'
import { readHeader, memorySource, extractMapEntities, BspError } from '../src/maps/bsp'
import { readStaticProps } from '../src/maps/props'
import { buildBsp, flatQuad, LUMP } from './helpers/bsp_builder'

// RFC 18, 4.3: where the models of a map stand, from the game lump (static props) and from the entity lump.

const read = async (spec: Parameters<typeof buildBsp>[0]) => {
  const src = memorySource(buildBsp({ ...flatQuad(0), ...spec }))
  return readStaticProps(src, await readHeader(src))
}
const MODELS = ['models/props/House1.mdl', 'models/props/tree.mdl']

describe('static props', () => {
  test('give the model, the place and the angles of each, with the model path in lower case', async () => {
    const r = await read({ staticProps: { models: MODELS, props: [{ model: 0, x: 10, y: 20, z: 30, pitch: 1, yaw: 90, roll: 3 }, { model: 1, x: -5, y: 6, z: 7 }] } })
    expect(r.skipped).toBe(0)
    expect(r.placements).toEqual([
      { model: 'models/props/house1.mdl', x: 10, y: 20, z: 30, pitch: 1, yaw: 90, roll: 3 },
      { model: 'models/props/tree.mdl', x: -5, y: 6, z: 7, pitch: 0, yaw: 0, roll: 0 },
    ])
  })

  test('the record size is taken from the data, so other versions of the record read the same fields', async () => {
    for (const stride of [56, 60, 64, 72, 76]) {
      const r = await read({ staticProps: { stride, models: MODELS, props: [{ model: 1, x: 1, y: 2, z: 3 }, { model: 0, x: 4, y: 5, z: 6 }] } })
      expect(r.placements.map(p => p.x)).toEqual([1, 4])
    }
  })

  test('a map with no static props, or no game lump, gives none', async () => {
    expect((await read({})).placements).toEqual([])
    expect((await read({ staticProps: { models: [], props: [] } })).placements).toEqual([])
  })

  test('a record that names a model that is not in the table, or stands at an impossible place, is skipped and counted', async () => {
    const r = await read({ staticProps: { models: MODELS, props: [{ model: 0, x: 1, y: 2, z: 3 }, { model: 9, x: 1, y: 2, z: 3 }, { model: 1, x: 1e9, y: 0, z: 0 }, { model: 1, x: NaN, y: 0, z: 0 }] } })
    expect(r.placements).toHaveLength(1)
    expect(r.skipped).toBe(3)
  })

  test('a table entry that is not a model path is skipped', async () => {
    const r = await read({ staticProps: { models: ['not-a-model', 'models/ok.mdl'], props: [{ model: 0, x: 0, y: 0, z: 0 }, { model: 1, x: 0, y: 0, z: 0 }] } })
    expect(r.placements.map(p => p.model)).toEqual(['models/ok.mdl'])
    expect(r.skipped).toBe(1)
  })

  test('a lump that does not add up is refused whole: a directory that does not fit, records that are not whole, a lump outside the file', async () => {
    const dirTooBig = Buffer.alloc(8); dirTooBig.writeInt32LE(1000, 0)
    await expect(read({ raw: { [LUMP.GAME_LUMP]: dirTooBig } })).rejects.toBeInstanceOf(BspError)
    const stray = { models: MODELS, props: [{ model: 0, x: 0, y: 0, z: 0 }, { model: 0, x: 0, y: 0, z: 0 }], strayBytes: 3 }
    await expect(read({ staticProps: stray })).rejects.toThrow('whole number of bytes')
    const outside = Buffer.alloc(4 + 16); outside.writeInt32LE(1, 0); outside.write('prps', 4, 'latin1'); outside.writeInt32LE(0x7fffff00, 12); outside.writeInt32LE(100, 16)
    await expect(read({ raw: { [LUMP.GAME_LUMP]: outside } })).rejects.toThrow('outside the file')
  })

  test('more props than are read is refused, whatever the lump holds', async () => {
    await expect(read({ staticProps: { models: MODELS, props: [{ model: 0, x: 0, y: 0, z: 0 }], declaredProps: 5_000_000 } })).rejects.toThrow(/more than is read/)
  })
})

describe('entity props', () => {
  const ents = (...blocks: string[]) => blocks.map(b => `{ ${b} }`).join('\n')
  const read2 = async (text: string) => (await extractMapEntities(memorySource(buildBsp({ ...flatQuad(0), entities: text })))).entityProps

  test('prop_dynamic, prop_physics and the like with a model give a placement; the class and the model path are checked', async () => {
    const p = await read2(ents(
      '"classname" "worldspawn"',
      '"classname" "prop_dynamic" "model" "models/Props/Crate.mdl" "origin" "1 2 3" "angles" "0 90 0"',
      '"classname" "prop_physics_multiplayer" "model" "models/barrel.mdl" "origin" "4 5 6"',
      '"classname" "prop_door_rotating" "model" "models/door.mdl" "origin" "7 8 9"',
      '"classname" "prop_dynamic" "model" "sprites/glow.vmt" "origin" "1 1 1"',
      '"classname" "prop_dynamic" "model" "models/nowhere.mdl"',
    ))
    expect(p).toEqual([
      { model: 'models/props/crate.mdl', x: 1, y: 2, z: 3, pitch: 0, yaw: 90, roll: 0 },
      { model: 'models/barrel.mdl', x: 4, y: 5, z: 6, pitch: 0, yaw: 0, roll: 0 },
    ])
  })

  test('angles that are not numbers are zero', async () => {
    const p = await read2(ents('"classname" "prop_dynamic" "model" "models/a.mdl" "origin" "0 0 0" "angles" "x y"'))
    expect(p[0]).toMatchObject({ pitch: 0, yaw: 0, roll: 0 })
  })
})
