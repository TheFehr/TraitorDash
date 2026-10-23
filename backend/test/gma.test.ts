import { expect, test, describe } from 'bun:test'
import { buildGma } from './helpers/bsp_builder'
import { memorySource } from '../src/services/bsp'
import { readGmaIndex, mapEntries, sliceSource } from '../src/services/gma'

// RFC 11, 3.2: the addon archive's file table is read, and a map inside it is read in place.

describe('readGmaIndex', () => {
  const gma = buildGma({ 'lua/a.lua': 'print(1)', 'maps/ttt_a.bsp': 'BSPDATA', 'materials/x.vmt': '' , 'Maps/TTT_B.BSP': 'XY' })

  test('lists every file with its place in the archive', async () => {
    const e = await readGmaIndex(memorySource(gma))
    expect(e.map(f => f.name)).toEqual(['lua/a.lua', 'maps/ttt_a.bsp', 'materials/x.vmt', 'Maps/TTT_B.BSP'])
    for (const f of e) expect(Buffer.from(gma.subarray(f.offset, f.offset + f.size)).toString()).toBe(
      ({ 'lua/a.lua': 'print(1)', 'maps/ttt_a.bsp': 'BSPDATA', 'materials/x.vmt': '', 'Maps/TTT_B.BSP': 'XY' } as Record<string, string>)[f.name]!)
  })

  test('mapEntries keeps only maps/<name>.bsp, by lower-case name', async () => {
    const m = mapEntries(await readGmaIndex(memorySource(gma)))
    expect(m.map(x => x.name)).toEqual(['ttt_a', 'ttt_b'])
  })

  test('names that are not plain map names are not maps', () => {
    const e = (name: string) => ({ name, offset: 0, size: 1 })
    expect(mapEntries([e('maps/sub/x.bsp'), e('maps/../x.bsp'), e('maps/a b.bsp'), e('maps/x.bsp.bz2'), e('maps/' + 'a'.repeat(65) + '.bsp')])).toEqual([])
  })

  test('an addon with a long description (some have pages of it) is read', async () => {
    const long = buildGma({ 'maps/ttt_a.bsp': 'BSPDATA' }, 'x'.repeat(5000))
    expect((await readGmaIndex(memorySource(long))).map(f => f.name)).toEqual(['maps/ttt_a.bsp'])
  })

  test('refuses what is not an archive, or is cut off, or lies about sizes', async () => {
    await expect(readGmaIndex(memorySource(Buffer.from('not an addon at all')))).rejects.toThrow('Not a readable addon archive')
    await expect(readGmaIndex(memorySource(gma.subarray(0, 30)))).rejects.toThrow('Not a readable addon archive')
    await expect(readGmaIndex(memorySource(gma.subarray(0, gma.length - 20)))).rejects.toThrow('past the end')
    await expect(readGmaIndex(memorySource(Buffer.alloc(0)))).rejects.toThrow('Not a readable')
  })

  test('a file table over the limit, and too many files, are refused', async () => {
    await expect(readGmaIndex(memorySource(gma), { maxTableBytes: 40 })).rejects.toThrow('cut off or too large')
    await expect(readGmaIndex(memorySource(gma), { maxFiles: 2 })).rejects.toThrow('too many files')
  })
})

describe('sliceSource', () => {
  const src = memorySource(Buffer.from('0123456789'))
  test('reads inside its range only', async () => {
    const s = sliceSource(src, 2, 5)
    expect(s.size).toBe(5)
    expect(Buffer.from(await s.read(0, 100)).toString()).toBe('23456')
    expect(Buffer.from(await s.read(3, 100)).toString()).toBe('56')
    expect((await s.read(5, 1)).length).toBe(0)
    expect((await s.read(-1, 1)).length).toBe(0)
  })
})
