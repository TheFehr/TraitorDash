/**
 * Which generation of the extractor made a mesh (RFC 18). A stored mesh below this number is rebuilt in the background;
 * raise it whenever a change to the reader or the writer should show in the maps that are already stored.
 * 2: water apart from the floors, brush entities that stand still, sky and helper materials left out.
 * 3: the props that are in the map file.
 * 4: brush entities at their own origin, parts (detached ones in a group of their own, the skybox by shared corners), storeys flag, spawns.
 * 5: also the game's own models (only where that is switched on, see `meshVersion`).
 * 6 and 7 (with the game's own models): the parts that can move (doors, lifts, a collapsing building) in a group of their own, at their starting place.
 * 8 (9 with the game's own models): the leaves of the plants carry their textures, cut out as the game does (RFC 18, 4.6).
 * 9 (10 with the game's own models): the floors and walls carry the textures of their materials, cut as the map's file says (RFC 18, 5).
 * 10 (11 with the game's own models): the solid props and the parts that can move carry their textures too, and a part without one is no longer orange (RFC 18, 5).
 * 11 (12 with the game's own models): a floor that blends two textures (grass on dirt, by the alpha of a displacement's corners) is drawn with both (RFC 18, 5).
 * 12 (13 with the game's own models): the limits on the props are far above any real map (3 000 000 triangles, 20 000 places, 5 000 models, 250 000 triangles a model) and only guard against a broken file, so no map loses props (six did at 600 000: the water slide of `ttt_waterworld_tropical`).
 * The part nodes of RFC 20 stage 1 are written by every build from now on, but are not a generation of their own: the generation is raised when the replay needs them (stage 3).
 */
export const MESH_VERSION = 12
export const MESH_VERSION_GAME = 13

/** The generation a backend wants: the one with the game's own models when it has them, else the one without. */
export const meshVersion = (withGameContent: boolean) => withGameContent ? MESH_VERSION_GAME : MESH_VERSION
