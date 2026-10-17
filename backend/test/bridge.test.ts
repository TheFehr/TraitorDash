import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// Runs the real addon/lua/traitordash/{commands,bridge}.lua against a minimal fake of GMod.
// GMod's `continue` is not Lua 5.3, so it is neutralised for loading (only Sync uses it, and
// these tests never call Sync).
const dir = path.join(import.meta.dir, '../../addon/lua/traitordash')
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
const COMMANDS = read('commands.lua')
const BRIDGE = read('bridge.lua').replace(/\bcontinue\b/g, 'error("continue")')

const PRELUDE = `
  FCVAR_ARCHIVE, FCVAR_PROTECTED = 1, 2
  isstring = function(v) return type(v) == "string" end
  istable = function(v) return type(v) == "table" end
  IsValid = function(v) return v ~= nil and v ~= false end
  include = function() end -- commands.lua is loaded by the harness before the bridge
  APPLIED, SENT, SET = {}, {}, {}
  REAL_CVARS = { ttt_known = "1", ttt2_other = "2", rcon_password = "secret", sv_password = "pw", ttt_survivalist_pct = "0.15" }
  local CV = { traitordash_url = 'http://td.test/"', traitordash_token = "tok" }
  function CreateConVar(n, v) if CV[n] == nil then CV[n] = tostring(v) end return { GetString = function() return CV[n] end } end
  function SetCv(n, v) CV[n] = v end
  function GetConVar(n)
    if CV[n] == nil and REAL_CVARS[n] == nil then return nil end
    return { GetString = function() return CV[n] or REAL_CVARS[n] end, GetName = function() return n end,
             GetDefault = function() return "0" end, GetMin = function() return 0 end, GetMax = function() return 1 end,
             SetString = function(_, v) SET[#SET + 1] = n .. "=" .. v end }
  end
  cvars = { AddChangeCallback = function() end }
  game = { ConsoleCommand = function(s) APPLIED[#APPLIED + 1] = "RAW:" .. s end } -- must never be used any more
  RunConsoleCommand = function(n, v) APPLIED[#APPLIED + 1] = n .. "=" .. tostring(v) end
  hook = { Add = function() end }
  timer = { Create = function() end, Simple = function() end, Exists = function() return false end }
  concommand = { Add = function() end }  player = { GetAll = function() return {} end }
  RealTime = os.clock
  string.Explode = function(sep, s) local o = {} for p in (s .. sep):gmatch("(.-)" .. sep:gsub("%p", "%%%0")) do o[#o + 1] = p end return o end
  util = { TableToJSON = function() return "{}" end, JSONToTable = function() return JSON_NEXT end, MD5 = function() return "x" end }
  function HTTP(req) SENT[#SENT + 1] = req end
  SetGlobalBool, SetGlobalInt, SetGlobalString = function() end, function() end, function() end
`

/** Runs `script` after loading the files and returns what was applied to the console, and which ConVars were SetString'd. */
function run(script: string): { applied: string[], set: string[] } {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const go = (c: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(c)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    go(PRELUDE); go(COMMANDS); go(BRIDGE); go(script)
    go('OUT = table.concat(APPLIED, "|") .. "#" .. table.concat(SET, "|")')
    lua.lua_getglobal(L, to_luastring('OUT'))
    const [applied = '', set = ''] = to_jsstring(lua.lua_tostring(L, -1)).split('#')
    return { applied: applied ? applied.split('|') : [], set: set ? set.split('|') : [] }
  } finally {
    lua.lua_close(L)
  }
}

// Fake network response: Poll() queues the request, the test then calls success() itself.
const poll = (commands: string) => `
  JSON_NEXT = { commands = ${commands} }
  TraitorDash.Poll()
  SENT[1].success(200, "ignored")`
const convar = (payload: string) => run(poll(`{ { type = "convar", payload = ${JSON.stringify(payload)} } }`)).applied

describe('commands the bridge applies', () => {
  test('a normal ConVar change is applied as ONE console command', () => {
    expect(convar('ttt_known 5')).toEqual(['ttt_known=5'])
    expect(convar('ttt2_other 0.25')).toEqual(['ttt2_other=0.25'])
  })

  test('a quoted value with spaces is applied as one value', () => {
    expect(convar('ttt_known "on off"')).toEqual(['ttt_known=on off'])
    expect(convar('ttt_known ""')).toEqual(['ttt_known='])
  })

  test('nothing is ever sent through the raw console string any more', () => {
    for (const a of convar('ttt_known 5')) expect(a.startsWith('RAW:')).toBe(false)
  })

  test('a ConVar that does not exist is refused', () => {
    expect(convar('ttt_nope 5')).toEqual([])
  })

  test('ConVars outside ttt_ / ttt2_ are refused even when they exist', () => {
    expect(convar('rcon_password hunter2')).toEqual([])
    expect(convar('sv_password pw')).toEqual([])
  })

  test('chained or injected payloads are refused outright, never partially applied', () => {
    for (const evil of [
      'ttt_known 1;quit',
      'ttt_known 1\nquit',
      'ttt_known 1\r\nquit',
      'ttt_known "1";quit',
      'ttt_known 1 ; rcon_password x',
      'ttt_known "1\nquit"',
      'ttt_known 1 2',
      'ttt_known',
      ' ttt_known 1',
      'ttt_known 1 // comment',
      'ttt_known $(id)',
      'ttt_known ' + 'a'.repeat(300),
    ]) {
      expect(convar(evil)).toEqual([])
    }
  })

  test('a non-string payload and a nil payload are refused without breaking the next command', () => {
    const { applied } = run(poll(`{ { type = "convar", payload = 5 }, { type = "convar", payload = nil }, { type = "convar", payload = "ttt_known 2" } }`))
    expect(applied).toEqual(['ttt_known=2'])
  })

  test('if commands.lua failed to load, every command is refused (fail closed)', () => {
    const { applied } = run(`TraitorDash.ParseConVarCommand = nil ${poll('{ { type = "convar", payload = "ttt_known 5" } }')}`)
    expect(applied).toEqual([])
  })
})

describe('data updates', () => {
  const data = (p: string) => run(poll(`{ { type = "data", payload = ${JSON.stringify(p)} } }`)).set
  const json = (v: unknown) => { return JSON.stringify(v) }

  test('only ttt_/ttt2_ ConVars are written, and only for plain identifier keys', () => {
    const run1 = (key: string) => run(`JSON_NEXT = { commands = { { type = "data", payload = { key = ${JSON.stringify(key)}, value = "x", dataType = "string" } } } }
      TraitorDash.Poll() SENT[1].success(200, "ignored")`).set
    expect(run1('ttt_known')).toEqual(['ttt_known=x'])
    expect(run1('rcon_password')).toEqual([])
    expect(run1('sv_password')).toEqual([])
    expect(run1('ttt_known; quit')).toEqual([])
    expect(run1('ttt_known\nquit')).toEqual([])
    expect(data(json({ key: 'rcon_password', value: 'x' }))).toEqual([])
  })
})

describe('the API token', () => {
  test('there is no built-in default: with no token the bridge sends nothing', () => {
    const { applied } = run(`
      SetCv("traitordash_token", "")
      TraitorDash.Poll()
      APPLIED[1] = "requests:" .. #SENT`)
    expect(applied).toEqual(['requests:0'])
  })

  test('the shipped default is empty, not a shared dev token', () => {
    expect(BRIDGE).not.toContain('dev-token')
    expect(/CreateConVar\("traitordash_token", ""/.test(BRIDGE)).toBe(true)
  })
})

describe('the rest of the bridge still works', () => {
  test('poll URL is cleaned and the token is sent as a Bearer header', () => {
    const { applied } = run(`TraitorDash.Poll() APPLIED[1] = SENT[1].url .. " " .. SENT[1].headers.Authorization`)
    expect(applied).toEqual(['http://td.test/api/v1/poll Bearer tok'])
  })

  test('a failing or malformed response never throws', () => {
    expect(run(`JSON_NEXT = nil TraitorDash.Poll() SENT[1].success(200, "garbage") SENT[1].success(500, "") SENT[1].failed("timeout")`).applied).toEqual([])
  })

  test('ReportRole chunks at 400 ConVars per request', () => {
    const { applied } = run(`
      local schema = {}
      for i = 1, 450 do schema[i] = { args = { convar = "ttt_x_" .. i } } end
      TraitorDash.ReportRole("survivalist", schema)
      APPLIED[1] = #SENT .. ":" .. SENT[1].url`)
    expect(applied).toEqual(['2:http://td.test/api/v1/values'])
  })
})
