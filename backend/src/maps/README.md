# Map code

Reads Source maps and makes meshes (RFC 10, 11, 18). It is kept apart from the rest of the backend so it can
become a package of its own later (RFC 18, 8b):

*   `bsp.ts`: the header, the surfaces, the entities of a `.bsp`, read in ranges; every offset and count is checked.
*   `gma.ts`: the file table of a Garry's Mod addon archive.
*   `fileSource.ts`: a file, or a range of one, as a source of bytes.
*   `levels.ts`: the storey model.
*   `pak.ts`: the ZIP a map carries (its models and materials), read by its directory, member by member.
*   `parts.ts`: the parts of a map by shared corners: main, detached, and the 3D skybox.
*   `props.ts`: where the static props stand (the game lump).
*   `model.ts`: the mesh of one model from its `.mdl`, `.vvd` and `.vtx`, and whether a material is foliage.
*   `vpk.ts`: the index of a Valve package (`*_dir.vpk`) and the files in its archives.
*   `propset.ts`: the props of a map as the mesh gets them: near the map, from the pack, within the limits.
*   `meshVersion.ts`: which generation of the extractor made a mesh.
*   `meshGlb.ts`: the skybox rule, the cutting at storey heights, and the glTF (GLB) writer.

**The rule:** nothing in this folder imports from outside it, except `node:` modules and the glTF library.
`test/maps_boundary.test.ts` checks it. The database, the queue, the Workshop fetcher and the pages stay in
`services/` and call into this folder, never the other way round.
