// The game's built-in browser is Chrome 86 (2020). Bun writes the bundles in modern syntax, and one thing
// in three.js is beyond that browser's parser: a class static block, `static { X.prototype.isY = true }`
// (Chrome 94), which makes the whole script fail. A static field with the same effect is understood from
// Chrome 72, and it runs at the same moment (when the class is defined), so the block is written as one.
// Anything else the browser cannot parse stops the build, rather than a page that silently does nothing.
//
// Usage: bun run scripts/oldbrowsers.ts <bundle.js>...

/** `static{A.prototype.isB=!0}` as `static __isB=(A.prototype.isB=!0);`. */
export function lowerStaticBlocks(js: string): string {
  return js.replace(/static\s*\{\s*(\w+)\.prototype\.(\w+)\s*=\s*(!0|true)\s*;?\s*\}/g, 'static __$2=($1.prototype.$2=$3);')
}

/** What is left in a bundle that Chrome 86 cannot parse, as a list of problems; empty when none. */
export function problems(js: string): string[] {
  const found: string[] = []
  if (/\bstatic\s*\{/.test(js)) found.push('a class static block (Chrome 94)')
  if (/#[A-Za-z_$][\w$]*\s+in\s/.test(js)) found.push('a private-field `in` check (Chrome 91)')
  return found
}

if (import.meta.main) {
  let failed = false
  for (const file of process.argv.slice(2)) {
    const lowered = lowerStaticBlocks(await Bun.file(file).text())
    const left = problems(lowered)
    if (left.length > 0) { console.error(`${file}: Chrome 86 cannot parse ${left.join(', ')}`); failed = true; continue }
    await Bun.write(file, lowered)
    console.log(`${file}: ready for Chrome 86`)
  }
  if (failed) process.exit(1)
}
