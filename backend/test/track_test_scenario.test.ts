import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// The bot scenario for exercising position tracking on a real server (addon/lua/traitordash/
// track_test.lua), run against a fake of GMod and TTT2 with a clock the test controls. It must
// refuse when anybody is online, make the bots walk, play a round to its end, and ALWAYS put the
// server's settings back, also when something goes wrong.
const FILE = path.join(import.meta.dir, '../../addon/lua/traitordash/track_test.lua')

const PRELUDE = `
  SERVER = true
  TTT2 = true
  ROUND_PREP, ROUND_ACTIVE = 2, 3
  TEAM_TRAITOR, TEAM_INNOCENT = "traitors", "innocents"
  WIN_TRAITOR = 2
  IN_JUMP = 2
  IsValid = function(v) return v ~= nil and v ~= false end
  math.Rand = function(a, b) return a + math.random() * (b - a) end
  math.Clamp = function(v, lo, hi) return math.min(math.max(v, lo), hi) end
  Angle = function(p, y, r) return { p = p, y = y, r = r } end

  NOW = 1000
  function CurTime() return NOW end
  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end

  -- Hooks and timers, driven by the test.
  local hooks = {}
  hook = {
    Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end,
    Remove = function(ev, id) if hooks[ev] then hooks[ev][id] = nil end end,
  }
  function Fire(ev, ...) for _, fn in pairs(hooks[ev] or {}) do fn(...) end end
  function HookCount(ev) local n = 0 for _ in pairs(hooks[ev] or {}) do n = n + 1 end return n end
  TIMERS, SIMPLES = {}, {}
  timer = {
    Create = function(n, d, r, fn) TIMERS[n] = { delay = d, fn = fn, due = NOW + d } end,
    Remove = function(n) TIMERS[n] = nil end,
    Simple = function(d, fn) SIMPLES[#SIMPLES + 1] = { due = NOW + d, fn = fn } end,
  }
  -- Moves the clock on in steps of a second.
  function Advance(seconds)
    for _ = 1, seconds do
      NOW = NOW + 1
      for i = #SIMPLES, 1, -1 do local s = SIMPLES[i] if s.due <= NOW then table.remove(SIMPLES, i) s.fn() end end
      for _, t in pairs(TIMERS) do if t.due <= NOW then t.due = NOW + t.delay t.fn() end end
    end
  end

  -- ConVars: values by name, changed by RunConsoleCommand.
  CVARS = { traitordash_track = "0", traitordash_stats_bots = "0", bot_zombie = "1" }
  CHANGES = {}
  function GetConVar(n) if CVARS[n] == nil then return nil end return { GetString = function() return CVARS[n] end } end

  -- Players and the round.
  BOTS, HUMANS = {}, {}
  STATE = ROUND_PREP
  ACTIVE_AFTER = 2
  NO_TRAITOR = false
  RESTARTS = 0
  KILLS = {}
  local nextId = 0
  local function mkbot()
    nextId = nextId + 1
    local b = { id = nextId, alive = true, speed = 200 }
    function b:IsBot() return true end
    function b:IsTerror() return self.alive end
    function b:Nick() return "Bot" .. self.id end
    function b:GetTeam() if self.boom then error("GetTeam failed") end return self.team or TEAM_INNOCENT end
    function b:GetSubRoleData() return { name = self.team == TEAM_TRAITOR and "traitor" or "innocent" } end
    function b:GetVelocity() local s = self.speed return { Length2D = function() return s end } end
    function b:Kick(why) self.kicked = why for i, x in ipairs(BOTS) do if x == self then table.remove(BOTS, i) break end end end
    function b:TakeDamageInfo(d) self.alive = false KILLS[#KILLS + 1] = { victim = self.id, attacker = d.attacker.id, at = NOW } CheckWin() end
    return b
  end
  function CheckWin()
    for _, b in ipairs(BOTS) do if b.alive and b.team ~= TEAM_TRAITOR then return end end
    STATE = ROUND_PREP
    Fire("TTTEndRound", WIN_TRAITOR)
  end
  player = { GetBots = function() local c = {} for i, b in ipairs(BOTS) do c[i] = b end return c end, GetHumans = function() return HUMANS end }
  gameloop = { GetRoundState = function() return STATE end }
  DamageInfo = function()
    local d = {}
    function d:SetAttacker(a) self.attacker = a end
    function d:SetInflictor() end function d:SetDamage() end function d:SetDamageType() end
    return d
  end
  DMG_BULLET = 2
  BOT_ADDS = 0

  function RunConsoleCommand(name, value)
    if name == "bot" then BOT_ADDS = BOT_ADDS + 1 BOTS[#BOTS + 1] = mkbot() return end
    if name == "ttt_roundrestart" then
      RESTARTS = RESTARTS + 1
      for i, b in ipairs(BOTS) do b.alive = true b.team = (i == 1 and not NO_TRAITOR) and TEAM_TRAITOR or TEAM_INNOCENT end
      timer.Simple(ACTIVE_AFTER, function() STATE = ROUND_ACTIVE ACTIVE_AT = NOW end)
      return
    end
    CHANGES[#CHANGES + 1] = name .. "=" .. tostring(value)
    CVARS[name] = tostring(value)
  end

  COMMAND = nil
  concommand = { Add = function(n, fn) COMMAND = fn end }
  function Cmd(args, ply) COMMAND(ply, "traitordash_track_test", args or {}) end
  function Done() for _, l in ipairs(PRINTED) do if l:find("done:", 1, true) then return true end end return false end
  function Say(pattern) for _, l in ipairs(PRINTED) do if l:find(pattern) then return l end end return nil end
  function NewCmd() local c = { forward = 0, yaw = nil, buttons = 0 }
    function c:ClearMovement() self.forward = 0 end function c:ClearButtons() self.buttons = 0 end
    function c:SetViewAngles(a) self.yaw = a.y end function c:SetForwardMove(v) self.forward = v end function c:SetButtons(b) self.buttons = b end
    return c end
  -- Plays the scenario to its end.
  function RunAll(limit) for _ = 1, limit or 400 do if Done() then return end Advance(1) end end
`

interface Result { printed: string[], out: any }

function play(script: string): Result {
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

const SETTINGS_BACK = `{ track = CVARS.traitordash_track, bots = CVARS.traitordash_stats_bots, zombie = CVARS.bot_zombie }`

describe('refuses', () => {
  test('when a real player is online: nothing is changed and no bot is added', () => {
    const r = play(`HUMANS = { { Nick = function() return "Alice" end } } Cmd({}) OUT = { changes = #CHANGES, adds = BOT_ADDS, hooks = HookCount("StartCommand") }`)
    expect(r.out).toEqual({ changes: 0, adds: 0, hooks: 0 })
    expect(r.printed.join('\n')).toContain('refusing: a real player (Alice) is online')
  })
  test('from a player (only the server console may run it)', () => {
    const r = play(`Cmd({}, { IsSuperAdmin = function() return true end }) OUT = { changes = #CHANGES, adds = BOT_ADDS }`)
    expect(r.out).toEqual({ changes: 0, adds: 0 })
    expect(r.printed).toHaveLength(0)
  })
  test('when TTT2 is not there', () => {
    const r = play(`TTT2 = nil Cmd({}) OUT = { changes = #CHANGES }`)
    expect(r.out.changes).toBe(0)
    expect(r.printed.join('\n')).toContain('TTT2 gameloop not available')
  })
  test('while it is already running', () => {
    const r = play(`Cmd({ "4", "60" }) Cmd({ "4", "60" })`)
    expect(r.printed.join('\n')).toContain('already running')
  })
})

describe('a full run', () => {
  const run = `Cmd({ "6", "60" }) OUT = { during = {} } Advance(1) OUT.during = ${SETTINGS_BACK} RunAll() OUT.after = ${SETTINGS_BACK} OUT.kills = KILLS OUT.bots = #BOTS OUT.hooks = HookCount("StartCommand") + HookCount("TTTEndRound") OUT.timers = (TIMERS.TraitorDash_TrackTest and 1 or 0) OUT.restarts = RESTARTS OUT.adds = BOT_ADDS OUT.activeAt = ACTIVE_AT`

  test('turns tracking and the bots on, plays the round to its end and puts every setting back', () => {
    const r = play(run)
    expect(r.out.during).toEqual({ track: '1', bots: '1', zombie: '0' })
    expect(r.out.after).toEqual({ track: '0', bots: '0', zombie: '1' }) // as they were found
    expect(r.out.adds).toBe(6)
    expect(r.out.restarts).toBe(1)
    expect(r.out.bots).toBe(0) // every bot kicked
    expect(r.out.hooks).toBe(0)
    expect(r.out.timers).toBe(0)
    const t = r.printed.join('\n')
    expect(t).toContain('position tracking ON')
    expect(t).toContain('TTTEndRound fired, result=2')
    expect(t).toContain('done: round over')
  })

  test('the traitor kills the five others, not before 30% of the time and one every few seconds', () => {
    const r = play(run)
    expect(r.out.kills).toHaveLength(5)
    expect(new Set(r.out.kills.map((k: any) => k.attacker))).toEqual(new Set([1])) // Bot1 is the traitor
    expect(new Set(r.out.kills.map((k: any) => k.victim)).size).toBe(5)
    const at = r.out.kills.map((k: any) => k.at)
    const active = r.out.activeAt
    expect(at[0] - active).toBeGreaterThanOrEqual(18) // 30% of 60 s
    expect(at[0] - active).toBeLessThanOrEqual(20)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(8) // 60 s * 0.7 / 5 = 8.4 s
    expect(at[4] - active).toBeLessThanOrEqual(62)
  })

  test('with "off" tracking stays off, for the control run', () => {
    const r = play(`Cmd({ "4", "40", "off" }) Advance(1) OUT = { track = CVARS.traitordash_track } RunAll()`)
    expect(r.out.track).toBe('0')
    expect(r.printed.join('\n')).toContain('position tracking OFF (control run)')
  })

  test('bots left from an earlier run are kicked first, and a surplus is trimmed', () => {
    const r = play(`
      for _ = 1, 3 do RunConsoleCommand("bot") end
      local old = {} for i, b in ipairs(BOTS) do old[i] = b end
      Cmd({ "4", "40" }) Advance(2)
      OUT = { oldKicked = old[1].kicked ~= nil and old[2].kicked ~= nil and old[3].kicked ~= nil, now = #BOTS }
    `)
    expect(r.out).toEqual({ oldKicked: true, now: 4 })
    expect(r.printed.join('\n')).toContain('kicked 3 leftover bots first')
  })

  test('the number of bots and the time are kept within sensible limits', () => {
    expect(play(`Cmd({ "100", "10" }) OUT = { n = 0 } Advance(3) OUT.n = BOT_ADDS`).out.n).toBe(16)
    expect(play(`Cmd({ "1", "10" }) Advance(3) OUT = { n = BOT_ADDS }`).out.n).toBe(2)
    expect(play(`Cmd({ "x" }) Advance(3) OUT = { n = BOT_ADDS }`).out.n).toBe(8)
    expect(play(`Cmd({ "4", "9999" }) OUT = {}`).printed.join('\n')).toContain('for about 300 s')
    expect(play(`Cmd({ "4", "1" }) OUT = {}`).printed.join('\n')).toContain('for about 30 s')
  })
})

describe('it always puts the settings back', () => {
  test('when the round never becomes active: gives up after the wait and restores', () => {
    const r = play(`ACTIVE_AFTER = 100000 Cmd({ "4", "60" }) RunAll(300) OUT = { s = ${SETTINGS_BACK}, bots = #BOTS, hooks = HookCount("StartCommand") }`)
    expect(r.out).toEqual({ s: { track: '0', bots: '0', zombie: '1' }, bots: 0, hooks: 0 })
    expect(r.printed.join('\n')).toContain('FAILED: no round finished within 240 s')
  })
  test('when no traitor was assigned', () => {
    const r = play(`NO_TRAITOR = true Cmd({ "4", "60" }) RunAll(60) OUT = { s = ${SETTINGS_BACK}, bots = #BOTS }`)
    expect(r.out).toEqual({ s: { track: '0', bots: '0', zombie: '1' }, bots: 0 })
    expect(r.printed.join('\n')).toContain('FAILED: no traitor bot was assigned')
  })
  test('when an error happens in the timer', () => {
    const r = play(`Cmd({ "4", "60" }) Advance(2) for _, b in ipairs(BOTS) do b.boom = true end RunAll(60) OUT = { s = ${SETTINGS_BACK}, bots = #BOTS, hooks = HookCount("StartCommand") }`)
    expect(r.out).toEqual({ s: { track: '0', bots: '0', zombie: '1' }, bots: 0, hooks: 0 })
    expect(r.printed.join('\n')).toMatch(/FAILED: .*GetTeam failed/)
  })
  test('a setting that did not exist before is not invented', () => {
    const r = play(`CVARS.bot_zombie = nil Cmd({ "4", "40" }) RunAll() OUT = { zombie = CVARS.bot_zombie, changes = CHANGES }`)
    expect(r.out.zombie).toBe('0') // the scenario set it; there was nothing to put back
  })
})

describe('the bots walk', () => {
  const setup = `Cmd({ "4", "60" }) Advance(3) BOT = BOTS[2]`

  test('a living bot is told to move forward, looking in one direction, and a dead bot, a human and a non-bot are left alone', () => {
    const r = play(`${setup}
      local c = NewCmd() Fire("StartCommand", BOT, c)
      local dead = BOTS[3] dead.alive = false
      local cd = NewCmd() Fire("StartCommand", dead, cd)
      local human = { IsBot = function() return false end, IsTerror = function() return true end }
      local ch = NewCmd() Fire("StartCommand", human, ch)
      OUT = { forward = c.forward, yawSet = c.yaw ~= nil, dead = cd.forward, human = ch.forward }
    `)
    expect(r.out).toEqual({ forward: 450, yawSet: true, dead: 0, human: 0 })
  })

  test('a bot keeps its heading for a while, then turns; it turns away at once when it is stuck', () => {
    const r = play(`${setup}
      local function yaw() local c = NewCmd() Fire("StartCommand", BOT, c) return c.yaw end
      local first = yaw()
      NOW = NOW + 1 local same = yaw()                -- a second later: still going the same way
      NOW = NOW + 5 local later = yaw()               -- after the longest stretch (4 s): turned
      BOT.speed = 0                                     -- now it stands against a wall
      NOW = NOW + 0.1 local stuck1 = yaw()
      NOW = NOW + 1 local stuck2 = yaw()                -- stuck for over 0.6 s: it turns
      OUT = { same = same == first, turned = later ~= first, stuckTurn = stuck2 ~= stuck1 }
    `)
    expect(r.out).toEqual({ same: true, turned: true, stuckTurn: true })
  })

  test('over time the bots jump now and then and the headings are spread (not all the same)', () => {
    const r = play(`${setup}
      local jumps, yaws = 0, {}
      for step = 1, 300 do
        NOW = NOW + 0.1
        for _, b in ipairs(BOTS) do local c = NewCmd() Fire("StartCommand", b, c) if c.buttons == IN_JUMP then jumps = jumps + 1 end yaws[math.floor(c.yaw / 90)] = true end
      end
      local n = 0 for _ in pairs(yaws) do n = n + 1 end
      OUT = { jumped = jumps > 0, quadrants = n }
    `)
    expect(r.out.jumped).toBe(true)
    expect(r.out.quadrants).toBeGreaterThanOrEqual(3)
  })

  test('an error in the movement is printed once and the hook is dropped, the scenario goes on', () => {
    const r = play(`${setup}
      BOT.IsTerror = function() error("no") end
      Fire("StartCommand", BOT, NewCmd())
      OUT = { hooks = HookCount("StartCommand") }
      Advance(1)
    `)
    expect(r.out.hooks).toBe(0)
    expect(r.printed.filter(l => l.includes('movement error'))).toHaveLength(1)
  })
})
