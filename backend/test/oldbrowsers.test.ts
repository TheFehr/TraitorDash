import { expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lowerStaticBlocks, problems } from '../scripts/oldbrowsers'

// The game's browser is Chrome 86: a bundle with syntax it cannot parse does nothing at all, so the
// build rewrites the one construct three.js has that it cannot, and fails on anything else.

describe('class static blocks', () => {
  test('the one three.js writes becomes a static field that does the same when the class is defined', () => {
    const out = lowerStaticBlocks('class Pe{static{Pe.prototype.isVector2=!0}constructor(e=0){this.x=e}}')
    expect(out).toBe('class Pe{static __isVector2=(Pe.prototype.isVector2=!0);constructor(e=0){this.x=e}}')
    // and it really is that: run both and compare
    const make = (src: string) => new Function(`${src}; return new Pe(3)`)()
    const a = make('class Pe{static{Pe.prototype.isVector2=true}constructor(e){this.x=e}}')
    const b = make(lowerStaticBlocks('class Pe{static{Pe.prototype.isVector2=true}constructor(e){this.x=e}}'))
    expect([a.isVector2, a.x]).toEqual([b.isVector2, b.x])
  })
  test('written with spaces and a semicolon (an unminified bundle) it is found too', () => {
    expect(lowerStaticBlocks('class A { static { A.prototype.isA = true; } }')).toBe('class A { static __isA=(A.prototype.isA=true); }')
  })
  test('a static block that does something else is left alone and reported', () => {
    const js = 'class A{static{console.log(1)}}'
    expect(lowerStaticBlocks(js)).toBe(js)
    expect(problems(js)).toEqual(['a class static block (Chrome 94)'])
  })
  test('a private-field check is reported; plain code is not', () => {
    expect(problems('class A{#x=1;static has(o){return #x in o}}')).toEqual(['a private-field `in` check (Chrome 91)'])
    expect(problems('const a = obj?.b ?? 1; class B { static n = 1; #p = 2 }')).toEqual([])
  })
})

describe('the real bundles', () => {
  test('replay.ts and mapview.ts, built and rewritten, have nothing Chrome 86 cannot parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-bundle-'))
    try {
      for (const entry of ['replay', 'mapview']) {
        const built = await Bun.build({ entrypoints: [join(import.meta.dir, `../src/${entry}.ts`)], format: 'iife', minify: true, outdir: dir })
        expect(built.success, entry).toBe(true)
        const js = await Bun.file(join(dir, `${entry}.js`)).text()
        expect(problems(js).length, `${entry} before`).toBeGreaterThan(0) // if three.js stops needing this, the step can go
        expect(problems(lowerStaticBlocks(js)), `${entry} after`).toEqual([])
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
})
