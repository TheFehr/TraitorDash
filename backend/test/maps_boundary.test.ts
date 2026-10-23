import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// RFC 18, 8b: the map code stands on its own, so that it can become a package. It may import its own files, the
// `node:` modules and the glTF library, and nothing else in this backend.
const dir = join(import.meta.dir, '../src/maps')
const ALLOWED = [/^\.\/[A-Za-z]+$/, /^node:/, /^@gltf-transform\//]

test('nothing in src/maps imports from outside it', () => {
  const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f))
  expect(files.length).toBeGreaterThan(3)
  const bad: string[] = []
  for (const f of files) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (!ALLOWED.some(re => re.test(m[1]!))) bad.push(`${f}: ${m[1]}`)
    }
  }
  expect(bad).toEqual([])
})
