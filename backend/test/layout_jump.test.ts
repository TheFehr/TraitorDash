// Layout jumps: nothing may move, grow or shrink when an element changes state (pressed, hovered, current, selected...).
//
// What a measurement in Chromium (getBoundingClientRect of every element before and after the state change, at 1100 and 390 px,
// with the real fonts) showed on the shared stylesheet:
//   - a pressed toggle on paper (.f .tog[aria-pressed=true]) was 6.4 px narrower and 7.6 px lower than the unpressed one wherever
//     the toggle's padding is set by another rule (.vc .tog on the voice page): the old pressed rule swapped the 1px border for a
//     2px one and took 1px off the padding on every side, which only cancels when the padding is the base .tog's own; the
//     neighbours moved too. The second pixel of the frame is an inset box-shadow now: border and padding never change.
//   - an `on` link of a .bar (sort, switches, pages) was 1 px wider than the others (Barlow Condensed 800 against 600): the
//     bold on the active link is gone, the filled background marks it.
//   - the current tab of the Tabs component is a <span aria-current>, which none of the .sections rules matched: it had no
//     border and no padding, so it was 22.7 px narrower than a link and its neighbours moved between two tabs.
// No jump: toggles in the replay and map markup (.f and plain), Play/Pause text, hover/focus/active on links, buttons, cards,
// pills, inputs, selects, summary, table rows, the jump bar's current link, the switch, .prow.sel/.dead, :invalid.
// (a.f:hover and .f.card:hover lift the card with transform: translateY(-3px); that moves only the card, not its neighbours.)
import { describe, expect, test } from 'bun:test'
import { ADMIN_CSS, PUBLIC_CSS } from '../src/components/styles'

interface Rule { selector: string, decls: Record<string, string> }

/** The rules of a stylesheet, @media blocks flattened, one entry per selector of a list. */
const parse = (css: string): Rule[] => {
  const out: Rule[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\{[^}]*\}/g, '')
  const walk = (src: string) => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) break
      const head = src.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++ }
      const body = src.slice(open + 1, j - 1)
      if (head.startsWith('@')) walk(body)
      else {
        const decls: Record<string, string> = {}
        for (const d of body.split(';')) {
          const k = d.indexOf(':')
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).replace(/\s*!important/, '').trim()
        }
        for (const s of head.split(',')) out.push({ selector: s.trim(), decls })
      }
      i = j
    }
  }
  walk(text)
  return out
}

const RULES = [...parse(PUBLIC_CSS), ...parse(ADMIN_CSS)]

/** A selector that depends on a state of the element. */
const STATE = /:hover|:focus|:active|:checked|:invalid|:disabled|:target|\[aria-(pressed|current|selected|expanded)|\[disabled|\[open|\.(on|active|open|sel|dirty|current)\b/
// Allowed on purpose: the span of the Tabs component is the BASE box of the current tab (it carries aria-current instead of being an <a>),
// the switch's knob is absolutely positioned (no layout effect), and the phone's role list opens on purpose.
const ALLOWED = new Set(['.sections span[aria-current]', 'input.switch:checked:before', '#roles-toggle:checked~.rbody'])
const stateRules = RULES.filter(r => STATE.test(r.selector) && !ALLOWED.has(r.selector))

describe('the state rules of the shared stylesheet', () => {
  test('there are state rules to check (the parser works)', () => {
    expect(stateRules.length).toBeGreaterThan(20)
    expect(stateRules.some(r => r.selector === '.tog[aria-pressed=true]')).toBe(true)
  })

  test('no state rule changes the box: padding, margin, border width or style, size, display, position, line height, flex', () => {
    // (a rule of a variant class, like .f.few with its dashed border, is not a state: it is not in STATE)
    const BOX = /^(padding|margin|width|height|min-|max-|display|position|line-height|flex|gap|top|left|right|bottom|white-space|content|font-size|letter-spacing|text-transform|font-family)/
    const bad: string[] = []
    for (const r of stateRules) {
      for (const [k, v] of Object.entries(r.decls)) {
        if (BOX.test(k)) bad.push(`${r.selector}{${k}:${v}}`)
        if (k === 'border' || k === 'border-width' || k === 'border-style' || /^border-(top|right|bottom|left)(-width|-style)?$/.test(k)) {
          // a colour-only change is fine; a state that sets a border shorthand must not change its width
          bad.push(`${r.selector}{${k}:${v}}`)
        }
      }
    }
    // `.pill.ok`-style colour classes are not boxes; the three that remain are listed so a new one is a decision, not an accident:
    //  - .filt a:hover, .sections a:hover ... set border-color only (not matched above)
    //  - .jump a[aria-current=true] sets border-bottom-color only (the 3px bottom border is there, transparent, in every state)
    //  - .ritem:hover sets border-left-color only (3px transparent in the base rule)
    expect(bad).toEqual([])
  })

  test('no state rule changes the font weight (a bold link is wider than a regular one), except the monospace filter chips', () => {
    // .filt is only ever inside .f, which is set in Courier Prime: the bold face has the same advance as the regular one
    // (measured: no change), so the chip may be bold when on.
    const MONO = new Set(['.filt a.on'])
    const bad = stateRules.filter(r => 'font-weight' in r.decls && !MONO.has(r.selector)).map(r => `${r.selector}{font-weight:${r.decls['font-weight']}}`)
    expect(bad).toEqual([])
  })

  test('a focus rule is an outline or a shadow, never a border or padding', () => {
    for (const r of stateRules.filter(r => /:focus/.test(r.selector))) {
      expect(Object.keys(r.decls).filter(k => /^(border|padding|margin)/.test(k)), r.selector).toEqual([])
    }
  })

  test('a transform on a state is a translate (the lift of a card), never a scale or a rotate that would overlap', () => {
    for (const r of stateRules.filter(r => 'transform' in r.decls)) expect(r.decls.transform, r.selector).toMatch(/^translateY\(-?\d+px\)$/)
  })
})

describe('the toggle button', () => {
  const tog = RULES.filter(r => /(^|\s)\.tog(\.play)?$/.test(r.selector) || /\.tog\[aria-pressed=true\]$/.test(r.selector) || /^\.vc \.tog$/.test(r.selector))
  const decl = (selector: string) => Object.assign({}, ...RULES.filter(r => r.selector === selector).map(r => r.decls))

  test('the pressed rules (plain and on paper) set neither padding, border width nor border style, so no override of the padding can unbalance them', () => {
    for (const sel of ['.tog[aria-pressed=true]', '.f .tog[aria-pressed=true]']) {
      const d = decl(sel)
      expect(Object.keys(d).filter(k => /^(padding|margin|border|font|letter|line|min-|max-|width|height)/.test(k) && k !== 'border-color'), sel).toEqual([])
    }
  })

  test('the base toggle has a 1px solid border and the pressed rule on paper adds the second pixel inside, as an inset shadow', () => {
    expect(decl('.tog').border).toBe('1px solid var(--rule)')
    const d = decl('.f .tog[aria-pressed=true]')
    expect(d['box-shadow']).toMatch(/^inset 0 0 0 1px /)
  })

  test('pressed or not, the toggle has the same padding and border width wherever its padding comes from', () => {
    // effective padding + border of the pressed state = that of the unpressed one, for the base toggle and the voice page's .vc .tog
    for (const base of ['.tog', '.vc .tog']) {
      const unpressed = { ...decl('.tog'), ...decl(base) }
      const pressedRules = ['.tog[aria-pressed=true]', '.f .tog[aria-pressed=true]'].map(decl)
      const pressed = Object.assign({}, unpressed, ...pressedRules)
      for (const k of ['padding', 'border', 'border-width', 'border-style', 'margin', 'font-size', 'font-weight', 'letter-spacing']) expect(pressed[k], `${base} ${k}`).toBe(unpressed[k])
    }
    expect(tog.length).toBeGreaterThan(2)
  })
})

describe('bars, tabs and chips', () => {
  const has = (selector: string) => RULES.filter(r => r.selector === selector)

  test('the active link of a bar keeps the weight of the others', () => {
    for (const r of has('.bar a.on')) expect(r.decls['font-weight']).toBeUndefined()
  })

  test('the current tab of the Tabs component (a span, not a link) has the same box as a tab link', () => {
    const box = (sel: string) => RULES.filter(r => r.selector === sel && r.decls.border).map(r => r.decls.border + '|' + r.decls.padding)
    expect(box('.sections span[aria-current]')).toEqual(box('.sections a'))
    expect(box('.sections a')[0]).toContain('1px solid')
  })

  test('hover and current rules of the section links change colours only', () => {
    for (const r of RULES.filter(r => /^\.(f )?\.?sections? (a|span)\[aria-current\]|^\.sections a:hover|^\.f \.sections a:hover/.test(r.selector) && !ALLOWED.has(r.selector) && !r.decls.border)) {
      expect(Object.keys(r.decls).filter(k => !/^(background|color|border-color)$/.test(k)), r.selector).toEqual([])
    }
  })

  test('the jump bar keeps a bottom border of the same width in every state', () => {
    expect(RULES.find(r => r.selector === '.jump a')!.decls['border-bottom']).toBe('3px solid transparent')
    expect(Object.keys(RULES.find(r => r.selector === '.jump a[aria-current=true]')!.decls).sort()).toEqual(['border-bottom-color', 'opacity'])
  })

  test('the side list keeps a left border of the same width in every state', () => {
    expect(RULES.find(r => r.selector === '.ritem')!.decls['border-left']).toBe('3px solid transparent')
    expect(Object.keys(RULES.find(r => r.selector === '.ritem:hover')!.decls).sort()).toEqual(['background', 'border-left-color'])
  })
})
