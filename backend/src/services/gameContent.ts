import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelFiles } from '../maps/model'
import type { StockModels } from '../maps/propset'
import { readVpkFile, readVpkIndex, vpkArchiveName, type VpkEntry, type VpkIndex } from '../maps/vpk'
import { fileSource } from '../maps/fileSource'
import { helperPath, runHelper, scratchRoot } from './workshop'

// The game's own models (RFC 18, 4.5). Counter-Strike: Source and Garry's Mod content is not in a map and not in the
// game's depots a stranger can fetch, but the free dedicated-server apps carry it and need no account. The backend keeps
// the small index files, fetches the archive that holds a missing model (about 110 MB), copies the three files of each
// wanted model into a cache, and deletes the archive. A model is cached by name for good.

/** Where the content is: the dedicated-server apps (4020: Garry's Mod, 232330: Counter-Strike: Source), and the index file of each package in them. */
export const GAME_SOURCES = [
  { app: '4020', dir: 'sourceengine/hl2_misc_dir.vpk' },
  { app: '232330', dir: 'cstrike/cstrike_pak_dir.vpk' },
  { app: '4020', dir: 'garrysmod/garrysmod_dir.vpk' },
] as const

export const gameContentEnabled = () => process.env.GAME_CONTENT === '1'

export interface GameContentOptions {
  binary?: string
  /** The cache and the index files. Default: GAME_CONTENT_DIR, else `.game-content` in the working directory (the server's own volume). */
  root?: string
  /** Where the archives are downloaded. Default: see `scratchRoot`. */
  scratch?: string
  /** An archive larger than this (by the index) is not fetched. Default 600 MiB. */
  maxArchiveBytes?: number
  /** Time for one download. Default 20 minutes. */
  timeoutMs?: number
  sources?: readonly { app: string, dir: string }[]
}

const EXTENSIONS = ['mdl', 'vvd', 'dx90.vtx'] as const
const MODEL_NAME = /^models\/[a-z0-9_\-/. ]+\.mdl$/
const MAX_FILE = 16 * 1024 * 1024

/** `models/props_c17/oildrum001.mdl` from whatever a map wrote ("./", backslashes, capitals), or null for a name that is not a model path. */
export function modelBase(name: string): string | null {
  const n = name.toLowerCase().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  return MODEL_NAME.test(n) && !n.includes('..') && !n.includes('//') ? n.slice(0, -4) : null
}

const cacheKey = (base: string) => createHash('sha1').update(base).digest('hex')

export class GameContentError extends Error {}

/** The model source for `buildPropSet`: cached files first, then the archives that hold the rest. Throws `GameContentError` when a download fails; models already cached are not lost. */
export function gameContent(opts: GameContentOptions = {}): { models: StockModels, root: string } {
  const binary = opts.binary ?? helperPath()
  const root = opts.root ?? process.env.GAME_CONTENT_DIR ?? join(process.cwd(), '.game-content')
  const sources = opts.sources ?? GAME_SOURCES
  const maxArchive = opts.maxArchiveBytes ?? 600 * 1024 * 1024
  const limits = { maxBytes: maxArchive + 64 * 1024 * 1024, timeoutMs: opts.timeoutMs ?? 20 * 60_000 }
  const indexes: (VpkIndex | null)[] = sources.map(() => null)
  const modelPath = (base: string, ext: string) => join(root, 'models', `${cacheKey(base)}.${ext}`)
  const indexPath = (i: number) => join(root, 'index', sources[i]!.app, sources[i]!.dir)

  /** Runs the helper once for exact paths of one app and returns the directory they landed in (the caller removes it). */
  async function fetchFiles(app: string, paths: string[]): Promise<{ dir: string, out: string }> {
    const scratch = opts.scratch ?? scratchRoot()
    await mkdir(scratch, { recursive: true })
    const dir = await mkdtemp(join(scratch, 'job-game-'))
    try {
      await writeFile(join(dir, 'list.txt'), paths.join('\n') + '\n')
      const err = await runHelper(binary, ['-app', app, '-filelist', join(dir, 'list.txt')], dir, limits)
      if (err) throw new GameContentError(err)
      return { dir, out: join(dir, 'out') }
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      throw e
    }
  }

  const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? 0

  async function loadIndexes() {
    // The index files (0.2 to 0.7 MB each) are fetched once and kept.
    const absent: number[] = []
    for (let i = 0; i < sources.length; i++) if (!indexes[i] && !(await sizeOf(indexPath(i)))) absent.push(i)
    for (const app of new Set(absent.map(i => sources[i]!.app))) {
      const mine = absent.filter(i => sources[i]!.app === app)
      const got = await fetchFiles(app, mine.map(i => sources[i]!.dir))
      try {
        for (const i of mine) {
          const bytes = await readFile(join(got.out, sources[i]!.dir)).catch(() => null)
          if (!bytes) continue
          await mkdir(dirname(indexPath(i)), { recursive: true })
          await writeFile(indexPath(i), bytes)
        }
      } finally { await rm(got.dir, { recursive: true, force: true }) }
    }
    for (let i = 0; i < sources.length; i++) {
      if (indexes[i] || !(await sizeOf(indexPath(i)))) continue
      const { src, close } = await fileSource(indexPath(i))
      try { indexes[i] = await readVpkIndex(src) } catch { await rm(indexPath(i), { force: true }) } finally { await close() }
    }
  }

  const cached = async (base: string): Promise<ModelFiles | null> => {
    const [mdl, vvd, vtx] = await Promise.all(EXTENSIONS.map(async e => { const f = Bun.file(modelPath(base, e)); return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null }))
    return mdl && vvd && vtx ? { mdl, vvd, vtx } : null
  }

  async function run(names: string[]): Promise<{ models: Map<string, ModelFiles>, error?: string }> {
    const result = new Map<string, ModelFiles>()
    let error: string | undefined
    const need = new Map<string, string[]>() // base -> the names that map to it
    for (const name of names) {
      const base = modelBase(name)
      if (!base) continue
      const files = await cached(base)
      if (files) { result.set(name, files); continue }
      need.set(base, [...(need.get(base) ?? []), name])
    }
    if (need.size === 0) return { models: result }

    try { await loadIndexes() } catch (e) { return { models: result, error: e instanceof Error ? e.message : 'The index files could not be fetched.' } }
    // Which archive holds which file of which model.
    const plan = new Map<string, { source: number, archive: number, items: { base: string, ext: string, entry: VpkEntry }[] }>()
    const complete: string[] = []
    for (const base of need.keys()) {
      const found: { source: number, ext: string, entry: VpkEntry }[] = []
      for (const ext of EXTENSIONS) {
        for (let i = 0; i < sources.length; i++) {
          const entry = indexes[i]?.get(`${base}.${ext}`)
          if (entry) { found.push({ source: i, ext, entry }); break }
        }
      }
      if (found.length !== EXTENSIONS.length) continue // the game does not have it (or not all of it)
      complete.push(base)
      for (const f of found) {
        const key = `${f.source}/${f.entry.archive}`
        const slot = plan.get(key) ?? { source: f.source, archive: f.entry.archive, items: [] }
        slot.items.push({ base, ext: f.ext, entry: f.entry })
        plan.set(key, slot)
      }
    }

    for (const { source, archive, items } of plan.values()) try {
      const dirFile = sources[source]!.dir
      if (archive === 0x7fff) {
        // Data inside the index file itself: already on disk.
        const { src, close } = await fileSource(indexPath(source))
        try { for (const it of items) await store(it.base, it.ext, await readVpkFile(it.entry, src, MAX_FILE)) } finally { await close() }
        continue
      }
      const archiveName = vpkArchiveName(dirFile, archive)
      // The archive's size, as far as the index says: the end of the last file in it.
      let size = 0
      for (const e of indexes[source]!.values()) if (e.archive === archive) size = Math.max(size, e.offset + e.length)
      if (size > maxArchive) throw new GameContentError(`The archive ${archiveName} is larger than the limit.`)
      const free = await statfs(root).then(s => s.bavail * s.bsize).catch(() => Infinity)
      if (free < size * 1.5 + 64 * 1024 * 1024) throw new GameContentError(`Not enough free disk to fetch ${archiveName} (${Math.ceil(size / 1048576)} MB needed).`)
      const got = await fetchFiles(sources[source]!.app, [archiveName])
      try {
        const { src, close } = await fileSource(join(got.out, archiveName)).catch(() => { throw new GameContentError(`The download held no ${archiveName}.`) })
        try { for (const it of items) await store(it.base, it.ext, await readVpkFile(it.entry, src, MAX_FILE)) } finally { await close() }
      } finally { await rm(got.dir, { recursive: true, force: true }) }
    } catch (e) { error ??= e instanceof Error ? e.message : 'The game content could not be fetched.' }

    for (const base of complete) {
      const files = await cached(base)
      if (files) for (const name of need.get(base)!) result.set(name, files)
    }
    return { models: result, error }
  }

  async function store(base: string, ext: string, bytes: Uint8Array) {
    const path = modelPath(base, ext)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path + '.tmp', bytes)
    await rename(path + '.tmp', path)
  }

  // One request at a time: two would download the same archive twice.
  let chain: Promise<unknown> = Promise.resolve()
  const models: StockModels = names => {
    const next = chain.then(() => run(names))
    chain = next.catch(() => {})
    return next.catch(e => ({ models: new Map<string, ModelFiles>(), error: e instanceof Error ? e.message : 'The game content could not be read.' }))
  }
  return { models, root }
}
