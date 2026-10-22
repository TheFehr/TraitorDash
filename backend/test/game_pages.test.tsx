import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 16: the Round stats and Maps pages as the game shows them (?embed=1): case-file look, no site
// header, no script, no admin controls; links keep embed=1; replays are offered only to signed-in visitors.

let mod: any, app: any, Store: any, db: any, serverId: string, cookie: string
const ADMIN = '76561198000000000', P1 = '76561198000000011', P2 = '76561198000000012', P3 = '76561198000000013'
let n = 0

beforeAll(async () => {
  mod = await import('../src/index')
  app = mod.default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', ADMIN, 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

beforeEach(() => {
  mod.resetRolePages()
  serverId = (Store.addServer('Games') as any).id
})

const get = (path: string, auth = false, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: { ...(auth ? { Cookie: cookie } : {}), ...headers } }))
const text = async (path: string, auth = false) => (await get(path, auth)).text()

function round(o: { map?: string, result?: string, track?: boolean, deaths?: { victim: string, attacker: string | null, at: number | null }[], duration?: number | null } = {}) {
  const id = `round-${String(++n).padStart(6, '0')}`
  Store.recordRound(serverId, {
    roundId: id, map: o.map ?? 'ttt_a', startedAt: null, duration: o.duration === undefined ? 300 : o.duration, result: o.result ?? 'traitors',
    players: [
      { steamId: P1, nick: 'Ann', role: 'traitor', team: 'traitors', survived: true, won: true },
      { steamId: P2, nick: 'Bob', role: 'innocent', team: 'innocents', survived: false, won: false },
      { steamId: P3, nick: 'Cy <b>x</b>', role: 'innocent', team: 'innocents', survived: false, won: false },
    ],
    deaths: o.deaths ?? [{ victim: P3, attacker: P1, at: 80 }, { victim: P2, attacker: P1, at: 48 }],
  })
  if (o.track) {
    const t = { roundId: id, map: o.map ?? 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0], players: [{ id: P1, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [] }
    Store.recordTrack(serverId, t, JSON.stringify(t))
  }
  return id
}

describe('the shell of every game page', () => {
  test('no site header, no script, no admin controls, strict policy', async () => {
    round()
    for (const path of [`/servers/${serverId}/stats?embed=1`, `/servers/${serverId}/stats?embed=1&view=rounds`, `/servers/${serverId}/stats?embed=1&view=leaders`, `/servers/${serverId}/maps?embed=1`]) {
      const r = await get(path, true) // even for an admin
      expect(r.status, path).toBe(200)
      const html = await r.text()
      expect(html).not.toContain('<script')
      expect(html).not.toContain('<header class="top"')
      expect(html).not.toMatch(/Delete selected|type="checkbox"|Pin/)
      expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
      expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
    }
  })
  test('every link inside keeps embed=1', async () => {
    const id = round({ track: true })
    Store.setMaps(serverId, { current: 'ttt_a', next: null, gamemode: 'terrortown', pattern: null, poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps: [{ name: 'ttt_a', size: 1, fingerprint: null, matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: true, inVotePool: true, votable: false }] })
    for (const path of [`/servers/${serverId}/stats?embed=1`, `/servers/${serverId}/stats?embed=1&view=rounds`, `/servers/${serverId}/stats?embed=1&view=leaders`, `/servers/${serverId}/maps?embed=1`, `/servers/${serverId}/rounds/${id}?embed=1`, `/servers/${serverId}/maps/ttt_a/rounds?embed=1`]) {
      const hrefs = [...(await text(path)).matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]!.replace(/&amp;/g, '&'))
      expect(hrefs.length, path).toBeGreaterThan(0)
      for (const h of hrefs) expect(h, `${path} -> ${h}`).toContain('embed=1')
    }
  })
  test('pages that are not embedded are unchanged: the website still has its header and the admin controls', async () => {
    round()
    const html = await text(`/servers/${serverId}/stats?view=rounds`, true)
    expect(html).toContain('Delete selected rounds')
    expect(html).toContain('<header class="top"')
    expect(html).toContain('data-admin-mark')
  })
  test('a page is not cached by a shared cache, and a repeat with its ETag is a 304', async () => {
    round()
    const r = await get(`/servers/${serverId}/stats?embed=1`)
    expect(r.headers.get('Cache-Control')).toBe('private, max-age=30')
    const again = await get(`/servers/${serverId}/stats?embed=1`, false, { 'If-None-Match': r.headers.get('ETag')! })
    expect(again.status).toBe(304)
  })
  test('an unknown server goes home', async () => {
    expect((await get(`/servers/nope/stats?embed=1`)).status).toBe(302)
  })
})

describe('Round stats', () => {
  test('overview: the numbers, who wins, and the best roles from three rounds on', async () => {
    for (let i = 0; i < 3; i++) round({ result: 'traitors' })
    round({ result: 'innocents' })
    const html = await text(`/servers/${serverId}/stats?embed=1`)
    expect(html).toContain('Who wins')
    expect(html).toContain('Traitors')
    expect(html).toMatch(/75%/) // 3 of 4
    expect(html).toContain('Best roles')
    expect(html).toContain('traitor') // 4 rounds, so it qualifies
  })
  test('no rounds says so', async () => {
    expect(await text(`/servers/${serverId}/stats?embed=1`)).toContain('No rounds yet')
  })
  test('leaderboard: a sort pill, the top rows with escaped names', async () => {
    round(); round()
    const html = await text(`/servers/${serverId}/stats?embed=1&view=leaders&sort=wins`)
    expect(html).toContain('Ann')
    expect(html).toContain('Cy &lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('Cy <b>')
    expect(html).toMatch(/class="on"[^>]*>Wins/)
  })
  test('rounds: each row opens the round; a replay is offered only to a signed-in visitor', async () => {
    const id = round({ track: true })
    round()
    const anon = await text(`/servers/${serverId}/stats?embed=1&view=rounds`)
    expect(anon).toContain(`/rounds/${id}?embed=1`)
    expect(anon).toContain('tape off')
    expect(anon).not.toContain(`/rounds/${id}/replay`)
    const user = await text(`/servers/${serverId}/stats?embed=1&view=rounds`, true)
    expect(user).toContain(`/rounds/${id}/replay`)
  })
})

describe('One round', () => {
  test('result, length, deaths, first blood by time, and the roles of the round', async () => {
    const id = round()
    const html = await text(`/servers/${serverId}/rounds/${id}?embed=1`)
    expect(html).toContain('Traitors')
    expect(html).toContain('5:00')
    expect(html).toMatch(/Deaths<\/dt><dd>2/)
    // the death at 48 s came second in the report but first in the round
    expect(html).toContain('0:48 · Ann → Bob')
    for (const who of ['Ann', 'Bob', 'Cy &lt;b&gt;x&lt;/b&gt;']) expect(html).toContain(who)
    expect(html).toContain('traitor')
    expect(html.match(/>innocent</g)?.length).toBe(2)
  })
  test('first blood without a time shows no clock; a death with no killer shows the victim only; no deaths shows no line', async () => {
    const a = round({ deaths: [{ victim: P2, attacker: null, at: null }] })
    const h = await text(`/servers/${serverId}/rounds/${a}?embed=1`)
    expect(h).toContain('First blood</dt><dd>Bob</dd>')
    const none = round({ deaths: [] })
    expect(await text(`/servers/${serverId}/rounds/${none}?embed=1`)).not.toContain('First blood')
  })
  test('the replay: a button for a signed-in visitor, a sentence for everybody else, nothing without a track', async () => {
    const id = round({ track: true }), plain = round()
    expect(await text(`/servers/${serverId}/rounds/${id}?embed=1`, true)).toContain('Watch the replay')
    const anon = await text(`/servers/${serverId}/rounds/${id}?embed=1`)
    expect(anon).not.toContain('Watch the replay')
    expect(anon).toContain('opens for signed-in visitors')
    const none = await text(`/servers/${serverId}/rounds/${plain}?embed=1`, true)
    expect(none).not.toContain('Watch the replay')
    expect(none).not.toContain('has a replay')
  })
  test('an unknown round or a bad id is a 404; the website shows the same page with its header; a bot-only round is not shown', async () => {
    expect((await get(`/servers/${serverId}/rounds/round-999999?embed=1`)).status).toBe(404)
    expect((await get(`/servers/${serverId}/rounds/..%2Fx?embed=1`)).status).toBe(404)
    const id = round()
    const site = await get(`/servers/${serverId}/rounds/${id}`)
    expect(site.status).toBe(200)
    expect(await site.text()).toContain('<header class="top"')
    const botId = `round-${String(++n).padStart(6, '0')}`
    Store.recordRound(serverId, { roundId: botId, map: 'ttt_a', startedAt: null, duration: 5, result: 'traitors', players: [{ steamId: '999000000001', nick: 'bot', role: 'traitor', team: 'traitors', survived: true, won: true }], deaths: [] })
    expect((await get(`/servers/${serverId}/rounds/${botId}?embed=1`)).status).toBe(404)
  })
})

describe('Maps', () => {
  const maps = [
    { name: 'ttt_a', size: 1, fingerprint: null, matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: true, inVotePool: true, votable: false },
    { name: 'ttt_b', size: 1, fingerprint: null, matchesGamemode: true, inCycle: true, onCooldown: false, isCurrent: false, inVotePool: true, votable: true },
    { name: 'ttt_c', size: 1, fingerprint: null, matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: false, votable: false },
  ]
  beforeEach(() => Store.setMaps(serverId, { current: 'ttt_a', next: 'ttt_b', gamemode: 'terrortown', pattern: null, poolBasis: 'gamemode', configSource: 'none', voteAddon: false, maps }))

  test('cards for the maps the vote can offer, the votable first; maps outside the pool stay out; no size', async () => {
    const html = await text(`/servers/${serverId}/maps?embed=1`)
    expect(html.indexOf('>ttt_b</a>')).toBeLessThan(html.indexOf('>ttt_a</a>'))
    expect(html).not.toContain('ttt_c')
    expect(html).toContain('Current')
    expect(html).toContain('Votable')
    expect(html).not.toMatch(/MB/)
    expect(html).not.toContain('/plan.svg')
  })
  test('rounds played and the last one on each card; a map never played says so', async () => {
    round({ map: 'ttt_a' }); round({ map: 'ttt_a', result: 'innocents' })
    const html = await text(`/servers/${serverId}/maps?embed=1`)
    expect(html).toContain('2 rounds')
    expect(html).toContain('Not played yet')
  })
  test('no report says so', async () => {
    const other = (Store.addServer('NoMaps') as any).id
    expect(await text(`/servers/${other}/maps?embed=1`)).toContain('No maps yet')
  })
  test('a map file: its numbers and who wins; no plan, no 3D, a pointer to the website; public', async () => {
    round({ map: 'ttt_a', duration: 300 }); round({ map: 'ttt_a', duration: 100, result: 'innocents' })
    const r = await get(`/servers/${serverId}/maps/ttt_a/rounds?embed=1`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toMatch(/Played<\/dt><dd>2/)
    expect(html).toContain('3:20') // average of 300 and 100
    expect(html).toContain('Who wins here')
    expect(html).toContain('floor plan is on the website')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('mesh.glb')
  })
  test('an unknown map is a 404, the website shows the same page, a map outside the pool still opens by its address', async () => {
    expect((await get(`/servers/${serverId}/maps/nope/rounds?embed=1`)).status).toBe(404)
    expect((await get(`/servers/${serverId}/maps/ttt_a/rounds`)).status).toBe(200)
    expect((await get(`/servers/${serverId}/maps/ttt_c/rounds?embed=1`)).status).toBe(200)
  })
  test('a map name that is markup is escaped', async () => {
    round({ map: '<i>x</i>' })
    const html = await text(`/servers/${serverId}/maps/${encodeURIComponent('<i>x</i>')}/rounds?embed=1`)
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
    expect(html).not.toContain('<i>x</i>')
  })
})

describe('the limiter', () => {
  test('the game pages and the role guide share one count per address: the 121st request is a 429, another address is not affected', async () => {
    process.env.TRUST_PROXY = '1'
    mod.resetRolePages()
    const from = (ip: string) => ({ 'X-Forwarded-For': ip })
    for (let i = 0; i < 60; i++) expect((await get(`/servers/${serverId}/maps?embed=1`, false, from('10.1.0.1'))).status).toBe(200)
    for (let i = 0; i < 60; i++) expect((await get(`/servers/${serverId}/stats?embed=1`, false, from('10.1.0.1'))).status).toBe(200)
    const over = await get(`/servers/${serverId}/maps?embed=1`, false, from('10.1.0.1'))
    expect(over.status).toBe(429)
    expect(over.headers.get('Retry-After')).toBeTruthy()
    expect((await get(`/servers/${serverId}/maps?embed=1`, false, from('10.1.0.2'))).status).toBe(200)
    delete process.env.TRUST_PROXY
    mod.resetRolePages()
  })
})
