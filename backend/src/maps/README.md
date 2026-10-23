# Map code

Reads Source maps and makes meshes (RFC 10, 11, 18). It is kept apart from the rest of the backend so it can
become a package of its own later (RFC 18, 8b):

*   `bsp.ts`: the header, the surfaces, the entities of a `.bsp`, read in ranges; every offset and count is checked.
*   `gma.ts`: the file table of a Garry's Mod addon archive.
*   `fileSource.ts`: a file, or a range of one, as a source of bytes.
*   `levels.ts`: the storey model.
*   `meshGlb.ts`: the skybox rule, the cutting at storey heights, and the glTF (GLB) writer.

**The rule:** nothing in this folder imports from outside it, except `node:` modules and the glTF library.
`test/maps_boundary.test.ts` checks it. The database, the queue, the Workshop fetcher and the pages stay in
`services/` and call into this folder, never the other way round.
