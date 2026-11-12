import { expect, test, describe } from 'bun:test'
import { PUBLIC_CSS, ADMIN_CSS } from '../src/components/styles'

// Text contrast on the paper cards. The palette (docs/UI_DESIGN.md, 2b) says which colour is for which ground: --muted is for the DARK ground,
// --dim is "quiet text on paper". The voice page used the class "muted" inside its paper cards and got --muted on paper: a contrast ratio of
// 1.98:1 (the usual minimum for text is 4.5:1), which the owner could not read. These tests keep the palette's rule: quiet text on a paper
// card is --dim or darker, and --muted comes back on the cards that are dark (.f.few, .f.off).

const root = /:root\{([^}]*)\}/.exec(PUBLIC_CSS)?.[1] ?? ''
const vars: Record<string, string> = Object.fromEntries([...root.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})/g)].map(m => [m[1]!, m[2]!]))

function lum(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }
const paper = vars.paper!
const AA = 4.5

describe('text contrast on the cards', () => {
  test('the palette: --muted is for the dark ground and fails on paper; --dim, --ink2 and --ink are for paper and pass', () => {
    expect(paper).toBeDefined()
    expect(ratio(vars.muted!, paper)).toBeLessThan(3) // 1.98 : 1 on paper
    for (const name of ['dim', 'ink2', 'ink']) expect(ratio(vars[name]!, paper), name).toBeGreaterThanOrEqual(AA)
    expect(ratio(vars.muted!, vars.night!)).toBeGreaterThanOrEqual(AA) // and it is fine on the dark ground it was made for
  })

  test('quiet text inside a paper card (.f .muted) is --dim, and the dark cards (.f.few, .f.off) keep --muted', () => {
    const rule = (sel: string) => new RegExp('^' + sel.replace(/[.[\]=]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(PUBLIC_CSS)?.[1]
    expect(rule('.f .muted')).toContain('color:var(--dim)')
    expect(rule('.muted')).toContain('color:var(--muted)') // everywhere else it stays what it was (the dark ground)
    const dark = /\.f\.few,\.f\.off\{background:(#[0-9a-fA-F]{6})/.exec(PUBLIC_CSS)?.[1]
    expect(dark).toBeDefined()
    expect(PUBLIC_CSS).toMatch(/\.f\.few \.muted,\.f\.off \.muted\{color:var\(--muted\)\}/)
    expect(ratio(vars.muted!, dark!)).toBeGreaterThanOrEqual(AA)
  })

  test('no rule gives text on a paper card a colour that fails on paper (a ratchet: the known ones are listed and the list may only shrink)', () => {
    // rules whose selector is inside a paper card (.f), not a dark one, that set a colour from the palette
    const found: string[] = []
    for (const m of (PUBLIC_CSS + ADMIN_CSS).matchAll(/(^|\})\s*([^{}@][^{}]*)\{([^}]*)\}/g)) {
      const sels = m[2]!.split(',').map(s => s.trim())
      const color = /(?:^|;)\s*color:var\(--([\w-]+)\)/.exec(m[3]!)?.[1]
      if (!color || !vars[color]) continue
      // A rule that paints its own ground (the filled current tab, the filled active link) is light text on a dark fill: judged against that, not paper.
      if (/(?:^|;)\s*background(?:-color)?:/.test(m[3]!)) continue
      for (const s of sels) {
        if (!/^\.f(\s|$|[.:[])/.test(s) && !/\s\.f\s/.test(' ' + s + ' ')) continue
        if (/\.few|\.off|\.dark|\.pn/.test(s)) continue
        if (ratio(vars[color]!, paper) < AA) found.push(`${s} {color:var(--${color})}`)
      }
    }
    // Known (to be looked at in their own change): none are expected; if this list is not empty the rules are named in the failure.
    const KNOWN: string[] = []
    expect(found.filter(f => !KNOWN.includes(f)), 'text on a paper card in a colour with a contrast under 4.5 : 1 on paper').toEqual([])
  })
})
