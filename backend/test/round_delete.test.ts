import { expect, test, describe, beforeAll, beforeEach } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
process.env.ADMIN_STEAM_IDS = '76561198000000000'

// Deleting test rounds: an admin deletes a round's replay (the round stays in the statistics), a round with
// its replay, or every round only bots played in. Admin session, same-site Origin, audited.

let app: any, Store: any, db: any, cookie: string, serverId: string
const ADMIN = '76561198000000000', A = '76561198000000001', BOT1 = '999000000001', BOT2 = '999000000002'
let n = 0

beforeAll(async () => {
  app = (await import('../src/index')).default
  Store = (await import('../src/services/Store')).Store
  db = (await import('../src/services/Database')).default
  cookie = (await serializeSigned('steam_id', ADMIN, 'test-secret-test-secret-test-secret-0')).split(';')[0]!
})

beforeEach(() => {
  Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 300, maxMb: 300, maxPinned: 2 })
  serverId = (Store.addServer('Delete') as any).id
})

const req = (path: string, init: RequestInit = {}, auth = true) =>
  app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(auth ? { Cookie: cookie } : {}), ...(init.headers as any) } }))
const form = (path: string, body: string, auth = true, headers: Record<string, string> = {}) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body }, auth)
const audit = (action: string) => db.query('SELECT steam_id, details FROM audit_log WHERE server_id = ? AND action = ?').all(serverId, action) as any[]
const count = (table: string, id: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ? AND ${table === 'rounds' ? 'round_id' : table === 'round_tracks' ? 'round_id' : 'round_id'} = ?`).get(serverId, id) as any).n

/** A round with its players, a death, a revival and a track. */
function round(players: string[] = [A]) {
  const id = `round-${String(++n).padStart(6, '0')}`
  Store.recordRound(serverId, { roundId: id, map: 'ttt_a', startedAt: null, duration: 60, result: 'innocents',
    players: players.map(p => ({ steamId: p, nick: 'n', role: 'innocent', team: 'innocents', survived: true, won: true })),
    deaths: [{ victim: players[0]!, attacker: null, at: 5 }], revives: [{ victim: players[0]!, reviver: null, how: null, why: null, at: 9 }] })
  const track = { roundId: id, map: 'ttt_a', fingerprint: null, truncated: false, degraded: false, t: [0], players: [{ id: players[0]!, segments: [{ from: 0, x: [1], y: [1], z: [1], a: [1] }] }], deaths: [] }
  Store.recordTrack(serverId, track, JSON.stringify(track))
  return id
}

describe('one round', () => {
  test('deleting the replay keeps the round and its numbers', async () => {
    const id = round()
    const r = await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=replay')
    expect(r.status).toBe(302)
    expect(Store.getTrack(serverId, id)).toBeNull()
    expect(count('rounds', id)).toBe(1)
    expect(count('round_players', id)).toBe(1)
    expect(audit('TRACK_DELETED')).toEqual([{ steam_id: ADMIN, details: id }])
  })
  test('deleting the round takes everything stored for it, and only that round', async () => {
    const id = round(), other = round()
    expect((await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=round')).status).toBe(302)
    for (const t of ['rounds', 'round_players', 'deaths', 'round_revives', 'round_tracks']) expect(count(t, id), t).toBe(0)
    for (const t of ['rounds', 'round_players', 'deaths', 'round_revives', 'round_tracks']) expect(count(t, other), t).toBe(1)
    expect(audit('ROUND_DELETED')).toEqual([{ steam_id: ADMIN, details: id }])
  })
  test('a pinned replay goes too: asking is the decision', async () => {
    const id = round()
    Store.pinTrack(serverId, id, true, ADMIN)
    await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=replay')
    expect(Store.getTrack(serverId, id)).toBeNull()
  })
  test('it must say what; an unknown round or server is a 404; a round of another server is untouched', async () => {
    const id = round()
    expect((await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=everything')).status).toBe(400)
    expect((await form(`/servers/${serverId}/rounds/${id}/delete`, '')).status).toBe(400)
    expect((await form(`/servers/${serverId}/rounds/nope/delete`, 'what=round')).status).toBe(404)
    expect((await form(`/servers/nope/rounds/${id}/delete`, 'what=round')).status).toBe(404)
    const other = (Store.addServer('Other') as any).id
    expect((await form(`/servers/${other}/rounds/${id}/delete`, 'what=round')).status).toBe(404)
    expect(count('rounds', id)).toBe(1)
  })
  test('not for guests or players, and not from another site', async () => {
    const id = round()
    expect((await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=round', false)).status).toBe(401)
    expect((await form(`/servers/${serverId}/rounds/${id}/delete`, 'what=round', true, { Origin: 'https://evil.example' })).status).toBe(403)
    expect(count('rounds', id)).toBe(1)
    expect(audit('ROUND_DELETED')).toEqual([])
  })
})

describe('test rounds', () => {
  test('only rounds that bots alone played in are deleted, with everything stored for them', async () => {
    const real = round([A]), mixed = round([A, BOT1]), b1 = round([BOT1]), b2 = round([BOT1, BOT2])
    expect(Store.countBotRounds(serverId)).toBe(2)
    const r = await form(`/servers/${serverId}/rounds/delete-bots`, '')
    expect(r.status).toBe(302)
    expect(count('rounds', real)).toBe(1)
    expect(count('rounds', mixed)).toBe(1)
    for (const id of [b1, b2]) for (const t of ['rounds', 'round_players', 'deaths', 'round_revives', 'round_tracks']) expect(count(t, id), `${id} ${t}`).toBe(0)
    expect(audit('BOT_ROUNDS_DELETED')).toEqual([{ steam_id: ADMIN, details: '2 rounds' }])
    expect(Store.countBotRounds(serverId)).toBe(0)
  })
  test("another server's test rounds are not touched; guests cannot", async () => {
    const other = (Store.addServer('Other') as any).id
    const mine = round([BOT1])
    serverId = other
    const theirs = round([BOT2])
    expect((await form(`/servers/${other}/rounds/delete-bots`, '', false)).status).toBe(401)
    await form(`/servers/${other}/rounds/delete-bots`, '')
    expect(count('rounds', theirs)).toBe(0)
    serverId = (db.query('SELECT server_id FROM rounds WHERE round_id = ?').get(mine) as any).server_id
    expect(count('rounds', mine)).toBe(1)
  })
})

describe('the buttons', () => {
  test('the replay page offers both deletions to an admin, and the stats page the test rounds', async () => {
    const id = round([BOT1])
    Store.setTrackConfig({ keepCount: 200, keepMb: 200, maxCount: 300, maxMb: 300, maxPinned: 2 })
    const replay = await (await req(`/servers/${serverId}/rounds/${id}/replay?bots=1`)).text()
    expect(replay).toContain('data-delete="replay"')
    expect(replay).toContain('data-delete="round"')
    const stats = await (await req(`/servers/${serverId}/stats`)).text()
    expect(stats).toContain('data-delete-bots')
    expect(stats).toContain('Delete 1 test round (bots only)')
    const nothing = await (await req(`/servers/${(Store.addServer('Empty') as any).id}/stats`)).text()
    expect(nothing).not.toContain('data-delete-bots')
  })
})
