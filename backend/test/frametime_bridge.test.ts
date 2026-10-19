import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// RFC 12, section 7: the console tool that measures the server's frame time, so rounds with
// position tracking off and on can be compared. Runs the real addon/lua/traitordash/frametime.lua
// against a minimal fake of GMod with a clock the test controls.
const FILE = path.join(import.meta.dir, '../../addon/lua/traitordash/frametime.lua')

const PRELUDE = `
  SERVER = true
  IsValid = function(v) return v ~= nil and v ~= false end
  local cvars = { traitordash_track = "0" }
  function GetConVar(n) if cvars[n] == nil then return nil end return { GetBool = function() return cvars[n] == "1" end } end
  function SetCv(n, v) cvars[n] = v end
  MAP = "ttt_test_map"
  game = { GetMap = function() return MAP end }
  engine = { TickInterval = function() return 0.015 end }
  FT = 0.015
  function FrameTime() return FT end
  NOW = 0
  function SysTime() return NOW end
  PLAYERS = { 1, 2, 3 }
  player = { GetAll = function() return PLAYERS end }

  local hooks = {}
  hook = {
    Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end,
    Remove = function(ev, id) if hooks[ev] then hooks[ev][id] = nil end end,
  }
  function Fire(ev, ...) for _, fn in pairs(hooks[ev] or {}) do fn(...) end end
  function HookCount(ev) local n = 0 for _ in pairs(hooks[ev] or {}) do n = n + 1 end return n end
  -- Plays n frames: each one lasts FT as the game reports it and 'gap' seconds of wall time.
  function Frames(n, ft, gap)
    for i = 1, n do FT = ft or FT NOW = NOW + (gap or FT) Fire("Think") end
    FT = 0.015
  end

  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end
  COMMAND = nil
  concommand = { Add = function(n, fn) COMMAND = fn end }
  function Cmd(sub, ply) COMMAND(ply, "traitordash_frametime", { sub }) end
  SUPER = { IsSuperAdmin = function() return true end }
  PLAIN = { IsSuperAdmin = function() return false end }
`

function play(script: string): { printed: string[], out: any } {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    run(fs.readFileSync(FILE, 'utf8'))
    run(script)
    run(`
      local function enc(v)
        local t = type(v)
        if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
        if t == "number" or t == "boolean" then return tostring(v) end
        if t == "table" then
          if #v > 0 or next(v) == nil then local o = {} for i, x in ipairs(v) do o[i] = enc(x) end return "[" .. table.concat(o, ",") .. "]" end
          local o = {} for k, x in pairs(v) do o[#o + 1] = enc(tostring(k)) .. ":" .. enc(x) end return "{" .. table.concat(o, ",") .. "}"
        end
        return "null"
      end
      PRINTED_JSON = enc(PRINTED)
      OUT_JSON = OUT ~= nil and enc(OUT) or "null"
    `)
    const get = (n: string) => { lua.lua_getglobal(L, to_luastring(n)); return to_jsstring(lua.lua_tostring(L, -1)) }
    return { printed: JSON.parse(get('PRINTED_JSON')), out: JSON.parse(get('OUT_JSON')) }
  } finally {
    lua.lua_close(L)
  }
}
const line = (r: { printed: string[] }) => r.printed.find(l => l.includes('frames over'))!

describe('frametime.lua', () => {
  test('does nothing until a measurement is started: no Think hook', () => {
    const r = play(`OUT = { think = HookCount("Think") }`)
    expect(r.out.think).toBe(0)
    expect(r.printed).toHaveLength(0)
  })

  test('start and stop print the mean, 99th percentile and worst frame, and the overruns', () => {
    // 98 normal frames of 15 ms, one of 25 ms (over 1.5x of 15 = 22.5) and one of 40 ms (over 2x = 30)
    const r = play(`Cmd("start") Frames(98) Frames(1, 0.025) Frames(1, 0.040) Cmd("stop")`)
    const l = line(r)
    expect(l).toContain('manual on ttt_test_map')
    expect(l).toContain('100 frames')
    expect(l).toContain('tick 15.0 ms')
    expect(l).toMatch(/frame time mean 15\.\d+ p99 25\.00 worst 40\.00 ms/)
    expect(l).toContain('frames over 1.5x the tick: 2, over 2x: 1')
    expect(l).toContain('3 players')
  })

  test('the time between frames is measured apart from the frame time the game reports', () => {
    const r = play(`Cmd("start") Frames(150, 0.015, 0.015) Frames(1, 0.015, 0.120) Cmd("stop")`)
    expect(line(r)).toMatch(/time between frames mean [\d.]+ p99 15\.00 worst 120\.00 ms/)
  })

  test('says whether position tracking was on, as it was when the measurement began', () => {
    const off = play(`Cmd("start") Frames(5) Cmd("stop")`)
    expect(line(off)).toContain('tracking off')
    const on = play(`SetCv("traitordash_track", "1") Cmd("start") Frames(5) SetCv("traitordash_track", "0") Cmd("stop")`)
    expect(line(on)).toContain('tracking ON')
  })

  test('the hook is removed when the measurement ends', () => {
    const r = play(`Cmd("start") OUT = { during = HookCount("Think") } Frames(3) Cmd("stop") OUT.after = HookCount("Think")`)
    expect(r.out).toEqual({ during: 1, after: 0 })
  })

  test('round measures from the start of the next round to its end, once', () => {
    const r = play(`
      Cmd("round")
      OUT = { armed = HookCount("Think") }
      Frames(5)                       -- before the round: not measured
      Fire("TTTBeginRound")
      OUT.during = HookCount("Think")
      Frames(40)
      Fire("TTTEndRound")
      OUT.after = HookCount("Think")
      Frames(10)                      -- after the round: not measured
      Fire("TTTBeginRound") Frames(3) Fire("TTTEndRound") -- not armed again
    `)
    expect(r.out).toEqual({ armed: 0, during: 1, after: 0 })
    const lines = r.printed.filter(l => l.includes('frames over'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('round on ttt_test_map')
    expect(lines[0]).toContain('40 frames')
  })

  test('a round that is restarted before it ends drops the measurement and the tool is free again', () => {
    const r = play(`
      Cmd("round") Fire("TTTBeginRound") Frames(3)
      Fire("TTTPrepareRound")
      OUT = { think = HookCount("Think") }
      Cmd("start") Frames(2) Cmd("stop")
    `)
    expect(r.out.think).toBe(0)
    expect(r.printed.join('\n')).toContain('measurement dropped')
    expect(line(r)).toContain('2 frames')
  })

  test('status says what is going on; history lists the results, newest last, at most 20', () => {
    const r = play(`
      Cmd("status")
      Cmd("round") Cmd("status")
      Cmd("start") Cmd("status") Frames(4) Cmd("stop")
      for i = 1, 22 do Cmd("start") Frames(1) Cmd("stop") end
      PRINTED = {}
      Cmd("history")
    `)
    expect(r.printed).toHaveLength(20)
    expect(r.printed[0]).toMatch(/ 1\. manual ttt_test_map tracking off/)
    expect(r.printed[19]).toMatch(/20\. manual/)
    const s = play(`Cmd("status") Cmd("round") Cmd("status") Cmd("start") Cmd("status") Frames(4) Cmd("status") Cmd("stop") Cmd("status")`)
    expect(s.printed.filter(l => l.includes('idle') || l.includes('armed') || l.includes('measuring')).length).toBeGreaterThan(4)
    expect(s.printed.join('\n')).toContain('measuring (manual): 4 frames so far')
    expect(s.printed.join('\n')).toContain('idle; 1 results kept')
  })

  test('only the console or a superadmin may use it', () => {
    const r = play(`Cmd("start", PLAIN) Frames(2) OUT = { think = HookCount("Think") } Cmd("start", SUPER) Frames(2) Cmd("stop", SUPER)`)
    expect(r.out.think).toBe(0)
    expect(r.printed.filter(l => l.includes('frames over'))).toHaveLength(1)
    expect(line(r)).toContain('2 frames')
  })

  test('starting twice, stopping with nothing and an unknown subcommand are said, not errors', () => {
    const r = play(`Cmd("stop") Cmd("start") Cmd("start") Cmd("stop") Cmd("round") Cmd("round") Cmd("nonsense") Cmd("")`)
    const t = r.printed.join('\n')
    expect(t).toContain('nothing is being measured')
    expect(t).toContain('already measuring')
    expect(t).toContain('armed')
    expect(t.match(/usage: traitordash_frametime/g)).toHaveLength(2)
  })

  test('stops by itself at 200 000 frames and says so', () => {
    const r = play(`Cmd("start") Frames(200010) OUT = { think = HookCount("Think") } Cmd("stop")`)
    expect(r.out.think).toBe(0)
    expect(line(r)).toContain('200000 frames')
    expect(line(r)).toContain('stopped at the frame limit')
  }, 60_000)

  test('an error while sampling is caught once, and the game goes on', () => {
    const r = play(`
      Cmd("start") Frames(2)
      local real = FrameTime
      FrameTime = function() error("boom") end
      Fire("Think") Fire("Think")
      FrameTime = real
      Frames(2)
      Cmd("stop")
    `)
    expect(r.printed.filter(l => l.includes('error while sampling'))).toHaveLength(1)
    expect(line(r)).toContain('4 frames')
    expect(line(r)).toContain('2 sampling errors')
  })

  test('a measurement with no frames prints zeros rather than failing', () => {
    const r = play(`Cmd("start") Cmd("stop")`)
    expect(line(r)).toContain('0 frames')
    expect(line(r)).toContain('mean 0.00 p99 0.00 worst 0.00 ms')
  })
})
