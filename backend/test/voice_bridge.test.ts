import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { addJsonDecode } from './helpers/bridge_harness'
import { parseVoiceState } from '../src/services/voice'

// RFC 27: runs the real addon/lua/traitordash/voice.lua against a fake of GMod/TTT with a clock the test controls, and checks
// what it sends: the round's phase and the WHOLE list of the living, on every change and every few seconds besides, and that
// a death and a revival each change the list (the case that matters: a revived player must not stay muted).
const DIR = path.join(import.meta.dir, '../../addon/lua/traitordash')
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

const PRELUDE = `
  FCVAR_ARCHIVE = 128
  IsValid = function(v) return v ~= nil and v ~= false end
  local cvars = {}
  local callbacks = {}
  function CreateConVar(n, v)
    if cvars[n] == nil then cvars[n] = tostring(v) end
    return { GetBool = function() return cvars[n] == "1" end }
  end
  CVARS = cvars
  _G.cvars = { AddChangeCallback = function(n, fn) callbacks[n] = fn end }
  function SetCv(n, v) local old = CVARS[n] CVARS[n] = v if callbacks[n] then callbacks[n](n, old, v) end end
  MAP = "ttt_test_map"
  game = { GetMap = function() return MAP end }
  concommand = { Add = function() end }
  NOW = 100
  function CurTime() return NOW end

  local hooks = {}
  hook = { Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end }
  function Fire(ev, ...) for _, fn in pairs(hooks[ev] or {}) do fn(...) end end

  TIMERS = {}
  SIMPLE = {}
  timer = {
    Create = function(n, d, r, fn) TIMERS[n] = { delay = d, fn = fn } end,
    Exists = function(n) return TIMERS[n] ~= nil end,
    Remove = function(n) TIMERS[n] = nil end,
    Simple = function(d, fn) SIMPLE[#SIMPLE + 1] = fn end,
  }
  function Flush() local q = SIMPLE SIMPLE = {} for _, fn in ipairs(q) do fn() end end
  -- Lets the clock run: each step is the timer's delay, then the timer runs, as the engine would.
  function Run(n)
    for i = 1, n do
      local t = TIMERS.TraitorDash_VoiceState
      if not t then return end
      NOW = NOW + t.delay
      t.fn()
    end
  end

  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end

  local function enc(v)
    local t = type(v)
    if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
    if t == "number" then return tostring(v) end
    if t == "boolean" then return tostring(v) end
    if t == "table" then
      if #v > 0 or next(v) == nil then
        local out = {} for i, x in ipairs(v) do out[i] = enc(x) end
        return "[" .. table.concat(out, ",") .. "]"
      end
      local out = {} for k, x in pairs(v) do out[#out + 1] = enc(tostring(k)) .. ":" .. enc(x) end
      return "{" .. table.concat(out, ",") .. "}"
    end
    return "null"
  end
  ENC = enc
  util = { TableToJSON = enc }
  SENT = {}
  function HTTP(req) SENT[#SENT + 1] = req end
  CONFIG = { url = "https://td.test", token = "tok" }
  TraitorDash = { GetConfig = function() return CONFIG end }

  local function mkply(sid, bot)
    local p = { sid = sid, alive = true, bot = bot }
    function p:IsBot() return self.bot end
    function p:IsTerror() if self.boom then error("IsTerror failed") end return self.alive end
    function p:SteamID64() return self.sid end
    return p
  end
  A = mkply("76561198000000001"); B = mkply("76561198000000002"); C = mkply("76561198000000003")
  BOT = mkply("0", true)
  SPEC = mkply("76561198000000009"); SPEC.alive = false
  PLAYERS = { C, A, B, BOT, SPEC }
  player = { GetAll = function() return PLAYERS end }
`

interface Msg { url: string, auth: string, body: any }
function play(script: string, opts: { on?: boolean, load?: boolean } = {}) {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  addJsonDecode(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    if (opts.on !== false) run('CVARS.traitordash_voice = "1"')
    run(read('voice.lua'))
    run(script)
    run(`
      local o = {}
      for i, s in ipairs(SENT) do o[i] = '{"url":"' .. s.url .. '","auth":"' .. s.headers.Authorization .. '","body":' .. s.body .. "}" end
      SENT_JSON = "[" .. table.concat(o, ",") .. "]"
      PRINTED_JSON = ENC(PRINTED)
      OUT_JSON = OUT ~= nil and ENC(OUT) or "null"
    `)
    const get = (n: string) => { lua.lua_getglobal(L, to_luastring(n)); return to_jsstring(lua.lua_tostring(L, -1)) }
    return { sent: JSON.parse(get('SENT_JSON')) as Msg[], printed: JSON.parse(get('PRINTED_JSON')) as string[], out: JSON.parse(get('OUT_JSON')) }
  } finally {
    lua.lua_close(L)
  }
}

const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003'

describe('voice.lua', () => {
  test('is off by default: no timer, nothing sent', () => {
    const r = play('Run(20) Fire("TTTBeginRound") Flush() OUT = { timers = TIMERS.TraitorDash_VoiceState ~= nil }', { on: false })
    expect(r.sent).toEqual([])
    expect(r.out.timers).toBe(false)
  })

  test('sends the phase and the whole list of the living: people only, sorted, no bot and no spectator', () => {
    const r = play('Run(1)')
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]!.url).toBe('https://td.test/api/v1/voice')
    expect(r.sent[0]!.auth).toBe('Bearer tok')
    expect(r.sent[0]!.body).toMatchObject({ phase: 'over', alive: [A, B, C], seq: 1 })
    expect(typeof r.sent[0]!.body.boot).toBe('number')
    expect(Object.keys(r.sent[0]!.body).sort()).toEqual(['alive', 'boot', 'phase', 'seq']) // nothing else: no role, team or position
    expect(parseVoiceState(r.sent[0]!.body)).not.toBeTypeOf('string')
  })

  test('says nothing new until something changes, and the same again every five seconds', () => {
    const r = play('Run(8)') // 8 looks of half a second: 4 seconds
    expect(r.sent).toHaveLength(1)
    const r2 = play('Run(12)') // 6 seconds
    expect(r2.sent).toHaveLength(2)
    expect(r2.sent.map(m => m.body.seq)).toEqual([1, 2])
    expect(r2.sent[1]!.body.alive).toEqual([A, B, C])
  })

  test('a death, a revival and a second death each change the list, and the list is whole every time', () => {
    const r = play(`
      Run(1)
      B.alive = false; Run(1)          -- B dies
      B.alive = true; Run(1)           -- B is revived: alive again
      B.alive = false; Run(1)          -- and dies again
    `)
    expect(r.sent.map(m => m.body.alive)).toEqual([[A, B, C], [A, C], [A, B, C], [A, C]])
    expect(r.sent.map(m => m.body.seq)).toEqual([1, 2, 3, 4])
  })

  test('a revival is sent at once by the game\'s own events, not at the next look', () => {
    const r = play(`
      Run(1)
      B.alive = false; Run(1)
      B.alive = true; Fire("TTT2AddedEvent"); Flush()
    `)
    expect(r.sent.map(m => m.body.alive)).toEqual([[A, B, C], [A, C], [A, B, C]])
  })

  test('the phase follows TTT\'s round state when it can be asked, else the round hooks', () => {
    const hooks = play(`
      Run(1)
      Fire("TTTPrepareRound"); Flush()
      Fire("TTTBeginRound"); Flush()
      Fire("TTTEndRound"); Flush()
    `)
    expect(hooks.sent.map(m => m.body.phase)).toEqual(['over', 'prep', 'active', 'over'])
    const state = play(`
      ROUND_WAIT, ROUND_PREP, ROUND_ACTIVE, ROUND_POST = 1, 2, 3, 4
      STATE = ROUND_WAIT
      function GetRoundState() return STATE end
      Run(1)
      STATE = ROUND_PREP; Run(1)
      STATE = ROUND_ACTIVE; Run(1)
      STATE = ROUND_POST; Run(1)
    `)
    expect(state.sent.map(m => m.body.phase)).toEqual(['prep', 'active', 'over']) // waiting and preparing are both "prep": one message
  })

  test('the same message twice from two hooks sends once', () => {
    const r = play('Run(1) B.alive = false; Fire("PlayerSpawn"); Fire("TTT2PostPlayerDeath"); Flush()')
    expect(r.sent.map(m => m.body.alive)).toEqual([[A, B, C], [A, C]])
  })

  test('switching it off removes the timer; on again starts it and sends at once', () => {
    const r = play(`
      Run(1)
      SetCv("traitordash_voice", "0"); local off = TIMERS.TraitorDash_VoiceState == nil
      SetCv("traitordash_voice", "1"); Run(1)
      OUT = { off = off, on = TIMERS.TraitorDash_VoiceState ~= nil }
    `)
    expect(r.out).toEqual({ off: true, on: true })
    expect(r.sent).toHaveLength(2)
  })

  test('without a URL or token nothing is sent; a 404 stops it on that map', () => {
    expect(play('CONFIG = { url = nil, token = "" } Run(2)').sent).toEqual([])
    const r = play(`
      Run(1)
      SENT[1].success(404, "")
      B.alive = false; Run(1)
      OUT = { n = #SENT }
    `)
    expect(r.out.n).toBe(1)
    expect(r.printed.some(l => l.includes('no voice endpoint'))).toBe(true)
  })

  test('a failing call is logged, never thrown, and the next look tries again', () => {
    const r = play('A.boom = true; Run(1) A.boom = nil; Run(1)')
    expect(r.printed.some(l => l.includes('error') && l.includes('IsTerror failed'))).toBe(true)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]!.body.alive).toEqual([A, B, C])
  })

  test('a failed send is dropped: the connection error changes nothing', () => {
    const r = play('Run(1) SENT[1].failed("down") B.alive = false; Run(1)')
    expect(r.sent.map(m => m.body.alive)).toEqual([[A, B, C], [A, C]])
  })
})
