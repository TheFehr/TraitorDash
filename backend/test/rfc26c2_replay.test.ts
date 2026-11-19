import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import {
  decodeTrack, lastEventAt, holdAt, creditsAt, karmaAt, watchingAt, holdingText, creditsLine, karmaLine, watchingText, creditsOwnText, karmaOwnText, specOwnText, timeMark, EQUIPMENT_KINDS,
  type RawTrack, type TrackEvent,
} from '../src/replaylogic'
import { weaponName, creditReason, karmaReason } from '../src/weaponName'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 26, stage C, package C2: what the replay makes of the weapon in hand, credits, karma and the target of a dead player.

const nick = (id: string) => ({ A: 'TheFehr', B: 'Tonda', C: 'Scip.MLP' }[id] ?? id)
const ev = (e: Partial<TrackEvent> & Pick<TrackEvent, 'k'>): TrackEvent => ({ t: 1000, p: 'A', ...e })

describe('decoding', () => {
  const raw = (events: TrackEvent[], begin?: number): RawTrack => ({
    ...(begin !== undefined ? { begin } : {}), t: [0, 200, 200], players: [{ id: 'A', segments: [{ from: 0, x: [1, 0, 0], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [], events,
  })

  test('hold, credits, karma and spec events are kept by player and kind in time order, with the preparation taken off their times', () => {
    const d = decodeTrack(raw([
      ev({ k: 'hold', t: 900, w: 'weapon_zm_mac10' }), ev({ k: 'hold', t: 300, w: 'weapon_ttt_m16' }), ev({ k: 'hold', t: 500, p: 'B', w: 'weapon_zm_shotgun' }),
      ev({ k: 'credits', t: 700, d: 1, c: 4, w: 'kill' }), ev({ k: 'karma', t: 800, d: -40, c: 960, w: 'teamhurt' }), ev({ k: 'spec', t: 850, p: 'B', of: 'A' }), ev({ k: 'buy', t: 400, item: 'x' }),
    ], 100))
    expect(d.polled.hold.get('A')!.map(e => [e.w, e.t])).toEqual([['weapon_ttt_m16', 200], ['weapon_zm_mac10', 800]])
    expect(d.polled.hold.get('B')!.map(e => e.t)).toEqual([400])
    expect(d.polled.credits.get('A')!).toHaveLength(1)
    expect(d.polled.karma.get('A')![0]).toMatchObject({ d: -40, c: 960, w: 'teamhurt', t: 700 })
    expect(d.polled.spec.get('B')![0]).toMatchObject({ of: 'A', t: 750 })
    expect(d.polled.spec.get('A')).toBeUndefined()
    expect(d.events).toHaveLength(7) // they are in the list of events too
  })

  test('a track without any of them decodes as before: empty maps', () => {
    const d = decodeTrack(raw([ev({ k: 'buy', item: 'x' })]))
    expect([d.polled.hold.size, d.polled.credits.size, d.polled.karma.size, d.polled.spec.size]).toEqual([0, 0, 0, 0])
    expect(decodeTrack(raw([])).polled.hold.size).toBe(0)
  })
})

describe('what a player held, had and watched at a time', () => {
  const holds = [ev({ k: 'hold', t: 0, w: 'weapon_ttt_m16' }), ev({ k: 'hold', t: 1000, w: 'weapon_zm_mac10' })]

  test('the last event at or before the time, by a search that finds the edges', () => {
    expect(lastEventAt(holds, -1)).toBeNull()
    expect(lastEventAt(holds, 0)).toBe(holds[0]!)
    expect(lastEventAt(holds, 999)).toBe(holds[0]!)
    expect(lastEventAt(holds, 1000)).toBe(holds[1]!)
    expect(lastEventAt(holds, 1e9)).toBe(holds[1]!)
    expect(lastEventAt([], 5)).toBeNull()
    expect(lastEventAt(undefined, 5)).toBeNull()
    const many = Array.from({ length: 101 }, (_, i) => ev({ k: 'hold', t: i * 10, w: 'w' + i }))
    for (const t of [0, 5, 10, 499, 500, 995, 1000]) expect(lastEventAt(many, t)!.w).toBe('w' + Math.floor(t / 10))
  })

  test('the weapon in hand: what was recorded last, nothing before the first or for nobody, nothing while dead', () => {
    expect(holdAt(holds, 500, false)).toBe('weapon_ttt_m16')
    expect(holdAt(holds, 1500, false)).toBe('weapon_zm_mac10')
    expect(holdAt(holds, -5, false)).toBeNull()
    expect(holdAt(holds, 1500, true)).toBeNull()
    expect(holdAt(undefined, 1500, false)).toBeNull()
    expect(holdingText('weapon_zm_mac10')).toBe('Holding MAC10')
  })

  test('credits: the amount after the last change; before the first the amount the first change started from; nothing without a change of the player or while dead', () => {
    const cr = [ev({ k: 'credits', t: 1000, d: 1, c: 4, w: 'kill' }), ev({ k: 'credits', t: 2000, d: -2, c: 2, w: 'buy' })]
    expect(creditsAt(cr, 999, false)).toBe(3)
    expect(creditsAt(cr, 1000, false)).toBe(4)
    expect(creditsAt(cr, 1999, false)).toBe(4)
    expect(creditsAt(cr, 2000, false)).toBe(2)
    expect(creditsAt(cr, 1500, true)).toBeNull()
    expect(creditsAt(undefined, 1500, false)).toBeNull()
    expect(creditsAt([], 1500, false)).toBeNull()
    expect(creditsAt([ev({ k: 'credits', t: 1000, d: 300, c: 5, w: 'other' })], 0, false)).toBe(0) // never below 0
    expect(creditsAt([ev({ k: 'credits', t: 1000, d: -300, c: 5, w: 'other' })], 0, false)).toBe(255) // never above 255
    expect(creditsLine(3)).toBe('Credits 3')
    expect(creditsLine(0)).toBe('Credits 0')
  })

  test('karma: the amount after the last change; nothing before the first (a server\'s maximum cuts it, the start cannot be worked out); still there when dead', () => {
    const ka = [ev({ k: 'karma', t: 1000, d: -40, c: 960, w: 'teamhurt' }), ev({ k: 'karma', t: 2000, d: 10, c: 970, w: 'cleanround' })]
    expect(karmaAt(ka, 999)).toBeNull()
    expect(karmaAt(ka, 1000)).toBe(960)
    expect(karmaAt(ka, 2500)).toBe(970)
    expect(karmaAt(undefined, 5)).toBeNull()
    expect(karmaLine(940)).toBe('Karma 940')
  })

  test('whom a dead player watches: the last target since the death; a target from an earlier death, a living player and an event with no player are nobody', () => {
    const sp = [ev({ k: 'spec', t: 1000, of: 'B' }), ev({ k: 'spec', t: 2000 }), ev({ k: 'spec', t: 5000, of: 'C' })]
    expect(watchingAt(sp, 1500, 900)).toBe('B')
    expect(watchingAt(sp, 2500, 900)).toBeNull() // stopped watching
    expect(watchingAt(sp, 5000, 900)).toBe('C')
    expect(watchingAt(sp, 1500, null)).toBeNull() // alive
    expect(watchingAt(sp, 4000, 3000)).toBeNull() // the last target is from before this death
    expect(watchingAt([ev({ k: 'spec', t: 1000, of: 'B' })], 4000, 3000)).toBeNull() // a target of an earlier death is not this death's
    expect(watchingAt(sp, 5000, 5000)).toBe('C') // at the very time of the death
    expect(watchingAt(sp, 500, 400)).toBeNull()
    expect(watchingAt(undefined, 500, 400)).toBeNull()
    expect(watchingText('Scip.MLP')).toBe('Watching Scip.MLP')
  })
})

describe('the lines of the lists', () => {
  test('credits: the sign, the reason in words, what is left; no reason for "other"; a word of a later bridge as it is', () => {
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 3, w: 'kill' }))).toBe('credits +1 (kill), 3 left')
    expect(creditsOwnText(ev({ k: 'credits', d: -1, c: 2, w: 'buy' }))).toBe('credits -1 (bought), 2 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 2, c: 5, w: 'found' }))).toBe('credits +2 (found on a body), 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 5, w: 'team' }))).toBe('credits +1 (team award), 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: -1, c: 5, w: 'give' }))).toBe('credits -1 (given), 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 5, w: 'got' }))).toBe('credits +1 (received), 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 5, w: 'other' }))).toBe('credits +1, 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 5, w: 'refund' }))).toBe('credits +1 (refund), 5 left')
    expect(creditsOwnText(ev({ k: 'credits', d: 1, c: 0 }))).toBe('credits +1, 0 left')
  })

  test('karma: the sign, the reason in words, what is left', () => {
    expect(karmaOwnText(ev({ k: 'karma', d: -40, c: 960, w: 'teamhurt' }))).toBe('karma -40 (team damage), 960 left')
    expect(karmaOwnText(ev({ k: 'karma', d: -100, c: 860, w: 'teamkill' }))).toBe('karma -100 (team kill), 860 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 5, c: 965, w: 'enemykill' }))).toBe('karma +5 (enemy kill), 965 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 5, c: 965, w: 'enemyhurt' }))).toBe('karma +5 (enemy damage), 965 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 30, c: 995, w: 'cleanround' }))).toBe('karma +30 (clean round), 995 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 3, c: 995, w: 'roundheal' }))).toBe('karma +3 (healing), 995 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 3, c: 995, w: 'unknown' }))).toBe('karma +3, 995 left')
    expect(karmaOwnText(ev({ k: 'karma', d: 3, c: 995, w: 'other' }))).toBe('karma +3, 995 left')
  })

  test('the target: a name, or nobody', () => {
    expect(specOwnText(ev({ k: 'spec', of: 'C' }), nick)).toBe('watches Scip.MLP')
    expect(specOwnText(ev({ k: 'spec' }), nick)).toBe('watches nobody')
  })

  test('the words for the reasons are not taken from the prototype: a reason called constructor is shown as the word it is', () => {
    expect(creditReason('constructor')).toBe('constructor')
    expect(karmaReason('toString')).toBe('toString')
    expect(creditReason(undefined)).toBe('')
    expect(karmaReason(undefined)).toBe('')
    expect(weaponName('weapon_zm_mac10')).toBe('MAC10') // the weapons' own names are untouched
  })
})

describe('what stays out of the feed and the time bar', () => {
  test('no mark on the time bar for any of the four kinds, and none of them is an equipment line of the feed', () => {
    for (const k of ['hold', 'credits', 'karma', 'spec'] as const) {
      expect(timeMark(ev({ k }))).toBeNull()
      expect(EQUIPMENT_KINDS.has(k)).toBe(false)
    }
  })
})

describe('the page', () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
  const page = read('components/ReplayPage.tsx'), replay = read('replay.ts')
  const rule = (sel: string) => new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(PUBLIC_CSS)?.[1] ?? ''

  test('the selected player has four more lines, hidden until the track has events of their kind, each of the height of a line, so nothing moves with the time or the selection', () => {
    for (const a of ['hold', 'credits', 'karma', 'watch']) expect(page).toContain(`<p data-selected-${a} class="phealth-line" hidden></p>`)
    expect(replay).toContain("line.hidden = !kindsInTrack.has(kind)")
    expect(replay).toContain("const kindsInTrack = new Set(data.events.map(e => e.k))")
    expect(rule('.phealth-line')).toMatch(/min-height:/)
    expect(rule('.phealth-line')).toContain('nowrap')
    expect(rule('.phealth-line')).toContain('text-overflow:ellipsis') // a long name does not widen the card
  })

  test('the lines follow the time and the selection, and a dead player has no weapon or credits and a living one no target', () => {
    expect(replay).toContain('const death = selected ? currentDeath(data.deaths, data.events, selected, ms) : null')
    expect(replay).toContain('holdAt(data.polled.hold.get(selected), ms, dead)')
    expect(replay).toContain('creditsAt(data.polled.credits.get(selected), ms, dead)')
    expect(replay).toContain('karmaAt(data.polled.karma.get(selected), ms)')
    expect(replay).toContain('watchingAt(data.polled.spec.get(selected), ms, death ? death.t : null)')
    expect(replay).toContain('    showPolled()\n')
  })

  test('the list of the player has their credits, karma and target but not the weapon in hand; none of the four is a line of the feed', () => {
    expect(replay).toContain("e.k !== 'hold' && (e.p === selected")
    expect(replay).toContain("case 'credits': return creditsOwnText(e)")
    expect(replay).toContain("case 'karma': return karmaOwnText(e)")
    expect(replay).toContain("case 'spec': return specOwnText(e, nick)")
    const feedFilter = replay.match(/const feed = data\.events\.filter\(([^\n]*)\n/)![1]!
    for (const k of ['hold', 'credits', 'karma', 'spec']) expect(feedFilter).not.toContain(`'${k}'`)
  })
})
