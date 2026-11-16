import { expect, test, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { extractSurfaces, extractMapEntities, memorySource, bspFingerprint, startPose, startsOpen, type Point, type ModelBox, type ByteSource } from '../src/maps/bsp'
import { asRecord } from '../src/maps/coverage'
import { buildGeometry } from '../src/services/mapgeometry'
import { buildBsp, flatQuads, LUMP } from './helpers/bsp_builder'
import { coverageMap } from './helpers/coverage_map'

// RFC 35, 7: where a door, a rotating door and a linear mover stand when the round starts. The keyvalues are written the way Hammer writes them (`spawnpos`, `movedir`,
// `lip`, `startposition`, `distance`, `spawnflags`, and `StartDisabled` with capitals); the extractor lower-cases the keys when it reads the entity lump (RFC 33, 9a).

const O: Point = { x: 100, y: 200, z: 300 }
const Z: [number, number, number] = [0, 0, 0]
/** The pool cover's box (x -697 to 505, y 1352 to 2231, z 40 to 66, around its origin -96 1791.5 53) and a box with three different sizes (100, 200, 300). */
const COVER: ModelBox = { mins: [-697, 1352, 40], maxs: [505, 2231, 66] }
const BOX: ModelBox = { mins: [0, 0, 0], maxs: [100, 200, 300] }
const pose = (cls: string, e: Record<string, string>, box: ModelBox | null = BOX, angles: [number, number, number] = Z) => startPose(cls, e, O, angles, box)
const near = (a: Point, x: number, y: number, z: number) => { expect(a.x).toBeCloseTo(x, 6); expect(a.y).toBeCloseTo(y, 6); expect(a.z).toBeCloseTo(z, 6) }
const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')

describe('startsOpen: spawnpos, and the first spawnflag for maps that have no spawnpos', () => {
  test('spawnpos 1 is open, 0 and nothing are closed', () => {
    expect(startsOpen({ spawnpos: '1' })).toBe(true)
    expect(startsOpen({ spawnpos: '1.0' })).toBe(true)
    expect(startsOpen({ spawnpos: '0' })).toBe(false)
    expect(startsOpen({})).toBe(false)
    expect(startsOpen({ spawnpos: '2' })).toBe(false)
  })
  test('without a spawnpos, the first bit of spawnflags says; other bits do not', () => {
    expect(startsOpen({ spawnflags: '1' })).toBe(true)
    expect(startsOpen({ spawnflags: '3' })).toBe(true)
    expect(startsOpen({ spawnflags: '2049' })).toBe(true) // 2048 (locked) + 1
    expect(startsOpen({ spawnflags: '2' })).toBe(false)
    expect(startsOpen({ spawnflags: '2048' })).toBe(false)
    expect(startsOpen({ spawnflags: '0' })).toBe(false)
    expect(startsOpen({ spawnflags: '-1' })).toBe(false) // not a flag word
    expect(startsOpen({ spawnflags: '1.5' })).toBe(false)
    expect(startsOpen({ spawnflags: 'one' })).toBe(false)
  })
  test('a spawnpos that is there rules; one that is not a number is as good as none', () => {
    expect(startsOpen({ spawnpos: '0', spawnflags: '1' })).toBe(false)
    expect(startsOpen({ spawnpos: '1', spawnflags: '0' })).toBe(true)
    expect(startsOpen({ spawnpos: 'abc', spawnflags: '1' })).toBe(true)
    expect(startsOpen({ spawnpos: '', spawnflags: '1' })).toBe(true)
    expect(startsOpen({ spawnpos: 'NaN', spawnflags: '0' })).toBe(false)
  })
})

describe('startPose of a func_door', () => {
  const door = (extra: Record<string, string>, box: ModelBox | null = BOX) => pose('func_door', { spawnpos: '1', ...extra }, box)

  test('a door that starts closed (spawnpos 0 or none) keeps the pose the map file stores, whatever its movedir', () => {
    for (const e of [{}, { spawnpos: '0' }, { spawnpos: '0', movedir: '0 0 0', lip: '-8' }, { movedir: '0 0 0' }, { spawnpos: '0', spawnflags: '1', movedir: '0 0 0' }] as Record<string, string>[]) {
      const p = pose('func_door', e)
      expect(p, JSON.stringify(e)).toEqual({ state: 'closed', origin: O, angles: Z })
    }
    // and a closed door with no movedir at all is closed, not left out
    expect(pose('func_door', {}).state).toBe('closed')
  })

  test('the pool cover: movedir 0 0 0 is east, 1 202 wide with a lip of -8 moves 1 210 units', () => {
    const p = startPose('func_door', { spawnpos: '1', spawnflags: '0', movedir: '0 0 0', lip: '-8', speed: '120' }, { x: -96, y: 1791.5, z: 53 }, Z, COVER)
    expect(p.state).toBe('open')
    near(p.origin, -96 + 1210, 1791.5, 53)
  })

  test('the bathroom doors: movedir 90 0 0 is down by the height of the door', () => {
    const p = door({ movedir: '90 0 0' }, { mins: [0, 0, 0], maxs: [10, 8, 128] })
    near(p.origin, 100, 200, 300 - 128)
  })

  test('east, west, north, south, up and down each use the size along their own axis (the box is 100 by 200 by 300)', () => {
    near(door({ movedir: '0 0 0' }).origin, 100 + 100, 200, 300) // east: +x by the x size
    near(door({ movedir: '0 180 0' }).origin, 100 - 100, 200, 300) // west
    near(door({ movedir: '0 90 0' }).origin, 100, 200 + 200, 300) // north: +y by the y size
    near(door({ movedir: '0 270 0' }).origin, 100, 200 - 200, 300) // south
    near(door({ movedir: '-90 0 0' }).origin, 100, 200, 300 + 300) // up: pitch -90
    near(door({ movedir: '90 0 0' }).origin, 100, 200, 300 - 300) // down: pitch +90
  })

  test('an oblique movedir: the unit vector times the extent along it (sum of the sizes it reaches into)', () => {
    const s = Math.SQRT1_2
    // pitch -45 yaw 0: direction (cos45, 0, sin45); travel = |s * 100| + |s * 300|
    const travel = s * 100 + s * 300
    near(door({ movedir: '-45 0 0' }).origin, 100 + s * travel, 200, 300 + s * travel)
    // yaw 45: (s, s, 0); travel = s * 100 + s * 200
    const t2 = s * 100 + s * 200
    near(door({ movedir: '0 45 0' }).origin, 100 + s * t2, 200 + s * t2, 300)
  })

  test('the lip is taken off the travel; a negative lip adds to it; a lip of 0 or none is the full size', () => {
    near(door({ movedir: '0 0 0', lip: '8' }).origin, 100 + 92, 200, 300)
    near(door({ movedir: '0 0 0', lip: '-8' }).origin, 100 + 108, 200, 300)
    near(door({ movedir: '0 0 0', lip: '0' }).origin, 100 + 100, 200, 300)
    near(door({ movedir: '0 0 0' }).origin, 100 + 100, 200, 300)
    near(door({ movedir: '0 0 0', lip: '' }).origin, 100 + 100, 200, 300)
    near(door({ movedir: '0 0 0', lip: '100' }).origin, 100, 200, 300) // the lip eats the whole size: it does not move
  })

  test('the starting place is added to the door\'s own origin, and the angles are untouched', () => {
    const p = startPose('func_door', { spawnpos: '1', movedir: '0 0 0' }, { x: -5, y: 6, z: 7 }, [1, 2, 3], BOX)
    near(p.origin, 95, 6, 7); expect(p.angles).toEqual([1, 2, 3])
  })

  test('spawnflags bit 1 starts it open when there is no spawnpos (older maps), and spawnpos 0 wins over it', () => {
    near(pose('func_door', { spawnflags: '1', movedir: '0 0 0' }).origin, 200, 200, 300)
    near(pose('func_door', { spawnflags: '2049', movedir: '0 0 0' }).origin, 200, 200, 300)
    expect(pose('func_door', { spawnflags: '2048', movedir: '0 0 0' }).state).toBe('closed')
    expect(pose('func_door', { spawnflags: '1', spawnpos: '0', movedir: '0 0 0' }).state).toBe('closed')
  })

  test('a door that starts open and cannot be placed is left out, not drawn closed', () => {
    for (const e of [{}, { movedir: '' }, { movedir: '0 0' }, { movedir: '0 0 0 0' }, { movedir: 'a b c' }, { movedir: '0 NaN 0' }, { movedir: '0 0 Infinity' }, { movedir: 'up' }] as Record<string, string>[]) {
      const p = door(e)
      expect(p.state, JSON.stringify(e)).toBe('leftOut')
    }
    expect(door({ movedir: '0 0 0' }, null).state).toBe('leftOut') // no box
    expect(door({ movedir: '0 0 0', lip: 'wide' }).state).toBe('leftOut')
    expect(door({ movedir: '0 0 0', lip: 'Infinity' }).state).toBe('leftOut')
    expect(door({ movedir: '0 0 0', lip: '99999' }).state).toBe('leftOut')
    expect(door({ movedir: '0 0 0', lip: '-99999' }).state).toBe('leftOut')
    expect(door({ movedir: '0 0 0', lip: '101' }).state).toBe('leftOut') // a travel below zero
    expect(door({ movedir: '0 0 0' }, { mins: [0, 0, 0], maxs: [Infinity, 1, 1] }).state).toBe('leftOut')
    expect(door({ movedir: '0 0 0' }, { mins: [10, 0, 0], maxs: [0, 1, 1] }).state).toBe('leftOut') // maxs below mins
    expect(door({ movedir: '0 0 0' }, { mins: [-1e9, 0, 0], maxs: [1e9, 1, 1] }).state).toBe('leftOut') // not a size any map has
    // a left-out part keeps its stored pose in the result (nothing uses it)
    expect(door({}).origin).toEqual(O)
  })

  test('movedir may be spaced out, and its numbers may be decimals', () => {
    near(door({ movedir: '  0   90 0 ' }).origin, 100, 400, 300)
    near(door({ movedir: '0.0 90.0 0.0' }).origin, 100, 400, 300)
  })

  test('other classes are never moved by a start state: a button, a train or a rotating part with spawnpos 1 keeps its pose', () => {
    for (const cls of ['func_button', 'func_tracktrain', 'func_rotating', 'func_brush', 'func_physbox', 'func_water_analog']) {
      expect(pose(cls, { spawnpos: '1', movedir: '0 0 0', spawnflags: '1', startposition: '1', movedistance: '100' }), cls).toEqual({ state: 'closed', origin: O, angles: Z })
    }
  })
})

describe('startPose of a func_movelinear', () => {
  const lin = (extra: Record<string, string>) => pose('func_movelinear', { movedir: '-90 0 0', movedistance: '200', ...extra })

  test('startposition 0, none, or not a number is closed', () => {
    for (const e of [{}, { startposition: '0' }, { startposition: 'x' }, { startposition: '' }, { startposition: '-1' }, { startposition: 'NaN' }] as Record<string, string>[]) expect(lin(e).state, JSON.stringify(e)).toBe('closed')
    expect(lin({ startposition: '0' }).origin).toEqual(O)
  })
  test('startposition 0.5 and 1 move it that fraction of movedistance along movedir; more than 1 counts as 1', () => {
    const p = lin({ startposition: '0.5' })
    expect(p.state).toBe('open'); expect(p.linear).toBe(true)
    near(p.origin, 100, 200, 300 + 100)
    near(lin({ startposition: '1' }).origin, 100, 200, 500)
    near(lin({ startposition: '7' }).origin, 100, 200, 500)
    near(pose('func_movelinear', { startposition: '1', movedistance: '50', movedir: '0 90 0' }).origin, 100, 250, 300) // north
    near(pose('func_movelinear', { startposition: '1', movedistance: '50', movedir: '90 0 0' }).origin, 100, 200, 250) // down
  })
  test('the box is not needed, and a start position with no usable movedir is left out', () => {
    expect(pose('func_movelinear', { startposition: '1', movedistance: '50', movedir: '0 0 0' }, null).state).toBe('open')
    for (const movedir of [undefined, '', 'a b c', '1 2']) {
      const e: Record<string, string> = { startposition: '1', movedistance: '50' }
      if (movedir !== undefined) e['movedir'] = movedir
      expect(pose('func_movelinear', e).state, String(movedir)).toBe('leftOut')
    }
    // closed with no movedir stays closed
    expect(pose('func_movelinear', { startposition: '0', movedistance: '50' }).state).toBe('closed')
  })
  test('spawnpos and spawnflags mean nothing to it', () => {
    expect(lin({ spawnpos: '1', spawnflags: '1' }).state).toBe('closed')
  })
})

describe('startPose of a func_door_rotating', () => {
  const rot = (extra: Record<string, string>, angles: [number, number, number] = Z) => pose('func_door_rotating', { spawnpos: '1', ...extra }, BOX, angles)

  test('it turns by distance degrees (90 by default) about Z, the yaw, and keeps its origin', () => {
    expect(rot({})).toEqual({ state: 'open', origin: O, angles: [0, 90, 0] })
    expect(rot({ distance: '120' }).angles).toEqual([0, 120, 0])
    expect(rot({ distance: '' }).angles).toEqual([0, 90, 0])
    expect(rot({ distance: '-30' }).angles).toEqual([0, -30, 0])
  })
  test('it is added to the angles the entity has', () => {
    expect(rot({ distance: '90' }, [0, 45, 0]).angles).toEqual([0, 135, 0])
    expect(rot({ distance: '90' }, [5, 270, 7]).angles).toEqual([5, 360, 7])
  })
  test('spawnflags 64 is the X axis (roll), 128 the Y axis (pitch), bit 2 reverses it; the other bits do not matter', () => {
    expect(rot({ spawnflags: '64' }).angles).toEqual([0, 0, 90])
    expect(rot({ spawnflags: '128' }).angles).toEqual([90, 0, 0])
    expect(rot({ spawnflags: '2' }).angles).toEqual([0, -90, 0])
    expect(rot({ spawnflags: '66' }).angles).toEqual([0, 0, -90])
    expect(rot({ spawnflags: '130', distance: '45' }).angles).toEqual([-45, 0, 0])
    expect(rot({ spawnflags: '192' }).angles).toEqual([0, 0, 90]) // both: X wins, as in the game
    expect(rot({ spawnflags: '1' }).angles).toEqual([0, 90, 0]) // the open bit itself
    expect(rot({ spawnflags: '2048' }).angles).toEqual([0, 90, 0])
  })
  test('it starts open by spawnpos or by the first spawnflag; closed otherwise', () => {
    expect(pose('func_door_rotating', { spawnflags: '1' }).angles).toEqual([0, 90, 0])
    expect(pose('func_door_rotating', { spawnflags: '65' }).angles).toEqual([0, 0, 90]) // open and X
    expect(pose('func_door_rotating', { spawnpos: '0', spawnflags: '64' })).toEqual({ state: 'closed', origin: O, angles: Z })
    expect(pose('func_door_rotating', {})).toEqual({ state: 'closed', origin: O, angles: Z })
  })
  test('a distance that is not a number, or not a turn, leaves it out; it needs neither movedir nor a box', () => {
    for (const distance of ['abc', 'NaN', 'Infinity', '99999', '-99999']) expect(rot({ distance }).state, distance).toBe('leftOut')
    expect(rot({}).state).toBe('open')
    expect(pose('func_door_rotating', { spawnpos: '1' }, null).state).toBe('open')
  })
})

// ---- the extractor, on constructed maps -----------------------------------------------------------

interface M { faces: number, mins?: [number, number, number], maxs?: [number, number, number] }
/** A map: the world's floor (face 0) and the models given, a face each (the quad of face i is at x i * 100 to i * 100 + 64, y 0 to 64, z of its height); the entities are the text. */
function map(models: M[], entities: string[], raw?: NonNullable<Parameters<typeof buildBsp>[0]>['raw']): Buffer {
  const total = models.reduce((n, m) => n + m.faces, 0)
  const quads = flatQuads([0, ...Array.from({ length: total }, (_, i) => 100 + i * 10)])
  let first = 1
  return buildBsp({
    ...quads, entities: ['{ "classname" "worldspawn" }', ...entities].join('\n'), raw,
    models: [{ firstFace: 0, numFaces: 1 }, ...models.map(m => { const r = { firstFace: first, numFaces: m.faces, mins: m.mins, maxs: m.maxs }; first += m.faces; return r })],
  })
}
const door = (cls: string, model: number, extra: string) => `{ "classname" "${cls}" "model" "*${model}" ${extra} }`
const read = async (file: Buffer) => {
  const src = memorySource(file)
  const ents = await extractMapEntities(src)
  return { ents, s: await extractSurfaces(src, {}, ents.fixtureModels) }
}
const xs = (a: number[]) => a.filter((_, i) => i % 3 === 0)

describe('the extractor: the pool cover pattern, with the keys as Hammer writes them', () => {
  const cover = door('func_door', 1, '"origin" "-96 1791.5 53" "targetname" "pool cover" "spawnpos" "1" "spawnflags" "0" "movedir" "0 0 0" "lip" "-8" "speed" "120" "forceclosed" "1"')
  const box: M = { faces: 1, mins: [-697, 1352, 40], maxs: [505, 2231, 66] }

  test('the part lands 1 210 units east of its origin, and its triangles with it', async () => {
    const { ents, s } = await read(map([box], [cover]))
    expect(ents.fixtureModels).toEqual([{ model: 1, x: -96 + 1210, y: 1791.5, z: 53, pitch: 0, yaw: 0, roll: 0, movable: true, class: 'func_door', name: 'pool cover' }])
    expect(s.movableParts).toHaveLength(1)
    expect(s.movableParts[0]).toMatchObject({ x: 1114, y: 1791.5, z: 53, name: 'pool cover' })
    // the quad is at x 100 to 164 around the origin, so placed at 1114 + 100
    expect(Math.min(...xs(s.movable))).toBe(Math.round(1114 + 100))
    expect(Math.max(...xs(s.movable))).toBe(Math.round(1114 + 164))
    expect(ents.census.startStates).toMatchObject({ closed: 0, openPlaced: 1, openLeftOut: 0, startPositioned: 0 })
  })

  test('the same door with spawnpos 0 is where the map file puts it, as before', async () => {
    const { ents, s } = await read(map([box], [cover.replace('"spawnpos" "1"', '"spawnpos" "0"')]))
    expect(ents.fixtureModels[0]).toMatchObject({ x: -96, y: 1791.5, z: 53 })
    expect(Math.min(...xs(s.movable))).toBe(-96 + 100)
    expect(ents.census.startStates).toMatchObject({ closed: 1, openPlaced: 0, openLeftOut: 0 })
  })

  test('keys are read in any case: SpawnPos, MoveDir, Lip, SpawnFlags', async () => {
    const odd = door('func_door', 1, '"origin" "0 0 0" "SpawnPos" "1" "MoveDir" "0 90 0" "Lip" "-8" "SpawnFlags" "0"')
    const { ents } = await read(map([box], [odd]))
    expect(ents.fixtureModels[0]).toMatchObject({ x: 0, y: 879 + 8, z: 0 }) // north by the y size (2231 - 1352 = 879) and the lip
    const flag = door('func_door', 1, '"origin" "0 0 0" "SpawnFlags" "1" "MoveDir" "0 0 0"')
    expect((await read(map([box], [flag]))).ents.fixtureModels[0]).toMatchObject({ x: 1202 })
  })

  test('the pool\'s bathroom doors: movedir 90 0 0 sinks the door by its height', async () => {
    const d = door('func_door', 1, '"origin" "50 60 200" "spawnpos" "1" "movedir" "90 0 0" "lip" "0" "targetname" "door 1"')
    const { ents } = await read(map([{ faces: 1, mins: [0, 0, 144], maxs: [8, 96, 272] }], [d]))
    expect(ents.fixtureModels[0]).toMatchObject({ x: 50, y: 60, z: 200 - 128 })
  })
})

describe('the extractor: a part that starts open and cannot be placed is left out, and counted', () => {
  const box: M = { faces: 1, mins: [0, 0, 0], maxs: [100, 20, 50] }

  test('no movedir: not in the fixtures, not drawn, not in the movable list or its parts, its face counted as another model\'s', async () => {
    const file = map([box, box], [door('func_door', 1, '"spawnpos" "1" "targetname" "gone"'), door('func_door', 2, '"spawnpos" "0" "movedir" "0 0 0" "targetname" "here"')])
    const { ents, s } = await read(file)
    expect(ents.fixtureModels.map(f => f.model)).toEqual([2])
    expect(s.movableParts.map(p => p.name)).toEqual(['here'])
    expect(s.movable.length / 9).toBe(2) // the one quad of 'here'
    expect(s.stats.otherModelFaces).toBe(1)
    expect(ents.census.startStates).toMatchObject({ closed: 1, openPlaced: 0, openLeftOut: 1, byClass: { func_door: { closed: 1, openPlaced: 0, openLeftOut: 1 } } })
    // the census of brush entities still lists it (the coverage record counts faces of everything)
    expect(ents.census.brush.map(b => b.model)).toEqual([1, 2])
  })

  test('a map whose models lump cannot be read: a door that starts open is left out, a rotating one is placed (it needs no box)', async () => {
    const entities = [door('func_door', 1, '"spawnpos" "1" "movedir" "0 0 0"'), door('func_door_rotating', 2, '"spawnpos" "1"')]
    const file = map([box, box], entities, { [LUMP.MODELS]: Buffer.alloc(0) })
    const ents = await extractMapEntities(memorySource(file))
    expect(ents.fixtureModels.map(f => [f.class, f.yaw])).toEqual([['func_door_rotating', 90]])
    expect(ents.census.startStates).toMatchObject({ openPlaced: 1, openLeftOut: 1 })
  })

  test('a model number the models lump does not have: left out', async () => {
    const file = map([box], [door('func_door', 7, '"spawnpos" "1" "movedir" "0 0 0"')])
    const ents = await extractMapEntities(memorySource(file))
    expect(ents.fixtureModels).toEqual([])
    expect(ents.census.startStates!.openLeftOut).toBe(1)
  })

  test('a hidden door (StartDisabled) or one with a parent is not drawn and not counted as a start state', async () => {
    const file = map([box, box, box], [
      door('func_door', 1, '"spawnpos" "1" "movedir" "0 0 0" "StartDisabled" "1"'),
      door('func_door', 2, '"spawnpos" "1" "movedir" "0 0 0" "parentname" "lift"'),
      door('func_door', 3, '"spawnpos" "1" "movedir" "0 0 0" "rendermode" "10"'),
    ])
    const ents = await extractMapEntities(memorySource(file))
    expect(ents.fixtureModels).toEqual([])
    expect(ents.census.startStates).toMatchObject({ closed: 0, openPlaced: 0, openLeftOut: 0 })
  })
})

describe('the extractor: rotating doors and linear movers', () => {
  const box: M = { faces: 1, mins: [0, 0, 0], maxs: [10, 10, 10] }

  test('a rotating door that starts open is drawn turned: its angles are the start pose, and its faces go through them', async () => {
    const file = map([box], [door('func_door_rotating', 1, '"origin" "1000 0 0" "spawnpos" "1" "distance" "90" "targetname" "t stall"')])
    const { ents, s } = await read(file)
    expect(ents.fixtureModels[0]).toMatchObject({ x: 1000, yaw: 90, pitch: 0, roll: 0 })
    expect(s.movableParts[0]).toMatchObject({ yaw: 90, x: 1000 })
    // the quad at x 100 to 164, y 0 to 64 turned by 90 degrees about z: x becomes -y, y becomes x
    const ys = s.movable.filter((_, i) => i % 3 === 1)
    expect(Math.min(...ys)).toBe(100); expect(Math.max(...ys)).toBe(164)
    expect(Math.max(...xs(s.movable))).toBe(1000) // y 0 to 64 turns to x -64 to 0, from the origin 1000: 936 to 1000
    expect(Math.min(...xs(s.movable))).toBe(936)
    expect(ents.census.startStates).toMatchObject({ openPlaced: 1, byClass: { func_door_rotating: { openPlaced: 1 } } })
  })

  test('a linear mover with startposition above 0 is placed and counted as such; at 0 it is closed', async () => {
    const mover = (n: number, pos: string) => door('func_movelinear', n, `"origin" "0 0 0" "startposition" "${pos}" "movedistance" "200" "movedir" "-90 0 0"`)
    const file = map([box, box, box], [mover(1, '0.5'), mover(2, '0'), mover(3, '1')])
    const { ents } = await read(file)
    expect(ents.fixtureModels.map(f => f.z)).toEqual([100, 0, 200])
    expect(ents.census.startStates).toMatchObject({ closed: 1, openPlaced: 2, openLeftOut: 0, startPositioned: 2 })
  })

  test('a linear mover with a start position and no movedir is left out', async () => {
    const file = map([box], [door('func_movelinear', 1, '"startposition" "0.5" "movedistance" "200"')])
    const ents = await extractMapEntities(memorySource(file))
    expect(ents.fixtureModels).toEqual([])
    expect(ents.census.startStates).toMatchObject({ openLeftOut: 1, startPositioned: 0 })
  })
})

describe('the models lump is read only for a map that has a func_door', () => {
  const counting = (buf: Buffer): ByteSource & { reads: [number, number][] } => { const reads: [number, number][] = []; return { size: buf.length, reads, async read(o, l) { reads.push([o, l]); return buf.subarray(o, o + l) } } }
  test('without one the reads are the header and the entity lump, as before; with one, the models lump as well', async () => {
    const without = counting(map([{ faces: 1 }], [door('func_door_rotating', 1, '"spawnpos" "1"')]))
    await extractMapEntities(without)
    expect(without.reads).toHaveLength(2)
    const withDoor = counting(map([{ faces: 1 }], [door('func_door', 1, '"spawnpos" "0"')]))
    await extractMapEntities(withDoor)
    expect(withDoor.reads).toHaveLength(3)
  })
})

describe('a map with no part that starts open is the bytes it was', () => {
  test('the coverage map (a closed func_door among its entities; its GLB is pinned in coverage.test.ts) counts its door as closed', async () => {
    const file = coverageMap()
    const fp = bspFingerprint(file.subarray(0, 1036), file.length)
    const r = await buildGeometry(memorySource(file), 'ttt_cov', fp)
    if (!r.ok) throw new Error(r.error)
    expect(r.info.coverage!.startStates).toMatchObject({ closed: 1, openPlaced: 0, openLeftOut: 0, startPositioned: 0, byClass: { func_door: { closed: 1, openPlaced: 0, openLeftOut: 0 } } })
  })

  test('spelling out spawnpos 0 or a movedir on a closed door changes no byte', async () => {
    const a = map([{ faces: 1, maxs: [10, 10, 10] }], [door('func_door', 1, '"origin" "5 5 5"')])
    const b = map([{ faces: 1, maxs: [10, 10, 10] }], [door('func_door', 1, '"origin" "5 5 5" "spawnpos" "0" "movedir" "0 0 0" "lip" "8" "spawnflags" "0"')])
    // the header (and so the fingerprint the file carries) differs with the entity text: the surfaces, which the mesh is made of, are what is compared
    const surfaces = async (f: Buffer) => { const src = memorySource(f); const ents = await extractMapEntities(src); const { fingerprint, ...rest } = await extractSurfaces(src, {}, ents.fixtureModels); return sha(JSON.stringify(rest)) }
    expect(await surfaces(a)).toBe(await surfaces(b))
    expect((await extractMapEntities(memorySource(b))).fixtureModels).toEqual((await extractMapEntities(memorySource(a))).fixtureModels)
  })

  test('an open door is a different mesh from a closed one, and a left-out door has no part at all', async () => {
    const glb = async (extra: string) => {
      const f = map([{ faces: 1, maxs: [10, 10, 10] }], [door('func_door', 1, `"origin" "5 5 5" ${extra}`)])
      const r = await buildGeometry(memorySource(f), 'm', bspFingerprint(f.subarray(0, 1036), f.length)); if (!r.ok) throw new Error(r.error); return r
    }
    const closed = await glb(''), open = await glb('"spawnpos" "1" "movedir" "0 0 0"'), gone = await glb('"spawnpos" "1"')
    expect(sha(closed.glb)).not.toBe(sha(open.glb))
    expect(closed.info.movable).toBe(2); expect(open.info.movable).toBe(2); expect(gone.info.movable).toBe(0)
    expect(gone.info.coverage!.startStates).toMatchObject({ openLeftOut: 1 })
  })
})

describe('the record carries the counts, and an old record loads', () => {
  const rec = async () => {
    const entities = [door('func_door', 1, '"spawnpos" "1" "movedir" "0 0 0"'), door('func_door', 2, '"spawnpos" "1"'), door('func_door', 3, ''), door('func_door_rotating', 4, '"spawnflags" "1"'), door('func_movelinear', 5, '"startposition" "1" "movedir" "0 0 0" "movedistance" "10"'), door('func_movelinear', 6, '')]
    const f = map(Array.from({ length: 6 }, () => ({ faces: 1, maxs: [10, 10, 10] as [number, number, number] })), entities)
    const r = await buildGeometry(memorySource(f), 'm', bspFingerprint(f.subarray(0, 1036), f.length))
    if (!r.ok) throw new Error(r.error)
    return r.info.coverage!
  }
  test('closed, open placed, open left out, and the linear movers with a start position, by class and in all', async () => {
    const r = await rec()
    expect(r.startStates).toEqual({
      closed: 2, openPlaced: 3, openLeftOut: 1, startPositioned: 1,
      byClass: { func_door: { closed: 1, openPlaced: 1, openLeftOut: 1 }, func_door_rotating: { closed: 0, openPlaced: 1, openLeftOut: 0 }, func_movelinear: { closed: 1, openPlaced: 1, openLeftOut: 0 } },
    })
  })
  test('it survives the JSON the store keeps, and a record from before RFC 35 (none) loads without it', async () => {
    const r = await rec()
    expect(asRecord(JSON.parse(JSON.stringify(r)))!.startStates).toEqual(r.startStates)
    const old = JSON.parse(JSON.stringify(r)); delete old.startStates
    const loaded = asRecord(old)!
    expect(loaded).not.toBeNull(); expect('startStates' in loaded).toBe(false)
  })
  test('a damaged startStates is dropped, the rest of the record is kept', async () => {
    const r = JSON.parse(JSON.stringify(await rec()))
    for (const bad of ['x', { closed: -1, openPlaced: 0, openLeftOut: 0, startPositioned: 0, byClass: {} }, { closed: 1, openPlaced: 0, openLeftOut: 0, startPositioned: 0 }, { closed: 1, openPlaced: 0, openLeftOut: 0, startPositioned: 0, byClass: { a: { closed: 'x' } } }, { closed: 1, openPlaced: 'n', openLeftOut: 0, startPositioned: 0, byClass: {} }]) {
      const loaded = asRecord({ ...r, startStates: bad })
      expect(loaded, JSON.stringify(bad)).not.toBeNull()
      expect('startStates' in loaded!, JSON.stringify(bad)).toBe(false)
    }
  })
})
