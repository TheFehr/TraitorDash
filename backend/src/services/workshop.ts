import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './Store'
import { HEADER_BYTES, bspFingerprint } from './bsp'
import { mapEntries, readGmaIndex } from './gma'
import { fileSource, type Fetcher } from './mapgeometry'

// Fetching a map from the Steam Workshop (RFC 11, 3.2): the helper program DepotDownloader is run as
// a separate process (it is GPL-2.0; nothing of it is linked into this program), anonymously, for
// one addon at a time. The addon is read in place and deleted when the job ends.

const GAME_APP = '4000' // Garry's Mod

export interface WorkshopOptions {
  /** The helper program. Default: see `helperPath`. */
  binary?: string
  /** Where scratch directories are made. Default: GEOMETRY_TMP, else the system temp directory. */
  scratch?: string
  /** A download is stopped when its files pass this many bytes. Default 1 GiB. */
  maxBytes?: number
  /** A download is stopped after this long. Default 15 minutes. */
  timeoutMs?: number
  /** At most this many addons are tried for one map. Default 60. */
  maxCandidates?: number
}

const WSID = /^\d{1,12}$/

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isFile()) total += (await stat(join(e.parentPath, e.name)).catch(() => null))?.size ?? 0
  }
  return total
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isFile() && e.name.toLowerCase().endsWith(suffix) && !e.parentPath.includes('.DepotDownloader')) out.push(join(e.parentPath, e.name))
  }
  return out
}

/** Runs the helper for one addon into `dir`. Returns an error text, or null when it exited cleanly in time and size. */
async function download(binary: string, wsid: string, dir: string, o: Required<Pick<WorkshopOptions, 'maxBytes' | 'timeoutMs'>>): Promise<string | null> {
  await mkdir(join(dir, 'home'), { recursive: true })
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([binary, '-app', GAME_APP, '-pubfile', wsid, '-dir', join(dir, 'out')], {
      cwd: dir,
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      // Nothing of this process's environment is handed on: no tokens, no database path.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
    })
  } catch {
    return 'The download helper (DepotDownloader) is not installed.'
  }
  let reason: string | null = null
  const stop = (why: string) => { if (!reason) { reason = why; proc.kill('SIGKILL') } }
  const timer = setTimeout(() => stop('The download took too long.'), o.timeoutMs)
  const watch = setInterval(async () => { if (await dirBytes(join(dir, 'out')) > o.maxBytes) stop('The addon is larger than the limit.') }, 1000)
  try {
    const code = await proc.exited
    if (reason) return reason
    return code === 0 ? null : 'The download failed.'
  } finally { clearTimeout(timer); clearInterval(watch) }
}

/**
 * Old Workshop items are one LZMA stream around the archive. Decodes it with the system `xz` into
 * `out`; the declared size in the stream's header is the check (the stream is followed by padding,
 * which xz reports as an error after all the data is written).
 */
async function unlzma(path: string, out: string, maxBytes: number): Promise<string | null> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 13).arrayBuffer())
  const size = Number(new DataView(head.buffer).getBigUint64(5, true))
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return 'The addon is larger than the limit.'
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['xz', '--format=lzma', '-dc', '--memlimit=512MiB', path], { stdin: 'ignore', stdout: Bun.file(out), stderr: 'ignore' })
  } catch {
    return 'The addon is compressed and the system has no xz to open it.'
  }
  await proc.exited
  return (await stat(out).catch(() => null))?.size === size ? null : 'The compressed addon could not be opened.'
}

/** Makes the downloaded files plain archives, returning their paths. */
async function archives(dir: string, maxBytes: number): Promise<{ paths: string[] } | { error: string }> {
  const paths: string[] = []
  for (const f of await findFiles(join(dir, 'out'), '.gma')) {
    const head = new Uint8Array(await Bun.file(f).slice(0, 4).arrayBuffer())
    if (new TextDecoder().decode(head) === 'GMAD') { paths.push(f); continue }
    const plain = f + '.plain'
    const err = await unlzma(f, plain, maxBytes)
    if (err) return { error: err }
    await rm(f, { force: true })
    paths.push(plain)
  }
  return paths.length ? { paths } : { error: 'The download held no addon archive.' }
}

/** The Workshop fetcher: finds the addon that holds this exact version of the map and downloads it. */
export function workshopFetcher(opts: WorkshopOptions = {}): Fetcher {
  const binary = opts.binary ?? helperPath()
  const root = opts.scratch ?? process.env.GEOMETRY_TMP ?? join(tmpdir(), 'traitordash-geometry')
  const limits = { maxBytes: opts.maxBytes ?? 1024 ** 3, timeoutMs: opts.timeoutMs ?? 15 * 60_000 }
  const maxCandidates = opts.maxCandidates ?? 60

  /** Downloads one addon, records every map in it, and returns the map's place if it holds the wanted version. */
  async function tryAddon(wsid: string, map: string, fingerprint: string, dir: string) {
    const err = await download(binary, wsid, dir, limits)
    if (err) return { error: err }
    const got = await archives(dir, limits.maxBytes)
    if ('error' in got) return got
    const found: { name: string, fingerprint: string }[] = []
    let hit: { path: string, offset: number, length: number } | null = null
    for (const path of got.paths) {
      const { src, close } = await fileSource(path)
      try {
        for (const { name, entry } of mapEntries(await readGmaIndex(src))) {
          if (entry.size < HEADER_BYTES) continue
          const fp = bspFingerprint(await src.read(entry.offset, HEADER_BYTES), entry.size)
          found.push({ name, fingerprint: fp })
          if (!hit && name === map.toLowerCase() && fp === fingerprint) hit = { path, offset: entry.offset, length: entry.size }
        }
      } catch { /* an archive that cannot be read holds nothing we can use */ } finally { await close() }
    }
    Store.recordAddonScan(wsid, found)
    return { hit }
  }

  return async (map, fingerprint) => {
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(join(root, 'job-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
      // Addons already known to hold this version first, then the server's mounted map addons that
      // have not been looked into yet.
      const known = Store.getKnownAddons(map, fingerprint)
      const fresh = Store.getCandidateAddons(map, fingerprint).filter(id => !Store.isAddonScanned(id))
      const order = [...new Set([...known, ...fresh])].filter(id => WSID.test(id)).slice(0, maxCandidates)
      if (order.length === 0) { await cleanup(); return { error: 'No mounted map addon is known to hold this version of the map.' } }

      let lastError: string | null = null
      for (const wsid of order) {
        const attempt = join(dir, `a-${wsid}`)
        await mkdir(attempt)
        const r = await tryAddon(wsid, map, fingerprint, attempt)
        if ('error' in r) { lastError = r.error; await rm(attempt, { recursive: true, force: true }); continue }
        if (r.hit) return { ...r.hit, cleanup }
        await rm(attempt, { recursive: true, force: true })
      }
      await cleanup()
      return { error: lastError ?? 'None of the mounted map addons holds this version of the map.' }
    } catch (e) {
      await cleanup().catch(() => {})
      throw e
    }
  }
}

/**
 * Where the helper is: DEPOTDOWNLOADER_PATH, else `bin/DepotDownloader` in the working directory (where
 * the Pelican egg's installer puts it), else whatever `DepotDownloader` the PATH finds.
 */
export function helperPath(): string {
  if (process.env.DEPOTDOWNLOADER_PATH) return process.env.DEPOTDOWNLOADER_PATH
  const local = join(process.cwd(), 'bin', 'DepotDownloader')
  return existsSync(local) ? local : 'DepotDownloader'
}

/** Is the helper there? Used at start-up to say so once in the log instead of failing every job. */
export async function helperAvailable(binary = helperPath()): Promise<boolean> {
  try {
    const p = Bun.spawn([binary, '-h'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await p.exited
    return true
  } catch { return false }
}
