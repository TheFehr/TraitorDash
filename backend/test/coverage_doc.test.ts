import { expect, test, describe } from 'bun:test'
import { COVERAGE, STATUSES, type Kind } from '../src/maps/coverage'

// RFC 32, 9: docs/MAP_COVERAGE.md is the registry in prose. The tables of its four registry sections are compared with the registry, in both directions, so an
// entry cannot be left out of the document, a row cannot be left behind when an entry goes, and a status or a note cannot differ.

const doc = await Bun.file(new URL('../../docs/MAP_COVERAGE.md', import.meta.url)).text()
const SECTIONS: Record<string, Kind> = { 'Surface flags': 'flag', 'Materials': 'material', 'Brush entity classes': 'class', 'Features of the file': 'feature' }

/** The rows of the tables under the four registry headings (`## ...`): [kind, key, status, note]. Other sections (the measurement) are not read here. */
function rows(): [Kind, string, string, string][] {
  const out: [Kind, string, string, string][] = []
  for (const part of doc.split(/^## /m).slice(1)) {
    const title = part.split('\n', 1)[0]!.trim()
    const kind = SECTIONS[title]
    if (!kind) continue
    for (const line of part.split('\n')) {
      if (!line.startsWith('| `')) continue
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      const key = /^`([^`]+)`/.exec(cells[0]!)?.[1]
      if (key && cells.length === 3) out.push([kind, key, cells[1]!, cells[2]!])
    }
  }
  return out
}

describe('docs/MAP_COVERAGE.md and the registry say the same', () => {
  test('every registry entry has a row in its section, with its status and its note', () => {
    const found = new Map(rows().map(r => [`${r[0]}:${r[1]}`, r]))
    for (const e of COVERAGE) {
      const row = found.get(`${e.kind}:${e.key}`)
      expect(row, `${e.kind} ${e.key} is in the registry and has no row in docs/MAP_COVERAGE.md`).toBeDefined()
      expect(row![2], `${e.kind} ${e.key}: the status in the document`).toBe(e.status)
      expect(row![3], `${e.kind} ${e.key}: the note in the document`).toBe(e.note)
    }
  })

  test('every row of the document is an entry of the registry (a row for something that is gone fails)', () => {
    const known = new Set(COVERAGE.map(e => `${e.kind}:${e.key}`))
    for (const [kind, key] of rows()) expect(known.has(`${kind}:${key}`), `${kind} ${key} is in the document and not in the registry`).toBe(true)
    expect(rows().length).toBe(COVERAGE.length)
  })

  test('a status in the document is one of the four an entry can have; unknown is explained and has no rows', () => {
    for (const [, key, status] of rows()) expect(STATUSES.filter(s => s !== 'unknown') as string[], key).toContain(status)
    expect(doc).toMatch(/\| unknown \|[^\n]*never a row of these tables/)
  })

  test('the flags carry their bit, so the table can be read against the format', () => {
    expect(doc).toContain('`BUMPLIGHT` (0x800)')
    expect(doc).toContain('`SKY` (0x4)')
    expect(doc).toContain('`HITBOX` (0x8000)')
  })

  test('the document has the measurement of the real map and the totals over the maps of the server', () => {
    expect(doc).toContain('## The measurement on a real map')
    expect(doc).toContain('ttt_67thway_rework_b1')
    expect(doc).toMatch(/## Totals over the server's maps \(\d{4}-\d{2}-\d{2}/)
    expect(doc).toContain('27 have a record')
    expect(doc).toContain('`func_illusionary` | gap | 10 | 2 076 | 327')
    expect(doc).toMatch(/11 571 faces in the world model/)
  })
})
