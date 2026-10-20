import { expect, test, describe } from 'bun:test'
import { decodeTrack, stateAt, currentDeath, killerDiedBefore, reviveSource, revivePose, type RawTrack, type TrackEvent, type Death, type Segment } from '../src/replaylogic'

// RFC 14, 4.6: what the replay works out from a track's events.

const death = (victim: string, t: number, attacker: string | null = null): Death => ({ victim, attacker, t, at: [0, 0, 0], from: null, weapon: null })
const revive = (p: string, t: number, extra: Partial<TrackEvent> = {}): TrackEvent => ({ t, p, k: 'revive', ...extra })
const role = (p: string, t: number, r: string, team: string): TrackEvent => ({ t, p, k: 'role', role: r, team })

describe('decodeTrack events', () => {
  const raw = (events?: TrackEvent[]): RawTrack => ({ t: [0, 1000], players: [], deaths: [], ...(events ? { events } : {}) })
  test('a track without events has an empty list, and events come out in time order', () => {
    expect(decodeTrack(raw()).events).toEqual([])
    expect(decodeTrack(raw([revive('A', 900), revive('B', 100)])).events.map(e => e.t)).toEqual([100, 900])
  })
})

describe('stateAt', () => {
  const start = { role: 'innocent', team: 'innocents' }
  const ev = [role('A', 5000, 'zombie', 'zombies'), role('B', 6000, 'traitor', 'traitors'), role('A', 9000, 'innocent', 'innocents')]
  test('the start state before any event, and only that player\'s events', () => {
    expect(stateAt(start, ev, 'A', 4999)).toEqual({ role: 'innocent', team: 'innocents', was: [] })
    expect(stateAt(start, ev, 'C', 99999)).toEqual({ role: 'innocent', team: 'innocents', was: [] })
  })
  test('after an event the new role and team, with the earlier role listed', () => {
    expect(stateAt(start, ev, 'A', 5000)).toEqual({ role: 'zombie', team: 'zombies', was: ['innocent'] })
    expect(stateAt(start, ev, 'B', 7000)).toEqual({ role: 'traitor', team: 'traitors', was: ['innocent'] })
  })
  test('going back to the first role does not list it as an earlier one', () => {
    expect(stateAt(start, ev, 'A', 9500)).toEqual({ role: 'innocent', team: 'innocents', was: ['zombie'] })
  })
})

describe('currentDeath', () => {
  const deaths = [death('A', 1000), death('A', 8000), death('B', 2000)]
  test('dead from the death on, alive again from the revival', () => {
    const ev = [revive('A', 4000)]
    expect(currentDeath(deaths, ev, 'A', 999)).toBeNull()
    expect(currentDeath(deaths, ev, 'A', 3000)?.t).toBe(1000)
    expect(currentDeath(deaths, ev, 'A', 4000)).toBeNull()
    expect(currentDeath(deaths, ev, 'A', 8000)?.t).toBe(8000) // died again after the revival
  })
  test('a revival of someone else, or one before the death, changes nothing', () => {
    expect(currentDeath(deaths, [revive('A', 500), revive('C', 2500)], 'B', 3000)?.t).toBe(2000)
    expect(currentDeath(deaths, [revive('A', 500)], 'A', 3000)?.t).toBe(1000)
  })
})

describe('killerDiedBefore', () => {
  test('the killer died within 30 s before the revival', () => {
    const d = [death('V', 1000, 'K'), death('K', 20000, 'X')]
    expect(killerDiedBefore(d, { p: 'V', t: 22000 })).toEqual({ killer: 'K', seconds: 2 })
  })
  test('nothing when the killer died earlier than 30 s before, after the revival, or before the victim', () => {
    expect(killerDiedBefore([death('V', 1000, 'K'), death('K', 20000)], { p: 'V', t: 50001 })).toBeNull()
    expect(killerDiedBefore([death('V', 1000, 'K'), death('K', 30000)], { p: 'V', t: 22000 })).toBeNull()
    expect(killerDiedBefore([death('K', 500), death('V', 1000, 'K')], { p: 'V', t: 22000 })).toBeNull()
  })
  test('nothing when the victim has no known killer, or the killer did not die', () => {
    expect(killerDiedBefore([death('V', 1000)], { p: 'V', t: 5000 })).toBeNull()
    expect(killerDiedBefore([death('V', 1000, 'K')], { p: 'V', t: 5000 })).toBeNull()
  })
  test('it is the last killer of the victim that counts', () => {
    const d = [death('V', 1000, 'OLD'), death('V', 40000, 'K'), death('OLD', 41000), death('K', 45000)]
    expect(killerDiedBefore(d, { p: 'V', t: 47000 })).toEqual({ killer: 'K', seconds: 2 })
  })
})

describe('reviveSource and revivePose', () => {
  test('names', () => {
    expect(reviveSource(undefined)).toBe('source unknown')
    expect(reviveSource('weapon_ttt_defibrillator')).toBe('Defibrillator')
    expect(reviveSource('role:haunter')).toBe('role: haunter')
  })
  test('the pose is the first sample at or after the revival, only when it is close', () => {
    const seg: Segment = { t: [1000, 5000, 5500], x: [1, 2, 3], y: [0, 0, 0], z: [0, 0, 0], a: [0, 10, 20] }
    expect(revivePose([seg], 4000)).toMatchObject({ x: 2, yaw: 10 })
    expect(revivePose([seg], 5600)).toBeNull()
    expect(revivePose([seg], 1500)).toBeNull() // next sample is 3.5 s away
  })
})
