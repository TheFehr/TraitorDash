import { expect, test, describe } from 'bun:test'
import { readHeader, memorySource, BspError } from '../src/maps/bsp'
import { readPak, readPakMember } from '../src/maps/pak'
import { buildBsp, flatQuad, LUMP } from './helpers/bsp_builder'
import { buildZip } from './helpers/model_builder'

// RFC 18, 4.3: the ZIP a map carries is read by its directory, member by member, and never trusted.

const open = async (pak: Buffer) => {
  const src = memorySource(buildBsp({ ...flatQuad(0), pak }))
  const header = await readHeader(src)
  return { src, header, pak: await readPak(src, header.lumps[LUMP.PAKFILE]!) }
}

describe('the directory', () => {
  test('lists the members, in lower case, with / for the separator', async () => {
    const { pak } = await open(buildZip({ 'Models\\Props\\A.mdl': 'x', 'materials/b.vmt': 'y' }))
    expect([...pak.entries.keys()].sort()).toEqual(['materials/b.vmt', 'models/props/a.mdl'])
  })

  test('a map without a pack, a pack that is not a ZIP, and a compressed lump give an empty directory, not an error', async () => {
    expect((await open(Buffer.alloc(0))).pak.entries.size).toBe(0)
    expect((await open(Buffer.from('not a zip at all, just some bytes that are long enough'))).pak.entries.size).toBe(0)
    const src = memorySource(buildBsp({ ...flatQuad(0), pak: buildZip({ 'a.txt': 'x' }), compressed: [LUMP.PAKFILE] }))
    const header = await readHeader(src)
    expect((await readPak(src, header.lumps[LUMP.PAKFILE]!)).entries.size).toBe(0)
  })

  test('members that cannot be read (encrypted, a method that is not stored or deflated) and directories are left out', async () => {
    const zip = buildZip({ 'a.txt': 'x', 'b.txt': 'y', 'c/': '' })
    // method 12 (bzip2) for b.txt, in the central directory
    const at = zip.indexOf(Buffer.from('b.txt', 'latin1'), zip.indexOf(Buffer.from([0x50, 0x4b, 1, 2])))
    zip.writeUInt16LE(12, at - 46 + 10)
    const { pak } = await open(zip)
    expect([...pak.entries.keys()]).toEqual(['a.txt'])
  })

  test('a directory that points outside the pack, or a Zip64 marker, gives an empty one', async () => {
    const zip = buildZip({ 'a.txt': 'x' })
    const bad = Buffer.from(zip); bad.writeUInt32LE(0x7fffff00, bad.length - 22 + 16) // directory offset far outside
    expect((await open(bad)).pak.entries.size).toBe(0)
    const z64 = Buffer.from(zip); z64.writeUInt16LE(0xffff, z64.length - 22 + 10)
    expect((await open(z64)).pak.entries.size).toBe(0)
  })

  test('a pack lump that reaches past the end of the file is refused', async () => {
    const src = memorySource(buildBsp({ ...flatQuad(0), pak: buildZip({ 'a.txt': 'x' }) }))
    const header = await readHeader(src)
    await expect(readPak(src, { ...header.lumps[LUMP.PAKFILE]!, length: 10_000_000 })).rejects.toBeInstanceOf(BspError)
  })
})

describe('a member', () => {
  const text = 'a model, or a material, or anything'.repeat(20)

  test('stored and deflated members come out as they went in', async () => {
    const { src, pak } = await open(buildZip({ 'a.bin': text, 'b.bin': text }, ['b.bin']))
    expect(Buffer.from((await readPakMember(src, pak, 'a.bin'))!).toString()).toBe(text)
    expect(Buffer.from((await readPakMember(src, pak, 'b.bin'))!).toString()).toBe(text)
  })

  test('one that is not there is null', async () => {
    const { src, pak } = await open(buildZip({ 'a.bin': 'x' }))
    expect(await readPakMember(src, pak, 'nope.bin')).toBeNull()
  })

  test('one over the member limit, and members past the total limit, are null', async () => {
    const { src, pak } = await open(buildZip({ 'a.bin': text, 'b.bin': text }))
    expect(await readPakMember(src, pak, 'a.bin', { maxMemberBytes: 10 })).toBeNull()
    const limits = { maxTotalBytes: text.length + 5 }
    expect(await readPakMember(src, pak, 'a.bin', limits)).not.toBeNull()
    expect(await readPakMember(src, pak, 'b.bin', limits)).toBeNull()
  })

  test('a member whose local header is not one, or that is cut off, is null', async () => {
    const zip = buildZip({ 'a.bin': text })
    const noHeader = Buffer.from(zip); noHeader.writeUInt32LE(0, 0)
    const a = await open(noHeader)
    expect(await readPakMember(a.src, a.pak, 'a.bin')).toBeNull()
    const cut = Buffer.from(zip); cut.writeUInt32LE(cut.readUInt32LE(cut.length - 22 + 16) + 10, cut.length - 22 + 16)
    expect((await open(cut)).pak.entries.size).toBe(0)
  })

  test('a deflated member that unpacks to more than it says (a zip bomb) is null, and so is one that lies about its stored size', async () => {
    const zip = buildZip({ 'a.bin': 'A'.repeat(100_000) }, ['a.bin'])
    const lie = Buffer.from(zip)
    const central = lie.readUInt32LE(lie.length - 22 + 16)
    lie.writeUInt32LE(100, central + 24) // the directory says 100 bytes
    const a = await open(lie)
    expect(await readPakMember(a.src, a.pak, 'a.bin')).toBeNull()
    const stored = buildZip({ 'b.bin': 'hello' })
    const c2 = stored.readUInt32LE(stored.length - 22 + 16)
    stored.writeUInt32LE(3, c2 + 24) // stored, but the sizes differ
    const b = await open(stored)
    expect(await readPakMember(b.src, b.pak, 'b.bin')).toBeNull()
  })
})
