import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { decodeTrack, damageTotals, shotsByWeapon, shotsTitle, totalsText, timeMark, EQUIPMENT_KINDS, type RawTrack, type TrackEvent } from '../src/replaylogic'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 26, stage C, package C3: what the replay makes of the shots events: a sum on the selected player's totals line, a tooltip by weapon, nothing in the feed, the list or on the time bar.

const shot = (t: number, p: string, w: string, n: number): TrackEvent => ({ t, p, k: 'shots', w, n })
const hurt = (t: number, p: string, a: string, d: number): TrackEvent => ({ t, p, k: 'hurt', a, w: 'weapon_zm_mac10', d, h: 50 })

describe('the sums', () => {
  const events: TrackEvent[] = [
    shot(1000, 'A', 'weapon_zm_mac10', 20), shot(2200, 'A', 'weapon_zm_mac10', 5), shot(3000, 'A', 'weapon_zm_shotgun', 17), shot(1500, 'B', 'weapon_zm_pistol', 3),
    hurt(1200, 'B', 'A', 22),
  ]
  test('a player\'s shots are the sum of the n of their shots events, and not of anybody else\'s', () => {
    expect(damageTotals(events, 'A')).toEqual({ took: 0, dealt: 22, healed: 0, shots: 42 })
    expect(damageTotals(events, 'B')).toEqual({ took: 22, dealt: 0, healed: 0, shots: 3 })
    expect(damageTotals(events, 'Z').shots).toBe(0)
    expect(damageTotals([], 'A').shots).toBe(0)
  })
  test('the n of a shots event that is not a positive number is not counted; the d of one is not a damage', () => {
    const odd = [{ t: 1, p: 'A', k: 'shots', w: 'x', n: '5' }, { t: 2, p: 'A', k: 'shots', w: 'x', n: 0 }, { t: 3, p: 'A', k: 'shots', w: 'x', n: -4 }, { t: 4, p: 'A', k: 'shots', w: 'x', d: 99, n: 2 }] as unknown as TrackEvent[]
    expect(damageTotals(odd, 'A')).toEqual({ took: 0, dealt: 0, healed: 0, shots: 2 })
  })
  test('the text adds "shot N" after the others; a track without shots keeps the line as it was', () => {
    expect(totalsText({ took: 48, dealt: 22, healed: 10, shots: 37 })).toBe('Took 48, dealt 22, healed 10, shot 37')
    expect(totalsText({ took: 0, dealt: 0, healed: 0, shots: 37 })).toBe('Shot 37')
    expect(totalsText({ took: 0, dealt: 22, healed: 0, shots: 1 })).toBe('Dealt 22, shot 1')
    expect(totalsText({ took: 48, dealt: 22, healed: 10, shots: 0 })).toBe('Took 48, dealt 22, healed 10')
    expect(totalsText({ took: 48, dealt: 22, healed: 10 })).toBe('Took 48, dealt 22, healed 10')
    expect(totalsText({ took: 0, dealt: 0, healed: 0, shots: 0 })).toBe('')
    expect(totalsText({ took: 148, dealt: 122, healed: 100, shots: 1234 })).toBe('Took 148, dealt 122, healed 100, shot 1234')
  })
  test('the shots by weapon: the most first, then by class; a tooltip of display names; nothing when none', () => {
    expect(shotsByWeapon(events, 'A')).toEqual([{ w: 'weapon_zm_mac10', n: 25 }, { w: 'weapon_zm_shotgun', n: 17 }])
    expect(shotsTitle(shotsByWeapon(events, 'A'))).toBe('Shots: MAC10 25, Shotgun 17')
    expect(shotsByWeapon([shot(1, 'A', 'b', 4), shot(2, 'A', 'a', 4)], 'A').map(s => s.w)).toEqual(['a', 'b'])
    expect(shotsByWeapon(events, 'Z')).toEqual([])
    expect(shotsTitle([])).toBe('')
  })
})

describe('decoding and the marks', () => {
  test('the events survive the decoding with their numbers and are in time order', () => {
    const raw: RawTrack = { t: [0, 200], players: [{ id: 'A', segments: [{ from: 0, x: [1, 0], y: [0, 0], z: [0, 0], a: [0, 0] }] }], deaths: [], begin: 100, events: [shot(3100, 'A', 'weapon_zm_mac10', 7), shot(1100, 'A', 'weapon_zm_shotgun', 1)] }
    const d = decodeTrack(raw)
    expect(d.events).toEqual([{ t: 1000, p: 'A', k: 'shots', w: 'weapon_zm_shotgun', n: 1 }, { t: 3000, p: 'A', k: 'shots', w: 'weapon_zm_mac10', n: 7 }])
  })
  test('shots have no mark on the time bar and are not an equipment line of the feed', () => {
    expect(timeMark(shot(1, 'A', 'x', 3))).toBeNull()
    expect(EQUIPMENT_KINDS.has('shots')).toBe(false)
  })
})

describe('the page', () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
  const page = read('components/ReplayPage.tsx'), replay = read('replay.ts')
  const rule = (sel: string) => new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(PUBLIC_CSS)?.[1] ?? ''
  test('the sums are on the one totals line, which keeps its height and cannot widen the card; the sums are made once for each player, not while the time moves', () => {
    expect(page.match(/data-selected-totals/g)).toHaveLength(1)
    expect(rule('.phealth-line')).toMatch(/min-height:/)
    expect(rule('.phealth-line')).toContain('nowrap')
    expect(rule('.phealth-line')).toContain('overflow:hidden')
    expect(rule('.phealth-line')).toContain('text-overflow:ellipsis')
    expect(rule('.phealth-line.two')).toMatch(/height:3em/) // a track with shots: two lines of 1.5em, whatever the text
    expect(rule('.phealth-line.two')).toContain('white-space:normal')
    expect(replay).toContain("totalsLine.classList.toggle('two', kindsInTrack.has('shots'))") // by the whole track, not by the selection
    expect(replay).toContain('totalsText(damageTotals(data.events, selected))')
    expect(replay).toContain('if (!totalsText_.has(selected ?? \'\'))')
    expect(replay).toContain('shotsTitle(shotsByWeapon(data.events, selected))')
  })
  test('shots are not in the feed, not in the player\'s list and not marked on the bar', () => {
    const feedFilter = replay.match(/const feed = data\.events\.filter\(([^\n]*)\n/)![1]!
    expect(feedFilter).not.toContain("'shots'")
    expect(replay).toContain("e.k !== 'shots' && (e.p === selected")
  })
})
