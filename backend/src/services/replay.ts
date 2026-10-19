import { createHash } from 'node:crypto'
import { Store } from './Store'
import { getReplayRound, type StatsOptions } from './stats'
import { planLevels } from './mapplan'
import type { LevelRange } from '../replaylogic'
import { chooseBackground, versionMismatch, type BackgroundKind } from '../replaylogic'

/**
 * What the replay page needs about one round, in one JSON document (RFC 12, 3.5): the round's header
 * and players, the stored track, and the best background there is for its map. The same for every
 * viewer, so one ETag serves all of them; who is looking is in the page, not here.
 */
export interface ReplayPayload {
  round: { id: string, map: string | null, result: string, duration: number | null, startedAt: string | null }
  players: { id: string, nick: string | null, role: string | null, team: string | null, won: boolean, survived: boolean }[]
  track: unknown
  trackInfo: { truncated: boolean, degraded: boolean, fingerprint: string | null, pinned: boolean }
  background: {
    kind: BackgroundKind
    /** The mesh to load, for kind "mesh". */
    meshUrl?: string
    /** The floor plan grid, for kind "plan". */
    plan?: unknown
    /** The storeys, for choosing a level and cutting the map away. */
    levels: LevelRange[]
    /** The mesh or plan was made for another version of the map than the round ran on. */
    mismatch: boolean
  }
}

/** The storeys the GLB writer named in its level nodes (RFC 11, 3.6): the JSON chunk of the binary glTF. */
export function glbLevels(glb: Uint8Array): LevelRange[] {
  if (glb.length < 20) return []
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67 /* glTF */ || dv.getUint32(16, true) !== 0x4e4f534a /* JSON */) return []
  const len = dv.getUint32(12, true)
  if (20 + len > glb.length) return []
  try {
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)))
    const levels: LevelRange[] = []
    for (const n of json.nodes ?? []) {
      const e = n?.extras
      if (e && Number.isInteger(e.level) && Number.isFinite(e.lo) && Number.isFinite(e.hi)) levels.push({ index: e.level, lo: e.lo, hi: e.hi })
    }
    return levels.sort((a, b) => a.index - b.index)
  } catch { return [] }
}

/** The replay of a round, or null when it has no track or is not shown (an unknown round, a bot-only one without `bots`). */
export function buildReplay(serverId: string, roundId: string, o?: StatsOptions): { payload: ReplayPayload, etag: string } | null {
  const round = getReplayRound(serverId, roundId, o)
  const stored = round && Store.getTrack(serverId, roundId)
  if (!round || !stored) return null

  const map = round.map ?? stored.meta.map
  const mesh = Store.getMesh(serverId, map)
  const planText = mesh ? null : Store.getMapPlan(serverId, map)
  const planMeta = planText ? Store.getMapPlans(serverId).find(p => p.map === map) ?? null : null
  const kind = chooseBackground({ mesh: !!mesh, plan: !!planText })
  const meshFingerprint = mesh ? (Store.getMaps(serverId).maps.find(m => m.name === map)?.fingerprint ?? null) : null

  const grid = planText ? JSON.parse(planText) : null
  const background: ReplayPayload['background'] = {
    kind,
    levels: mesh ? glbLevels(mesh) : grid ? planLevels(grid).map(l => ({ index: l.index, lo: l.lo, hi: l.hi })) : [],
    mismatch: versionMismatch(stored.meta.fingerprint, mesh ? meshFingerprint : planMeta?.fingerprint ?? null),
  }
  if (kind === 'mesh') background.meshUrl = `/servers/${serverId}/maps/${encodeURIComponent(map)}/mesh.glb`
  if (kind === 'plan') background.plan = grid

  const payload: ReplayPayload = {
    round: { id: round.roundId, map: round.map, result: round.result, duration: round.duration, startedAt: round.startedAt },
    players: round.players,
    track: stored.track,
    trackInfo: { truncated: stored.meta.truncated, degraded: stored.meta.degraded, fingerprint: stored.meta.fingerprint, pinned: stored.meta.pinned },
    background,
  }
  // A track is immutable; what can change is what is drawn behind it, and the pin.
  const etag = 'W/"' + createHash('sha1').update(JSON.stringify([
    stored.meta.createdAt, stored.meta.bytes, stored.meta.pinned, !!o?.bots, kind, meshFingerprint, planMeta?.scannedAt ?? null, background.mismatch,
  ])).digest('hex').slice(0, 20) + '"'
  return { payload, etag }
}
