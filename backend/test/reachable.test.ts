import { expect, test, describe } from 'bun:test'
import { CLIMB, DROP, NO_FLOOR, flatten, reachableCells, reachableStoreys, type TopDown } from '../src/maps/topdown'
import { listedStoreys } from '../src/services/killzones'
import { surfacesToGlb } from '../src/maps/meshGlb'

// RFC 21, 12: which storeys a player can get to. A storey is cut from the mesh by the heights of its floors; a plate under the map is one too.

const CELL = 32
/** A top-down map of `nx` by 1 cells whose storeys have the floor heights given for each cell (null: no floor). */
const map = (...layers: (number | null)[][]): TopDown => {
  const nx = layers[0]!.length
  return {
    cell: CELL, minx: 0, miny: 0, nx, ny: 1,
    layers: layers.map((zs, i) => ({ index: i + 1, lo: 0, hi: 0, cells: Uint8Array.from(zs.map(z => (z === null ? 0 : 1))), zs: Int16Array.from(zs.map(z => (z === null ? NO_FLOOR : z))) })),
  }
}
const at = (x: number, z: number) => ({ x: x * CELL + 10, y: 10, z })
const count = (top: TopDown, seeds: { x: number, y: number, z: number }[]) => reachableCells(top, seeds).map(c => c.reduce((a, v) => a + v, 0))

describe('what a player can reach', () => {
  test('a floor is reached from a spawn on it, across its cells, and a plate far under it is not', () => {
    const top = map([0, 0, 0, 0, 0, 0], [-1000, -1000, -1000, null, null, null])
    expect(count(top, [at(0, 0)])).toEqual([6, 0])
    expect(reachableStoreys(top, [at(0, 0)])).toEqual([1])
  })

  test('stairs between storeys: steps up of a jump or less, in one storey and the next', () => {
    const top = map([0, 0, 0, 40, null, null, null], [null, null, null, null, 80, 120, 160])
    expect(CLIMB + CELL).toBeGreaterThan(44)
    expect(count(top, [at(0, 0)])).toEqual([4, 3]) // 0 -> 40 -> 80 -> 120 -> 160, each step within a jump
    expect(reachableStoreys(top, [at(0, 0)])).toEqual([1, 2])
  })

  test('a cliff is not climbed, and a ledge too high to drop from keeps its own storey to itself', () => {
    const top = map([0, 0, 0, null, null, null], [null, null, null, 300, 300, 300])
    expect(reachableStoreys(top, [at(0, 0)])).toEqual([1]) // 300 up is not a jump
    expect(count(top, [at(4, 300)])).toEqual([0, 3]) // standing on the ledge: 300 down is more than a fall that is walked off
  })

  test('a drop that does not kill is walked off, one that does is not', () => {
    const ok = map([null, null, 200, 200], [0, 0, 0, 0])
    expect(DROP + CELL).toBeGreaterThan(200)
    expect(reachableStoreys(ok, [at(2, 200)])).toEqual([1, 2]) // 200 down: a short fall
    const deep = map([null, null, 500, 500], [0, 0, 0, 0])
    expect(reachableStoreys(deep, [at(2, 500)])).toEqual([1]) // 500 down: no one walks off that
  })

  test('a place a player died is a seed: a plate with a death on it is reachable, and what it leads to', () => {
    const top = map([0, 0, 0, 0], [-1000, -1000, -1000, -1000])
    expect(reachableStoreys(top, [at(0, 0)])).toEqual([1])
    expect(reachableStoreys(top, [at(0, 0), at(1, -1000)])).toEqual([1, 2])
  })

  test('a seed lands on the highest floor under it, in the air over a pit it is no seed, and outside the map it is ignored', () => {
    const top = map([0, 0, 0, 0], [-100, -100, -100, -100])
    expect(count(top, [at(1, 20)])).toEqual([4, 4]) // lands on 0; -100 is a drop of 100: reached
    expect(count(top, [at(1, 2000)])).toEqual([0, 0]) // 2,000 over the nearest floor
    expect(count(top, [{ x: -5000, y: 0, z: 0 }, { x: 5, y: 5000, z: 0 }, { x: 5, y: 5, z: Infinity }])).toEqual([0, 0])
    expect(count(top, [])).toEqual([0, 0])
  })

  test('a seed with no floor in its own cell takes the floor of a neighbour', () => {
    const top = map([null, 0, 0, 0])
    expect(count(top, [at(0, 0)])).toEqual([3])
  })

  test('the map\'s own spawn points come with the mesh', async () => {
    const floor = (z: number) => [0, 0, z, 256, 0, z, 256, 256, z, 0, 0, z, 256, 256, z, 0, 256, z]
    const { glb } = (await surfacesToGlb({ floors: [...floor(0), ...floor(-1000)], walls: [], spawns: [{ class: 'info_player_start', x: 100, y: 100, z: 5 }], fingerprint: 'ab'.repeat(32), version: 20, revision: 1 }, { map: 'ttt_a' }))!
    const top = (await flatten(glb))!
    expect(top.spawns).toEqual([{ x: 100, y: 100, z: 5 }])
    expect(top.layers).toHaveLength(2)
    expect(reachableStoreys(top, top.spawns!)).toEqual([top.layers.find(l => l.hi >= 0)!.index]) // the one with the spawn on it
    expect(listedStoreys(top, [])).toHaveLength(1)
    expect(listedStoreys(top, [{ x: 100, y: 100, z: -1000 }])).toHaveLength(2) // and the plate once someone has died on it
  })

  test('the list is kept until a death is added', () => {
    const top = map([0, 0], [-1000, -1000])
    expect(listedStoreys(top, [])).toEqual([])
    const a = listedStoreys(top, [at(0, 0)])
    expect(listedStoreys(top, [at(0, 0)])).toBe(a)
    expect(listedStoreys(top, [at(0, 0), at(1, -1000)])).toEqual([1, 2])
  })
})
