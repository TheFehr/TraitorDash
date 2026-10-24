import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// RFC 20, stage 0: the console probe for the parts of a map that move. Runs the real
// addon/lua/traitordash/partsprobe.lua against a minimal fake of GMod: entities the test places, a clock and timers it
// advances, and hooks it fires, so what the probe answers can be checked without a server.
const FILE = path.join(import.meta.dir, '../../addon/lua/traitordash/partsprobe.lua')

const PRELUDE = `
  SERVER = true
  isstring = function(v) return type(v) == "string" end
  IsValid = function(v) return v ~= nil and v ~= false and v.valid ~= false end
  MAP = "ttt_rooftops_2016_v1"
  game = { GetMap = function() return MAP end }
  NOW = 0
  function SysTime() return NOW end
  PLAYERS = {}
  player = { GetAll = function() return PLAYERS end }
  os = nil

  -- Entities: methods through a metatable, like GMod's.
  local E = {}
  E.__index = E
  function E:EntIndex() return self.idx end
  function E:GetClass() return self.class end
  function E:GetModel() return self.model end
  function E:GetName() return self.name end
  function E:GetPos() return self.pos end
  function E:GetAngles() return self.ang end
  function E:GetParent() return self.parent or { valid = false } end
  function E:IsPlayer() return self.player == true end
  function E:IsBot() return self.bot == true end
  ENTS = {}
  local nextIdx = 1
  function Ent(class, model, name)
    local e = setmetatable({ idx = nextIdx, class = class, model = model, name = name or "", pos = { x = 0, y = 0, z = 0 }, ang = { p = 0, y = 0, r = 0 } }, E)
    nextIdx = nextIdx + 1
    ENTS[#ENTS + 1] = e
    return e
  end
  function Ply() local e = Ent("player", "models/player.mdl", "") e.player = true e.IsSuperAdmin = function() return true end return e end
  ents = { GetAll = function() return ENTS end }

  -- Hooks, and what each one returned (a hook that returns true from AcceptInput stops the game's input).
  local hooks = {}
  hook = {
    Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end,
    Remove = function(ev, id) if hooks[ev] then hooks[ev][id] = nil end end,
  }
  function Fire(ev, ...)
    local returned = {}
    for id, fn in pairs(hooks[ev] or {}) do
      if id:find("PartsProbe") then returned[#returned + 1] = table.pack(fn(...)).n end
    end
    return returned
  end
  function HookCount(ev) local n = 0 for _ in pairs(hooks[ev] or {}) do n = n + 1 end return n end

  -- Timers the test advances.
  local timers = {}
  timer = {
    Create = function(id, secs, reps, fn) timers[id] = { secs = secs, reps = reps, fn = fn, at = NOW + secs, left = reps } end,
    Remove = function(id) timers[id] = nil end,
  }
  function TimerCount() local n = 0 for _ in pairs(timers) do n = n + 1 end return n end
  -- Moves the clock forward in steps, running every timer that falls due.
  function Advance(secs, step)
    step = step or 0.1
    local target = NOW + secs
    while NOW < target - 1e-9 do
      NOW = math.min(NOW + step, target)
      for id, t in pairs(timers) do
        while timers[id] and NOW >= t.at - 1e-9 do
          t.at = t.at + t.secs
          if t.reps > 0 then t.left = t.left - 1 if t.left <= 0 then timers[id] = nil end end
          t.fn()
        end
      end
    end
  end

  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end
  DATA = {}
  file = { Read = function(p) return DATA[p] end, Write = function(p, c) DATA[p] = c end, Delete = function(p) DATA[p] = nil end }
  FRAME = 0.015
  function FrameTime() return FRAME end
  COMMAND = nil
  concommand = { Add = function(n, fn) COMMAND = fn end }
  function Cmd(...) COMMAND(CONSOLE_PLAYER, "traitordash_parts_probe", { ... }) end
  CONSOLE_PLAYER = nil
  PLAIN = { IsSuperAdmin = function() return false end }
`

function play(script: string): { printed: string[], out: any } {
  return playWithData('', script)
}

// "before" runs after the fake GMod is set up and before the addon loads, like a file already on the server.
function playWithData(before: string, script: string): { printed: string[], out: any } {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    if (before) run(before)
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
const text = (r: { printed: string[] }) => r.printed.join('\n')

describe('partsprobe.lua', () => {
  test('hooks nothing and starts no timer until a watch is started', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      OUT = { input = HookCount("AcceptInput"), use = HookCount("PlayerUse"), timers = TimerCount() }
    `)
    expect(r.out).toEqual({ input: 0, use: 0, timers: 0 })
  })

  test('scan lists the movable entities by class and says how their models look', () => {
    const r = play(`
      Ent("func_door", "*3", "door1") Ent("func_door", "*4", "door1") Ent("func_movelinear", "*98", "building_collapse")
      Ent("func_tracktrain", "models/props/train.mdl", "") -- a model that is not "*N"
      Ent("func_door", "*3", "twin")                        -- *3 twice
      Ent("prop_door_rotating", "models/door.mdl", "d") Ent("func_breakable", "*7", "") Ent("func_breakable", "*8", "") Ent("func_button", "*9", "")
      Ent("prop_physics", "models/crate.mdl", "")
      local parented = Ent("func_rotating", "*11", "fan") parented.parent = Ent("func_tracktrain", "*12", "t")
      Cmd("scan")
    `)
    const t = text(r)
    expect(t).toContain('movable entities: 7 (func_door 3, func_movelinear 1, func_rotating 1, func_tracktrain 2)')
    expect(t).toContain('model is "*N": 6 of 7; without it: 1; the same N on two entities: 1; without a name: 1; with a parent (left out of the mesh): 1')
    expect(t).toContain('no *N: func_tracktrain name=(none) model=models/props/train.mdl')
    expect(t).toContain('*3 twice: func_door name=door1 model=*3 and func_door name=twin model=*3')
    expect(t).toContain('prop_door_rotating 1, func_breakable 2, func_breakable_surf 0, func_button 1, func_wall_toggle 0')
  })

  test('the result also goes to a data file, one block after another', () => {
    const r = play(`Ent("func_door", "*3", "a") Cmd("scan") Cmd("scan") OUT = { blocks = select(2, DATA["traitordash_parts_probe.txt"]:gsub("%-%-%- parts probe, scan, map ttt_rooftops_2016_v1", "")) }`)
    expect(r.out.blocks).toBe(2)
  })

  test('a watch hooks the input and the use, starts its timers, and removes all of it at the end', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      Cmd("start", "30")
      local during = { input = HookCount("AcceptInput"), use = HookCount("PlayerUse"), timers = TimerCount() }
      Advance(31)
      OUT = { during = during, after = { input = HookCount("AcceptInput"), use = HookCount("PlayerUse"), timers = TimerCount() } }
    `)
    expect(r.out.during).toEqual({ input: 1, use: 1, timers: 2 })
    expect(r.out.after).toEqual({ input: 0, use: 0, timers: 0 })
    expect(text(r)).toContain('watched 30 s (time is up)')
  })

  test('the hooks return no value on any path: returning true from AcceptInput would block the input', () => {
    const r = play(`
      local door, other, p = Ent("func_door", "*3", "door1"), Ent("prop_physics", "models/c.mdl", ""), Ply()
      Cmd("start", "60")
      OUT = {
        tracked = Fire("AcceptInput", door, "Open", p, p, ""),
        untracked = Fire("AcceptInput", other, "Break", p, p, ""),
        invalid = Fire("AcceptInput", { valid = false }, "Open", nil, nil, ""),
        use = Fire("PlayerUse", p, door),
        useOther = Fire("PlayerUse", p, other),
      }
    `)
    expect(r.out).toEqual({ tracked: [0], untracked: [0], invalid: [0], use: [0], useOther: [0] })
  })

  test('even when the bookkeeping fails, the hook returns nothing, counts the error and the watch goes on', () => {
    const r = play(`
      local door = Ent("func_door", "*3", "door1")
      Cmd("start", "60")
      local bad = setmetatable({}, { __index = function() error("boom") end })
      OUT = { returned = Fire("AcceptInput", bad, "Open", nil, nil, ""), still = HookCount("AcceptInput") }
      Fire("AcceptInput", door, "Open", nil, nil, "")
      Cmd("stop")
    `)
    expect(r.out).toEqual({ returned: [0], still: 1 })
    expect(text(r)).toContain('errors while watching: 1')
  })

  test('inputs on parts are counted by class and input, and by who caused them; other entities only add to the total', () => {
    const r = play(`
      local door, building, crate = Ent("func_door", "*3", "door1"), Ent("func_movelinear", "*98", "building_collapse"), Ent("prop_physics", "models/c.mdl", "")
      local p = Ply()
      Cmd("start", "60")
      NOW = NOW + 2   Fire("AcceptInput", door, "Open", p, door, "")
      NOW = NOW + 1   Fire("AcceptInput", door, "CLOSE", nil, p, "")
      NOW = NOW + 1   Fire("AcceptInput", building, "Trigger", nil, nil, "")
      Fire("AcceptInput", crate, "Break", p, p, "")
      Fire("PlayerUse", p, door) Fire("PlayerUse", p, crate)
      Cmd("stop")
    `)
    const t = text(r)
    expect(t).toContain('inputs on any entity: 4')
    expect(t).toContain('on movable parts: 3')
    expect(t).toContain('inputs on movable parts: func_door close 1, func_door open 1, func_movelinear trigger 1')
    expect(t).toContain('activator was a player 1, only the caller was a player 1, nobody 1')
    expect(t).toMatch(/open +func_door name=door1 model=\*3 \(by activator\)/)
    expect(t).toContain('PlayerUse on movable parts: 1')
  })

  test('a movement right after an input is announced; one with no input is listed as unannounced', () => {
    const r = play(`
      local door, lift = Ent("func_door", "*3", "door1"), Ent("func_movelinear", "*5", "lift")
      Cmd("start", "60")
      Advance(1)
      Fire("AcceptInput", door, "Open", nil, nil, "")
      Advance(0.4)
      door.pos = { x = 0, y = 0, z = 60 }        -- the door moves, an input came 0.4 s before
      Advance(1)
      lift.ang = { p = 0, y = 90, r = 0 }          -- the lift turns with no input at all
      Advance(1)
      Cmd("stop")
    `)
    const t = text(r)
    expect(t).toContain('parts that moved: 2 of 2; movements 2: announced by an input in the 5 s before 1, with no input 1')
    expect(t).toMatch(/s func_movelinear name=lift model=\*5 \(no input yet\)/)
  })

  test('one long movement counts once, and a second one after standing still counts again', () => {
    const r = play(`
      local door = Ent("func_door", "*3", "door1")
      Cmd("start", "60")
      Advance(0.5)
      for i = 1, 5 do door.pos = { x = 0, y = 0, z = i * 10 } Advance(0.2) end   -- one swing
      Advance(1)                                                                  -- still
      door.pos = { x = 0, y = 0, z = 0 } Advance(0.5)                             -- back
      Cmd("stop")
    `)
    expect(text(r)).toContain('movements 2:')
  })

  test('a very small change is not a movement; an angle that wraps around 360 is not a big one', () => {
    const r = play(`
      local door = Ent("func_door", "*3", "door1")
      door.ang = { p = 0, y = 359.9, r = 0 }
      Cmd("start", "60")
      Advance(0.5)
      door.pos = { x = 0.2, y = 0, z = 0 } Advance(0.5)
      door.ang = { p = 0, y = 0.05, r = 0 } Advance(0.5)
      Cmd("stop")
    `)
    expect(text(r)).toContain('parts that moved: 0 of 1')
  })

  test('a part that is removed from the game is noted and not looked at again', () => {
    const r = play(`
      local wall = Ent("func_movelinear", "*3", "wall")
      Cmd("start", "60")
      Advance(1)
      wall.valid = false
      Advance(1)
      Cmd("stop")
    `)
    const t = text(r)
    expect(t).toContain('parts removed from the game while watching: 1')
    expect(t).toMatch(/s removed: func_movelinear name=wall model=\*3/)
    expect(t).not.toContain('errors while watching')
  })

  test('only the console and superadmins may use it', () => {
    const r = play(`
      Ent("func_door", "*3", "a")
      CONSOLE_PLAYER = PLAIN
      Cmd("scan") Cmd("start")
      OUT = { hooks = HookCount("AcceptInput"), printed = #PRINTED }
    `)
    expect(r.out).toEqual({ hooks: 0, printed: 0 })
  })

  test('starting twice, stopping with nothing, an unknown word and an out-of-range time are all said or limited, never errors', () => {
    const r = play(`
      Ent("func_door", "*3", "a")
      Cmd("stop") Cmd("status") Cmd("bogus")
      Cmd("start", "1")
      Cmd("start", "30")
      Cmd("status")
      Cmd("stop")
    `)
    const t = text(r)
    expect(t).toContain('nothing is being watched')
    expect(t.match(/usage: traitordash_parts_probe/g)).toHaveLength(1)
    expect(t).toContain('for 5 s (manual)') // the shortest watch is 5 s
    expect(t).toContain('already watching (manual)')
    expect(t).toContain('watching (manual) for 0 s')
  })

  test('a very long watch is cut to 30 minutes', () => {
    const r = play(`
      Ent("func_door", "*3", "a")
      Cmd("start", "999999")
    `)
    expect(text(r)).toContain('for 1800 s (manual)')
  })

  test('round: armed, watches from the start of the next round to its end, and a restarted round ends the watch with what it saw', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      Cmd("round")
      local armed = HookCount("AcceptInput")                 -- armed, but nothing hooked yet
      Fire("TTTBeginRound")
      local during = HookCount("AcceptInput")
      Advance(10)
      Fire("TTTEndRound")
      local after = HookCount("AcceptInput")
      Cmd("round") Fire("TTTBeginRound")
      Advance(3)
      Fire("TTTPrepareRound")                                -- the round is restarted
      OUT = { armed = armed, during = during, after = after, restarted = HookCount("AcceptInput"), timers = TimerCount() }
    `)
    expect(r.out).toEqual({ armed: 0, during: 1, after: 0, restarted: 0, timers: 0 })
    const t = text(r)
    expect(t).toContain('watched 10 s (the round ended)')
    expect(t).toContain('watched 3 s (the round was restarted)')
  })

  test('auto: watches each round with enough humans, bots not counted, and keeps going round after round', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      local a, b, bot = Ply(), Ply(), Ply() bot.bot = true
      PLAYERS = { a, bot }
      Cmd("auto", "on", "2")
      Fire("TTTBeginRound")                                   -- one human and a bot: too few
      local few = HookCount("AcceptInput")
      PLAYERS = { a, b, bot }
      Fire("TTTBeginRound")                                   -- two humans
      local first = HookCount("AcceptInput")
      Advance(5) Fire("TTTEndRound")
      Fire("TTTBeginRound")                                   -- the next round, no new command
      local second = HookCount("AcceptInput")
      Advance(5) Fire("TTTEndRound")
      Cmd("auto", "off")
      Fire("TTTBeginRound")
      OUT = { few = few, first = first, second = second, off = HookCount("AcceptInput"), fileGone = DATA["traitordash_parts_probe_auto.txt"] == nil }
    `)
    expect(r.out).toEqual({ few: 0, first: 1, second: 1, off: 0, fileGone: true })
    expect(text(r).match(/--- parts probe, round/g)).toHaveLength(2)
  })

  test('auto is kept in a file and comes back when the addon loads again', () => {
    const r = play(`
      Cmd("auto", "on", "12")
      OUT = { saved = DATA["traitordash_parts_probe_auto.txt"] }
    `)
    expect(r.out.saved).toBe('12')
    // a new load, with the file still there
    const second = playWithData(`
      DATA["traitordash_parts_probe_auto.txt"] = "12"
    `, `
      PLAYERS = {} for i = 1, 12 do PLAYERS[i] = Ply() end
      Fire("TTTBeginRound")
      OUT = { watching = HookCount("AcceptInput") }
    `)
    expect(second.out.watching).toBe(1)
    expect(text(second)).toContain('auto: every round that starts with 12 or more people is watched')
  })

  test('a map change or shutdown ends the watch and writes what it saw', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      Cmd("round") Fire("TTTBeginRound")
      Advance(7)
      Fire("ShutDown")
      OUT = { hooks = HookCount("AcceptInput"), timers = TimerCount() }
    `)
    expect(r.out).toEqual({ hooks: 0, timers: 0 })
    expect(text(r)).toContain('watched 7 s (the server shut down or changed map)')
  })

  test('the report says how many people there were at most, how the frames did and has one summary line', () => {
    const r = play(`
      Ent("func_door", "*3", "door1")
      local ps = {} for i = 1, 20 do ps[i] = Ply() end
      PLAYERS = { ps[1], ps[2] }
      Cmd("start", "60")
      Advance(2)
      PLAYERS = ps                                            -- the server fills up
      Advance(3)
      FRAME = 0.05 Advance(1) FRAME = 0.015
      PLAYERS = { ps[1] }
      Cmd("stop")
    `)
    const t = text(r)
    expect(t).toContain('at the start 2 people (0 of them bots), at most 20 (20 humans), at the end 1 (1 humans)')
    expect(t).toMatch(/SUMMARY humans<=20 \| inputs 0\.0\/s \| hook 0\.0 us avg 0\.0 us worst \| looking at parts [\d.]+ us avg [\d.]+ us worst \| unannounced movements 0 \| frames [\d.]+ ms avg 50\.00 ms worst/)
  })

  test('a data file that has grown too large is left alone, and the result still goes to the console', () => {
    const r = play(`
      Ent("func_door", "*3", "a")
      DATA["traitordash_parts_probe.txt"] = string.rep("x", 600 * 1024)
      Cmd("scan")
      OUT = { size = #DATA["traitordash_parts_probe.txt"] }
    `)
    expect(r.out.size).toBe(600 * 1024)
    expect(text(r)).toContain('movable entities: 1')
    expect(text(r)).toContain('could not write data/traitordash_parts_probe.txt')
  })

  test('with more than 512 movable entities only the first 512 are watched, and it says so', () => {
    const r = play(`
      for i = 1, 520 do Ent("func_door", "*" .. i, "d" .. i) end
      Cmd("scan")
    `)
    const t = text(r)
    expect(t).toContain('movable entities: 512 (func_door 512) - more than 512, the rest are not looked at')
  })
})
