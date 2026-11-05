/**
 * Which generation of the extractor made a mesh (RFC 18). A stored mesh below this number is rebuilt in the background;
 * raise it whenever a change to the reader or the writer should show in the maps that are already stored.
 * 2: water apart from the floors, brush entities that stand still, sky and helper materials left out.
 * 3: the props that are in the map file.
 * 4: brush entities at their own origin, parts (detached ones in a group of their own, the skybox by shared corners), storeys flag, spawns.
 * 5: also the game's own models (only where that is switched on, see `meshVersion`).
 * 6 and 7 (with the game's own models): the parts that can move (doors, lifts, a collapsing building) in a group of their own, at their starting place.
 * 8 (9 with the game's own models): the leaves of the plants carry their textures, cut out as the game does (RFC 18, 4.6).
 * The part nodes of RFC 20 stage 1 are written by every build from now on, but are not a generation of their own: the generation is raised when the replay needs them (stage 3).
 */
export const MESH_VERSION = 8
export const MESH_VERSION_GAME = 9

/** The generation a backend wants: the one with the game's own models when it has them, else the one without. */
export const meshVersion = (withGameContent: boolean) => withGameContent ? MESH_VERSION_GAME : MESH_VERSION
