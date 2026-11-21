import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { decodeTrack, damageTotals, shotsByWeapon, type RawTrack, type TrackEvent } from '../src/replaylogic'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 41: what the replay makes of the end mark: the replay's time of it, the totals that stop there, the mark on the bar.

const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
const A = 'A', B = 'B'
const raw = (over: Partial<RawTrack> = {}): RawTrack => ({
  t: [0, 1000, 1000, 1000, 1000], players: [{ id: A, segments: [{ from: 0, x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0] }] }], deaths: [], ...over,
})
const hurt = (t: number, p: string, a: string, d: number): TrackEvent => ({ t, p, k: 'hurt', a, w: 'weapon_zm_mac10', d, h: 50 })

describe('decodeTrack: the end of the round', () => {
  test('the end is in the replay\'s time: the round\'s start is 0, so the preparation is taken off; null for a track without it', () => {
    expect(decodeTrack(raw({ ended: 3000 })).ended).toBe(3000)
    expect(decodeTrack(raw({ ended: 3000, begin: 1000 })).ended).toBe(2000)
    expect(decodeTrack(raw()).ended).toBeNull()
  })
})

describe('the totals stop at the end', () => {
  const events = [hurt(1000, B, A, 10), hurt(2000, A, B, 20), hurt(3500, B, A, 40), { t: 3600, p: A, k: 'shots', w: 'weapon_zm_mac10', n: 7 } as TrackEvent, { t: 2500, p: A, k: 'shots', w: 'weapon_zm_mac10', n: 3 } as TrackEvent]
  test('damage and shots after the end are not counted; at the end itself they are; without an end everything counts', () => {
    expect(damageTotals(events, A, 3000)).toEqual({ took: 20, dealt: 10, healed: 0, shots: 3 })
    expect(damageTotals(events, A, 3500)).toEqual({ took: 20, dealt: 50, healed: 0, shots: 3 })
    expect(damageTotals(events, A)).toEqual({ took: 20, dealt: 50, healed: 0, shots: 10 })
    expect(damageTotals(events, A, null)).toEqual(damageTotals(events, A))
    expect(shotsByWeapon(events, A, 3000)).toEqual([{ w: 'weapon_zm_mac10', n: 3 }])
    expect(shotsByWeapon(events, A)).toEqual([{ w: 'weapon_zm_mac10', n: 10 }])
  })
})

describe('the page', () => {
  test('a mark on the time bar at the end, only when the track has one, and the totals take the end', () => {
    const replay = src('replay.ts')
    expect(replay).toContain("if (ticks && data.ended !== null) {")
    expect(replay).toContain("t.title = `${stamp(data.ended)} Round end`")
    expect(replay).toContain('damageTotals(data.events, selected, data.ended)')
    expect(replay).toContain('shotsByWeapon(data.events, selected, data.ended)')
    expect(PUBLIC_CSS).toContain('.tick-end{width:3px')
  })
})
