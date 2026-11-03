import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// The role trace (RFC 14, section 10): addon/lua/traitordash/roletrace.lua against a minimal fake of GMod. It must
// write nothing and hook nothing until switched on, follow only players who have died, name the code that changed a
// role, and never return a value from a hook (that could block the game's own work).
const FILE = path.join(import.meta.dir, '../../addon/lua/traitordash/roletrace.lua')

const PRELUDE = `
  SERVER = true
  IsValid = function(v) return v ~= nil and v ~= false end
  game = { GetMap = function() return "ttt_minecraft_b7_summer" end }
  NOW = 10
  function CurTime() return NOW end
  local P = {}
  P.__index = P
  function P:Nick() return self.nick end
  function P:UserID() return self.uid end
  function P:GetRoleString() return self.role end
  function P:GetTeam() return self.team end
  function P:Alive() return self.alive end
  function P:IsSuperAdmin() return self.admin == true end
  function Ply(uid, nick, role, team) return setmetatable({ uid = uid, nick = nick, role = role, team = team, alive = true }, P) end
  PLAYERS = {}
  CORPSE = { GetPlayer = function(r) for _, p in ipairs(PLAYERS) do if r == "ragdoll-" .. string.lower(p.nick:sub(1, 1)) then return p end end end }
  player = { GetAll = function() return PLAYERS end }
  HOOKS = {}
  hook = {
    Add = function(ev, id, fn) HOOKS[ev] = HOOKS[ev] or {} HOOKS[ev][id] = fn end,
    Remove = function(ev, id) if HOOKS[ev] then HOOKS[ev][id] = nil end end,
  }
  function Fire(ev, ...)
    local n = 0
    for _, fn in pairs(HOOKS[ev] or {}) do n = n + table.pack(fn(...)).n end
    return n
  end
  function Hooked() local n = 0 for _, t in pairs(HOOKS) do for _ in pairs(t) do n = n + 1 end end return n end
  PRINTED = {}
  print = function(...) PRINTED[#PRINTED + 1] = table.concat({ ... }, " ") end
  DATA = {}
  file = {
    Read = function(p) return DATA[p] end,
    Write = function(p, c) DATA[p] = c end,
    Append = function(p, c) DATA[p] = (DATA[p] or "") .. c end,
    Delete = function(p) DATA[p] = nil end,
    Size = function(p) return #(DATA[p] or "") end,
  }
  COMMAND = nil
  concommand = { Add = function(n, fn) COMMAND = fn end }
  function Cmd(who, ...) COMMAND(who, "traitordash_role_trace", { ... }) end
`

function play(script: string, before = ''): { out: any } {
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
    const get = (code: string) => {
      run('OUT_V = ' + code)
      lua.lua_getglobal(L, to_luastring('OUT_V'))
      return to_jsstring(lua.lua_tostring(L, -1))
    }
    return {
      out: {
        trace: get('DATA["traitordash_role_trace.txt"] or ""'),
        hooked: Number(get('tostring(Hooked())')),
        printed: get('table.concat(PRINTED, "\\n")'),
        returned: Number(get('tostring(returned)')),
        switch: get('tostring(DATA["traitordash_role_trace_on.txt"] ~= nil)') === 'true',
      },
    }
  } finally {
    lua.lua_close(L)
  }
}

describe('roletrace.lua', () => {
  test('hooks nothing and writes nothing until switched on', () => {
    const r = play(`Fire("PlayerDeath", Ply(1, "A", "innocent", "innocents"))`)
    expect(r.out.hooked).toBe(0)
    expect(r.out.trace).toBe('')
  })

  test('only a superadmin or the console can switch it', () => {
    const r = play(`Cmd(Ply(1, "A", "innocent", "innocents"), "on")`)
    expect(r.out.hooked).toBe(0)
    expect(r.out.switch).toBe(false)
  })

  test('on and off hook and unhook everything and keep the switch across a restart', () => {
    const on = play(`Cmd(nil, "on")`)
    expect(on.out.hooked).toBeGreaterThan(0)
    expect(on.out.switch).toBe(true)
    const restarted = play('', `DATA["traitordash_role_trace_on.txt"] = "1"`)
    expect(restarted.out.hooked).toBe(on.out.hooked)
    const off = play(`Cmd(nil, "on") Cmd(nil, "off")`)
    expect(off.out.hooked).toBe(0)
    expect(off.out.switch).toBe(false)
  })

  test('follows a player after the death: spawn, defibrillator, role changes with the stack, the end', () => {
    const r = play(`
      Cmd(nil, "on")
      local a = Ply(1, "Alice", "innocent", "innocents")
      local necro = Ply(2, "Necro", "necromancer", "necromancers")
      local bystander = Ply(3, "Bob", "innocent", "innocents")
      PLAYERS = { a, necro, bystander }
      Fire("TTTPrepareRound")
      Fire("TTT2UpdateSubrole", bystander, 1, 2)
      Fire("PlayerDeath", a)
      Fire("TTT2AttemptDefibPlayer", necro, "ragdoll-a", { GetClass = function() return "weapon_ttt_necro_defi" end })
      NOW = 12
      Fire("PlayerSpawn", a)
      function AddZombie(p) a.role = "zombie" Fire("TTT2UpdateSubrole", p, 1, 9) end
      AddZombie(a)
      Fire("TTT2UpdateTeam", a, "innocents", "necromancers")
      Fire("TTTEndRound")
    `)
    const t = r.out.trace
    expect(t).toContain('DEATH Alice role=innocent team=innocents')
    expect(t).toContain('DEFIB by Necro with weapon_ttt_necro_defi at Alice role=innocent')
    expect(t).toContain('SPAWN Alice')
    expect(t).toContain('SUBROLE Alice 1 -> 9 (now zombie)')
    expect(t).toContain('AddZombie')               // the stack names the function that made the change
    expect(t).toContain('TEAM Alice innocents -> necromancers')
    expect(t).toContain('END Alice role=zombie team=innocents alive=true')
    expect(t).not.toContain('Bob')                 // never died, not followed
  })

  test('a role reset at the start of a round is one short line, not a stack', () => {
    const r = play(`
      Cmd(nil, "on")
      local a = Ply(1, "Alice", "innocent", "innocents")
      Fire("PlayerDeath", a)
      function ResetAllPlayers() Fire("TTT2UpdateSubrole", a, 0, 3) end
      ResetAllPlayers()
    `)
    expect(r.out.trace).toContain('SUBROLE Alice 0 -> 3 (now innocent)\n    (the role reset at the start of a round)')
  })

  test('a revived player who stays what they were shows no change after the spawn', () => {
    const r = play(`
      Cmd(nil, "on")
      local a = Ply(1, "Alice", "innocent", "innocents")
      PLAYERS = { a }
      Fire("TTTPrepareRound")
      Fire("PlayerDeath", a)
      Fire("PlayerSpawn", a)
      Fire("TTTEndRound")
    `)
    expect(r.out.trace).toContain('SPAWN Alice role=innocent')
    expect(r.out.trace).not.toContain('SUBROLE')
    expect(r.out.trace).toContain('END Alice role=innocent')
  })

  test('a new round forgets who died', () => {
    const r = play(`
      Cmd(nil, "on")
      local a = Ply(1, "Alice", "innocent", "innocents")
      Fire("PlayerDeath", a)
      Fire("TTTPrepareRound")
      Fire("PlayerSpawn", a)
    `)
    expect(r.out.trace).not.toContain('SPAWN')
  })

  test('no hook returns a value, and an error in one does not escape', () => {
    const r = play(`
      Cmd(nil, "on")
      local a = Ply(1, "Alice", "innocent", "innocents")
      PLAYERS = { a }
      OUT_N = 0
      for _, ev in ipairs({ "TTTPrepareRound", "PlayerDeath", "PlayerSpawn", "TTT2UpdateSubrole", "TTT2UpdateTeam", "TTT2AttemptDefibPlayer", "TTTEndRound" }) do
        OUT_N = OUT_N + Fire(ev, a, a, a)
      end
      player = nil
      Fire("PlayerDeath", a)
      OUT_N = OUT_N + Fire("TTTEndRound")
      returned = OUT_N
    `)
    expect(r.out.printed).toContain('error')
    expect(r.out.returned).toBe(0)
  })

  test('stops growing at the size cap', () => {
    const r = play(`
      Cmd(nil, "on")
      DATA["traitordash_role_trace.txt"] = string.rep("x", 512 * 1024 + 1)
      Fire("PlayerDeath", Ply(1, "Alice", "innocent", "innocents"))
    `)
    expect(r.out.trace.length).toBe(512 * 1024 + 1)
  })
})
