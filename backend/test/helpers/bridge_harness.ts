import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// Shared by the bridge and config tests. Runs the real addon/lua/traitordash/{commands,config,bridge}.lua against a minimal fake of GMod.
// The bridge avoids GMod's `continue` (not Lua 5.3), so it loads unmodified.
const dir = path.join(import.meta.dir, '../../../addon/lua/traitordash')
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
export const COMMANDS = read('commands.lua')
// config.lua is loaded between commands.lua and the bridge, as bridge.lua includes it.
export const CONFIG = fs.existsSync(path.join(dir, 'config.lua')) ? read('config.lua') : ''
// pairing.lua (RFC 9) is loaded after config.lua, as bridge.lua includes it.
export const PAIRING = fs.existsSync(path.join(dir, 'pairing.lua')) ? read('pairing.lua') : ''
// mapscan.lua (map floor plan prototype) is loaded after pairing.lua, as bridge.lua includes it.
export const MAPSCAN = fs.existsSync(path.join(dir, 'mapscan.lua')) ? read('mapscan.lua') : ''
// maps.lua (map inventory prototype) is loaded after mapscan.lua, as bridge.lua includes it.
export const MAPS = fs.existsSync(path.join(dir, 'maps.lua')) ? read('maps.lua') : ''
// util.lua is what bridge.lua includes first; the harness loads it before everything else.
export const UTIL = read('util.lua')
export const BRIDGE = read('bridge.lua')

import { createHash } from 'node:crypto'
// util.SHA256 as GMod has it: a string in, lowercase hex out.
export function addSha256(L: any) {
  lua.lua_pushjsfunction(L, (st: any) => {
    const input = to_jsstring(lauxlib.luaL_checklstring(st, 1))
    lua.lua_pushstring(st, to_luastring(createHash('sha256').update(input).digest('hex')))
    return 1
  })
  lua.lua_setglobal(L, to_luastring('JS_SHA256'))
}


// util.JSONToTable as GMod has it: a table for valid JSON objects/arrays, nil for anything else.
export function addJsonDecode(L: any) {
  const push = (v: any): void => {
    if (v === null || v === undefined) lua.lua_pushnil(L)
    else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v))
    else if (typeof v === 'number') lua.lua_pushnumber(L, v)
    else if (typeof v === 'boolean') lua.lua_pushboolean(L, v)
    else if (Array.isArray(v)) {
      lua.lua_newtable(L)
      v.forEach((x, i) => { push(x); lua.lua_rawseti(L, -2, i + 1) })
    } else {
      lua.lua_newtable(L)
      for (const [k, x] of Object.entries(v)) { push(x); lua.lua_setfield(L, -2, to_luastring(k)) }
    }
  }
  lua.lua_pushjsfunction(L, (st: any) => {
    try {
      const parsed = JSON.parse(to_jsstring(lauxlib.luaL_checklstring(st, 1)))
      if (parsed === null || typeof parsed !== 'object') lua.lua_pushnil(L)
      else push(parsed)
    } catch { lua.lua_pushnil(L) }
    return 1
  })
  lua.lua_setglobal(L, to_luastring('JS_JSON_DECODE'))
}

export const PRELUDE = `
  FCVAR_ARCHIVE, FCVAR_PROTECTED = 1, 2
  isnumber = function(v) return type(v) == "number" end
  isstring = function(v) return type(v) == "string" end
  istable = function(v) return type(v) == "table" end
  IsValid = function(v) return v ~= nil and v ~= false end
  include = function() end -- commands.lua is loaded by the harness before the bridge
  APPLIED, SENT, SET = {}, {}, {}
  PRINTS = {}
  local realPrint = print
  print = function(...) local t = {} for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end PRINTS[#PRINTS + 1] = table.concat(t, " ") end
  REAL_CVARS = { sv_hibernate_think = "0", ttt_known = "1", ttt2_other = "2", rcon_password = "secret", sv_password = "pw", ttt_survivalist_pct = "0.15" }
  local CV = { traitordash_url = 'https://td.test/"', traitordash_token = "tok" }
  local DEF = {}
  function CreateConVar(n, v) DEF[n] = tostring(v) if CV[n] == nil then CV[n] = tostring(v) end return { GetString = function() return CV[n] end } end
  function SetCv(n, v) CV[n] = v end
  function GetConVar(n)
    if CV[n] == nil and REAL_CVARS[n] == nil then return nil end
    return { GetString = function() return CV[n] or REAL_CVARS[n] end, GetName = function() return n end,
             GetInt = function() return tonumber(CV[n] or REAL_CVARS[n]) end, GetDefault = function() return DEF[n] or "0" end, GetMin = function() return 0 end, GetMax = function() return 1 end,
             SetString = function(_, v) SET[#SET + 1] = n .. "=" .. v end }
  end
  cvars = { AddChangeCallback = function() end }
  game = { ConsoleCommand = function(s) APPLIED[#APPLIED + 1] = "RAW:" .. s end } -- must never be used any more
  RunConsoleCommand = function(n, v) APPLIED[#APPLIED + 1] = n .. "=" .. tostring(v) end
  HOOKS, TIMERS = {}, {}
  hook = { Add = function(ev, id, fn) HOOKS[#HOOKS + 1] = ev .. ":" .. id end, Remove = function() end }
  timer = { Create = function(id, secs, reps, fn) TIMERS[#TIMERS + 1] = "create " .. id .. " " .. secs .. " " .. reps end,
            Simple = function(secs, fn) TIMERS[#TIMERS + 1] = "simple " .. secs end, Exists = function() return false end }
  CONCMDS = {}
  concommand = { Add = function(n, fn) CONCMDS[n] = fn end }  player = { GetAll = function() return {} end }
  RealTime = os.clock
  string.Explode = function(sep, s) local o = {} for p in (s .. sep):gmatch("(.-)" .. sep:gsub("%p", "%%%0")) do o[#o + 1] = p end return o end
  util = { TableToJSON = function(t) LAST_PAYLOAD = t return "{}" end, JSONToTable = function() return JSON_NEXT end, MD5 = function() return "x" end, SHA256 = JS_SHA256 }
  SysTime = os.clock
  -- The server's data folder: DATA["traitordash/config.json"] = "<json text>". FILE_READS counts reads of it.
  DATA, FILE_READS = {}, 0
  -- WRITE_LIMIT (when set) is how many writes succeed; later ones are silently lost, as GMod does for a path it cannot write.
  WRITES, DIRS = 0, {}
  file = { Read = function(p, where) if where == "DATA" then FILE_READS = FILE_READS + 1 return DATA[p] end return nil end,
           Write = function(p, c)
             -- GMod only writes files with these extensions and silently drops the rest.
             local ext = tostring(p):match("%.(%w+)$")
             local OK_EXT = { txt = true, dat = true, json = true, xml = true, csv = true, jpg = true, jpeg = true, png = true, vtf = true, vmt = true, mp3 = true, wav = true, ogg = true }
             if not ext or not OK_EXT[ext:lower()] then return end
             WRITES = WRITES + 1 if WRITE_LIMIT and WRITES > WRITE_LIMIT then return end DATA[p] = c end,
           Exists = function(p, where) return where == "DATA" and DATA[p] ~= nil end,
           Delete = function(p) DATA[p] = nil end,
           CreateDir = function(d) DIRS[#DIRS + 1] = d end, Find = function() return {}, {} end }
  JSON_DECODE = JS_JSON_DECODE
  function HTTP(req) req.nonce = LAST_PAYLOAD and LAST_PAYLOAD.nonce SENT[#SENT + 1] = req end
  -- The backend's answer to request i, signed the way the backend signs it.
  function SIGNED(i, cj, key, nonce)
    return '{"commands":' .. cj .. ',"sig":"' .. TraitorDash.ExpectedSignature(key or "tok", nonce or SENT[i].nonce, cj, util.SHA256) .. '"}'
  end
  function OK(i, cj) SENT[i].success(200, SIGNED(i, cj or "[]")) end
  SetGlobalBool, SetGlobalInt, SetGlobalString = function() end, function() end, function() end
`

/** Runs `script` after loading the files and returns what was applied to the console, and which ConVars were SetString'd. */
export function run(script: string, before = ''): { applied: string[], set: string[], result: string } {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L); addSha256(L); addJsonDecode(L)
  const go = (c: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(c)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    go(PRELUDE); go(UTIL); go(before); go(COMMANDS); go(CONFIG); go(PAIRING); go(MAPSCAN); go(MAPS); go(BRIDGE); go(script)
    go('OUT = table.concat(APPLIED, "|") .. "#" .. table.concat(SET, "|")')
    lua.lua_getglobal(L, to_luastring('OUT'))
    const [applied = '', set = ''] = to_jsstring(lua.lua_tostring(L, -1)).split('#')
    lua.lua_getglobal(L, to_luastring('RESULT'))
    const result = lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1)) : ''
    return { applied: applied ? applied.split('|') : [], set: set ? set.split('|') : [], result }
  } finally {
    lua.lua_close(L)
  }
}

// Fake network response: Poll() queues the request, the test then calls success() itself.
export const poll = (commands: string) => `
  JSON_NEXT = { commands = ${commands} }
  TraitorDash.Poll()
  OK(1)`
export const convar = (payload: string) => run(poll(`{ { type = "convar", payload = ${JSON.stringify(payload)} } }`)).applied

