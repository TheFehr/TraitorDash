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

import { createHash } from 'node:crypto'
// util.SHA256 as GMod has it: a string in, lowercase hex out.
function addSha256(L: any) {
  lua.lua_pushjsfunction(L, (st: any) => {
    const input = to_jsstring(lauxlib.luaL_checklstring(st, 1))
    lua.lua_pushstring(st, to_luastring(createHash('sha256').update(input).digest('hex')))
    return 1
  })
  lua.lua_setglobal(L, to_luastring('JS_SHA256'))
}

const PRELUDE = `
  FCVAR_ARCHIVE, FCVAR_PROTECTED = 1, 2
  isnumber = function(v) return type(v) == "number" end
  isstring = function(v) return type(v) == "string" end
  istable = function(v) return type(v) == "table" end
  IsValid = function(v) return v ~= nil and v ~= false end
  include = function() end -- commands.lua is loaded by the harness before the bridge
  APPLIED, SENT, SET = {}, {}, {}
  REAL_CVARS = { ttt_known = "1", ttt2_other = "2", rcon_password = "secret", sv_password = "pw", ttt_survivalist_pct = "0.15" }
  local CV = { traitordash_url = 'https://td.test/"', traitordash_token = "tok" }
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
  util = { TableToJSON = function(t) LAST_PAYLOAD = t return "{}" end, JSONToTable = function() return JSON_NEXT end, MD5 = function() return "x" end, SHA256 = JS_SHA256 }
  SysTime = os.clock
  function HTTP(req) req.nonce = LAST_PAYLOAD and LAST_PAYLOAD.nonce SENT[#SENT + 1] = req end
  -- The backend's answer to request i, signed the way the backend signs it.
  function OK(i, body) SENT[i].success(200, body, { ["x-traitordash-signature"] = TraitorDash.ExpectedSignature("tok", SENT[i].nonce, body, util.SHA256) }) end
  SetGlobalBool, SetGlobalInt, SetGlobalString = function() end, function() end, function() end
`

/** Runs `script` after loading the files and returns what was applied to the console, and which ConVars were SetString'd. */
function run(script: string): { applied: string[], set: string[] } {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L); addSha256(L)
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
  OK(1, "ignored")`
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
      TraitorDash.Poll() OK(1, "ignored")`).set
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
    expect(applied).toEqual(['https://td.test/api/v1/poll Bearer tok'])
  })

  test('a failing or malformed response never throws', () => {
    expect(run(`JSON_NEXT = nil TraitorDash.Poll() OK(1, "garbage") SENT[1].success(500, "") SENT[1].failed("timeout")`).applied).toEqual([])
  })

  test('ReportRole chunks at 400 ConVars per request', () => {
    const { applied } = run(`
      local schema = {}
      for i = 1, 450 do schema[i] = { args = { convar = "ttt_x_" .. i } } end
      TraitorDash.ReportRole("survivalist", schema)
      APPLIED[1] = #SENT .. ":" .. SENT[1].url`)
    expect(applied).toEqual(['2:https://td.test/api/v1/values'])
  })
})

describe('acknowledging commands', () => {
  // Reads what the bridge says it has acked in its n-th poll.
  const ackedIn = (script: string) => {
    const L = lauxlib.luaL_newstate()
    lualib.luaL_openlibs(L); addSha256(L)
    const go = (c: string) => {
      if (lauxlib.luaL_dostring(L, to_luastring(c)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
    }
    try {
      go(PRELUDE); go(COMMANDS); go(BRIDGE); go(script)
      go('OUT = table.concat(LAST_PAYLOAD.acked, ",")')
      lua.lua_getglobal(L, to_luastring('OUT'))
      return to_jsstring(lua.lua_tostring(L, -1))
    } finally { lua.lua_close(L) }
  }
  const cmds = '{ { id = 7, type = "convar", payload = "ttt_known 5" }, { id = 8, type = "convar", payload = "rcon_password x" } }'

  test('applied and refused commands are acknowledged on the next poll', () => {
    expect(ackedIn(`${poll(cmds)} JSON_NEXT = { commands = {} } TraitorDash.Poll()`)).toBe('7,8')
  })

  test('an acknowledgement is not repeated once the backend answered', () => {
    expect(ackedIn(`${poll(cmds)} JSON_NEXT = { commands = {} } TraitorDash.Poll() OK(2, "") TraitorDash.Poll()`)).toBe('')
  })

  test('a poll that failed keeps the acknowledgements for the next one', () => {
    expect(ackedIn(`${poll(cmds)} TraitorDash.Poll() SENT[2].failed("x") TraitorDash.Poll()`)).toBe('7,8')
  })
})

describe('transport', () => {
  const check = (url: string) => {
    const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L); addSha256(L)
    try {
      for (const c of [PRELUDE, COMMANDS, `R = TraitorDash.IsTrustedTransport(${JSON.stringify(url)})`]) {
        if (lauxlib.luaL_dostring(L, to_luastring(c)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
      }
      lua.lua_getglobal(L, to_luastring('R'))
      return lua.lua_toboolean(L, -1)
    } finally { lua.lua_close(L) }
  }

  test('https and local or private http are trusted', () => {
    for (const u of ['https://td.example', 'HTTPS://td.example/x', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.1.2.3', 'http://192.168.1.5:3000', 'http://172.16.0.1', 'http://172.31.255.1'])
      expect([u, check(u)]).toEqual([u, true])
  })

  test('plain http to anything else, and junk, is not', () => {
    for (const u of ['http://td.example', 'http://8.8.8.8', 'http://172.32.0.1', 'http://172.15.0.1', 'http://10.evil.com', 'ftp://x', '', 'td.example'])
      expect([u, check(u)]).toEqual([u, false])
  })

  test('the poller does nothing over untrusted http', () => {
    expect(run('SetCv("traitordash_url", "http://td.example") TraitorDash.Poll() APPLIED[1] = "sent:" .. #SENT').applied).toEqual(['sent:0'])
  })
})

describe('signed poll answers', () => {
  const applied = (script: string) => run(script).applied
  const cmd = 'JSON_NEXT = { commands = { { id = 1, type = "convar", payload = "ttt_known 5" } } } TraitorDash.Poll()'

  test('an answer signed for this poll is applied', () => {
    expect(applied(`${cmd} OK(1, "body")`)).toEqual(['ttt_known=5'])
  })

  test('an unsigned answer applies nothing and acknowledges nothing', () => {
    expect(applied(`${cmd} SENT[1].success(200, "body", {})`)).toEqual([])
    expect(applied(`${cmd} SENT[1].success(200, "body")`)).toEqual([])
  })

  test('a signature from another token, another body or another poll is refused', () => {
    const bad = (sig: string) => applied(`${cmd} SENT[1].success(200, "body", { ["X-TraitorDash-Signature"] = ${sig} })`)
    expect(bad('TraitorDash.ExpectedSignature("other", SENT[1].nonce, "body", util.SHA256)')).toEqual([])
    expect(bad('TraitorDash.ExpectedSignature("tok", SENT[1].nonce, "tampered", util.SHA256)')).toEqual([])
    expect(bad('TraitorDash.ExpectedSignature("tok", "an-older-nonce", "body", util.SHA256)')).toEqual([])
    expect(bad('""')).toEqual([])
  })

  test('the header name is found whatever its case', () => {
    expect(applied(`${cmd} local sig = TraitorDash.ExpectedSignature("tok", SENT[1].nonce, "b", util.SHA256) SENT[1].success(200, "b", { ["X-TRAITORDASH-SIGNATURE"] = sig })`)).toEqual(['ttt_known=5'])
  })

  test('a refused answer is reported with details, and a recovery is announced', () => {
    const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L); addSha256(L)
    const out: string[] = []
    lua.lua_pushjsfunction(L, (st: any) => { out.push(to_jsstring(lauxlib.luaL_checklstring(st, 1))); return 0 })
    lua.lua_setglobal(L, to_luastring('print'))
    try {
      for (const c of [PRELUDE, COMMANDS, BRIDGE, `${cmd} SENT[1].success(200, "body", { ["x-other"] = "1" }) TraitorDash.Poll() OK(2, "ok")`]) {
        if (lauxlib.luaL_dostring(L, to_luastring(c)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
      }
    } finally { lua.lua_close(L) }
    const warn = out.find(l => l.includes('without a valid signature'))!
    expect(warn).toContain('header=MISSING')
    expect(warn).toContain('headers: x-other')
    expect(out.some(l => l.includes('signed correctly again'))).toBe(true)
  })

  test('every poll uses a new nonce', () => {
    expect(applied('TraitorDash.Poll() TraitorDash.Poll() APPLIED[1] = tostring(SENT[1].nonce ~= SENT[2].nonce) .. ":" .. #SENT[1].nonce')).toEqual(['true:32'])
  })
})
