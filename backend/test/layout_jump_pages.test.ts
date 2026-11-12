import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'
import { readFileSync } from 'node:fs'
import { PUBLIC_CSS, ADMIN_CSS, FONT_URLS } from '../src/components/styles'
import { planFrame, renderPlanSvg } from '../src/services/mapplan'
import { BRIDGE_SETTINGS } from '../src/services/bridgeSettings'

// Layout jumps of the pages' own behaviour (not the voice page, not the shared state rules): what moved in a real Chromium (Playwright, 1100 and
// 390 px wide, layout-shift entries and box measurements before and after the scripts ran), and the static facts that keep it from moving again.
// A test here cannot run a browser; it pins the markup and the rules the measurements showed to be the cure.

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'
process.env.OPEN_SIGNIN = '1'

let app: any, Store: any, db: any
const ADMIN = '76561198000000000'
const P = Array.from({ length: 4 }, (_, i) => `7656119800000010${i}`)
let serverId: string, roundId: string

beforeAll(async () => {
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  serverId = (Store.addServer('Jumps') as any).id
  Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 2000, maxMb: 2000, maxPinned: 2 })
  for (const [n, team] of [['traitor', 'traitors'], ['innocent', 'innocents'], ['jester', 'jesters']] as const) Store.saveSchema(serverId, n, team, false, 0, [], 'h' + n, null, '#336699')
  Store.setConVarValues(serverId, [{ name: 'ttt_jester_enabled', role: 'jester', present: true, value: '0' }])
  Store.setBridgeSettings(serverId, { traitordash_stats: '1', traitordash_track_interval_min: '0.2' }, {})
  roundId = 'round-jump-1'
  Store.recordRound(serverId, { roundId, map: 'ttt_a', startedAt: null, duration: 120, result: 'traitors',
    players: P.map((p, i) => ({ steamId: p, nick: `N${i}`, role: i ? 'innocent' : 'traitor', team: i ? 'innocents' : 'traitors', survived: !i, won: !i })),
    deaths: [{ victim: P[1], attacker: P[0], at: 40, weapon: 'weapon_ttt_m16', x: 1, y: 1, z: 1 }, { victim: P[2], attacker: P[0], at: 50, weapon: null, x: 1, y: 1, z: 1 }] })
  const track = { roundId, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0, 200, 200],
    players: P.map(p => ({ id: p, segments: [{ from: 0, x: [10, 1, 1], y: [10, 0, 0], z: [0, 0, 0], a: [0, 8, 8] }] })), deaths: [] }
  Store.recordTrack(serverId, track, JSON.stringify(track))
})
afterAll(() => { delete process.env.OPEN_SIGNIN })

const page = async (path: string): Promise<string> => {
  const cookie = (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]!
  const r = await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }))
  expect(r.status).toBe(200)
  return r.text()
}
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
const CSS = PUBLIC_CSS + ADMIN_CSS
/** The declarations of the first rule whose selector is `sel` (an exact selector, as written). */
const rule = (sel: string): string => {
  const at = CSS.indexOf(`\n${sel}{`)
  expect(at).toBeGreaterThanOrEqual(0)
  return CSS.slice(at + sel.length + 2, CSS.indexOf('}', at))
}

describe('web fonts: the whole page moved when they arrived', () => {
  // Measured: the four faces were font-display:swap, so the text was laid out in the fallback and again in Barlow Condensed ~40 ms later.
  // Layout shift 0.12 to 0.28 on a phone (the header wrapped differently and pushed the page 33 px), 0.01 to 0.04 at 1100 px, on every page.
  // With the preload and optional: 0.0000 on all 13 pages at both widths.
  test('every face is optional and its file is preloaded in the head of every page', async () => {
    expect(PUBLIC_CSS).not.toContain('font-display:swap')
    expect((PUBLIC_CSS.match(/font-display:optional/g) ?? []).length).toBe(4)
    const t = await page(`/servers/${serverId}/stats`)
    for (const u of FONT_URLS) expect(t).toContain(`<link rel="preload" as="font" type="font/woff2" href="${u}" crossorigin=""/>`)
    expect(t.indexOf('rel="preload"')).toBeLessThan(t.indexOf('<style>'))
  })
  test('the page scroller keeps the room of its scrollbar (a list that grows past the window made the page slide sideways)', () => {
    expect(rule('html')).toContain('scrollbar-gutter:stable')
  })
})

describe('the settings page', () => {
  // Measured with the page's own Alpine: editing a value added a 28 px "Reset to default" row to the field (every field below moved, 0.008 per edit,
  // and back on Reset), the "changed" tag could wrap the label, and the red dot of the jump bar pushed the links beside it 17 px sideways.
  // After: no layout shift in any of 12 interactions at both widths.
  test('what comes and goes in a field sits in a corner with a height of its own, not in the flow of the field', async () => {
    const t = await page(`/servers/${serverId}/settings`)
    expect((t.match(/class="fx"/g) ?? []).length).toBeGreaterThanOrEqual(BRIDGE_SETTINGS.length + 3) // every setting, the two replay limits and the map cooldown
    expect(rule('.fx')).toMatch(/min-height:1\.9rem/)
    expect(rule('.fx')).toContain('white-space:nowrap')
    // the Reset button and the tag are inside it, not after the hints
    for (const m of t.matchAll(/<span class="fx">(.*?)<\/span><\/div>/gs)) expect(m[1]).toContain('class="src missing"')
    expect(t).toMatch(/<span class="fx">.*?Reset to default<\/button><\/span>/s)
    expect(t.replace(/<span class="fx">.*?<\/span><\/div>/gs, '')).not.toContain('Reset to default')
  })
  test('the dot of the jump bar is hidden with visibility, so its width stays', async () => {
    const t = await page(`/servers/${serverId}/settings`)
    const dots = [...t.matchAll(/<span class="dot"[^>]*>/g)].map(m => m[0])
    expect(dots.length).toBe(5)
    for (const d of dots) { expect(d).toContain('style="visibility:hidden"'); expect(d).toContain('x-bind:style'); expect(d).not.toContain('x-show') }
  })
  test('the save bar and the message are out of the flow, and the form keeps room under it so it never covers the last field', () => {
    expect(rule('.savebar')).toContain('position:fixed')
    expect(rule('.toast')).toContain('position:fixed')
    expect(CSS).toMatch(/\n\.cfg\{padding-bottom:6\.5rem\}/)
  })
  test('on a phone the corner is a row of its own (beside the label it would wrap the label when a button appeared)', () => {
    expect(ADMIN_CSS).toMatch(/@media \(max-width:30rem\)\{\.fh\{flex-direction:column\}/)
  })
})

describe('the server page (Alpine filter)', () => {
  // Measured: "Enabled only" is on at the start, so Alpine hid the disabled roles after the page was drawn (0.19 at 1100 px, 0.07 at 390), the sort button
  // and the count were empty until Alpine wrote them (a 29 px button, 0.0003), and sorting by a number added a line to every tile (+18 px, 0.012).
  // After: 0 at load at both widths, 0 when the sort is changed. Filtering and flat/grouped still change the list: that is the content changing.
  test('a disabled role starts hidden, and a team with none enabled too, as Alpine will have it', async () => {
    const t = await page(`/servers/${serverId}`)
    expect(t).toMatch(/<a[^>]*data-role="jester"[^>]*style="[^"]*display:none/)
    expect(t).not.toMatch(/<a[^>]*data-role="traitor"[^>]*display:none/)
    expect(t).toMatch(/<section[^>]*x-show="sectionVisible\(\$el\)"[^>]*style="display:none"/) // the jesters' section: its only role is off
  })
  test('the count and the sort button have their words from the server', async () => {
    const t = await page(`/servers/${serverId}`)
    expect(t).toContain('>Showing 2 of 3</span>')
    expect(t).toContain('>↑ low to high</button>')
  })
  test('the line a sort adds is always there: the tile keeps the room', async () => {
    const t = await page(`/servers/${serverId}`)
    expect(t).not.toMatch(/class="val"[^>]*x-show/)
    expect(rule('.tile .val')).toContain('min-height:1.35em')
  })
  test('"No roles match" is not drawn for a server that has no roles (it opened a 123 px box in the empty state)', async () => {
    const empty = (Store.addServer('Empty') as any).id
    expect(await page(`/servers/${empty}`)).not.toContain('No roles match these filters')
    expect(await page(`/servers/${serverId}`)).toContain('No roles match these filters')
  })
  test('the Copy button keeps its width when it says Copied (11 px)', () => {
    expect(rule('.copy .ab')).toContain('min-width:4.6rem')
  })
})

describe('the replay page', () => {
  // Measured with WebGL (SwiftShader) with the track held back and then released: the time text was 110 px wide at 0:00 and 120 px with a minus
  // ("-0:05 / 4:55", the preparation), so the speed buttons moved 10 px; the players list grew from 0 to 224 px, the selected player's line 0 to 46,
  // the map note 0 to 18 or 37, the level row left (33 px at 1100, 77 at 390), the chat and revival panels came in above Deaths (172 + 125 px);
  // layout shift 0.084 at 1100 (the part in the window; the rest was below it). After: 0.0001, only the last panels coming in at the end of the column.
  test('the time text has a width that holds the minus and every clock the round can show', () => {
    expect(rule('.time')).toContain('min-width:13ch')
  })
  test('the lists have room before they are filled: the players and deaths by their count, the selected player by a fixed height', async () => {
    const t = await page(`/servers/${serverId}/rounds/${roundId}/replay`)
    expect(t).toMatch(/<div data-players="true" class="list" style="--n:4">/)
    expect(t).toMatch(/<ol data-deaths="true" class="list" style="--n:2">/)
    expect(rule('.replay [data-players]')).toMatch(/min-height:min\(14rem,calc\(var\(--n,0\) \* 1\.73rem\)\)/)
    expect(rule('.replay [data-deaths]')).toMatch(/min-height:min\(14rem,calc\(var\(--n,0\) \* 3\.4rem\)\)/)
    expect(rule('.replay [data-player-events]')).toContain('height:7rem')
    expect(rule('.replay [data-selected-role]')).toContain('min-height:2.7em')
    expect(rule('.replay [data-background]')).toContain('min-height:1.35em')
    expect(CSS).toMatch(/@media \(max-width:30rem\)\{\.replay \[data-background\]\{min-height:2\.7em\}\}/)
  })
  test('what may or may not appear comes last: the chat and revival panels after the admin panel, the notes after the disclaimer', async () => {
    const t = await page(`/servers/${serverId}/rounds/${roundId}/replay`)
    const at = (s: string) => t.indexOf(s)
    expect(at('data-deaths')).toBeLessThan(at('data-pin'))
    expect(at('data-pin')).toBeLessThan(at('data-feed-wrap'))
    expect(at('data-feed-wrap')).toBeLessThan(at('data-revives-wrap'))
    expect(at('data-disclaimer')).toBeLessThan(at('data-notes'))
  })
  test('the scripts keep the room of what they hide (visibility, not the hidden attribute)', () => {
    expect(rule('.replay .gone')).toContain('visibility:hidden')
    const replay = src('replay.ts'), flat = src('replayflat.ts')
    expect(replay).toContain("closest('[data-levels-wrap]')?.classList.add('gone')")
    expect(replay).toContain("closest('label')?.classList.add('gone')")
    expect(replay).not.toMatch(/data-levels-wrap\]'\)\?\.setAttribute\('hidden'/)
    expect(flat).toContain("b.classList.add('gone')")
    expect(flat).not.toContain("b.hidden = true")
  })
  test('the play button keeps its width over Play, Pause and Replay', () => {
    expect(rule('.tog.play')).toContain('min-width:4.5rem')
  })
  test('the status text is laid over the canvas, not in the flow, while the canvas has a fixed height', () => {
    expect(rule('.view [data-status]')).toContain('position:absolute')
    expect(rule('.view canvas')).toMatch(/height:min\(60vh,28rem\)/)
  })
})

describe('the map pages', () => {
  // Measured with the plan pictures held back: a figure was 22 px high (the caption) until its image arrived, then 122 to 144 px (99 to 121 at 390):
  // the rest of the page moved. The image now carries the size of the picture the server draws; the 3D view's canvas has a fixed height as the replay's.
  const grid = { cell: 64, minx: 0, miny: 0, nx: 8, ny: 2, zmin: 0, zmax: 300, rows: [Array(8).fill('0').join('|'), Array(8).fill('300').join('|')] }
  test('planFrame is the size of the SVG that renderPlanSvg draws, for every level and for all floors', () => {
    const f = planFrame(grid as any)
    for (const level of [undefined, 1, 2]) {
      const svg = renderPlanSvg(grid as any, 'ttt_a', level)!
      expect(svg).toContain(`width="${f.width}" height="${f.height}"`)
    }
    const empty = { ...grid, rows: ['|||||||', '|||||||'] }
    expect(renderPlanSvg(empty as any, 'x')).toContain(`width="${planFrame(empty as any).width}" height="${planFrame(empty as any).height}"`)
  })
  test('the page puts that size on the images', async () => {
    db.run('INSERT OR REPLACE INTO map_plans (server_id, map_name, fingerprint, plan, cell, nx, ny, floor_cells, crouch_floors, seeds, scanned_at) VALUES (?, ?, ?, ?, 64, 8, 2, 16, 0, 1, ?)',
      [serverId, 'ttt_a', 'ab'.repeat(32), JSON.stringify(grid), new Date().toISOString()])
    Store.setMaps(serverId, { current: null, next: null, gamemode: 'terrortown', pattern: null, poolBasis: null, configSource: null, voteAddon: false,
      maps: [{ name: 'ttt_a', size: 1, fingerprint: 'ab'.repeat(32), matchesGamemode: true, inCycle: null, onCooldown: null, isCurrent: false, inVotePool: true, votable: true }] })
    const t = await page(`/servers/${serverId}/maps/ttt_a`)
    const f = planFrame(grid as any)
    expect(t).toContain(`<img loading="lazy" width="${f.width}" height="${f.height}"`)
  })
})
