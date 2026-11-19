import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import {
  decodeTrack, equipText, equipOwnText, c4Text, c4OwnText, dnaText, dnaOwnText, tbtnText, tbtnOwnText, hiddenPickups, BUY_PICKUP_MS, timeMark, c4Charges, c4At, C4_COLOURS, EQUIPMENT_KINDS,
  type RawTrack, type TrackEvent,
} from '../src/replaylogic'
import { weaponName } from '../src/weaponName'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 26, stage C, package C1: what the replay makes of weapon pickups and drops, C4, DNA scans and traitor buttons.

const nick = (id: string) => ({ A: 'TheFehr', B: 'Tonda', C: 'Scip.MLP' }[id] ?? id)
const ev = (e: Partial<TrackEvent> & Pick<TrackEvent, 'k'>): TrackEvent => ({ t: 1000, p: 'A', ...e })

describe('the feed lines of equipment', () => {
  test('a pickup and a drop name the player and the weapon as the statistics pages do', () => {
    expect(equipText(ev({ k: 'wpick', p: 'B', w: 'weapon_zm_shotgun' }), nick)).toBe('Tonda picked up Shotgun')
    expect(equipText(ev({ k: 'wdrop', p: 'B', w: 'weapon_zm_mac10' }), nick)).toBe('Tonda dropped MAC10')
    expect(equipText(ev({ k: 'wpick', p: 'B', w: 'weapon_ttt_something_new' }), nick)).toBe('Tonda picked up Something new')
    expect(equipOwnText(ev({ k: 'wdrop', w: 'weapon_ttt_c4' }))).toBe('dropped C4')
    expect(equipOwnText(ev({ k: 'wpick', w: 'weapon_ttt_m16' }))).toBe('picked up M16')
  })

  test('C4: who armed it and for how long, who defused it and whose it was, a wrong wire, an explosion', () => {
    expect(c4Text(ev({ k: 'c4', st: 'plant', p: 'B', s: 45 }), nick)).toBe('Tonda armed a C4 (45 s)')
    expect(c4Text(ev({ k: 'c4', st: 'plant', p: 'B' }), nick)).toBe('Tonda armed a C4')
    expect(c4Text(ev({ k: 'c4', st: 'defuse', p: 'C', of: 'B' }), nick)).toBe('Scip.MLP defused the C4 of Tonda')
    expect(c4Text(ev({ k: 'c4', st: 'defuse', p: 'C' }), nick)).toBe('Scip.MLP defused a C4')
    expect(c4Text(ev({ k: 'c4', st: 'fail', p: 'C', of: 'B' }), nick)).toBe("Scip.MLP cut the wrong wire of Tonda's C4")
    expect(c4Text(ev({ k: 'c4', st: 'fail', p: 'C' }), nick)).toBe('Scip.MLP cut the wrong wire of a C4')
    expect(c4Text(ev({ k: 'c4', st: 'boom', p: 'B' }), nick)).toBe("Tonda's C4 exploded")
  })

  test('C4 in a player\'s own list reads from their side: the one who acted, and the owner whose charge it was', () => {
    const plant = ev({ k: 'c4', st: 'plant', p: 'B', s: 45 }), defuse = ev({ k: 'c4', st: 'defuse', p: 'C', of: 'B' }), fail = ev({ k: 'c4', st: 'fail', p: 'C', of: 'B' }), boom = ev({ k: 'c4', st: 'boom', p: 'B' })
    expect(c4OwnText(plant, nick, 'B')).toBe('armed a C4 (45 s)')
    expect(c4OwnText(defuse, nick, 'C')).toBe('defused the C4 of Tonda')
    expect(c4OwnText(defuse, nick, 'B')).toBe('had a C4 defused by Scip.MLP')
    expect(c4OwnText(fail, nick, 'C')).toBe("cut the wrong wire of Tonda's C4")
    expect(c4OwnText(fail, nick, 'B')).toBe('had Scip.MLP cut the wrong wire of their C4')
    expect(c4OwnText(boom, nick, 'B')).toBe('had a C4 explode')
    expect(c4OwnText(ev({ k: 'c4', st: 'defuse', p: 'B', of: 'B' }), nick, 'B')).toBe('defused their own C4')
    expect(c4OwnText(ev({ k: 'c4', st: 'fail', p: 'B', of: 'B' }), nick, 'B')).toBe('cut the wrong wire of their own C4')
  })

  test('DNA: whose, and from what; a body is "a body", another class is named, nothing when the bridge did not say; in the list of the one whose DNA it was', () => {
    expect(dnaText(ev({ k: 'dna', p: 'B', of: 'C', w: 'prop_ragdoll' }), nick)).toBe('Tonda took the DNA of Scip.MLP from a body')
    expect(dnaText(ev({ k: 'dna', p: 'B', of: 'C', w: 'weapon_zm_shotgun' }), nick)).toBe('Tonda took the DNA of Scip.MLP from Shotgun')
    expect(dnaText(ev({ k: 'dna', p: 'B', w: 'prop_ragdoll' }), nick)).toBe('Tonda took a DNA sample from a body')
    expect(dnaText(ev({ k: 'dna', p: 'B' }), nick)).toBe('Tonda took a DNA sample')
    expect(dnaText(ev({ k: 'dna', p: 'B', of: 'B', w: 'prop_ragdoll' }), nick)).toBe('Tonda took their own DNA from a body')
    expect(dnaOwnText(ev({ k: 'dna', p: 'B', of: 'C', w: 'prop_ragdoll' }), nick, 'B')).toBe('took the DNA of Scip.MLP from a body')
    expect(dnaOwnText(ev({ k: 'dna', p: 'B', of: 'C', w: 'prop_ragdoll' }), nick, 'C')).toBe('had their DNA taken by Tonda from a body')
  })

  test('a traitor button: the mapper\'s text in brackets when there is one', () => {
    expect(tbtnText(ev({ k: 'tbtn', p: 'C', n: 'Open the vent' }), nick)).toBe('Scip.MLP used a traitor button (Open the vent)')
    expect(tbtnText(ev({ k: 'tbtn', p: 'C' }), nick)).toBe('Scip.MLP used a traitor button')
    expect(tbtnOwnText(ev({ k: 'tbtn', n: 'Trap' }))).toBe('used a traitor button (Trap)')
  })

  test('the display names the lines rely on', () => {
    expect(['weapon_ttt_c4', 'weapon_zm_improvised', 'prop_ragdoll'].map(weaponName)).toEqual(['C4', 'Crowbar', 'Prop ragdoll'])
  })
})

describe('hiding the pickup that sits next to its purchase', () => {
  const buy = (t: number, p = 'A', item = 'weapon_zm_mac10') => ev({ k: 'buy', t, p, item })
  const pick = (t: number, p = 'A', w = 'weapon_zm_mac10') => ev({ k: 'wpick', t, p, w })

  test('a pickup of the bought class by the same player within 1 500 ms of the purchase, before or after, is hidden', () => {
    const after = pick(1000 + BUY_PICKUP_MS), before = pick(1000 - BUY_PICKUP_MS), just = pick(1000)
    expect(hiddenPickups([buy(1000), before, just, after]).size).toBe(3)
    expect(BUY_PICKUP_MS).toBe(1500)
  })

  test('one millisecond more is not hidden; another class, another player, a drop, and a pickup with no purchase are not hidden', () => {
    const late = pick(1000 + BUY_PICKUP_MS + 1), early = pick(1000 - BUY_PICKUP_MS - 1)
    const other = pick(1000, 'A', 'weapon_zm_shotgun'), stranger = pick(1000, 'B'), alone = pick(9000)
    const drop = ev({ k: 'wdrop', t: 1000, w: 'weapon_zm_mac10' })
    const hidden = hiddenPickups([buy(1000), late, early, other, stranger, alone, drop])
    expect(hidden.size).toBe(0)
  })

  test('the purchase\'s class is cut as the bridge cuts it (a long class is 64 characters in a purchase and 40 in a pickup)', () => {
    const cls = 'weapon_' + 'x'.repeat(50)
    expect(hiddenPickups([buy(1000, 'A', cls), pick(1100, 'A', cls.slice(0, 40))]).size).toBe(1)
  })

  test('the page uses it for the feed only: the selected player\'s own list still has every pickup', () => {
    const replay = fs.readFileSync(path.join(import.meta.dir, '../src/replay.ts'), 'utf8')
    expect(replay).toContain('const covered = hiddenPickups(data.events)')
    expect(replay).toContain('&& !covered.has(e))')
    const mine = replay.slice(replay.indexOf('const mine = data.events.filter'), replay.indexOf('const mine = data.events.filter') + 400)
    expect(mine).not.toContain('covered')
  })
})

describe('the marks of the time bar: C4 only, besides revivals and role changes', () => {
  test('an arming, a defuse, a wrong wire (the defuse colour) and an explosion have marks of their own', () => {
    expect(timeMark(ev({ k: 'c4', st: 'plant' }))).toEqual({ cls: 'tick-c4plant', mark: 'c4plant' })
    expect(timeMark(ev({ k: 'c4', st: 'defuse' }))).toEqual({ cls: 'tick-c4defuse', mark: 'c4defuse' })
    expect(timeMark(ev({ k: 'c4', st: 'fail' }))).toEqual({ cls: 'tick-c4defuse', mark: 'c4defuse' })
    expect(timeMark(ev({ k: 'c4', st: 'boom' }))).toEqual({ cls: 'tick-c4boom', mark: 'c4boom' })
    expect(timeMark(ev({ k: 'revive' }))).toEqual({ cls: 'tick-revive', mark: 'revive' })
    expect(timeMark(ev({ k: 'role' }))).toEqual({ cls: 'tick-role', mark: 'role' })
  })

  test('no other kind has a mark: a mark for every shot, button or weapon would bury the deaths', () => {
    for (const k of ['say', 'buy', 'found', 'pickup', 'drop', 'hurt', 'heal', 'wpick', 'wdrop', 'dna', 'tbtn'] as const) expect(timeMark(ev({ k })), k).toBeNull()
    expect([...EQUIPMENT_KINDS].sort()).toEqual(['c4', 'dna', 'tbtn', 'wdrop', 'wpick'])
  })

  test('the CSS has the three colours, which stand out from the page\'s dark ground (3 : 1) and from each other', () => {
    for (const [cls, colour] of [['tick-c4plant', C4_COLOURS.plant], ['tick-c4defuse', C4_COLOURS.defuse], ['tick-c4boom', C4_COLOURS.boom]]) {
      expect(PUBLIC_CSS, cls).toContain(`.${cls}{background:${colour}}`)
    }
    const rootVars = /:root\{([^}]*)\}/.exec(PUBLIC_CSS)?.[1] ?? ''
    const desk = /--desk:(#[0-9a-fA-F]{6})/.exec(rootVars)?.[1]!
    const lum = (hex: string) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    }
    const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }
    for (const c of Object.values(C4_COLOURS)) expect(ratio(c, desk), c).toBeGreaterThanOrEqual(3)
    const all = [...Object.values(C4_COLOURS), '#dc2626', '#34d399', '#a78bfa']
    expect(new Set(all).size).toBe(all.length)
  })

  test('the page draws its marks from timeMark, so no kind is on the bar that it does not name', () => {
    const replay = fs.readFileSync(path.join(import.meta.dir, '../src/replay.ts'), 'utf8')
    expect(replay).toContain('const mark = timeMark(e)')
    expect(replay).toContain('t.dataset.mark = mark.mark')
  })
})

describe('the lifetime of a C4 charge with a place', () => {
  const U = 8
  const plant = (t: number, p: string, x: number, extra: Partial<TrackEvent> = {}) => ev({ k: 'c4', st: 'plant', t, p, x, y: 2, z: 3, ...extra })
  const end = (st: 'defuse' | 'fail' | 'boom', t: number, p: string, extra: Partial<TrackEvent> = {}) => ev({ k: 'c4', st, t, p, ...extra })

  test('a charge lasts from its arming to the defuse that names its place, with the place in Source units; one never ended lasts to the end', () => {
    const c = c4Charges([plant(1000, 'B', 10), plant(2000, 'B', 20), end('defuse', 3000, 'C', { of: 'B', x: 10, y: 2, z: 3 })])
    expect(c).toEqual([{ owner: 'B', x: 10 * U, y: 2 * U, z: 3 * U, from: 1000, until: 3000 }, { owner: 'B', x: 20 * U, y: 2 * U, z: 3 * U, from: 2000, until: Infinity }])
    expect(c4At(c, 999)).toEqual([])
    expect(c4At(c, 1000)).toHaveLength(1)
    expect(c4At(c, 2500)).toHaveLength(2)
    expect(c4At(c, 2999)).toHaveLength(2)
    expect(c4At(c, 3000)).toHaveLength(1) // the first is over at the moment it was defused
    expect(c4At(c, 9e9)).toHaveLength(1)
  })

  test('an explosion ends the charge of its owner by place; a wrong wire ends it at once, and the explosion a moment later finds nothing open', () => {
    const c = c4Charges([plant(1000, 'B', 10), plant(1500, 'B', 20), end('fail', 2000, 'C', { of: 'B', x: 10, y: 2, z: 3 }), end('boom', 2100, 'B', { x: 10, y: 2, z: 3 }), end('boom', 4000, 'B', { x: 20, y: 2, z: 3 })])
    expect(c.map(x => [x.from, x.until])).toEqual([[1000, 2000], [1500, 4000]])
  })

  test('without a place on the end the only open charge of the owner is the one; with several open and no place, none is ended (it cannot be told)', () => {
    const one = c4Charges([plant(1000, 'B', 10), plant(1000, 'C', 30), end('defuse', 2000, 'A', { of: 'B' })])
    expect(one.map(x => [x.owner, x.until])).toEqual([['B', 2000], ['C', Infinity]])
    const two = c4Charges([plant(1000, 'B', 10), plant(1100, 'B', 20), end('boom', 2000, 'B')])
    expect(two.map(x => x.until)).toEqual([Infinity, Infinity])
    const noOwner = c4Charges([plant(1000, 'B', 10), end('defuse', 2000, 'A')])
    expect(noOwner[0]!.until).toBe(2000) // the owner is not known and only one charge is open
  })

  test('a charge of another owner is not ended by an end that names a different owner or place; an arming with no place is no marker; ends with nothing open do nothing', () => {
    const c = c4Charges([plant(1000, 'B', 10), ev({ k: 'c4', st: 'plant', t: 1100, p: 'C' }), end('defuse', 2000, 'A', { of: 'C', x: 10, y: 2, z: 3 }), end('boom', 2500, 'A'), end('boom', 3000, 'B', { x: 99, y: 2, z: 3 })])
    expect(c).toHaveLength(1)
    expect(c[0]!.until).toBe(Infinity)
    expect(c4Charges([end('boom', 100, 'B'), ev({ k: 'say', text: 'x', ch: 'all' })])).toEqual([])
  })
})

describe('decoding', () => {
  const raw = (events: TrackEvent[], begin?: number): RawTrack => ({
    ...(begin !== undefined ? { begin } : {}), t: [0, 200, 200], players: [{ id: 'A', segments: [{ from: 0, x: [1, 0, 0], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] }], deaths: [], events,
  })

  test('the new events keep their fields and lose the preparation from their times, like the others', () => {
    const d = decodeTrack(raw([ev({ k: 'c4', st: 'plant', t: 700, s: 45, x: 1, y: 2, z: 3 }), ev({ k: 'wpick', t: 500, w: 'weapon_zm_mac10' }), ev({ k: 'tbtn', t: 600, n: 'Trap', x: 4, y: 5, z: 6 })], 100))
    expect(d.events.map(e => [e.k, e.t])).toEqual([['wpick', 400], ['tbtn', 500], ['c4', 600]])
    expect(d.events[2]).toMatchObject({ st: 'plant', s: 45, x: 1, y: 2, z: 3 })
  })

  test('a track without any of them decodes as before', () => {
    expect(decodeTrack(raw([])).events).toEqual([])
    expect(c4Charges(decodeTrack(raw([ev({ k: 'buy', item: 'x' })])).events)).toEqual([])
  })
})

describe('the page', () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
  const page = read('components/ReplayPage.tsx'), replay = read('replay.ts'), flat = read('replayflat.ts')

  test('the feed is named for what is in it, equipment included', () => {
    expect(page).toContain('Chat, shop, bodies, damage, healing and equipment')
    expect(page).not.toContain('damage and healing')
  })

  test('every new kind is a line of the feed, a link that seeks, and the list of the player has the lines of the player; the one whose C4 or DNA it was has them too', () => {
    expect(replay).toContain('EQUIPMENT_KINDS.has(e.k)')
    expect(replay).toMatch(/b\.addEventListener\('click', \(\) => \{ selected = e\.p; seek\(e\.t - 2000\) \}\)/)
    expect(replay).toContain("(e.k === 'c4' || e.k === 'dna') && e.of === selected")
    expect(replay).toContain('ownText(e, selected!)')
  })

  test('the charge is marked in the 3D view and the flat drawing from its arming to its end, and the marker is made once', () => {
    expect(replay).toContain('c4Charges(data.events)')
    expect(replay).toContain('sprite.visible = ms >= c.from && ms < c.until')
    expect(flat).toContain('c4At(charges, ms)')
    expect(flat).toContain('const charges = c4Charges(data.events)')
  })
})
