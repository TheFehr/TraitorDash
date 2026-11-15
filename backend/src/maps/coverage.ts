import { DECORATION_CLASSES, FIXTURE_CLASSES, MOVABLE_CLASSES, SURFACE_FLAGS, WATER_CLASSES, type BspHeader, type ByteSource, type EntityCensus, type FaceTally } from './bsp'

// RFC 32: what the map pipeline does with each thing a Source map can hold. The registry below is the catalogue (docs/MAP_COVERAGE.md has the
// same table in prose, and a test fails when they differ); the record (`buildCoverage`) counts, for one map, what it holds per entry.
// Nothing here decides what is drawn: the extractor does, and the registry only describes it. Change a status by changing one line.

/** What the pipeline does with a kind of thing. `unknown` is never in the registry: it is what a lookup answers for a thing nobody has classified. */
export type Status = 'drawn' | 'invisible' | 'gap' | 'not read' | 'unknown'
export type RegistryStatus = Exclude<Status, 'unknown'>
export type Kind = 'flag' | 'material' | 'class' | 'feature'
export interface Entry { kind: Kind, key: string, status: RegistryStatus, note: string }

export const STATUSES: readonly Status[] = ['drawn', 'invisible', 'gap', 'not read', 'unknown']
export const KINDS: readonly Kind[] = ['flag', 'material', 'class', 'feature']

/** The names a class regex lists: `/^func_(a|b)$/` is `func_a`, `func_b`; `/^func_a$/` is `func_a`. The lists of the extractor are the source, so the registry cannot drift from them. */
export const alternatives = (re: RegExp): string[] => {
  const single = /^\^(\w+)\$$/.exec(re.source)
  if (single) return [single[1]!]
  const m = /^\^(\w*)\(([\w|]+)\)\$$/.exec(re.source)
  if (!m) throw new Error(`the class list ${re.source} is not of the form ^prefix(a|b)$ or ^name$, which the coverage registry reads`)
  return m[2]!.split('|').map(a => m[1]! + a)
}

const FLAG: Record<string, [RegistryStatus, string]> = {
  LIGHT: ['drawn', 'The surface gives off light (a light source); the face is drawn as any other and its glow is not modelled.'],
  SKY2D: ['invisible', 'A sky face seen flat; the extractor leaves it out (SKIP_FLAGS), the player sees sky.'],
  SKY: ['invisible', 'A sky face; the extractor leaves it out (SKIP_FLAGS), the player sees sky.'],
  WARP: ['drawn', 'A liquid surface (water, lava, slime): drawn as water, never as a floor (RFC 18, 4.1).'],
  TRANS: ['drawn', 'A translucent surface (glass, grates): drawn as an ordinary face, its translucency is not modelled.'],
  NOPORTAL: ['drawn', 'The game cannot place a portal on it; no visual effect, the face is drawn as any other.'],
  TRIGGER: ['invisible', 'A trigger volume face; the extractor leaves it out (SKIP_FLAGS), a player never sees it.'],
  NODRAW: ['invisible', 'The game does not draw it; the extractor leaves it out (SKIP_FLAGS).'],
  HINT: ['invisible', 'A helper for the map compiler; the extractor leaves it out (SKIP_FLAGS), a player never sees it.'],
  SKIP: ['invisible', 'A helper for the map compiler; the extractor leaves it out (SKIP_FLAGS), a player never sees it.'],
  NOLIGHT: ['drawn', 'The face gets no lightmap; lighting is not read at all, so the face is drawn as any other.'],
  BUMPLIGHT: ['drawn', 'The face is lit with a bump map; lighting is not read, so the face is drawn as any other.'],
  NOSHADOWS: ['drawn', 'The face receives no shadows; shadows are not modelled, the face is drawn as any other.'],
  NODECALS: ['drawn', 'Decals do not stick to it; decals (overlays) are not read, the face is drawn as any other.'],
  NOCHOP: ['drawn', 'The map compiler does not split the face; no visual effect.'],
  HITBOX: ['drawn', 'The face is part of a hitbox of a model; the face is drawn as any other.'],
}

const MATERIAL: [string, RegistryStatus, string][] = [
  ['sky', 'invisible', 'A sky picture pasted on ordinary brushes (the name has `skybox` in it or ends in `sky`): left out as the sky it is (RFC 18, 4.1a).'],
  ['tools/*', 'invisible', 'The helper materials under `tools/` (nodraw, clip, triggers, skybox, black): never a surface a player sees (RFC 18, 4.1a).'],
]

const FIXTURE_NOTE = 'A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2).'
const MOVABLE_NOTE = 'A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20).'
const WATER_NOTE = 'The water brush (a pool a map raises or lowers): its upward liquid faces are drawn as water, moved by `startposition` along `movedir`; the rise during the round is not shown (RFC 33, 4.2).'
const DECORATION_NOTE = 'A brush a player sees and walks through: drawn in a group of its own (Decoration), never a floor or a wall; a face below the map is left out (RFC 33, 4.4).'

/** A class entry whose key ends in `*` stands for every class that begins with what comes before it. */
const CLASSES: [string, RegistryStatus, string][] = [
  ...alternatives(FIXTURE_CLASSES).map((k): [string, RegistryStatus, string] => [k, 'drawn', FIXTURE_NOTE]),
  ...alternatives(MOVABLE_CLASSES).map((k): [string, RegistryStatus, string] => [k, 'drawn', MOVABLE_NOTE]),
  ...alternatives(WATER_CLASSES).map((k): [string, RegistryStatus, string] => [k, 'drawn', WATER_NOTE]),
  ...alternatives(DECORATION_CLASSES).map((k): [string, RegistryStatus, string] => [k, 'drawn', DECORATION_NOTE]),
  ['trigger_*', 'invisible', 'Every trigger (a volume that fires something when touched) is invisible to a player; its faces are not drawn.'],
  ['func_clip_vphysics', 'invisible', 'A volume that blocks physics objects only; invisible.'],
  ['func_areaportal*', 'invisible', 'A door of the map compiler that cuts the map into areas for visibility (area portals and their windows); invisible.'],
  ['func_occluder', 'invisible', 'A volume the engine uses to hide what is behind it; invisible.'],
  ['func_precipitation', 'invisible', 'A volume that rain or snow falls in; the volume itself is invisible (the weather is not drawn).'],
  ['env_embers', 'invisible', 'A volume that particle embers rise from; the brush is a volume, the particles are not drawn.'],
  ['func_dustcloud', 'invisible', 'A volume that a dust cloud of particles fills; the brush is a volume, the particles are not drawn (RFC 33, 4.6).'],
  ['func_buyzone', 'invisible', 'A zone where a player may buy; a volume, not a surface (RFC 33, 4.6).'],
  ['func_bomb_target', 'invisible', 'A zone where a bomb can be planted; a volume, not a surface (RFC 33, 4.6).'],
  ['game_zone_player', 'invisible', 'A zone that counts the players inside it for the map\'s logic; a volume, not a surface (RFC 33, 4.6).'],
  ['ttt_traitor_check', 'invisible', 'A zone of the TTT game, used like a trigger; a volume, not a surface (RFC 33, 4.6).'],
  ['func_dustmotes', 'invisible', 'A volume that floating dust is drawn in; the brush is a volume, the particles are not drawn.'],
  ['func_smokevolume', 'invisible', 'A volume that smoke particles fill; the brush is a volume, the particles are not drawn.'],
]

const FEATURES: [string, RegistryStatus, string][] = [
  ['displacements', 'drawn', 'Terrain (lump 26 and 33): turned into a grid of triangles (RFC 18, 4.3).'],
  ['static props', 'drawn', 'Props placed by the compiler (the `sprp` game lump) and the props of the entity lump, as the models the map carries or the game has (RFC 18, 4.4).'],
  ['textures from the pak', 'drawn', 'The map\'s own materials and textures, read from the pak file at the end of the map (RFC 18, 5).'],
  ['lighting', 'not read', 'The lightmaps (lump 8, HDR lump 53): drawing them needs the lightmap atlas and every face\'s coordinates in it.'],
  ['overlays', 'not read', 'Decals the mapper put on surfaces (lump 45, `info_overlay`): drawing them needs a quad on the surface for each.'],
  ['cubemaps', 'not read', 'Environment cube maps for reflections (lump 42): only matter with reflective materials, which are not modelled.'],
  ['detail props', 'not read', 'Grass and rubble sprites and models of the game lump (`dprp`): drawing them needs the sprite sheet and the placing rules.'],
  ['visibility', 'not read', 'The potentially-visible-set data (lump 4): an optimisation of the game\'s renderer, nothing to see.'],
  ['fog and light entities', 'not read', 'Fog, sun and light entities (`env_fog_controller`, `env_sun`, `light*`): the atmosphere; drawing it needs fog and a lit scene.'],
  ['3D skybox', 'invisible', 'The small copy of the world around `sky_camera`: removed on purpose, it is not part of the map (RFC 11, RFC 18, 4.4).'],
]

export const COVERAGE: readonly Entry[] = [
  ...SURFACE_FLAGS.map(([, name]): Entry => {
    const [status, note] = FLAG[name] ?? (() => { throw new Error(`the surface flag ${name} has no entry in the coverage registry`) })()
    return { kind: 'flag', key: name, status, note }
  }),
  ...MATERIAL.map(([key, status, note]): Entry => ({ kind: 'material', key, status, note })),
  ...CLASSES.map(([key, status, note]): Entry => ({ kind: 'class', key, status, note })),
  ...FEATURES.map(([key, status, note]): Entry => ({ kind: 'feature', key, status, note })),
]

const exact = new Map<string, Entry>(COVERAGE.map(e => [`${e.kind}:${e.key}`, e]))
const prefixes = COVERAGE.filter(e => e.kind === 'class' && e.key.endsWith('*')).map(e => ({ prefix: e.key.slice(0, -1), entry: e })).sort((a, b) => b.prefix.length - a.prefix.length)

export const UNKNOWN_NOTE = 'Not in the registry: nobody has said what the pipeline does with it. Classify it in backend/src/maps/coverage.ts.'

/**
 * What the registry says about a thing. A flag, material or feature is looked up by its exact key. A class is looked up by its exact name first,
 * then by the longest entry that ends in `*` and is a prefix of it (`trigger_*`); anything else is `unknown`, with no entry.
 */
export function lookup(kind: Kind, key: string): { status: Status, note: string, entry: Entry | null } {
  let entry = exact.get(`${kind}:${key}`) ?? null
  if (!entry && kind === 'class') entry = prefixes.find(p => key.startsWith(p.prefix))?.entry ?? null
  return entry ? { status: entry.status, note: entry.note, entry } : { status: 'unknown', note: UNKNOWN_NOTE, entry: null }
}

/** The registry's feature a point entity belongs to, or null (counted for the not-read list: lights, fog, decals, cube maps). */
export function pointFeature(cls: string): string | null {
  if (/^light(_|$)/.test(cls) || /^env_(fog_controller|sun|tonemap_controller)$/.test(cls) || cls === 'shadow_control') return 'fog and light entities'
  if (/^info_overlay/.test(cls)) return 'overlays'
  if (cls === 'env_cubemap') return 'cubemaps'
  return null
}

// ---- the record -----------------------------------------------------------------------------------

export const MAX_BRUSH_CLASSES = 200
export const MAX_POINT_CLASSES = 30
const MAX_NAME = 64

/** A name from the map file made safe to keep and show: lower case, only `a-z 0-9 _ *`, at most 64 characters (`_` when nothing is left). */
export const cleanName = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9_*]/g, '').slice(0, MAX_NAME) || '_'

/** `parentedFaces`: of the faces, those of entities that have a parent entity; the extractor does not draw those even when the class is drawn (only given when there are some). */
export interface BrushClassCount { class: string, entities: number, faces: number, status: Status, parentedFaces?: number }

/** What one map holds, counted per registry entry (RFC 32, 4). Stored as `coverage` in the mesh's `GeometryInfo`. */
export interface CoverageRecord {
  /** The faces of the world model, by flag set (`SKY|NOLIGHT`, `-` for none), and by what became of them. */
  worldFaces: number
  flags: Record<string, number>
  outcome: FaceTally['byOutcome']
  /** Faces left out for the name of their material, by rule: `sky` and `tools/*` (the keys of the material entries). */
  material: { sky: number, 'tools/*': number }
  /** The brush entities by class, the ones the registry does not list first, then those it calls a gap; at most 200 classes, the rest in `brushOther`. */
  brush: BrushClassCount[]
  brushOther?: { classes: number, entities: number, faces: number }
  /** The point entities: the 30 most numerous classes, and the rest together. */
  points: { class: string, count: number }[]
  pointsOther?: { classes: number, entities: number }
  /** Point entities that belong to a feature the pipeline does not read (`fog and light entities`, `overlays`, `cubemaps`), counted over all classes. */
  pointFeatures: Record<string, number>
  /** The sizes in bytes of the lumps the pipeline does not read. */
  lumps: { lighting: number, overlays: number, cubemaps: number, gameLump: number, visibility: number, pakfile: number }
}

const LUMP_MODELS = 14
/** Lump numbers of the Source BSP format (the SDK's bspfile.h). */
const LUMP_OF = { visibility: 4, lighting: 8, gameLump: 35, pakfile: 40, cubemaps: 42, overlays: 45, lightingHdr: 53 } as const

/** The number of faces of each model that is asked for, from the models lump (48 bytes a model; the numbers are the file's, and a model that is not there has none). */
async function facesOfModels(src: ByteSource, header: BspHeader, wanted: Set<number>): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const lump = header.lumps[LUMP_MODELS]!
  if (lump.compressed || lump.length === 0 || lump.length % 48 !== 0 || lump.length > 64 * 1024 * 1024) return out
  const bytes = await src.read(lump.offset, lump.length)
  if (bytes.length !== lump.length) return out
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = lump.length / 48
  for (const m of wanted) if (m < n) { const faces = dv.getInt32(m * 48 + 44, true); if (faces > 0) out.set(m, faces) }
  return out
}

/**
 * The coverage record of a map (RFC 32, 4) from what the extractor counted: the face tally of `extractSurfaces`, the census of `extractMapEntities`, and the
 * directory of the file. It reads one more lump (the models, for the faces of each brush entity) and counts; it decides nothing and changes nothing the mesh holds.
 */
export async function buildCoverage(src: ByteSource, header: BspHeader, tally: FaceTally, census: EntityCensus): Promise<CoverageRecord> {
  const faces = await facesOfModels(src, header, new Set(census.brush.map(b => b.model)))
  // The brush entities by class; names are cleaned first, so two names that become one are one class.
  const byClass = new Map<string, { entities: number, faces: number, parented: number }>()
  for (const b of census.brush) {
    const name = cleanName(b.class)
    const row = byClass.get(name) ?? { entities: 0, faces: 0, parented: 0 }
    row.entities++; row.faces += faces.get(b.model) ?? 0
    if (b.parented) row.parented += faces.get(b.model) ?? 0
    byClass.set(name, row)
  }
  const rank: Record<Status, number> = { unknown: 0, gap: 1, 'not read': 2, drawn: 3, invisible: 4 }
  const classes: BrushClassCount[] = [...byClass].map(([name, r]) => ({ class: name, entities: r.entities, faces: r.faces, status: lookup('class', name).status, ...(r.parented > 0 ? { parentedFaces: r.parented } : {}) }))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.faces - a.faces || b.entities - a.entities || (a.class < b.class ? -1 : a.class > b.class ? 1 : 0))
  const brush = classes.slice(0, MAX_BRUSH_CLASSES)
  const rest = classes.slice(MAX_BRUSH_CLASSES)

  const points = new Map<string, number>()
  const pointFeatures: Record<string, number> = {}
  for (const [raw, count] of census.points) {
    const name = cleanName(raw)
    points.set(name, (points.get(name) ?? 0) + count)
    const feature = pointFeature(name)
    if (feature) pointFeatures[feature] = (pointFeatures[feature] ?? 0) + count
  }
  const ranked = [...points].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const top = ranked.slice(0, MAX_POINT_CLASSES), beyond = ranked.slice(MAX_POINT_CLASSES)
  const beyondEntities = beyond.reduce((n, [, c]) => n + c, 0) + census.pointsOther

  const size = (i: number) => header.lumps[i]!.length
  return {
    worldFaces: tally.worldFaces,
    flags: { ...tally.byFlags },
    outcome: { ...tally.byOutcome },
    material: { sky: tally.byMaterial.sky, 'tools/*': tally.byMaterial.tools },
    brush,
    ...(rest.length ? { brushOther: { classes: rest.length, entities: rest.reduce((n, r) => n + r.entities, 0), faces: rest.reduce((n, r) => n + r.faces, 0) } } : {}),
    points: top.map(([name, count]) => ({ class: name, count })),
    ...(beyondEntities > 0 ? { pointsOther: { classes: beyond.length, entities: beyondEntities } } : {}),
    pointFeatures,
    lumps: { lighting: size(LUMP_OF.lighting) + size(LUMP_OF.lightingHdr), overlays: size(LUMP_OF.overlays), cubemaps: size(LUMP_OF.cubemaps), gameLump: size(LUMP_OF.gameLump), visibility: size(LUMP_OF.visibility), pakfile: size(LUMP_OF.pakfile) },
  }
}

/**
 * A stored record, checked: a mesh made before the record existed has none, and what is stored is JSON that was written by an older or newer build, so the page
 * takes nothing on trust. Returns null for anything that is not a record.
 */
export function asRecord(x: unknown): CoverageRecord | null {
  if (!x || typeof x !== 'object') return null
  const r = x as Record<string, any>
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!num(r.worldFaces) || !r.flags || typeof r.flags !== 'object' || !r.outcome || typeof r.outcome !== 'object' || !Array.isArray(r.brush) || !Array.isArray(r.points) || !r.lumps || typeof r.lumps !== 'object') return null
  if (!Object.values(r.flags).every(num) || !Object.values(r.outcome).every(num) || !Object.values(r.lumps).every(num)) return null
  if (!r.brush.every((b: any) => b && typeof b.class === 'string' && num(b.entities) && num(b.faces) && (b.parentedFaces === undefined || num(b.parentedFaces)) && typeof b.status === 'string' && (STATUSES as readonly string[]).includes(b.status))) return null
  if (!r.points.every((p: any) => p && typeof p.class === 'string' && num(p.count))) return null
  return { ...r, material: { sky: num(r.material?.sky) ? r.material.sky : 0, 'tools/*': num(r.material?.['tools/*']) ? r.material['tools/*'] : 0 }, pointFeatures: r.pointFeatures && typeof r.pointFeatures === 'object' && Object.values(r.pointFeatures).every(num) ? r.pointFeatures : {} } as CoverageRecord
}
