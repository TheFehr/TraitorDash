import { COVERAGE, lookup, type CoverageRecord, type Kind, type Status, type TextureCensus } from '../maps/coverage'

// RFC 32, 5: what the admin page shows, made from the coverage records of the maps of a server. Pure: the records go in, the numbers come out.
// Statuses are looked up now, in the registry as it is, not read from the record: a status changed in the registry shows at once, without a rebuild.

export interface CoverageInput { map: string, /** Where the map's 3D mesh stands (queued, parsed, failed, ...). */ state: string, record: CoverageRecord | null }

export interface StatusTotals { worldFaces: number, brushEntities: number, brushFaces: number }
export interface GapRow {
  kind: Kind, key: string, status: Status
  /** The number of maps it is in, its faces (all of the map's faces that carry it) and, for a class, its entities. */
  maps: number, faces: number, entities: number
  /** The map with the most of it, and how many faces that is. */
  top: { map: string, faces: number, entities: number }
}
export interface MapRow {
  map: string, state: string, record: CoverageRecord | null
  /** The faces and entities of what is a `gap` here, and how many different things are `unknown`. */
  gapFaces: number, gapEntities: number, unknown: number
}
/** One map's row of the start-state card (RFC 35, 5): the doors, rotating doors and linear movers that start closed, that start open and were placed at the open end, and that start open and were left out. */
export interface StartRow { map: string, closed: number, openPlaced: number, openLeftOut: number, startPositioned: number }
export interface StartReport {
  /** The maps with a record that has start states (a record from before RFC 35 has none). */
  withData: number
  totals: { closed: number, openPlaced: number, openLeftOut: number, startPositioned: number }
  /** By class, over the same maps. */
  byClass: Record<string, { closed: number, openPlaced: number, openLeftOut: number }>
  /** The maps with start states, those with the most parts that moved or were left out first. */
  rows: StartRow[]
}
/** One map's row of the texture card (RFC 36, 4): its census and the number of materials left to a fallback. */
export interface TextureRow extends TextureCensus { map: string, fallback: number }
export interface TextureReport {
  /** The maps with a record that has the texture census (a record from before RFC 36 has none). */
  withData: number
  totals: TextureCensus & { fallback: number }
  /** The maps with the census, the largest GLB first. */
  rows: TextureRow[]
}
export interface CoverageReport {
  maps: number, withRecord: number, without: string[]
  starts: StartReport
  textures: TextureReport
  totals: Record<Status, StatusTotals>
  gaps: GapRow[]
  rows: MapRow[]
  /** The lumps that are not read, summed, and the point entities that belong to a feature that is not read. */
  lumps: CoverageRecord['lumps']
  pointFeatures: Record<string, number>
}

const STATUS_ORDER: Status[] = ['drawn', 'invisible', 'gap', 'not read', 'unknown']

/**
 * The status of a face by the flags it carries: `unknown` if any flag is, else `gap` if any is, else `invisible` if any is (the extractor leaves out a face that has
 * one of those flags), else `drawn` (no flags is drawn too). So a face is counted once.
 */
export function flagSetStatus(set: string): Status {
  if (set === '-') return 'drawn'
  const statuses = set.split('|').map(f => lookup('flag', f).status)
  for (const s of ['unknown', 'gap', 'invisible'] as const) if (statuses.includes(s)) return s
  return 'drawn'
}

/** The faces of a record's world model by status; each face once. Faces left out for their material are `invisible` whatever their flags said (the rule is in the registry). */
export function worldFacesByStatus(r: CoverageRecord): Record<Status, number> {
  const out: Record<Status, number> = { drawn: 0, invisible: 0, gap: 0, 'not read': 0, unknown: 0 }
  for (const [set, n] of Object.entries(r.flags)) out[flagSetStatus(set)] += n
  const byMaterial = r.outcome.skippedByMaterial
  out.drawn -= byMaterial; out.invisible += byMaterial
  return out
}

const emptyTotals = (): StatusTotals => ({ worldFaces: 0, brushEntities: 0, brushFaces: 0 })

/** What the registry says about a thing; the default. Another can be given (a test, to have a `gap`: the registry has none left since RFC 33). */
export type StatusOf = (kind: Kind, key: string) => Status

export function summarise(inputs: CoverageInput[], statusOf: StatusOf = (kind, key) => lookup(kind, key).status): CoverageReport {
  const totals = Object.fromEntries(STATUS_ORDER.map(s => [s, emptyTotals()])) as Record<Status, StatusTotals>
  const lumps = { lighting: 0, overlays: 0, cubemaps: 0, gameLump: 0, visibility: 0, pakfile: 0 }
  const pointFeatures: Record<string, number> = {}
  const gaps = new Map<string, GapRow>()
  const rows: MapRow[] = []
  const without: string[] = []
  let withRecord = 0

  const note = (map: string, kind: Kind, key: string, faces: number, entities: number, row: MapRow) => {
    const status = statusOf(kind, key)
    if (status !== 'gap' && status !== 'unknown') return
    const id = `${kind}:${key}`
    const g = gaps.get(id) ?? { kind, key, status, maps: 0, faces: 0, entities: 0, top: { map, faces: -1, entities: 0 } }
    g.maps++; g.faces += faces; g.entities += entities
    if (faces > g.top.faces || (faces === g.top.faces && entities > g.top.entities)) g.top = { map, faces, entities }
    gaps.set(id, g)
    if (status === 'gap') { row.gapFaces += faces; row.gapEntities += entities } else row.unknown++
  }

  for (const input of inputs) {
    const r = input.record
    const row: MapRow = { map: input.map, state: input.state, record: r, gapFaces: 0, gapEntities: 0, unknown: 0 }
    rows.push(row)
    if (!r) { without.push(input.map); continue }
    withRecord++
    const world = worldFacesByStatus(r)
    for (const s of STATUS_ORDER) totals[s].worldFaces += world[s]
    for (const b of r.brush) { const t = totals[statusOf('class', b.class)]; t.brushEntities += b.entities; t.brushFaces += b.faces }
    if (r.brushOther) { totals.unknown.brushEntities += r.brushOther.entities; totals.unknown.brushFaces += r.brushOther.faces }
    for (const k of Object.keys(lumps) as (keyof typeof lumps)[]) lumps[k] += r.lumps[k] ?? 0
    for (const [k, n] of Object.entries(r.pointFeatures)) pointFeatures[k] = (pointFeatures[k] ?? 0) + n

    for (const b of r.brush) note(input.map, 'class', b.class, b.faces, b.entities, row)
    // flags: a flag is counted once for each face that carries it (a face with two flags is in two rows here, unlike in the totals)
    const perFlag = new Map<string, number>()
    for (const [set, n] of Object.entries(r.flags)) if (set !== '-') for (const f of set.split('|')) perFlag.set(f, (perFlag.get(f) ?? 0) + n)
    for (const [f, n] of perFlag) note(input.map, 'flag', f, n, 0, row)
    for (const [key, n] of Object.entries(r.material)) if (n > 0) note(input.map, 'material', key, n, 0, row)
  }

  const starts: StartReport = { withData: 0, totals: { closed: 0, openPlaced: 0, openLeftOut: 0, startPositioned: 0 }, byClass: {}, rows: [] }
  for (const input of inputs) {
    const st = input.record?.startStates
    if (!st) continue
    starts.withData++
    starts.totals.closed += st.closed; starts.totals.openPlaced += st.openPlaced; starts.totals.openLeftOut += st.openLeftOut; starts.totals.startPositioned += st.startPositioned
    for (const [cls, c] of Object.entries(st.byClass)) {
      const t = starts.byClass[cls] ??= { closed: 0, openPlaced: 0, openLeftOut: 0 }
      t.closed += c.closed; t.openPlaced += c.openPlaced; t.openLeftOut += c.openLeftOut
    }
    starts.rows.push({ map: input.map, closed: st.closed, openPlaced: st.openPlaced, openLeftOut: st.openLeftOut, startPositioned: st.startPositioned })
  }
  starts.rows.sort((a, b) => (b.openPlaced + b.openLeftOut) - (a.openPlaced + a.openLeftOut) || b.openLeftOut - a.openLeftOut || (a.map < b.map ? -1 : a.map > b.map ? 1 : 0))

  const textures: TextureReport = { withData: 0, totals: { materials: 0, textured: 0, notFound: 0, notDecodable: 0, ceiling: 0, pngBytes: 0, glbBytes: 0, fallback: 0 }, rows: [] }
  for (const input of inputs) {
    const t = input.record?.textures
    if (!t) continue
    textures.withData++
    const fallback = t.notFound + t.notDecodable + t.ceiling
    for (const k of ['materials', 'textured', 'notFound', 'notDecodable', 'ceiling', 'pngBytes', 'glbBytes'] as const) textures.totals[k] += t[k]
    textures.totals.fallback += fallback
    textures.rows.push({ map: input.map, ...t, fallback })
  }
  textures.rows.sort((a, b) => b.glbBytes - a.glbBytes || (a.map < b.map ? -1 : a.map > b.map ? 1 : 0))

  const ranked = [...gaps.values()].sort((a, b) => b.faces - a.faces || b.entities - a.entities || b.maps - a.maps || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  rows.sort((a, b) => (a.record ? 0 : 1) - (b.record ? 0 : 1) || b.gapFaces - a.gapFaces || b.unknown - a.unknown || (a.map < b.map ? -1 : a.map > b.map ? 1 : 0))
  return { maps: inputs.length, withRecord, without, starts, textures, totals, gaps: ranked, rows, lumps, pointFeatures }
}

/** The size of a lump in the unit that reads best: bytes, KB or MB (thousands, as the file sizes of the pages are). */
export const sizeText = (bytes: number): string =>
  bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`

/** The registry's entries of a status, for the legend of the page. */
export const entriesOf = (status: Status) => COVERAGE.filter(e => e.status === status)
