import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 12 and 17: the list of rounds is paged. It showed the latest 15 and no way to the older ones (2026-11-05: 66 rounds, 62 replays
// kept, 15 reachable). A page is a plain link, 25 rounds, the newest first; the footer says which rounds the page holds.

let mod: any, app: any, Store: any, stats: any, serverId: string
const P1 = '76561198000000011'
let n = 0

beforeAll(async () => {
  mod = await import('../src/index')
  app = mod.default
  Store = (await import('../src/services/Store')).Store
  stats = await import('../src/services/stats')
})
beforeEach(() => { mod.resetRolePages(); serverId = (Store.addServer('Paging') as any).id })

const text = async (path: string) => (await app.fetch(new Request(`http://localhost${path}`))).text()
const rounds = (count: number, bots = false) => {
  for (let i = 0; i < count; i++) {
    Store.recordRound(serverId, {
      roundId: `round-${String(++n).padStart(6, '0')}`, map: `ttt_m${i}`, startedAt: null, duration: 100, result: 'traitors',
      players: [{ steamId: bots ? '99900000000000' + (i % 10) : P1, nick: 'Ann', role: 'traitor', team: 'traitors', survived: true, won: true }], deaths: [],
    })
  }
}
const maps = (html: string) => [...html.matchAll(/title="ttt_m(\d+)"/g)].map(m => Number(m[1]))

describe('the list of rounds in pages', () => {
  test('the store counts the rounds and skips the ones before the page', () => {
    rounds(30)
    expect(stats.countRounds(serverId)).toBe(30)
    const first = stats.getRecentRounds(serverId, undefined, 25, 0), second = stats.getRecentRounds(serverId, undefined, 25, 25)
    expect(first).toHaveLength(25); expect(second).toHaveLength(5)
    expect(new Set([...first, ...second].map((r: any) => r.roundId)).size).toBe(30) // no round twice, none missing
    expect(first[0].map).toBe('ttt_m29'); expect(second.at(-1).map).toBe('ttt_m0') // newest first, across the pages
  })

  test('the first page has 25 rounds, the newest, and a link to the older ones', async () => {
    rounds(60)
    const html = await text(`/servers/${serverId}/stats?view=rounds`)
    expect(maps(html)).toEqual(Array.from({ length: 25 }, (_, i) => 59 - i))
    expect(html).toContain('Rounds 1 to 25 of 60'); expect(html).toContain('1 of 3')
    expect(html).toContain('page=2'); expect(html).toContain('Older'); expect(html).not.toContain('Newer')
  })

  test('a middle page has both links, and the last page holds the oldest', async () => {
    rounds(60)
    const mid = await text(`/servers/${serverId}/stats?view=rounds&page=2`)
    expect(maps(mid)).toEqual(Array.from({ length: 25 }, (_, i) => 34 - i))
    expect(mid).toContain('Rounds 26 to 50 of 60'); expect(mid).toContain('Newer'); expect(mid).toContain('Older')
    expect(mid).toMatch(/href="[^"]*view=rounds[^"]*"[^>]*rel="prev"|rel="prev"/)
    const last = await text(`/servers/${serverId}/stats?view=rounds&page=3`)
    expect(maps(last)).toEqual(Array.from({ length: 10 }, (_, i) => 9 - i))
    expect(last).toContain('Rounds 51 to 60 of 60'); expect(last).toContain('Newer'); expect(last).not.toContain('Older')
  })

  test('the link back to the first page has no page number; a page past the end or a bad one is the nearest page', async () => {
    rounds(60)
    const second = await text(`/servers/${serverId}/stats?view=rounds&page=2`)
    const newer = /<a href="([^"]*)"[^>]*rel="prev"/.exec(second)![1]!.replace(/&amp;/g, '&')
    expect(newer).toContain('view=rounds'); expect(newer).not.toContain('page=')
    expect(maps(await text(`/servers/${serverId}/stats?view=rounds&page=99`))).toEqual(Array.from({ length: 10 }, (_, i) => 9 - i))
    expect(maps(await text(`/servers/${serverId}/stats?view=rounds&page=0`))).toHaveLength(25)
    expect(maps(await text(`/servers/${serverId}/stats?view=rounds&page=abc`))).toHaveLength(25)
    expect(maps(await text(`/servers/${serverId}/stats?view=rounds&page=-3`))).toHaveLength(25)
  })

  test('a few rounds have no paging and say what they are; the embedded window keeps embed and the options in the links', async () => {
    rounds(7)
    const html = await text(`/servers/${serverId}/stats?view=rounds`)
    expect(html).not.toContain('data-rounds-pages'); expect(html).toContain('The latest 7 rounds')
    rounds(30)
    const embed = await text(`/servers/${serverId}/stats?embed=1&view=rounds&by=start`)
    const older = /<a href="([^"]*)"[^>]*rel="next"/.exec(embed)![1]!.replace(/&amp;/g, '&')
    expect(older).toContain('embed=1'); expect(older).toContain('by=start'); expect(older).toContain('page=2')
    expect(embed).not.toContain('<script')
  })

  test('bot-only rounds are left out of the count and the pages unless asked for, as before', async () => {
    rounds(5); rounds(40, true)
    expect(stats.countRounds(serverId)).toBe(5)
    expect(stats.countRounds(serverId, { bots: true })).toBe(45)
    expect(await text(`/servers/${serverId}/stats?view=rounds`)).not.toContain('data-rounds-pages')
    expect(await text(`/servers/${serverId}/stats?view=rounds&bots=1`)).toContain('1 of 2')
  })

  test('the overview keeps its list short and has no paging', async () => {
    rounds(40)
    const html = await text(`/servers/${serverId}/stats`)
    expect(html).not.toContain('data-rounds-pages')
  })
})
