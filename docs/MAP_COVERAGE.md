# Map coverage: what the 3D pipeline does with each part of a Source map

This is the catalogue of [RFC 32](rfcs/RFC-032.md): for every kind of thing a map can hold that the map pipeline (`backend/src/maps`) has a view on, what it does. The tables are the registry in `backend/src/maps/coverage.ts` written out; a test compares the two, so an entry cannot be added to the code without a row here (or the other way round). To change a status, change the line in the registry and the row here.

| Status | Meaning |
|---|---|
| drawn | The pipeline draws it. |
| invisible | Not drawn, and nothing is lost: a player never sees it. |
| gap | A player sees it and the pipeline does not draw it. [RFC 33](rfcs/RFC-033.md) built the ones the survey ranked, so the registry has no gap entry now; a class seen in a map and not classified is `unknown` until someone decides. |
| not read | A part of the file the pipeline does not read, with a note on what drawing it would take. |
| unknown | Not in the registry: seen in a map and not classified. It is never a row of these tables; it shows on the admin page (`/servers/:serverId/map-coverage`) by itself, and is a task. |

## Surface flags

The flags of a face's texture (`texinfo`), from the BSP format. A face with any of the flags marked invisible is left out; the others are drawn as ordinary faces.

### Surface flags: drawn

| Key | Status | What the pipeline does |
|---|---|---|
| `LIGHT` (0x1) | drawn | The surface gives off light (a light source); the face is drawn as any other and its glow is not modelled. |
| `WARP` (0x8) | drawn | A liquid surface (water, lava, slime): drawn as water, never as a floor (RFC 18, 4.1). |
| `TRANS` (0x10) | drawn | A translucent surface (glass, grates): drawn as an ordinary face, its translucency is not modelled. |
| `NOPORTAL` (0x20) | drawn | The game cannot place a portal on it; no visual effect, the face is drawn as any other. |
| `NOLIGHT` (0x400) | drawn | The face gets no lightmap; lighting is not read at all, so the face is drawn as any other. |
| `BUMPLIGHT` (0x800) | drawn | The face is lit with a bump map; lighting is not read, so the face is drawn as any other. |
| `NOSHADOWS` (0x1000) | drawn | The face receives no shadows; shadows are not modelled, the face is drawn as any other. |
| `NODECALS` (0x2000) | drawn | Decals do not stick to it; decals (overlays) are not read, the face is drawn as any other. |
| `NOCHOP` (0x4000) | drawn | The map compiler does not split the face; no visual effect. |
| `HITBOX` (0x8000) | drawn | The face is part of a hitbox of a model; the face is drawn as any other. |

### Surface flags: invisible

| Key | Status | What the pipeline does |
|---|---|---|
| `SKY2D` (0x2) | invisible | A sky face seen flat; the extractor leaves it out (SKIP_FLAGS), the player sees sky. |
| `SKY` (0x4) | invisible | A sky face; the extractor leaves it out (SKIP_FLAGS), the player sees sky. |
| `TRIGGER` (0x40) | invisible | A trigger volume face; the extractor leaves it out (SKIP_FLAGS), a player never sees it. |
| `NODRAW` (0x80) | invisible | The game does not draw it; the extractor leaves it out (SKIP_FLAGS). |
| `HINT` (0x100) | invisible | A helper for the map compiler; the extractor leaves it out (SKIP_FLAGS), a player never sees it. |
| `SKIP` (0x200) | invisible | A helper for the map compiler; the extractor leaves it out (SKIP_FLAGS), a player never sees it. |

## Materials

Rules on the name of a face's material, for faces whose flags say nothing.

### Materials: invisible

| Key | Status | What the pipeline does |
|---|---|---|
| `sky` | invisible | A sky picture pasted on ordinary brushes (the name has `skybox` in it or ends in `sky`): left out as the sky it is (RFC 18, 4.1a). |
| `tools/*` | invisible | The helper materials under `tools/` (nodraw, clip, triggers, skybox, black): never a surface a player sees (RFC 18, 4.1a). |

## Brush entity classes

Entities that own a model `*N` (a brush). A key that ends in `*` stands for every class that begins with what comes before it; a class that matches no entry is `unknown`.

### Brush entity classes: drawn

| Key | Status | What the pipeline does |
|---|---|---|
| `func_brush` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_wall` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_breakable` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_lod` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_wall_toggle` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_breakable_surf` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_monitor` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_conveyor` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_reflective_glass` | drawn | A brush entity that stands still: its faces are drawn with the world where the map puts it (RFC 18, 4.2). |
| `func_door` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_door_rotating` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_movelinear` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_rotating` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_tracktrain` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_tanktrain` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_button` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_rot_button` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `momentary_rot_button` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_physbox` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_physbox_multiplayer` | drawn | A brush entity that can move: drawn at its starting place as a part of its own, which the replay moves (RFC 18, 4.2, RFC 20). |
| `func_water_analog` | drawn | The water brush (a pool a map raises or lowers): its upward liquid faces are drawn as water, moved by `startposition` along `movedir`; the rise during the round is not shown (RFC 33, 4.2). |
| `func_illusionary` | drawn | A brush a player sees and walks through: drawn in a group of its own (Decoration), never a floor or a wall; a face below the map is left out (RFC 33, 4.4). |

### Brush entity classes: invisible

| Key | Status | What the pipeline does |
|---|---|---|
| `trigger_*` | invisible | Every trigger (a volume that fires something when touched) is invisible to a player; its faces are not drawn. |
| `func_clip_vphysics` | invisible | A volume that blocks physics objects only; invisible. |
| `func_areaportal*` | invisible | A door of the map compiler that cuts the map into areas for visibility (area portals and their windows); invisible. |
| `func_occluder` | invisible | A volume the engine uses to hide what is behind it; invisible. |
| `func_precipitation` | invisible | A volume that rain or snow falls in; the volume itself is invisible (the weather is not drawn). |
| `env_embers` | invisible | A volume that particle embers rise from; the brush is a volume, the particles are not drawn. |
| `func_dustcloud` | invisible | A volume that a dust cloud of particles fills; the brush is a volume, the particles are not drawn (RFC 33, 4.6). |
| `func_buyzone` | invisible | A zone where a player may buy; a volume, not a surface (RFC 33, 4.6). |
| `func_bomb_target` | invisible | A zone where a bomb can be planted; a volume, not a surface (RFC 33, 4.6). |
| `game_zone_player` | invisible | A zone that counts the players inside it for the map's logic; a volume, not a surface (RFC 33, 4.6). |
| `ttt_traitor_check` | invisible | A zone of the TTT game, used like a trigger; a volume, not a surface (RFC 33, 4.6). |
| `func_dustmotes` | invisible | A volume that floating dust is drawn in; the brush is a volume, the particles are not drawn. |
| `func_smokevolume` | invisible | A volume that smoke particles fill; the brush is a volume, the particles are not drawn. |

## Features of the file

Parts of the map file and what the pipeline does with them.

### Features of the file: drawn

| Key | Status | What the pipeline does |
|---|---|---|
| `displacements` | drawn | Terrain (lump 26 and 33): turned into a grid of triangles (RFC 18, 4.3). |
| `static props` | drawn | Props placed by the compiler (the `sprp` game lump) and the props of the entity lump, as the models the map carries or the game has (RFC 18, 4.4). |
| `textures from the pak` | drawn | The map's own materials and textures, read from the pak file at the end of the map (RFC 18, 5). |
| `door start states` | drawn | Doors, rotating doors and linear movers are drawn where they stand when the round starts: at the open end when the map starts them open (`spawnpos`, `startposition`), not drawn when that cannot be placed with confidence (RFC 35). |

### Features of the file: invisible

| Key | Status | What the pipeline does |
|---|---|---|
| `3D skybox` | invisible | The small copy of the world around `sky_camera`: removed on purpose, it is not part of the map (RFC 11, RFC 18, 4.4). |

### Features of the file: not read

| Key | Status | What the pipeline does |
|---|---|---|
| `lighting` | not read | The lightmaps (lump 8, HDR lump 53): drawing them needs the lightmap atlas and every face's coordinates in it. |
| `overlays` | not read | Decals the mapper put on surfaces (lump 45, `info_overlay`): drawing them needs a quad on the surface for each. |
| `cubemaps` | not read | Environment cube maps for reflections (lump 42): only matter with reflective materials, which are not modelled. |
| `detail props` | not read | Grass and rubble sprites and models of the game lump (`dprp`): drawing them needs the sprite sheet and the placing rules. |
| `visibility` | not read | The potentially-visible-set data (lump 4): an optimisation of the game's renderer, nothing to see. |
| `fog and light entities` | not read | Fog, sun and light entities (`env_fog_controller`, `env_sun`, `light*`): the atmosphere; drawing it needs fog and a lit scene. |

The `door start states` feature ([RFC 35](rfcs/RFC-035.md)): the coverage record also counts, per map, the doors, rotating doors and linear movers that start closed, start open and were placed at their open end, and start open and were left out; the coverage page shows them in the card "Where moving parts start".

## The measurement on a real map

Measured on 2026-11-15 on `ttt_67thway_rework_b1` (Workshop item 577197148, 11 571 faces in the world model), by the coverage record of the pipeline itself (the numbers are what `buildCoverage` gives, not an estimate). The record is 3 056 bytes of JSON.

### World faces by flags

| Flags | Faces |
|---|---|
| none | 9 895 |
| BUMPLIGHT | 1 381 |
| SKY|NOLIGHT | 219 |
| TRANS | 50 |
| WARP|NOLIGHT|NOSHADOWS|NODECALS | 18 |
| NOPORTAL | 8 |

A flag set is written in the order of the bits. `SKY|NOLIGHT` is the sky box (`tools/toolsskybox`), `WARP|NOLIGHT|NOSHADOWS|NODECALS` is the water of the coast.

### World faces by what became of them

| Outcome | Faces |
|---|---|
| floor (drawn) | 2 759 |
| wall (drawn) | 7 989 |
| ceiling (left out on purpose) | 484 |
| water (drawn as water) | 18 |
| displacement (terrain, drawn) | 94 |
| left out by a flag (sky, trigger, nodraw, hint, skip) | 219 |
| left out by the name of the material | 8 |

The 8 faces left out by their material are `tools/toolsblack`.

### Brush entities by class

| Class | Entities | Faces | Status |
|---|---|---|---|
| `ttt_traitor_check` | 1 | 0 | unknown |
| `func_button` | 6 | 36 | gap |
| `func_breakable_surf` | 29 | 29 (2 of an entity with a parent, which is not drawn) | gap |
| `func_water_analog` | 1 | 2 | gap |
| `func_breakable` | 40 | 274 | drawn |
| `func_door` | 10 | 117 | drawn |
| `func_physbox` | 10 | 59 | drawn |
| `func_door_rotating` | 5 | 30 | drawn |
| `func_movelinear` | 1 | 21 | drawn |
| `func_brush` | 3 | 17 (6 of an entity with a parent, which is not drawn) | drawn |
| `func_wall_toggle` | 1 | 5 | drawn |
| `func_tracktrain` | 2 | 0 | drawn |
| `trigger_teleport` | 11 | 66 | invisible |
| `trigger_multiple` | 8 | 47 (12 of an entity with a parent, which is not drawn) | invisible |
| `func_clip_vphysics` | 4 | 24 | invisible |
| `trigger_hurt` | 2 | 12 (12 of an entity with a parent, which is not drawn) | invisible |
| `env_embers` | 1 | 6 | invisible |
| `trigger_soundscape` | 1 | 6 | invisible |

The entities of a class that is drawn are not all drawn: an entity with a parent entity moves with it and is left out (the `func_brush` of the table has one such entity of 6 faces). 28 entities of the listed classes are of the kinds that can move.

### Point entities (the most numerous classes)

| Class | Entities |
|---|---|
| `info_node` | 486 |
| `info_node_air` | 393 |
| `prop_physics` | 148 |
| `ttt_random_ammo` | 110 |
| `env_soundscape` | 100 |
| `light` | 93 |
| `info_player_deathmatch` | 53 |
| `info_ladder_dismount` | 30 |
| `prop_door_rotating` | 30 |
| `func_areaportal` | 27 |
| `ttt_random_weapon` | 25 |
| `item_ammo_pistol_ttt` | 23 |

### Parts of the file that are not read

| Part | Size |
|---|---|
| lighting (lightmaps) | 6.6 MB |
| overlays | 28 KB |
| cubemaps | 4 KB |
| visibility | 188 KB |
| game lump (static props, detail props) | 2.2 MB |
| pak file (the embedded content, where the textures are) | 98 MB |

Light, fog and sun entities: 98.

## Totals over the server's maps (2026-11-15, the coverage page after the first rebuild)

Read from the admin page `/servers/:serverId/map-coverage` of the maintainer's server: 28 maps, **27 have a record** (`ttt_community_bowling_v5a` has no 3D mesh). Copied by hand from a screenshot, so the numbers are exact but the transcription is the author's.

**Totals by status** (a world face is counted once, by its flags; ceilings, which the view leaves out on purpose, count with the drawn):

| Status | World faces | Brush entities | Brush faces |
|---|---|---|---|
| drawn | 249 087 | 2 143 | 28 392 |
| invisible | 10 147 | 936 | 7 794 |
| gap | 0 | 906 | 3 269 |
| not read | 0 | 0 | 0 |
| unknown | 0 | 173 | 670 |

**Gaps and unknowns, ranked by faces** (maps = number of maps with it; the largest map in brackets):

| Entry | Status | Maps | Faces | Entities | Largest in |
|---|---|---|---|---|---|
| `func_illusionary` | gap | 10 | 2 076 | 327 | `ttt_minecraft_b7_summer` (663) |
| `func_button` | gap | 23 | 622 | 262 | `ttt_airbus_b3` (126) |
| `func_dustcloud` | unknown | 4 | 365 | 70 | `ttt_rooftops_2016_v1` (365) |
| `func_water_analog` | gap | 7 | 319 | 87 | `ttt_cquestt` (130) |
| `func_breakable_surf` | gap | 10 | 252 | 230 | `ttt_diescraper` (96) |
| `func_rot_button` | unknown | 3 | 95 | 53 | `ttt_waterworld_tropical` (48) |
| `ttt_traitor_check` | unknown | 7 | 65 | 16 | `ttt_airbus_b3` (47) |
| `func_tanktrain` | unknown | 3 | 45 | 13 | `ttt_minecraft_b7_summer` (45) |
| `func_buyzone` | unknown | 2 | 36 | 6 | `ttt_alps` (24) |
| `func_bomb_target` | unknown | 2 | 24 | 4 | `ttt_alps` (12) |
| `func_monitor` | unknown | 5 | 22 | 6 | `ttt_diescraper` (12) |
| `game_zone_player` | unknown | 1 | 12 | 2 | `ttt_rooftops_2016_v1` (12) |
| `func_conveyor` | unknown | 1 | 4 | 1 | `ttt_cquestt` (4) |
| `func_reflective_glass` | unknown | 1 | 2 | 1 | `ttt_volcano` (2) |
| `momentary_rot_button` | unknown | 1 | 0 | 1 | `ttt_airbus_b3` (0) |

The maps with the most gap faces: `ttt_minecraft_b7_summer` 678, `ttt_pwp_v4` 675, `ttt_mc_skyislands` 342, `ttt_cquestt` 244, `ttt_alps` 243. Four maps have no gap faces (`ttt_community_bowling_re_v1b`, `ttt_forest_final` (one gap entity, no faces), `ttt_sandcrawler_v1`, `ttt_theship_v1`). **This is the snapshot that [RFC 33](rfcs/RFC-033.md) starts from.**
