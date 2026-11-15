import { buildBsp, flatQuads, LUMP, type BspSpec } from './bsp_builder'

// A small map for the coverage record (RFC 32): ten faces in the world model that cover every outcome, and one face each (two for the button)
// in six brush-entity models. The hand count of what it holds is in test/coverage.test.ts.

export const F = { LIGHT: 0x1, SKY2D: 0x2, SKY: 0x4, WARP: 0x8, TRANS: 0x10, NOPORTAL: 0x20, TRIGGER: 0x40, NODRAW: 0x80, HINT: 0x100, SKIP: 0x200, NOLIGHT: 0x400, BUMPLIGHT: 0x800 } as const

/** Face by face: its flags, its material, and (for the wall and the ceiling) the normal of its plane. */
const FACES: { flags: number, material: string, normal?: [number, number, number] }[] = [
  /* 0 */ { flags: 0, material: 'concrete/floor' },
  /* 1 */ { flags: F.BUMPLIGHT | F.NOLIGHT, material: 'concrete/lit' },
  /* 2 */ { flags: F.BUMPLIGHT, material: 'concrete/lit2' },
  /* 3 */ { flags: 0, material: 'brick/wall', normal: [1, 0, 0] },
  /* 4 */ { flags: F.WARP, material: 'nature/water01' },
  /* 5 */ { flags: F.SKY | F.NOLIGHT, material: 'tools/toolsskybox' },
  /* 6 */ { flags: 0, material: 'tools/toolsblack' },
  /* 7 */ { flags: 0, material: 'sky/mysky' },
  /* 8 */ { flags: F.TRANS, material: 'glass/ceiling', normal: [0, 0, -1] },
  /* 9 */ { flags: F.NOPORTAL, material: 'concrete/noportal' },
  // the brush entities: *1 func_door, *2 func_brush, *3 func_button (two faces), *4 trigger_hurt, *5 func_mystery_box, *6 func_water_analog
  /* 10 */ { flags: 0, material: 'metal/door' },
  /* 11 */ { flags: 0, material: 'concrete/fixture' },
  /* 12 */ { flags: 0, material: 'metal/button' },
  /* 13 */ { flags: 0, material: 'metal/button2' },
  /* 14 */ { flags: F.TRIGGER, material: 'tools/toolstrigger' },
  /* 15 */ { flags: 0, material: 'metal/mystery' },
  /* 16 */ { flags: F.WARP, material: 'nature/pool' },
]

export const WORLD_FACES = 10
export const MODELS = [[0, 10], [10, 1], [11, 1], [12, 2], [14, 1], [15, 1], [16, 1]] as const

export const COVERAGE_ENTITIES = [
  '{ "classname" "worldspawn" }',
  '{ "classname" "func_door" "model" "*1" "origin" "10 20 30" "targetname" "door1" }',
  '{ "classname" "func_brush" "model" "*2" }',
  '{ "classname" "func_button" "model" "*3" }',
  '{ "classname" "trigger_hurt" "model" "*4" }',
  '{ "classname" "func_mystery_box" "model" "*5" }',
  '{ "classname" "func_water_analog" "model" "*6" }',
  '{ "classname" "light" "origin" "0 0 100" }', '{ "classname" "light" "origin" "0 0 200" }', '{ "classname" "light_spot" "origin" "0 0 300" }',
  '{ "classname" "env_fog_controller" "origin" "0 0 0" }',
  '{ "classname" "info_player_terrorist" "origin" "5 5 5" }', '{ "classname" "info_player_terrorist" "origin" "6 6 6" }',
  '{ "classname" "info_overlay" "origin" "1 1 1" }',
].join('\n')

export function coverageMapSpec(extra: Partial<BspSpec> = {}): BspSpec {
  const quads = flatQuads(FACES.map((_, i) => i * 8))
  FACES.forEach((f, i) => { if (f.normal) quads.planes[i] = { nx: f.normal[0], ny: f.normal[1], nz: f.normal[2], dist: 0 } })
  return {
    ...quads,
    texinfoFlags: FACES.map(f => f.flags), materials: FACES.map(f => f.material),
    models: MODELS.map(([firstFace, numFaces]) => ({ firstFace, numFaces })),
    entities: COVERAGE_ENTITIES,
    raw: { [LUMP.PAKFILE]: Buffer.alloc(0) },
    ...extra,
  }
}

export const coverageMap = (extra: Partial<BspSpec> = {}): Buffer => buildBsp(coverageMapSpec(extra))
