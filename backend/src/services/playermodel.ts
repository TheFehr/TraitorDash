import { modelBase, gameContentEnabled, type GameContentSource } from './gameContent'
import { geometryEnabled } from './mapgeometry'
import { readPosedModel, POSES, type Pose } from '../maps/posedmodel'
import { playerModelGlb } from '../maps/modelGlb'

// RFC 22, 4.1: the player model of the replay as a posed glTF file. One neutral stock model for everyone (the operator's
// setting `PLAYER_MODEL`, a Counter-Strike: Source terrorist by default), read from the game's own files like the props of a
// map are, together with the shared animation set its poses come from. Built once for each pose and kept in memory.

export const DEFAULT_PLAYER_MODEL = 'models/player/phoenix.mdl'
export const ANIMATION_SET = 'models/m_anm.mdl'

/** The model name from the setting, or the default when it is not a model path. */
export const playerModelName = (): string => {
  const set = process.env.PLAYER_MODEL
  return set && modelBase(set) ? set : DEFAULT_PLAYER_MODEL
}

/** On when the backend may read the game's files and the maps' geometry is on (the same switches as the props of a map). */
export const playerModelEnabled = () => geometryEnabled() && gameContentEnabled()

export const isPose = (s: unknown): s is Pose => typeof s === 'string' && (POSES as string[]).includes(s)

let content: GameContentSource | null = null
const built = new Map<string, Promise<Uint8Array | null>>()
/** The place the game's files come from (set at start; null in a test that has none). Forgets what was built. */
export const setPlayerModelContent = (c: GameContentSource | null) => { content = c; built.clear() }

async function build(pose: Pose): Promise<Uint8Array | null> {
  if (!content) return null
  const name = playerModelName()
  const models = await content.models([name])
  const files = models.models.get(name)
  if (!files) { console.warn(`[PlayerModel] ${name}: ${models.error ?? 'the game does not have it'}`); return null }
  const anm = await content.animations(ANIMATION_SET)
  if (!anm.files) { console.warn(`[PlayerModel] ${ANIMATION_SET}: ${anm.error ?? 'the game does not have it'}`); return null }
  const mesh = readPosedModel(files, anm.files, pose)
  if (!mesh) { console.warn(`[PlayerModel] ${name} could not be posed`); return null }
  return await playerModelGlb(mesh, `${name} (${pose})`)
}

/** The model in a pose as a GLB, or null when it is not available. A failure is not remembered, so a later request tries again. */
export async function playerModel(pose: Pose): Promise<Uint8Array | null> {
  if (!playerModelEnabled()) return null
  const key = `${playerModelName()}|${pose}`
  let p = built.get(key)
  if (!p) {
    p = build(pose).catch(e => { console.warn(`[PlayerModel] ${e instanceof Error ? e.message : e}`); return null })
    built.set(key, p)
  }
  const glb = await p
  if (!glb) built.delete(key)
  return glb
}
