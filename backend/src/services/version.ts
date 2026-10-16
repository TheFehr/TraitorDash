import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import db from './Database'

// What is running, answerable from the running process alone. The deployed app has no .git
// (it is shipped as a tarball), so the identity is a hash of the SOURCE FILES it was started from:
// the same code gives the same hash however it was deployed (Ansible today, a release later).
//
// Covered: src/, package.json, bun.lock. Not covered, on purpose: src/public/ (CSS/JS built from
// the sources at deploy time, and gitignored, so the hash can be reproduced from a plain checkout
// without building), tests, scripts, node_modules, the database.

const ROOT = path.join(import.meta.dir, '../..')
const HASHED_DIRS = ['src']
const HASHED_FILES = ['package.json', 'bun.lock']
const SKIPPED = (rel: string) => rel.startsWith('src/public/')

/** 12 hex characters identifying the source tree under `root`. Same files, same hash. */
export function computeSourceHash(root: string = ROOT): string {
  const files: string[] = []
  for (const dir of HASHED_DIRS) {
    for (const rel of new Bun.Glob(`${dir}/**/*`).scanSync({ cwd: root, onlyFiles: true })) {
      const normalized = rel.split(path.sep).join('/')
      if (!SKIPPED(normalized)) files.push(normalized)
    }
  }
  for (const f of HASHED_FILES) if (existsSync(path.join(root, f))) files.push(f)

  const hash = createHash('sha256')
  for (const rel of files.sort()) {
    hash.update(`${rel}\0`)
    hash.update(readFileSync(path.join(root, rel)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** Optional `build.json` written at deploy time ({ commit, dirty, builtAt }); null when absent or unreadable. */
export function readBuildInfo(root: string = ROOT): { commit?: string, dirty?: boolean, builtAt?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, 'build.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const pick = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
    return {
      commit: pick(raw.commit, 40),
      dirty: typeof raw.dirty === 'boolean' ? raw.dirty : undefined,
      builtAt: pick(raw.builtAt, 40),
    }
  } catch {
    return null
  }
}

const startedAt = new Date()
let cachedHash: string | null = null
export const sourceHash = () => (cachedHash ??= computeSourceHash())

export interface Health {
  status: 'ok' | 'error'
  sourceHash: string
  build: ReturnType<typeof readBuildInfo>
  startedAt: string
  uptimeSeconds: number
  schemaVersion: number | null
  runtime: string
  error?: string
}

/** The health report. `schemaVersion` is injectable so a failing database can be tested. */
export function checkHealth(
  schemaVersion: () => number = () => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
): Health {
  const base = {
    sourceHash: sourceHash(),
    build: readBuildInfo(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    runtime: `bun ${Bun.version}`,
  }
  try {
    return { status: 'ok', ...base, schemaVersion: schemaVersion() }
  } catch {
    // Deliberately no error text: this endpoint is unauthenticated.
    return { status: 'error', ...base, schemaVersion: null, error: 'database unavailable' }
  }
}
