/**
 * Which generation of the extractor made a mesh (RFC 18). A stored mesh below this number is rebuilt in the background;
 * raise it whenever a change to the reader or the writer should show in the maps that are already stored.
 * 2: water apart from the floors, brush entities that stand still, sky and helper materials left out.
 */
export const MESH_VERSION = 2
