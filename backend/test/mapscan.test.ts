import { expect, test, describe } from 'bun:test'
import { run } from './helpers/bridge_harness'

// Prototype: can the server measure a map's floors with traces alone (no client, no admin)?
// The scanner is pure logic over a "tracer" (start, end -> trace result), so it is tested here
// against a fake world made of vertical slabs. Whether the real engine's traces behave like the
// fake (StartSolid / FractionLeftSolid in particular) is what the real-server run decides.

const SETUP = `
  Vector = function(x, y, z) return { x = x, y = y, z = z } end
  MASK_PLAYERSOLID_BRUSHONLY = 1
  math.Clamp = function(v, lo, hi) return math.max(lo, math.min(hi, v)) end -- GMod's
  -- slabs(x, y) -> list of solid { bottom, top, sky } at that column. Vertical traces only.
  function FAKE_TRACER(slabs, wall)
    return function(a, b)
      TRACES = (TRACES or 0) + 1
      if a.z == b.z then -- horizontal: blocked only if the test's wall says so
        WALL_ZS = WALL_ZS or {} WALL_ZS[#WALL_ZS + 1] = a.z
        local blocked = wall and wall(a, b) or false
        return { Hit = blocked, StartSolid = false, Fraction = blocked and 0.5 or 1, HitPos = b }
      end
      local list = slabs(a.x, a.y)
      local z0, z1 = a.z, b.z
      local down = z1 < z0
      local len = math.abs(z1 - z0)
      for _, s in ipairs(list) do
        if z0 > s.bottom and z0 < s.top then
          local leave = down and s.bottom or s.top
          return { StartSolid = true, Hit = true, Fraction = 0, HitPos = a, HitSky = s.sky or false,
                   FractionLeftSolid = math.min(1, math.abs(z0 - leave) / len) }
        end
      end
      local best
      for _, s in ipairs(list) do
        local face = down and s.top or s.bottom
        local inRange = down and (face <= z0 and face >= z1) or (not down and face >= z0 and face <= z1)
        if inRange and (not best or (down and face > best.face) or (not down and face < best.face)) then best = { face = face, s = s } end
      end
      if not best then return { Hit = false, StartSolid = false, Fraction = 1, HitPos = b } end
      return { Hit = true, StartSolid = false, HitSky = best.s.sky or false, Fraction = math.abs(best.face - z0) / len,
               HitPos = Vector(a.x, a.y, best.face) }
    end
  end
  SKY = { bottom = 1000, top = 1100, sky = true }
  function COLUMN(slabs) return TraitorDash.ScanColumn(0, 0, 1200, -500, FAKE_TRACER(function() return slabs end)) end
  function LIST(t) return table.concat(t, ",") end
`
const floors = (slabs: string) => run(`${SETUP}\nRESULT = LIST(COLUMN(${slabs}))`).result
// The heights of the floors one can only reach crouching.
const crouchOnly = (slabs: string) => run(`${SETUP}\nlocal _, _, c = COLUMN(${slabs})\nlocal t = {} for z in pairs(c) do t[#t + 1] = z end table.sort(t) RESULT = LIST(t)`).result

describe('ScanColumn: floors found by tracing straight down', () => {
  test('open ground under the sky has one floor, at the top of the ground', () => {
    expect(floors('{ SKY, { bottom = -64, top = 0 } }')).toBe('0')
  })

  test('nothing but sky is no floor', () => {
    expect(floors('{ SKY }')).toBe('')
  })

  test('stacked floors are all found, lowest first', () => {
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 200, top = 216 } }')).toBe('0,216')
  })

  test('a space too low even to crouch in (under 36 units) is not walkable', () => {
    // floor at 0, ceiling slab 30..60: nobody fits under it, but one can stand on top of the slab (60)
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 30, top = 60 } }')).toBe('60')
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 35, top = 60 } }')).toBe('60')
  })

  test('a crawlspace one can crouch in (36 to 71 units) is a floor, flagged crouch-only', () => {
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 40, top = 60 } }')).toBe('0,60')
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 36, top = 60 } }')).toBe('0,60')
    expect(crouchOnly('{ SKY, { bottom = -64, top = 0 }, { bottom = 40, top = 60 } }')).toBe('0')
    expect(crouchOnly('{ SKY, { bottom = -64, top = 0 }, { bottom = 71, top = 90 } }')).toBe('0')
  })

  test('72 units of headroom or more is an ordinary floor, not crouch-only', () => {
    expect(crouchOnly('{ SKY, { bottom = -64, top = 0 }, { bottom = 72, top = 90 } }')).toBe('')
    expect(crouchOnly('{ SKY, { bottom = -64, top = 0 } }')).toBe('')
  })

  test('exactly enough headroom counts', () => {
    expect(floors('{ SKY, { bottom = -64, top = 0 }, { bottom = 73, top = 90 } }')).toBe('0,90')
  })

  test('a deep stack is capped and the scan ends', () => {
    const slabs = Array.from({ length: 12 }, (_, i) => `{ bottom = ${i * 100 - 20}, top = ${i * 100} }`).join(',')
    const r = run(`${SETUP}\nlocal f = COLUMN({ ${slabs} }) RESULT = #f .. "/" .. TRACES`).result
    const [n, traces] = r.split('/').map(Number)
    expect(n).toBeLessThanOrEqual(8)
    expect(traces).toBeLessThan(60)
  })

  test('a tracer that never gets out of solid cannot loop forever', () => {
    const r = run(`${SETUP}
      local n = 0
      local f = TraitorDash.ScanColumn(0, 0, 1200, -500, function() n = n + 1 return { StartSolid = true, Hit = true, Fraction = 0, FractionLeftSolid = 0, HitPos = Vector(0, 0, 0) } end)
      RESULT = #f .. "/" .. n`).result
    const [found, traces] = r.split('/').map(Number)
    expect(found).toBe(0)
    expect(traces).toBeLessThan(100)
  })
})

describe('the grid scan', () => {
  // 4 x 2 cells of 64 units from (0, 0): ground everywhere, a second floor over the x >= 128 half.
  const WORLD = `
    local function slabs(x, y)
      local s = { SKY, { bottom = -64, top = 0 } }
      if x >= 128 then s[#s + 1] = { bottom = 200, top = 216 } end
      return s
    end
    SCAN = TraitorDash.NewMapScan({ map = "gm_test", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 256, y = 128, z = 1200 },
      tracer = FAKE_TRACER(slabs), clock = function() return CLOCK or 0 end })
  `
  test('covers the bounds in cells and records each cell\'s floors', () => {
    const r = run(`${SETUP}\n${WORLD}\nwhile not SCAN:Step(1) do end\nlocal res = SCAN:Result()\nRESULT = res.nx .. "x" .. res.ny .. " " .. table.concat(res.rows, ";") .. " " .. res.cell .. " " .. res.minx .. "," .. res.miny`).result
    expect(r).toBe('4x2 0|0|0,216|0,216;0|0|0,216|0,216 64 0,0')
  })

  test('crouch-only floors carry a "c" in the cell', () => {
    const r = run(`${SETUP}
      local function slabs(x, y) return { SKY, { bottom = -64, top = 0 }, { bottom = 40, top = 60 } } end
      SCAN = TraitorDash.NewMapScan({ map = "m", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 64, y = 64, z = 1200 }, tracer = FAKE_TRACER(slabs) })
      while not SCAN:Step(1) do end
      RESULT = SCAN:Result().rows[1] .. " " .. SCAN.crouchFloors`).result
    expect(r).toBe('0c,60 1')
  })

  test('works in slices: a spent time budget stops the step before the grid is done', () => {
    const r = run(`${SETUP}\n${WORLD}
      -- every trace costs one tick of the clock; a budget of 3 stops after a few cells
      local real = SCAN.tracer
      SCAN.tracer = function(a, b) CLOCK = (CLOCK or 0) + 1 return real(a, b) end
      local done = SCAN:Step(3)
      local p = SCAN:Progress()
      RESULT = tostring(done) .. " " .. p`).result
    const [done, p] = r.split(' ')
    expect(done).toBe('false')
    expect(Number(p)).toBeGreaterThan(0)
    expect(Number(p)).toBeLessThan(1)
  })

  test('counts the traces it used', () => {
    const r = run(`${SETUP}\n${WORLD}\nwhile not SCAN:Step(1) do end\nRESULT = SCAN:Result().traces`).result
    expect(Number(r)).toBeGreaterThan(8)
  })
})

describe('the reachable scan: only what a player can walk to from a spawn', () => {
  // 8 x 4 cells of 64 units from (0, 0). WORLD(slabsLua, wallLua) builds the scan; seeds are spawn points.
  const reach = (slabs: string, spawns: string, wall = 'nil', opts = '') => run(`${SETUP}
    local function slabs(x, y) ${slabs} end
    SCAN = TraitorDash.NewReachScan({ map = "m", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 512, y = 256, z = 1200 },
      tracer = FAKE_TRACER(slabs, ${wall}), spawns = ${spawns}${opts} })
    while not SCAN:Step(1) do end
    local r = SCAN:Result()
    RESULT = table.concat(r.rows, ";") .. " seeds=" .. r.seeds .. " traces=" .. r.traces .. " columns=" .. r.columns`).result
  const GROUND = '{ SKY, { bottom = -64, top = 0 } }'
  const rows = (r: string) => (r.split(' ')[0] ?? '').split(';')
  const field = (r: string, k: string) => Number(r.match(new RegExp(`${k}=(\\d+)`))![1])
  const SPAWN = '{ { x = 32, y = 32, z = 0 } }'
  const ROW = (...c: string[]) => c.join('|')

  test('a floor with no path from a spawn is not in the result (the skybox, a roof, a decoy platform)', () => {
    // ground for cells 0-3, a void in cells 4-5, a second platform in cells 6-7
    const r = reach('local s = { SKY } if x < 256 or x >= 384 then s[#s + 1] = { bottom = -64, top = 0 } end return s', SPAWN)
    expect(rows(r)).toEqual(Array(4).fill(ROW('0', '0', '0', '0', '', '', '', '')))
  })

  test('the top of a ceiling slab above a walkable floor is not reached', () => {
    const r = reach('return { SKY, { bottom = -64, top = 0 }, { bottom = 40, top = 56 } }', SPAWN)
    expect(rows(r)[0]).toBe(ROW('0c', '0c', '0c', '0c', '0c', '0c', '0c', '0c'))
  })

  test('stairs and ramps (steps of 16) are walked up', () => {
    const r = reach('local h = math.floor(x / 64) * 16 return { SKY, { bottom = h - 64, top = h } }', SPAWN)
    expect(rows(r)[0]).toBe(ROW('0', '16', '32', '48', '64', '80', '96', '112'))
  })

  test('a cliff is not walked, and nothing beyond it is reached', () => {
    const r = reach('local h = x < 192 and 0 or 200 return { SKY, { bottom = h - 64, top = h } }', SPAWN)
    expect(rows(r)[0]).toBe(ROW('0', '0', '0', '', '', '', '', ''))
  })

  test('a wall between two cells cuts them, and is tested at knee height above the higher floor', () => {
    const wall = 'function(a, b) return (a.x < 192) ~= (b.x < 192) end'
    const r = reach(GROUND.replace(/^/, 'return '), SPAWN, wall)
    expect(rows(r)[0]).toBe(ROW('0', '0', '0', '', '', '', '', ''))
    const zs = run(`${SETUP}
      local function slabs() return ${GROUND} end
      SCAN = TraitorDash.NewReachScan({ map = "m", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 512, y = 256, z = 1200 },
        tracer = FAKE_TRACER(slabs, function() return false end), spawns = ${SPAWN} })
      while not SCAN:Step(1) do end
      RESULT = table.concat(WALL_ZS, ",")`).result
    expect(new Set(zs.split(','))).toEqual(new Set(['20'])) // flat ground at 0, so everything is tested at 0 + 20
  })

  test('the spawn picks the floor nearest to it when a column has several', () => {
    // ground at 0 and a floor at 272 over cells 0-3 only
    const r = reach('local s = { SKY, { bottom = -64, top = 0 } } if x < 256 then s[#s + 1] = { bottom = 256, top = 272 } end return s', '{ { x = 32, y = 32, z = 280 } }')
    expect(rows(r)[0]).toBe(ROW('272', '272', '272', '272', '', '', '', ''))
  })

  test('a spawn that is not over any floor seeds nothing', () => {
    const r = reach('return { SKY }', SPAWN)
    expect(field(r, 'seeds')).toBe(0)
    expect(rows(r).every(x => x.replace(/\|/g, '') === '')).toBe(true)
  })

  test('going down a step is not cut by a wall check made at the lower floor', () => {
    // two cells, 112 then 96; the wall check blocks traces below 120, i.e. below the higher floor (112) + 8
    const r = reach('local s = { SKY } if x < 128 then local h = x < 64 and 112 or 96 s[#s + 1] = { bottom = h - 64, top = h } end return s',
      '{ { x = 32, y = 32, z = 112 } }', 'function(a, b) return a.z < 120 end')
    expect(rows(r)[0]).toBe(ROW('112', '96', '', '', '', '', '', ''))
  })

  test('a spawn far above any floor (100+ units) seeds nothing', () => {
    expect(field(reach(GROUND.replace(/^/, 'return '), '{ { x = 32, y = 32, z = 1000 } }'), 'seeds')).toBe(0)
  })

  test('a spawn outside the grid seeds nothing', () => {
    const r = reach(GROUND.replace(/^/, 'return '), '{ { x = 5000, y = 5000, z = 0 } }')
    expect(field(r, 'seeds')).toBe(0)
  })

  test('only columns near the reachable area are traced, not the whole grid', () => {
    // 40 x 40 cells, ground in only a 3 x 3 patch
    const r = run(`${SETUP}
      local function slabs(x, y) local s = { SKY } if x < 192 and y < 192 then s[#s + 1] = { bottom = -64, top = 0 } end return s end
      SCAN = TraitorDash.NewReachScan({ map = "m", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 2560, y = 2560, z = 1200 },
        tracer = FAKE_TRACER(slabs), spawns = ${SPAWN} })
      while not SCAN:Step(1) do end
      RESULT = SCAN:Result().columns .. " " .. SCAN:Result().traces`).result
    const [columns, traces] = r.split(' ').map(Number)
    expect(columns).toBeLessThan(30) // 9 reachable + the ring around them
    expect(traces).toBeLessThan(200)
  })

  test('works in slices and reports done only when the queue is empty', () => {
    const r = run(`${SETUP}
      local function slabs() return ${GROUND} end
      SCAN = TraitorDash.NewReachScan({ map = "m", cell = 64, mins = { x = 0, y = 0, z = -500 }, maxs = { x = 512, y = 256, z = 1200 },
        tracer = FAKE_TRACER(slabs), spawns = ${SPAWN}, clock = function() return CLOCK or 0 end })
      local real = SCAN.tracer
      SCAN.tracer = function(a, b) CLOCK = (CLOCK or 0) + 1 return real(a, b) end
      local first = SCAN:Step(3)
      local steps = 1
      while not SCAN:Step(3) do steps = steps + 1 end
      RESULT = tostring(first) .. " " .. steps`).result
    const [first, steps] = r.split(' ')
    expect(first).toBe('false')
    expect(Number(steps)).toBeGreaterThan(1)
  })
})

describe('traitordash_mapscan', () => {
  const CMD = `
    ${SETUP}
    util.TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end
    local fn
    hook.Add = function(ev, id, f) if ev == "Think" then THINK = f end end
    game.GetMap = function() return "ttt_Some Map/v2" end
    game.GetWorld = function() return { GetModelBounds = function() return Vector(0, 0, -500), Vector(256, 128, 1200) end } end
    local fake = FAKE_TRACER(function() return { SKY, { bottom = -64, top = 0 } } end)
    util.TraceLine = function(d) return fake(d.start, d.endpos) end
    SPAWNS = { info_player_start = { { GetPos = function() return Vector(32, 32, 0) end } } }
    ents = { FindByClass = function(c) return SPAWNS[c] or {} end }
    SUPER = { IsSuperAdmin = function() return true end }
    PLAIN = { IsSuperAdmin = function() return false end }
    function SCANCMD(ply, ...) CONCMDS.traitordash_mapscan(ply, "traitordash_mapscan", { ... }) end
    function FINISH() for i = 1, 100 do if not THINK then return end THINK() end end
  `
  const cmd = (body: string) => run(`${CMD}\n${body}\nRESULT = table.concat(PRINTS, "\\n") .. "\\n#FILES=" .. (function() local n = {} for k in pairs(DATA) do n[#n + 1] = k end table.sort(n) return table.concat(n, ",") end)()`).result

  test('is superadmin or console only', () => {
    expect(cmd('SCANCMD(PLAIN, "64")')).toContain('#FILES=\n'.trimEnd())
    expect(cmd('SCANCMD(PLAIN, "64")')).not.toContain('Scanning')
  })

  test('scans, then writes data/traitordash/mapscan_<safe map name>.json', () => {
    const r = cmd('SCANCMD(nil, "64") FINISH()')
    expect(r).toContain('Scanning')
    expect(r).toContain('#FILES=traitordash/mapscan_ttt_Some_Map_v2.json')
    expect(r).toMatch(/done/i)
  })

  test('a second scan is refused while one is running', () => {
    const r = cmd('SCANCMD(nil, "64") SCANCMD(nil, "64")')
    expect(r).toContain('already running')
  })

  test('refuses a cell size that would make an enormous grid, and says how to fix it', () => {
    const r = cmd(`game.GetWorld = function() return { GetModelBounds = function() return Vector(-16384, -16384, -500), Vector(16384, 16384, 1200) end } end SCANCMD(nil, "16")`)
    expect(r).toContain('too many cells')
    expect(r).not.toContain('Scanning')
  })

  test('without spawn points it says so and points to the full scan', () => {
    const r = cmd('SPAWNS = {} SCANCMD(nil, "64")')
    expect(r).toContain('No spawn points')
    expect(r).toContain('full')
    expect(r).not.toContain('Scanning')
  })

  test('"full" scans the whole grid without needing spawn points', () => {
    const r = cmd('SPAWNS = {} SCANCMD(nil, "64", "full") FINISH()')
    expect(r).toContain('whole grid')
    expect(r).toContain('#FILES=traitordash/mapscan_ttt_Some_Map_v2.json')
  })

  test('times itself: seconds, ticks and the slowest tick are in the file and the console line', () => {
    const r = run(`${CMD}\nTraitorDash.PushMapPlan = nil -- LAST_PAYLOAD should be the file's, not the upload's\nSCANCMD(nil, "64") FINISH()\nlocal p = LAST_PAYLOAD\nRESULT = type(p.seconds) .. " " .. p.ticks .. " " .. type(p.maxSliceMs) .. " " .. p.mode .. " " .. table.concat(PRINTS, "\\n")`).result
    expect(r).toMatch(/^number \d+ number reach /)
    expect(r).toMatch(/done in [\d.]+ s over \d+ ticks \(slowest tick [\d.]+ ms\)/)
  })

  test('falls back to a large default box when the world reports no bounds', () => {
    const r = cmd(`game.GetWorld = function() return { GetModelBounds = function() return Vector(0, 0, 0), Vector(0, 0, 0) end } end SCANCMD(nil, "256")`)
    expect(r).toContain('Scanning')
  })

  // RFC 10, 4.5: a finished reachable-area scan goes to the dashboard; the whole-grid one does not.
  const pushed = (script: string) => run(`${CMD}
    PUSHED = {}
    TraitorDash.PushMapPlan = function(r) PUSHED[#PUSHED + 1] = r.mode .. ":" .. r.map .. ":" .. #r.rows end
    ${script}
    RESULT = table.concat(PUSHED, ",") .. "|" .. table.concat(PRINTS, "\\n")`).result

  test('a finished scan is handed to the upload', () => {
    expect(pushed('SCANCMD(nil, "64") FINISH()')).toMatch(/^reach:ttt_Some Map\/v2:\d+\|/)
  })

  test('a whole-grid scan is only written to a file, never uploaded', () => {
    expect(pushed('SPAWNS = {} SCANCMD(nil, "64", "full") FINISH()')).toMatch(/^\|/)
  })

  test('nothing is uploaded while the scan is still running', () => {
    expect(pushed('SCANCMD(nil, "64")')).toMatch(/^\|/)
  })

  test('a failing upload does not stop the scan from finishing, writing its file and saying so', () => {
    const r = run(`${CMD}
      TraitorDash.PushMapPlan = function() error("boom") end
      SCANCMD(nil, "64") FINISH()
      RESULT = tostring(DATA["traitordash/mapscan_ttt_Some_Map_v2.json"]) .. "|" .. table.concat(PRINTS, "\\n")`).result
    expect(r).toContain('{json}|')
    expect(r).toContain('Map scan done')
    expect(r).toContain('boom')
  })

  test('without an upload function (the bridge did not load) the scan still finishes', () => {
    const r = run(`${CMD}
      TraitorDash.PushMapPlan = nil
      SCANCMD(nil, "64") FINISH()
      RESULT = table.concat(PRINTS, "\\n")`).result
    expect(r).toContain('Map scan done')
  })
})
