import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { decodeTrack, isTalking, timeMark, type RawTrack } from '../src/replaylogic'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 26, stage C, package C4: what the replay makes of `talk`: a lookup, a dot at the name in the list, a line in the selected player's card;
// nothing in the feed, in the lists of events or on the time bar.

const raw = (extra: Partial<RawTrack> = {}): RawTrack => ({ t: [0, 200, 200], players: [], deaths: [], ...extra })
const read = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')

describe('decodeTrack and isTalking', () => {
  test('a track without talk has an empty map; the field is optional', () => {
    expect(decodeTrack(raw()).talk.size).toBe(0)
    expect(decodeTrack(raw({ talk: [] })).talk.size).toBe(0)
  })
  test('each player\'s spans come out in order, as [from, to)', () => {
    const d = decodeTrack(raw({ talk: [{ p: 'B', from: 5000, to: 6000 }, { p: 'A', from: 3000, to: 4000 }, { p: 'A', from: 1000, to: 2000 }] }))
    expect(d.talk.get('A')).toEqual([[1000, 2000], [3000, 4000]])
    expect(d.talk.get('B')).toEqual([[5000, 6000]])
  })
  test('overlapping or touching spans are one, so the lookup is sure; backwards, empty and malformed ones are left out', () => {
    const d = decodeTrack(raw({ talk: [{ p: 'A', from: 1000, to: 3000 }, { p: 'A', from: 2000, to: 2500 }, { p: 'A', from: 3000, to: 4000 }, { p: 'A', from: 9, to: 9 }, { p: 'A', from: 8, to: 2 },
      { p: 'A', from: NaN, to: 5 }, { p: 7, from: 1, to: 2 }, null] as any }))
    expect(d.talk.get('A')).toEqual([[1000, 4000]])
    expect(d.talk.size).toBe(1)
  })
  test('the times are since the round\'s start, whatever `begin` (the preparation) is: they are not moved with the track\'s own times', () => {
    const d = decodeTrack(raw({ begin: 5000, talk: [{ p: 'A', from: 1000, to: 2000 }] }))
    expect(d.talk.get('A')).toEqual([[1000, 2000]])
  })
  test('isTalking: inside a span, the start included and the end not; none for nobody, a missing list or an empty one', () => {
    const spans: [number, number][] = [[1000, 2000], [3000, 3500], [9000, 12000]]
    for (const [t, want] of [[-5, false], [999, false], [1000, true], [1999, true], [2000, false], [2500, false], [3000, true], [3499, true], [3500, false], [8999, false], [9000, true], [11999, true], [12000, false], [1e9, false]] as const) {
      expect(isTalking(spans, t), String(t)).toBe(want)
    }
    expect(isTalking(undefined, 1000)).toBe(false)
    expect(isTalking([], 1000)).toBe(false)
  })
  test('isTalking agrees with a plain scan for every millisecond of a busy list', () => {
    const spans: [number, number][] = Array.from({ length: 40 }, (_, i) => [i * 100 + 7, i * 100 + 7 + (i % 5) * 13 + 1])
    for (let t = 0; t < 4100; t++) expect(isTalking(spans, t), String(t)).toBe(spans.some(s => t >= s[0] && t < s[1]))
  })
})

describe('nothing else uses it', () => {
  test('talk is not an event: it has no mark on the time bar and no kind', () => {
    expect(timeMark({ t: 1, p: 'A', k: 'talk' } as any)).toBeNull()
    const replay = read('replay.ts')
    expect(replay).not.toMatch(/k === 'talk'/)
  })
})

describe('the page', () => {
  const replay = read('replay.ts'), page = read('components/ReplayPage.tsx')
  const css = PUBLIC_CSS
  const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.]/g, '\\.') + '\\{([^}]*)\\}'))![1]!
  const hex = (name: string) => css.match(new RegExp(`--${name}:(#[0-9a-fA-F]{6})`))![1]!
  const lum = (h: string) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]! }
  const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }

  test('the card has its line, hidden in the page and shown only when the track has talk (so an older track keeps its card)', () => {
    expect(page).toContain('<p data-selected-talk class="phealth-line" hidden></p>')
    expect(replay).toContain('lineTalk.hidden = data.talk.size === 0')
  })
  test('the list has a dot of its own only when the track has talk, of fixed size whether on or off, so a row never moves', () => {
    expect(replay).toContain("const talkEl = hasTalk ? text('', 'span', 'ptalk') : null")
    expect(replay).toContain('const hasTalk = data.talk.size > 0')
    expect(rule('.ptalk')).toMatch(/width:\.6rem/); expect(rule('.ptalk')).toMatch(/height:\.6rem/); expect(rule('.ptalk')).toContain('flex:none')
    expect(rule('.ptalk.on')).not.toMatch(/width|height|margin|padding|border/) // the "on" state changes colour only
  })
  test('the dot passes 3 : 1 on the paper of the card and on the selected row; the "Speaking" line is --dim text on paper (4.5 : 1)', () => {
    const paper = hex('paper'), ink = hex('ink'), okOnPaper = css.match(/--st-ok:(#[0-9a-fA-F]{6})/)![1]!
    expect(rule('.ptalk.on')).toContain('var(--st-ok)')
    expect(ratio(okOnPaper, paper)).toBeGreaterThanOrEqual(3)
    expect(rule('.prow.sel .ptalk.on')).toContain('var(--good)')
    expect(ratio(hex('good'), ink)).toBeGreaterThanOrEqual(3)
    expect(ratio(hex('dim'), paper)).toBeGreaterThanOrEqual(4.5)
  })
  test('the marker is not announced by colour alone: it has a title and an aria-label while on', () => {
    expect(replay).toContain("dot.title = on ? 'Speaking' : ''")
    expect(replay).toContain("dot.setAttribute('aria-label', 'Speaking')")
  })
  test('it is written only when it changes (the dot), and both drawings use the shared function that does it', () => {
    expect(replay).toContain("if (dot.classList.contains('on') !== on)")
    const flat = read('replayflat.ts')
    expect(flat).not.toContain('isTalking') // the flat drawing only calls `lists`, which calls showHealth, which is where it is written
  })
  test('the feed filter does not take talk, and the events list never has it', () => {
    const feed = replay.slice(replay.indexOf('const feed = data.events.filter'), replay.indexOf('const feed = data.events.filter') + 400)
    expect(feed).not.toContain('talk')
  })
})
