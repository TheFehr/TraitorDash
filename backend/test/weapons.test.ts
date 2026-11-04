import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// RFC 21: weapon statistics and killzones. The report's new fields, the tables made from them, the picture, and the
// pages (a guest's, an admin's, and the window's).

let api: any, app: any, Store: any, db: any, stats: any, kz: any, wn: any, mig: any
const ADMIN = '76561198000000000', USER = '76561198000000042'
const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003', BOT = '999000000007'
let serverId: string, token: string, n = 0

beforeAll(async () => {
  api = (await import('../src/routes/api')).default
  app = (await import('../src/index')).app
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  stats = await import('../src/services/stats')
  kz = await import('../src/services/killzones')
  wn = await import('../src/weaponName')
  mig = await import('../src/services/migrations')
})
beforeEach(async () => {
  const added = Store.addServer('Weapons') as any
  serverId = added.id; token = added.token
  ;(await import('../src/routes/api')).roundLimiter.reset()
})

const round = (over: Record<string, unknown> = {}) => ({
  round_id: `a1b2c3d4-${String(++n).padStart(4, '0')}`, map: 'ttt_a', started_at: '2026-11-04T20:00:00Z', duration: 300, result: 'traitors',
  players: [
    { steam_id: A, nick: 'Alice', role: 'traitor', team: 'traitors', survived: true, won: true },
    { steam_id: B, nick: 'Bob', role: 'innocent', team: 'innocents', survived: false, won: false },
    { steam_id: C, nick: 'Cy', role: 'innocent', team: 'innocents', survived: false, won: false },
  ],
  deaths: [
    { victim: B, attacker: A, at: 100, weapon: 'weapon_ttt_m16', x: 100, y: 100, z: 10 },
    { victim: C, attacker: null, at: 200, weapon: 'worldspawn', x: -100, y: 100, z: 10 },
  ],
  damage: [
    { attacker: A, weapon: 'weapon_ttt_m16', damage: 120, hits: 8, friendly: false },
    { attacker: A, weapon: 'weapon_ttt_m16', damage: 25, hits: 1, friendly: true },
    { attacker: B, weapon: 'weapon_zm_shotgun', damage: 60, hits: 6, friendly: false },
  ],
  ...over,
})
const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
  api.request('/v1/round', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
const sendOk = async (b: any) => { const r = await post(b); expect(r.status).toBe(200); return b }
const count = (t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE server_id = ?`).get(serverId) as any).n

describe('the report', () => {
  test('stores the weapon and the place of a death, and the damage', async () => {
    const b = await sendOk(round())
    const d = db.query('SELECT victim_steam_id v, weapon, x, y, z FROM deaths WHERE server_id = ? AND round_id = ? ORDER BY id').all(serverId, b.round_id)
    expect(d).toEqual([{ v: B, weapon: 'weapon_ttt_m16', x: 100, y: 100, z: 10 }, { v: C, weapon: 'worldspawn', x: -100, y: 100, z: 10 }])
    expect(count('round_damage')).toBe(3)
  })

  test('a round from an old bridge is stored as before, with nulls', async () => {
    const b = round(); for (const d of b.deaths as any[]) { delete d.weapon; delete d.x; delete d.y; delete d.z }; delete (b as any).damage
    await sendOk(b)
    expect(db.query('SELECT weapon, x FROM deaths WHERE server_id = ?').all(serverId)).toEqual([{ weapon: null, x: null }, { weapon: null, x: null }])
    expect(count('round_damage')).toBe(0)
  })

  test('a weapon with other characters, or half a position, is stored as unknown, not refused', async () => {
    const b = round({ deaths: [{ victim: B, attacker: A, weapon: 'x; DROP TABLE', x: 1, y: 2 }, { victim: C, attacker: A, weapon: 'ok_w', x: 1, y: 2, z: 99999999 }] })
    await sendOk(b)
    expect(db.query('SELECT weapon, x, y, z FROM deaths WHERE server_id = ? ORDER BY id').all(serverId)).toEqual([
      { weapon: null, x: null, y: null, z: null }, { weapon: 'ok_w', x: null, y: null, z: null }])
  })

  test('damage entries that do not fit are dropped; the same attacker, weapon and kind are added up', async () => {
    const b = round({ damage: [
      { attacker: A, weapon: 'w1', damage: 10, hits: 1 }, { attacker: A, weapon: 'w1', damage: 5, hits: 2 },
      { attacker: '76561198000000099', weapon: 'w1', damage: 1, hits: 1 }, // not in the round
      { attacker: A, weapon: 'bad weapon!', damage: 1, hits: 1 }, { attacker: A, weapon: 'w2', damage: -5, hits: 1 }, { attacker: A, weapon: 'w3', damage: 5, hits: 'x' },
    ] })
    await sendOk(b)
    expect(db.query('SELECT steam_id, weapon, friendly, damage, hits FROM round_damage WHERE server_id = ?').all(serverId)).toEqual([{ steam_id: A, weapon: 'w1', friendly: 0, damage: 15, hits: 3 }])
  })

  test('more than 1,024 damage entries, or a damage that is not an array, is a 400 that stores nothing', async () => {
    const many = Array.from({ length: 1025 }, () => ({ attacker: A, weapon: 'w', damage: 1, hits: 1 }))
    expect((await post(round({ damage: many }))).status).toBe(400)
    expect((await post(round({ damage: 'lots' }))).status).toBe(400)
    expect(count('rounds')).toBe(0)
  })

  test('a repeat of a round changes nothing; deleting the server deletes its damage', async () => {
    const b = await sendOk(round())
    await sendOk(b)
    expect(count('round_damage')).toBe(3)
    Store.deleteServer(serverId)
    expect(count('round_damage')).toBe(0)
  })

  test('the migration adds the columns and the table to an existing database, and a second run changes nothing', () => {
    const d = new Database(':memory:')
    for (const m of mig.migrations.slice(0, 24)) m(d)
    d.run('PRAGMA user_version = 24')
    mig.migrate(d); mig.migrate(d)
    expect((d.query('PRAGMA table_info(deaths)').all() as any[]).map(c => c.name)).toEqual(expect.arrayContaining(['weapon', 'x', 'y', 'z']))
    expect(d.query("SELECT name FROM sqlite_master WHERE name='round_damage'").get()).toBeTruthy()
  })
})

describe('the tracks that are already stored', () => {
  test('give their weapons and places to the deaths of existing rounds (v26), matched by victim and time', () => {
    const d = new Database(':memory:')
    for (const m of mig.migrations.slice(0, 25)) m(d)
    d.run('PRAGMA user_version = 25')
    d.run("INSERT INTO rounds (server_id, round_id, map, result) VALUES ('s', 'r1', 'm', 'traitors'), ('s', 'r2', 'm', 'traitors')")
    const death = d.prepare("INSERT INTO deaths (server_id, round_id, victim_steam_id, attacker_steam_id, at_seconds) VALUES ('s', ?, ?, NULL, ?)")
    death.run('r1', B, 100); death.run('r1', B, 240); death.run('r1', C, 101); death.run('r2', B, 50)
    const track = (deaths: unknown[]) => JSON.stringify({ roundId: 'r', deaths })
    const put = d.prepare("INSERT INTO round_tracks (server_id, round_id, map, bytes, created_at, data) VALUES ('s', ?, 'm', 1, 'now', ?)")
    put.run('r1', track([
      { victim: B, t: 241000, vx: 3, vy: -2, vz: 1, weapon: 'late_gun' },
      { victim: B, t: 99500, vx: 10, vy: 20, vz: 30, weapon: 'early_gun' },
      { victim: C, t: 150000, vx: 1, vy: 1, vz: 1, weapon: 'too_far' }, // more than 3 s from 101: no match
    ]))
    put.run('r2', 'not json')
    mig.migrate(d)
    const rows = d.query("SELECT round_id r, victim_steam_id v, at_seconds a, weapon w, x, y, z FROM deaths ORDER BY id").all() as any[]
    expect(rows[0]).toMatchObject({ w: 'early_gun', x: 80, y: 160, z: 240 })
    expect(rows[1]).toMatchObject({ w: 'late_gun', x: 24, y: -16, z: 8 })
    expect(rows[2]).toMatchObject({ w: null, x: null })
    expect(rows[3]).toMatchObject({ w: null, x: null })
    mig.migrate(d) // a second run changes nothing
    expect((d.query("SELECT COUNT(*) n FROM deaths WHERE weapon IS NOT NULL").get() as any).n).toBe(2)
  })
})

describe('the weapon tables', () => {
  test('damage, share, hits, kills, deaths and players of a known set of rounds', async () => {
    await sendOk(round()); await sendOk(round())
    const w = stats.getWeaponStats(serverId)
    expect(w.rows.map((r: any) => r.weapon)).toEqual(['weapon_ttt_m16', 'weapon_zm_shotgun', 'worldspawn'])
    expect(w.rows[0]).toMatchObject({ weapon: 'weapon_ttt_m16', damage: 240, friendlyDamage: 50, hits: 16, kills: 2, deaths: 2, players: 1, rounds: 2 })
    expect(w.rows[1]).toMatchObject({ weapon: 'weapon_zm_shotgun', damage: 120, hits: 12, kills: 0, deaths: 0 })
    expect(w.rows[2]).toMatchObject({ weapon: 'worldspawn', damage: 0, kills: 0, deaths: 2 }) // the world kills nobody
    expect(w.totalDamage).toBe(360)
    expect(w.rounds).toEqual({ withData: 2, total: 2 })
  })

  test('friendly damage is kept apart and does not rank', async () => {
    await sendOk(round({ damage: [{ attacker: A, weapon: 'a_gun', damage: 500, hits: 5, friendly: true }, { attacker: B, weapon: 'b_gun', damage: 10, hits: 1, friendly: false }] }))
    const w = stats.getWeaponStats(serverId)
    expect(w.rows[0].weapon).toBe('b_gun')
    expect(w.rows.find((r: any) => r.weapon === 'a_gun')).toMatchObject({ damage: 0, friendlyDamage: 500 })
  })

  test('the sort orders the table; bots are left out unless asked for', async () => {
    await sendOk(round({ players: [
      { steam_id: A, nick: 'A', role: 'traitor', team: 'traitors', survived: true, won: true }, { steam_id: BOT, nick: 'Bot', role: 'innocent', team: 'innocents', survived: false, won: false }],
      deaths: [{ victim: BOT, attacker: A, weapon: 'k_gun' }], damage: [{ attacker: A, weapon: 'k_gun', damage: 10, hits: 10 }, { attacker: A, weapon: 'd_gun', damage: 99, hits: 1 }, { attacker: BOT, weapon: 'bot_gun', damage: 1000, hits: 1 }] }))
    expect(stats.getWeaponStats(serverId, undefined, 'kills').rows[0].weapon).toBe('k_gun')
    expect(stats.getWeaponStats(serverId, undefined, 'hits').rows[0].weapon).toBe('k_gun')
    expect(stats.getWeaponStats(serverId, undefined, 'damage').rows[0].weapon).toBe('d_gun')
    expect(stats.getWeaponStats(serverId).rows.some((r: any) => r.weapon === 'bot_gun')).toBe(false)
    expect(stats.getWeaponStats(serverId, { bots: true }).rows[0].weapon).toBe('bot_gun')
    expect(stats.parseWeaponSort('nonsense')).toBe('damage')
  })

  test('a round without weapon data does not count as one the numbers rest on', async () => {
    await sendOk(round())
    const old = round(); delete (old as any).damage; for (const d of old.deaths as any[]) delete d.weapon
    await sendOk(old)
    expect(stats.getWeaponStats(serverId).rounds).toEqual({ withData: 1, total: 2 })
  })

  test("a player's weapons", async () => {
    await sendOk(round())
    const rows = stats.getPlayerWeapons(serverId, A)
    expect(rows).toEqual([expect.objectContaining({ weapon: 'weapon_ttt_m16', damage: 120, friendlyDamage: 25, hits: 8, kills: 1, deaths: 0 })])
    expect(stats.getPlayerWeapons(serverId, B).map((r: any) => [r.weapon, r.deaths])).toEqual(expect.arrayContaining([['weapon_ttt_m16', 1], ['weapon_zm_shotgun', 0]]))
  })

  test('the names are readable and the class stays the fallback', () => {
    expect(wn.weaponName('weapon_ttt_m16')).toBe('M16')
    expect(wn.weaponName('weapon_zm_shotgun')).toBe('Shotgun')
    expect(wn.weaponName('weapon_ttt2_cool_thing')).toBe('Cool thing')
    expect(wn.weaponName('worldspawn')).toContain('world')
    expect(wn.weaponName(null)).toBe('Unknown')
  })
})

describe('killzones', () => {
  const deaths = (list: [number, number, number, string?][]) => round({ deaths: list.map(([x, y, z, w]) => ({ victim: B, attacker: A, weapon: w ?? 'w', x, y, z })), damage: [] })

  test('deaths are summed into the right squares, a negative position and an edge included', async () => {
    await sendOk(deaths([[0, 0, 0], [127, 127, 0], [128, 0, 0], [-1, -1, 0], [-128, -128, 0], [-129, 0, 0]]))
    const cells = stats.getKillzones(serverId, 'ttt_a').cells
    const at = (bx: number, by: number) => cells.filter((c: any) => c.bx === bx && c.by === by).reduce((s: number, c: any) => s + c.n, 0)
    expect(at(0, 0)).toBe(2); expect(at(1, 0)).toBe(1); expect(at(-1, -1)).toBe(2); expect(at(-2, 0)).toBe(1)
  })

  test('a death with no position is not drawn; the weapon filter; other maps are not mixed in', async () => {
    await sendOk(round({ deaths: [{ victim: B, attacker: A, weapon: 'w' }, { victim: C, attacker: A, weapon: 'w', x: 5, y: 5, z: 5 }], damage: [] }))
    await sendOk({ ...deaths([[5, 5, 5, 'other']]), map: 'ttt_b' })
    await sendOk(deaths([[200, 5, 5, 'other']]))
    const all = stats.getKillzones(serverId, 'ttt_a')
    expect(all.deaths).toBe(2)
    expect(all.weapons).toEqual([{ weapon: 'other', n: 1 }, { weapon: 'w', n: 1 }])
    expect(stats.getKillzones(serverId, 'ttt_a', undefined, 'w').deaths).toBe(1)
    expect(stats.getKillzones(serverId, 'ttt_a', undefined, 'nothing').deaths).toBe(0)
  })

  test('the picture: one square for each, the busiest first, well formed, with nothing that can run or load', async () => {
    await sendOk(deaths([[0, 0, 0], [10, 10, 0], [300, 300, 0]]))
    const sq = kz.squaresOf(stats.getKillzones(serverId, 'ttt_a').cells)
    expect(sq.map((s: any) => s.n)).toEqual([2, 1])
    expect(kz.hottest(sq)[0]).toEqual({ x: 64, y: 64, n: 2 })
    const svg = kz.renderKillzonesSvg(sq, 'a "map" <x>')!
    expect((svg.match(/<rect /g) ?? []).length).toBe(2)
    expect(svg).toContain('2 deaths'); expect(svg).toContain('1 death<')
    expect(svg).not.toMatch(/<script|<image|href=|xlink|onload|<foreignObject/i)
    expect(svg).toContain('a &quot;map&quot; &lt;x&gt;')
    expect(kz.renderKillzonesSvg([], 'm')).toBeNull()
  })

  test('with a plan an admin gets the floor and the storeys; a picture of one storey holds that storey', async () => {
    const grid = { cell: 64, minx: 0, miny: 0, nx: 30, ny: 2, zmin: 0, zmax: 400, rows: [Array(30).fill('0').join('|'), Array(30).fill('300').join('|')] }
    await sendOk(deaths([[10, 10, 5], [10, 10, 305]]))
    const cells = stats.getKillzones(serverId, 'ttt_a').cells
    const { levels, storeyOf } = kz.storeysOf(grid)
    expect(levels.length).toBe(2)
    const low = kz.squaresOf(cells, (z: number) => storeyOf(z) === 0)
    expect(low.map((s: any) => s.n)).toEqual([1])
    const withFloor = kz.renderKillzonesSvg(low, 'ttt_a', { grid, level: 1 })!
    const without = kz.renderKillzonesSvg(low, 'ttt_a')!
    expect(withFloor).toContain('fill="#2b2b2b"'); expect(without).not.toContain('#2b2b2b')
  })

  test('more than 10,000 squares draw the busiest 10,000', () => {
    const sq = Array.from({ length: 10_050 }, (_, i) => ({ bx: i, by: 0, n: 10_050 - i }))
    const svg = kz.renderKillzonesSvg(sq, 'm')!
    expect((svg.match(/<rect /g) ?? []).length).toBe(10_000)
  })
})

describe('the pages', () => {
  const cookie = async (id: string) => (await serializeSigned('steam_id', id, SECRET)).split(';')[0]!
  const get = async (path: string, as: string | null = null) =>
    app.fetch(new Request(`http://localhost${path}`, { headers: as ? { Cookie: await cookie(as) } : {} }))
  const text = async (path: string, as: string | null = null) => { const r = await get(path, as); return { status: r.status, text: await r.text() } }
  const noScript = (t: string) => t.replace(/<script[\s\S]*?<\/script>/g, '')

  test('the Weapons tab lists the weapons, sorted by a link, with no script of its own', async () => {
    await sendOk(round())
    const r = await text(`/servers/${serverId}/stats?view=weapons`)
    expect(r.status).toBe(200)
    expect(r.text).toContain('Most damage by weapon'); expect(r.text).toContain('M16'); expect(r.text).toContain('Shotgun')
    expect(r.text).toContain('data-weapons')
    expect(r.text).toContain('view=weapons&amp;sort=kills')
    expect(r.text).toContain('From 1 of 1 rounds')
    expect(r.text).not.toMatch(/<canvas|<svg/)
  })

  test('the tab says so when no round has weapon data, and the overview tab links to it', async () => {
    const old = round(); delete (old as any).damage; for (const d of old.deaths as any[]) delete d.weapon
    await sendOk(old)
    expect((await text(`/servers/${serverId}/stats?view=weapons`)).text).toContain('data-no-weapons')
    expect((await text(`/servers/${serverId}/stats`)).text).toContain('view=weapons')
  })

  test("a player's page has the weapons table", async () => {
    await sendOk(round())
    const r = await text(`/servers/${serverId}/players/${A}`)
    expect(r.text).toContain('data-player-weapons'); expect(r.text).toContain('M16')
  })

  test('the map page has the killzone picture inline, in the window too, and a filter that is a link', async () => {
    await sendOk(round())
    for (const q of ['', '?embed=1']) {
      const r = await text(`/servers/${serverId}/maps/ttt_a/rounds${q}`)
      expect(r.status).toBe(200)
      expect(r.text).toContain('data-killzones'); expect(r.text).toContain('<svg')
      expect(r.text).toContain('weapon=weapon_ttt_m16')
      expect(noScript(r.text)).not.toMatch(/<canvas/)
    }
    const filtered = await text(`/servers/${serverId}/maps/ttt_a/rounds?weapon=worldspawn`)
    expect(filtered.text).toContain('1 death in 1 round')
    expect((await text(`/servers/${serverId}/maps/ttt_a/rounds?weapon=bad%20name`)).text).toContain('2 deaths')
  })

  test('a map with no deaths with a position says so', async () => {
    const old = round(); for (const d of old.deaths as any[]) { delete d.x; delete d.y; delete d.z }
    await sendOk(old)
    const r = await text(`/servers/${serverId}/maps/ttt_a/rounds`)
    expect(r.text).toContain('data-no-killzones'); expect(r.text).not.toContain('<svg')
  })

  test('a guest gets no floor and no storeys; an admin with a plan gets both', async () => {
    await sendOk(round({ deaths: [{ victim: B, attacker: A, weapon: 'w', x: 10, y: 10, z: 5 }, { victim: C, attacker: A, weapon: 'w', x: 10, y: 10, z: 305 }], damage: [] }))
    Store.setMapPlan(serverId, {
      map: 'ttt_a', fingerprint: null, cell: 64, nx: 30, ny: 2, seeds: 1, traces: null, seconds: null, floorCells: 60, crouchFloors: 0,
      grid: { cell: 64, minx: 0, miny: 0, nx: 30, ny: 2, zmin: 0, zmax: 400, rows: [Array(30).fill('0').join('|'), Array(30).fill('300').join('|')] },
    })
    const path = `/servers/${serverId}/maps/ttt_a/rounds`
    for (const as of [null, USER]) {
      const g = await text(path + '?level=1', as)
      expect(g.text).not.toContain('#2b2b2b'); expect(g.text).not.toContain('level=2'); expect(g.text).toContain('2 deaths in 1 round')
    }
    const a = await text(path, ADMIN)
    expect(a.text).toContain('#2b2b2b'); expect(a.text).toContain('level=2')
    expect((await text(path + '?level=1', ADMIN)).text).toContain('1 death in 1 round')
    expect((await text(path + '?level=9', ADMIN)).text).toContain('2 deaths in 1 round')
    // the window shows no admin extras, whoever looks
    expect((await text(path + '?embed=1', ADMIN)).text).not.toContain('#2b2b2b')
  })
})
