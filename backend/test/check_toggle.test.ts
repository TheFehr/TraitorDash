import { describe, expect, test } from 'bun:test'
import { PUBLIC_CSS } from '../src/components/styles'

// The two checkboxes of the voice page ("Microphone opens when:") look like the page's toggle buttons: the real input stays in the page (voice.ts reads
// it, the keyboard and screen readers use it) but is hidden accessibly, and its label is drawn as a toggle with a check mark. What this test reads
// is the stylesheet text; the sizes (0 px jump between checked and unchecked, the same height as .tog) were measured in Chromium.

const rule = (sel: string) => new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(PUBLIC_CSS)?.[1]

describe('.vc .check, a multi-choice toggle', () => {
  test('the checkbox is hidden but stays focusable and readable (not display:none)', () => {
    const r = rule('.vc .check input')
    expect(r).toContain('position:absolute')
    expect(r).toContain('opacity:0')
    expect(r).toContain('width:1px')
    expect(r).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })

  test('the label is a toggle: the .tog look, the pressed look on :checked, the padding of .vc .tog', () => {
    const base = rule('.vc .check')
    expect(base).toContain('background:var(--line)')
    expect(base).toContain('color:var(--soft)')
    expect(base).toContain('border:1px solid var(--rule)')
    expect(base).toContain('font-family:var(--cond)')
    expect(base).not.toMatch(/(?:^|;)(?:padding|border-width)/)
    expect(PUBLIC_CSS).toMatch(/\.vc \.tog,\.vc \.check\{[^}]*padding:\.3rem \.9rem/)
    const on = rule('.f.vc .check:has(input:checked)')
    expect(on).toContain('background:#fff8e6')
    expect(on).toContain('color:var(--ink)')
    expect(on).toContain('border-color:var(--ink)')
    expect(on).toContain('box-shadow:inset 0 0 0 1px var(--ink)')
    // size never changes: the pressed look touches no border width, padding, margin or font
    expect(on).not.toMatch(/(?:^|;)(?:border(?:-width)?|padding|margin|font[\w-]*|letter-spacing):/)
  })

  test('the check mark has a reserved width in both states, and there is a focus ring and a disabled look', () => {
    const mark = rule('.vc .check::before')
    expect(mark).toContain('width:1em')
    expect(mark).toContain('color:transparent')
    expect(rule('.f.vc .check:has(input:checked)::before')).toContain('color:var(--ink)')
    expect(rule('.vc .check:has(input:focus-visible)')).toMatch(/outline:\s*2px solid var\(--/)
    expect(rule('.vc .check:has(input:disabled)')).toContain('opacity:.55')
  })
})
