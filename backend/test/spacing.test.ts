import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { ADMIN_CSS, PUBLIC_CSS } from '../src/components/styles'

// RFC 30: a spacing scale (--space-1 .. --space-5 and --tab) and two layout primitives (.stack, .g). The stylesheet text and the inline style="..."
// of the components are read here, so that a new page cannot write its own numbers again. The test checks text, not looks: how the change looks
// in a browser was measured in Chromium (RFC 30, section 7) and what it cannot say is whether a page looks right.

/** Layout rules that still hold a raw length, by selector (the text before the `{`, exactly as in the stylesheet), each with the reason. A new entry is
 *  a decision, not an accident: the list can only get shorter (ALLOW_MAX is the ratchet; lower it when you shorten the list). */
const ALLOW: Record<string, string> = {
  // details inside a control: the padding is the control's own size, not the space between things
  'button': 'a button: its padding is its size',
  'input[type=search]': 'a field: its padding is its size',
  '.sections a,.sections span[aria-current]': 'a tab-like link: its padding is its size',
  '.bar a': 'a pill-like link: .05rem of padding is its height',
  '.filt a': 'a chip: its padding is its size',
  '.stamp': 'a rubber stamp: a badge, .35rem of side padding',
  '.res': 'a result badge: .3rem of side padding',
  '.tape': 'a label badge: .45rem of side padding',
  '.btn': 'a button: its padding is its size',
  '.pill': 'a pill: .3rem of side padding',
  '.tog': 'a toggle: its padding is its size (.05rem high, the same pressed or not)',
  '.vc .tog': 'a toggle of the voice page: its padding is its size',
  '.f input:not([type]),.f input[type=text],.f input[inputmode]': 'a field on paper: its padding is its size',
  '.mark': 'a badge: .4rem of side padding',
  'select,input[type=number],input[type=text].dk,.dk': 'a dark field: its padding is its size',
  '.ab': 'a button of the admin pages: its padding is its size',
  '.team': 'a badge: its padding is its size',
  '.status': 'a status chip: its padding is its size',
  '.side .find input': 'a field: its padding is its size',
  '.jump a': 'a tab-like link of a sticky strip: its padding is its click height',
  '.lvl b': 'the line of the level bar: a one-pixel overlap margin (-1px) centres a 2px line',
  // rows of dense lists and tables: a step would add or take a pixel or two from every row, and a table has dozens
  '.ledger': 'dotted rows: .1rem between rows (a step would add 1.6 to 2.4 px to each of them)',
  '.ledger div': 'dotted rows: .2rem of padding is the row height',
  'table.set th': 'a table row: .2rem is the row height',
  'table.set td': 'a table row: .22rem is the row height',
  'table.log th': 'a table row: .15rem and .25rem are the head height',
  'table.log td': 'a table row: .28rem is the row height (a list of rounds has dozens)',
  '.win': 'a bar row: .12rem is the row height',
  '.prow': 'a row of a player list: its padding is its click height',
  '.ritem': 'a row of the role list: its padding is its click height',
  // reserved room, not space between things
  '.cfg': 'the room for the fixed save bar at the foot of the page (6.5rem)',
}
/** The ratchet on ALLOW: fails when the list grows. Lower it when it shrinks. */
const ALLOW_MAX = 31
/** What each allow-listed selector holds that is not on the scale, exactly. The list above lets a selector off; this pins what it may keep, so a new
 *  raw margin or a changed padding on an allowed selector (`button{margin:9rem}`) fails too. Change an entry only on purpose. */
const PINNED: Record<string, string> = {
  '.sections a,.sections span[aria-current]': 'padding:.2rem .7rem',
  '.bar a': 'padding:.05rem .6rem',
  'input[type=search]': 'padding:.3rem .6rem',
  'button': 'padding:.35rem .9rem',
  '.stamp': 'padding:0 .35rem',
  '.ledger': 'gap:.1rem 1.5rem',
  '.ledger div': 'padding:.2rem 0',
  'table.set th': 'padding:.2rem .4rem .2rem 0',
  'table.set td': 'padding:.22rem .4rem .22rem 0',
  '.mark': 'padding:0 .4rem',
  '.win': 'padding:.12rem 0',
  'table.log th': 'padding:.15rem .5rem .25rem 0',
  'table.log td': 'padding:.28rem .5rem .28rem 0',
  '.res': 'padding:0 .3rem',
  '.tape': 'padding:0 .45rem',
  '.btn': 'padding:.15rem .8rem',
  '.pill': 'padding:0 .3rem',
  '.filt a': 'padding:.12rem .65rem',
  '.prow': 'padding:.15rem .3rem',
  '.tog': 'padding:.05rem .7rem',
  '.vc .tog': 'padding:.3rem .9rem',
  '.lvl b': 'margin-left:-1px',
  '.f input:not([type]),.f input[type=text],.f input[inputmode]': 'padding:.25rem .5rem',
  '.team': 'padding:.05rem .7rem',
  '.status': 'padding:.3rem .8rem',
  'select,input[type=number],input[type=text].dk,.dk': 'padding:.3rem .6rem',
  '.ab': 'padding:.2rem .85rem',
  '.jump a': 'padding:.55rem .15rem',
  '.cfg': 'padding-bottom:6.5rem',
  '.side .find input': 'padding:.3rem .6rem',
  '.ritem': 'padding:.35rem .6rem',
}
/** The ratchet on raw spacing values in the components' inline style attributes. Lower it when it shrinks. */
const INLINE_RAW_MAX = 0

const LAYOUT_PROP = /^(?:(?:grid-)?(?:row-|column-)?gap|(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?)$/

/** Split at the top level of a value: whitespace outside parentheses. */
function tokens(value: string): string[] {
  const out: string[] = []; let depth = 0, cur = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = '' } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}
const STEP = /var\(--(?:space-[1-5]|tab)\)/g
/** 0, auto, a step of the scale, or a calc of steps and plain numbers. */
function onScale(token: string): boolean {
  if (token === '0' || token === 'auto') return true
  if (/^var\(--(?:space-[1-5]|tab)\)$/.test(token)) return true
  const calc = /^calc\((.*)\)$/.exec(token)
  if (!calc) return false
  const inner = calc[1]!.replace(STEP, '')
  return STEP.test(calc[1]!) && /^[\s\d.*+\-/]*$/.test(inner) && !/\d(?:rem|px|em|%)/.test(inner)
}
/** The raw values of one declaration block: `property: value` pairs that are layout and not on the scale. */
function rawIn(decls: string): string[] {
  const bad: string[] = []
  for (const d of decls.split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*([^]*?)\s*$/.exec(d)
    if (!m || !LAYOUT_PROP.test(m[1]!)) continue
    const value = m[2]!.replace(/\s*!important$/, '')
    if (!tokens(value).every(onScale)) bad.push(`${m[1]}:${value}`)
  }
  return bad
}
/** Every rule of a stylesheet as [selector, declarations], the rules inside @media included. */
function rules(css: string): [string, string][] {
  const text = css.replace(/\/\*[^]*?\*\//g, '')
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => [m[1]!.replace(/^[^]*\{/, '').trim(), m[2]!] as [string, string])
    .filter(([sel]) => !sel.startsWith('@font-face'))
}

const ALL = [...rules(PUBLIC_CSS), ...rules(ADMIN_CSS)]

describe('the spacing scale (RFC 30)', () => {
  test('the six variables are on :root with the values of the scale, and the notes name each of them', async () => {
    const root = /:root\{([^}]*)\}/.exec(PUBLIC_CSS)?.[1] ?? ''
    const want: Record<string, string> = { '--space-1': '.25rem', '--space-2': '.5rem', '--space-3': '.8rem', '--space-4': '1.2rem', '--space-5': '2rem', '--tab': '.7rem' }
    for (const [name, value] of Object.entries(want)) expect(root, name).toContain(`${name}:${value}`)
    const notes = await Bun.file(new URL('../../docs/UI_DESIGN.md', import.meta.url)).text()
    for (const name of Object.keys(want)) expect(notes, `${name} in docs/UI_DESIGN.md`).toContain(name)
  })

  test('the tab of a card is --tab high and reaches up by as much, so the room above a card is counted from one number', () => {
    const tab = ALL.find(([sel]) => sel === '.f:before,.pn:before')?.[1] ?? ''
    expect(tab).toContain('height:var(--tab)')
    expect(tab).toContain('top:calc(-1 * var(--tab))')
  })

  test('a column of cards and a grid of cards leave the same room above the first card and the same gaps between the others', () => {
    const rule = (sel: string) => ALL.find(([s]) => s === sel)?.[1] ?? ''
    const above = 'padding-top:calc(var(--tab) + var(--space-2))'
    expect(rule('.stack')).toContain('flex-direction:column'); expect(rule('.stack')).toContain('gap:var(--space-4)'); expect(rule('.stack')).toContain(above)
    expect(rule('.g,.pair,.nums')).toContain('gap:var(--space-4) var(--space-3)'); expect(rule('.g,.pair,.nums')).toContain(above)
    expect(rule('.tiles')).toContain('gap:var(--space-4) var(--space-3)'); expect(rule('.tiles')).toContain(above)
    // no page-specific rule sets those again (the voice page's own .vcs is gone)
    expect(PUBLIC_CSS + ADMIN_CSS).not.toMatch(/\.vcs\b/)
  })

  test('every gap, margin and padding of the stylesheet is 0, auto, a step of the scale or a calc of steps, except the written allow-list', () => {
    const raw: Record<string, string[]> = {}
    for (const [sel, decls] of ALL) { const bad = rawIn(decls); if (bad.length) raw[sel] = [...(raw[sel] ?? []), ...bad] }
    const unlisted = Object.keys(raw).filter(sel => !(sel in ALLOW))
    expect(unlisted.map(sel => `${sel} { ${raw[sel]!.join('; ')} }`), 'raw spacing outside the allow-list: use a step of the scale (docs/UI_DESIGN.md, spacing), or list the selector with a reason').toEqual([])
    // what an allowed selector may keep is pinned, not open
    expect(Object.fromEntries(Object.entries(raw).filter(([sel]) => sel in ALLOW).map(([sel, r]) => [sel, r.join('; ')])), 'an allow-listed selector holds a raw value that PINNED does not list').toEqual(PINNED)
    // an entry that no longer has a raw value is removed, so the list only gets shorter
    expect(Object.keys(ALLOW).filter(sel => !(sel in raw)), 'allow-list entries that hold no raw value any more: remove them and lower ALLOW_MAX').toEqual([])
  })

  test('the allow-list is a ratchet: it does not grow', () => {
    expect(Object.keys(ALLOW).length).toBeLessThanOrEqual(ALLOW_MAX)
    for (const [sel, why] of Object.entries(ALLOW)) expect(why.length, sel).toBeGreaterThan(10)
  })

  test('the inline style attributes of the components hold no raw spacing, and the count is a ratchet', async () => {
    const found: string[] = []
    for (const file of new Glob('*.tsx').scanSync(new URL('../src/components/', import.meta.url).pathname)) {
      const text = await Bun.file(new URL(`../src/components/${file}`, import.meta.url)).text()
      for (const m of text.matchAll(/(?<![\w:-])(x-bind:)?style=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{\{([^}]*)\}\})/g)) {
        // style={{ marginTop: '13px' }}: an object of camelCase keys, read as css
        if (m[5] !== undefined) { for (const bad of rawIn([...m[5].matchAll(/(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([^,\s]+))/g)].map(k => `${k[1]!.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${k[2] ?? k[3] ?? k[4] ?? k[5]}`).join(';'))) found.push(`${file}: ${bad}`); continue }
        const body = m[2] ?? m[3] ?? m[4] ?? ''
        // a style="..." is css; an x-bind:style is an object of camelCase keys and string values
        const css = m[1]
          ? [...body.matchAll(/\b(gap|margin\w*|padding\w*)\s*:\s*([^,}]*)/g)].map(k => `${k[1]!.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${[...k[2]!.matchAll(/'([^']*)'/g)].map(q => q[1]).join(' ')}`).join(';')
          : body
        for (const bad of rawIn(css.replace(/\$\{[^}]*\}/g, '0'))) found.push(`${file}: ${bad}`)
      }
    }
    expect(found, 'inline spacing outside the scale: use var(--space-N) or a helper class (mt1..mt4, sp1..sp3, ml2, mb2)').toHaveLength(INLINE_RAW_MAX)
  })

  test('the helper classes of the margins are one per step and are the only ones', () => {
    const helpers = PUBLIC_CSS.match(/^\.(?:mt|sp|ml|mb)\d\{[^}]*\}/gm) ?? []
    expect(helpers.length).toBeGreaterThan(0)
    for (const h of helpers) expect(h).toMatch(/var\(--space-[1-5]\)/)
    expect(PUBLIC_CSS).not.toMatch(/\.mt12|\.mt6|\.ml6|\.mb6/)
  })
})
