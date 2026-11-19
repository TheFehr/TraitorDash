import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { decodeTrack, healthAt, healthBar, healthColour, hurtText, hurtOwnText, healText, healOwnText, damageTotals, totalsText, HEALTH_COLOURS, type RawTrack, type TrackEvent } from '../src/replaylogic'
import { weaponName } from '../src/weaponName'
import { PUBLIC_CSS } from '../src/components/styles'

// RFC 26, stage B (4a): what the replay works out from the health of the samples and the damage events, and the facts of the page that keep it from jumping.

const hurt = (t: number, p: string, h: number, extra: Partial<TrackEvent> = {}): TrackEvent => ({ t, p, k: 'hurt', w: 'weapon_zm_mac10', d: 10, h, ...extra })
const raw = (over: Partial<RawTrack> = {}): RawTrack => ({
  t: [0, 200, 200, 200, 200, 200],
  players: [
    // A: 100, 100, 70, 70, 70 (ticks 0-4), then nothing; mh 100
    { id: 'A', mh: 100, segments: [{ from: 0, x: [1, 0, 0, 0, 0], y: [0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0], a: [0, 0, 0, 0, 0], hp: [100, 0, -30, 0, 0] }] },
    // B has no health in its track (an older one)
    { id: 'B', segments: [{ from: 0, x: [1, 0, 0], y: [0, 0, 0], z: [0, 0, 0], a: [0, 0, 0] }] },
    // C: two segments, the second after a gap, a revival: 40, then 100 (ticks 4-5)
    { id: 'C', mh: 150, segments: [{ from: 0, x: [1, 0], y: [0, 0], z: [0, 0], a: [0, 0], hp: [40, 0] }, { from: 4, x: [1, 0], y: [0, 0], z: [0, 0], a: [0, 0], hp: [100, 0] }] },
  ],
  deaths: [],
  ...over,
})

describe('decodeTrack: health', () => {
  test('hp is rebuilt from its differences, one for each sample; the most health of each player is kept; a track without them has none', () => {
    const d = decodeTrack(raw())
    expect(d.players.get('A')![0]!.hp).toEqual([100, 100, 70, 70, 70])
    expect(d.players.get('C')![1]!.hp).toEqual([100, 100])
    expect(d.maxHealth.get('A')).toBe(100)
    expect(d.maxHealth.get('C')).toBe(150)
    expect(d.maxHealth.has('B')).toBe(false)
    expect('hp' in d.players.get('B')![0]!).toBe(false)
  })

  test('the damage events of each victim are kept in time order, with the preparation taken off their times', () => {
    const d = decodeTrack(raw({ begin: 100, events: [hurt(900, 'A', 60), hurt(500, 'A', 70), hurt(600, 'C', 30), { t: 700, p: 'A', k: 'buy', item: 'x' }] }))
    expect(d.hurts.get('A')!.map(e => e.t)).toEqual([400, 800])
    expect(d.hurts.get('C')!.map(e => e.h)).toEqual([30])
    expect(d.hurts.has('B')).toBe(false)
  })
})

describe('healthAt', () => {
  const d = decodeTrack(raw())
  const at = (id: string, ms: number) => healthAt(d.players.get(id)!, d.hurts.get(id), ms)

  test('the health of the last sample at or before the time, between samples too', () => {
    expect(at('A', 0)).toBe(100)
    expect(at('A', 399)).toBe(100)
    expect(at('A', 400)).toBe(70)
    expect(at('A', 599)).toBe(70)
    expect(at('A', 800)).toBe(70)
  })

  test('nothing before the first sample, after the last, in a gap, or for a track without health', () => {
    expect(at('A', -1)).toBeNull()
    expect(at('A', 801)).toBeNull()
    expect(at('C', 600)).toBeNull() // the gap between the segments
    expect(at('C', 800)).toBe(100)
    expect(at('B', 200)).toBeNull()
    expect(healthAt([], undefined, 0)).toBeNull()
  })

  test('a damage event after the last sample says the health since; one before it, or after the time asked, does not', () => {
    const e = decodeTrack(raw({ events: [hurt(250, 'A', 55), hurt(300, 'A', 40)] }))
    const a = (ms: number) => healthAt(e.players.get('A')!, e.hurts.get('A'), ms)
    expect(a(200)).toBe(100) // the sample, before the blow
    expect(a(249)).toBe(100)
    expect(a(250)).toBe(55) // the blow, before the next sample shows it
    expect(a(299)).toBe(55)
    expect(a(300)).toBe(40)
    expect(a(399)).toBe(40)
    expect(a(400)).toBe(70) // the sample after it is the health again
    const old = decodeTrack(raw({ events: [hurt(100, 'A', 99)] })) // before the sample at 200: that sample is the truth
    expect(healthAt(old.players.get('A')!, old.hurts.get('A'), 200)).toBe(100)
    const late = decodeTrack(raw({ events: [hurt(100, 'B', 1)] })) // a track without hp for the player has no health, hurt event or not
    expect(healthAt(late.players.get('B')!, late.hurts.get('B'), 150)).toBeNull()
  })
})

describe('healthBar and healthColour', () => {
  test('nothing for no data or no health; the most is the one the track says, or 100; more health than the most is a full bar', () => {
    expect(healthBar(null, 100)).toBeNull()
    expect(healthBar(0, 100)).toBeNull()
    expect(healthBar(78, 100)).toEqual({ hp: 78, max: 100, fraction: 0.78 })
    expect(healthBar(50, undefined)).toEqual({ hp: 50, max: 100, fraction: 0.5 })
    expect(healthBar(150, undefined)).toEqual({ hp: 150, max: 150, fraction: 1 })
    expect(healthBar(120, 100)).toEqual({ hp: 120, max: 120, fraction: 1 })
    expect(healthBar(60, 150)!.fraction).toBe(0.4)
  })
  test('green from 60 %, amber from 30 %, red below', () => {
    expect(healthColour(1)).toBe(HEALTH_COLOURS.good)
    expect(healthColour(0.6)).toBe(HEALTH_COLOURS.good)
    expect(healthColour(0.59)).toBe(HEALTH_COLOURS.hurt)
    expect(healthColour(0.3)).toBe(HEALTH_COLOURS.hurt)
    expect(healthColour(0.29)).toBe(HEALTH_COLOURS.low)
    expect(healthColour(0.01)).toBe(HEALTH_COLOURS.low)
  })
})

describe('the feed lines of damage', () => {
  const nick = (id: string) => ({ A: 'TheFehr', B: 'Tonda' }[id] ?? id)
  test('who hurt whom with what, and what was left; damage with no player behind it says what the victim took', () => {
    expect(hurtText(hurt(57000, 'B', 78, { a: 'A', d: 22 }), nick)).toBe('TheFehr hurt Tonda: 22 (MAC10), 78 left')
    expect(hurtText(hurt(1, 'B', 61, { w: 'fall', d: 15 }), nick)).toBe('Tonda took 15 (Falling), 61 left')
    expect(hurtText(hurt(1, 'B', 0, { a: 'A', d: 5, w: 'weapon_ttt_something_new' }), nick)).toBe('TheFehr hurt Tonda: 5 (Something new), 0 left')
  })
  test('in a player\'s own list the damage taken and the damage dealt read from their side', () => {
    const e = hurt(1, 'B', 78, { a: 'A', d: 22 })
    expect(hurtOwnText(e, nick, 'B')).toBe('took 22 from TheFehr (MAC10), 78 left')
    expect(hurtOwnText(e, nick, 'A')).toBe('hurt Tonda: 22 (MAC10), 78 left')
    expect(hurtOwnText(hurt(1, 'B', 61, { w: 'drown', d: 3 }), nick, 'B')).toBe('took 3 (Drowning), 61 left')
  })
  test('the damage types the bridge names have words of their own', () => {
    expect(['fall', 'drown', 'fire', 'explosion', 'world', 'shock'].map(weaponName)).toEqual(['Falling', 'Drowning', 'Fire', 'Explosion', 'The world', 'Electric shock'])
  })
})

// ---- the page

const read = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf8')
const replay = read('replay.ts'), flat = read('replayflat.ts'), page = read('components/ReplayPage.tsx')
const rootVars = /:root\{([^}]*)\}/.exec(PUBLIC_CSS)?.[1] ?? ''
const vars: Record<string, string> = Object.fromEntries([...rootVars.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})/g)].map(m => [m[1]!, m[2]!]))
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }

describe('the page', () => {
  test('the feed is named for what is in it, damage included, and the selected player has a health line', () => {
    expect(page).toContain('Chat, shop, bodies, damage, healing and equipment')
    expect(page).not.toContain('Chat, shop and bodies')
    expect(page).toContain('data-selected-health')
  })

  test('the feed has the damage lines as links that seek, and the selected player\'s list has the damage they took and dealt', () => {
    expect(replay).toContain("e.k === 'hurt' || e.k === 'heal' || EQUIPMENT_KINDS.has(e.k))")
    expect(replay).toMatch(/b\.addEventListener\('click', \(\) => \{ selected = e\.p; seek\(e\.t - 2000\) \}\)/)
    expect(replay).toContain("(e.k === 'hurt' || e.k === 'heal') && e.a === selected)")
  })

  test('the health in the list has a box of its own width with figures of one width, so the row does not move when it changes; the health line keeps its height', () => {
    const rule = (sel: string) => new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(PUBLIC_CSS)?.[1] ?? ''
    expect(rule('.phealth')).toContain('flex:none')
    expect(rule('.phealth')).toMatch(/min-width:\d/)
    expect(rule('.phealth')).toContain('tabular-nums')
    expect(rule('.phealth-line')).toMatch(/min-height:/)
    expect(rule('.phealth-line')).toContain('nowrap')
    expect(rule('.phealth-line')).toContain('tabular-nums')
    expect(rule('.phealth-line')).toContain('var(--space-1)') // the spacing variables of RFC 30, not pixels
    expect(replay).toContain("setText(chip.hp, hb ? String(hb.hp) : '')") // written only when it differs
    expect(replay).toContain('hpEl.title') // and named for a pointer
  })

  test('the health text is --dim on paper and --soft on the selected row, which pass 4.5 : 1; the colours of the bar stand out from its dark ground and from the outline (3 : 1)', () => {
    const paper = vars.paper!, ink = vars.ink!
    expect(ratio(vars.dim!, paper)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(vars.soft!, ink)).toBeGreaterThanOrEqual(4.5)
    for (const c of Object.values(HEALTH_COLOURS)) {
      expect(ratio(c, '#4b5563'), c).toBeGreaterThanOrEqual(1.5) // the empty part of the bar
      expect(ratio(c, '#000000'), c).toBeGreaterThanOrEqual(3) // the outline
    }
  })

  test('the 3D bar sits over the name, is drawn again only when its width or colour changes, and is hidden with the player; the flat drawing has it too', () => {
    expect(replay).toContain('group.add(ring, pin, label, bar)')
    expect(replay).toContain('if (key !== m.barKey)')
    expect(replay).toContain('m.bar.visible = !!hb')
    expect(replay).toContain('const hb = p ? healthNow(id) : null') // no pose, no bar
    expect(flat).toContain('healthBar(healthAt(player(d.id)')
    expect(flat).toContain('healthColour(hb.fraction)')
  })
})

// ---- RFC 26, stage B (4b): heal events in the replay

describe('the feed lines of heals', () => {
  const nick = (id: string) => ({ A: 'TheFehr', B: 'Tonda' }[id] ?? id)
  const heal = (p: string, h: number, extra: Partial<TrackEvent> = {}): TrackEvent => ({ t: 1, p, k: 'heal', w: 'ttt_health_station', d: 25, h, ...extra })

  test('who was healed, by how much, by what, and what they have now; the source is left out when the bridge did not know it', () => {
    expect(healText(heal('B', 77), nick)).toBe('Tonda healed +25 by Health station, 77 left')
    expect(healText(heal('B', 77, { w: 'other' }), nick)).toBe('Tonda healed +25, 77 left')
    expect(healText(heal('B', 77, { w: 'regen' }), nick)).toBe('Tonda healed +25 by Regeneration, 77 left')
    expect(healText(heal('B', 77, { a: 'A', w: 'ttt_surgeryknife' }), nick)).toBe('Tonda healed +25 by TheFehr (Surgeryknife), 77 left')
    expect(healText(heal('B', 77, { a: 'A', w: 'other' }), nick)).toBe('Tonda healed +25 by TheFehr, 77 left')
    expect(healText(heal('B', 100, { a: 'B', w: 'ttt_surgeryknife' }), nick)).toBe('Tonda healed themselves +25 (Surgeryknife), 100 left')
  })

  test('in a player\'s own list it reads from their side: the healed, the healer and oneself', () => {
    const e = heal('B', 77, { a: 'A', w: 'ttt_surgeryknife' })
    expect(healOwnText(e, nick, 'B')).toBe('healed +25 by TheFehr (Surgeryknife), 77 left')
    expect(healOwnText(e, nick, 'A')).toBe('healed Tonda +25 (Surgeryknife), 77 left')
    expect(healOwnText(heal('B', 77), nick, 'B')).toBe('healed +25 by Health station, 77 left')
    expect(healOwnText(heal('B', 77, { w: 'other' }), nick, 'B')).toBe('healed +25, 77 left')
    expect(healOwnText(heal('B', 100, { a: 'B', w: 'ttt_surgeryknife' }), nick, 'B')).toBe('healed themselves +25 (Surgeryknife), 100 left')
  })

  test('the sums of the selected player: damage taken, dealt and health gained, each only from the right events; a track without any gives nothing', () => {
    const events: TrackEvent[] = [
      hurt(1, 'B', 78, { a: 'A', d: 22 }), hurt(2, 'B', 60, { d: 18 }), hurt(3, 'A', 50, { a: 'B', d: 7 }),
      heal('B', 70, { d: 10 }), heal('B', 80, { d: 10, a: 'A' }), heal('A', 90, { d: 5 }),
      { t: 5, p: 'B', k: 'buy', item: 'x' },
    ]
    expect(damageTotals(events, 'B')).toEqual({ took: 40, dealt: 7, healed: 20 })
    expect(damageTotals(events, 'A')).toEqual({ took: 7, dealt: 22, healed: 5 })
    expect(damageTotals(events, 'Z')).toEqual({ took: 0, dealt: 0, healed: 0 })
    expect(damageTotals([], 'B')).toEqual({ took: 0, dealt: 0, healed: 0 })
    expect(totalsText({ took: 40, dealt: 7, healed: 20 })).toBe('Took 40, dealt 7, healed 20')
    expect(totalsText({ took: 0, dealt: 0, healed: 20 })).toBe('Healed 20')
    expect(totalsText({ took: 0, dealt: 0, healed: 0 })).toBe('')
  })

  test('heal events are decoded with the others (the preparation off their times) and do not change the health between samples; a track without heals decodes as before', () => {
    const e: TrackEvent = { t: 700, p: 'A', k: 'heal', w: 'other', d: 5, h: 75 }
    const d = decodeTrack(raw({ begin: 100, events: [e, hurt(500, 'A', 70)] }))
    expect(d.events.map(x => [x.k, x.t])).toEqual([['hurt', 400], ['heal', 600]])
    expect(d.hurts.get('A')!.map(x => x.k)).toEqual(['hurt'])
    expect(decodeTrack(raw()).events).toEqual([])
  })

  test('the sources of a heal that are no class have names, and the page lists heals in the feed and in the lists of the healed and the healer', () => {
    expect(['regen', 'revive', 'other', 'ttt_health_station'].map(weaponName)).toEqual(['Regeneration', 'Revival', 'Other', 'Health station'])
    const replaySrc = fs.readFileSync(path.join(import.meta.dir, '../src/replay.ts'), 'utf8')
    expect(replaySrc).toContain("e.k === 'hurt' || e.k === 'heal' || EQUIPMENT_KINDS.has(e.k))")
    expect(replaySrc).toContain('healText(e, nick)')
    expect(replaySrc).toContain('healOwnText(e, nick, selected!)')
    expect(fs.readFileSync(path.join(import.meta.dir, '../src/components/ReplayPage.tsx'), 'utf8')).toContain('data-selected-totals')
  })
})
