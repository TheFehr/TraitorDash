// A Valve package for tests (RFC 18, 4.5): the index (`*_dir.vpk`, version 2) and the archives it points to.

export interface VpkFileSpec {
  /** `models/test/a.mdl` */
  name: string
  data: Buffer
  /** Archive number, or 0x7fff for data stored behind the index. Default 0. */
  archive?: number
  /** Bytes of the data to keep in the index itself. */
  preload?: number
}

export function buildVpk(files: VpkFileSpec[]): { dir: Buffer, archives: Map<number, Buffer> } {
  const archives = new Map<number, Buffer[]>()
  const inDir: Buffer[] = []
  const placed = files.map(f => {
    const archive = f.archive ?? 0
    const preload = f.data.subarray(0, f.preload ?? 0)
    const rest = f.data.subarray(preload.length)
    const bucket = archive === 0x7fff ? inDir : (archives.get(archive) ?? archives.set(archive, []).get(archive)!)
    const offset = bucket.reduce((n, b) => n + b.length, 0)
    bucket.push(rest)
    return { ...f, archive, preload, offset, length: rest.length }
  })
  // ext -> dir -> [file]
  const tree = new Map<string, Map<string, typeof placed>>()
  for (const f of placed) {
    const slash = f.name.lastIndexOf('/')
    const dir = slash < 0 ? ' ' : f.name.slice(0, slash)
    const base = f.name.slice(slash + 1)
    const dot = base.lastIndexOf('.')
    const ext = dot < 0 ? ' ' : base.slice(dot + 1)
    const stem = dot < 0 ? base : base.slice(0, dot)
    const dirs = tree.get(ext) ?? tree.set(ext, new Map()).get(ext)!
    const list = dirs.get(dir) ?? dirs.set(dir, []).get(dir)!
    list.push({ ...f, name: stem })
  }
  const parts: Buffer[] = []
  const str = (s: string) => parts.push(Buffer.from(s + '\0', 'latin1'))
  for (const [ext, dirs] of tree) {
    str(ext)
    for (const [dir, list] of dirs) {
      str(dir)
      for (const f of list) {
        str(f.name)
        const rec = Buffer.alloc(18)
        rec.writeUInt16LE(f.preload.length, 4); rec.writeUInt16LE(f.archive, 6)
        rec.writeUInt32LE(f.offset, 8); rec.writeUInt32LE(f.length, 12); rec.writeUInt16LE(0xffff, 16)
        parts.push(rec, f.preload)
      }
      str('')
    }
    str('')
  }
  str('')
  const treeBytes = Buffer.concat(parts)
  const header = Buffer.alloc(28)
  header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(treeBytes.length, 8)
  header.writeUInt32LE(inDir.reduce((n, b) => n + b.length, 0), 12)
  return { dir: Buffer.concat([header, treeBytes, ...inDir]), archives: new Map([...archives].map(([k, v]) => [k, Buffer.concat(v)])) }
}
