import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { addJsonDecode } from './helpers/bridge_harness'

// RFC 31: the `!voice` chat command of voice.lua, run against a fake of GMod with a clock the test controls: the line is hidden, nothing happens when
// traitordash_voice is off, the code goes to the one player who asked (and only when it has the shape of a code), a failure says one short thing,
// bots and fast repeats are ignored, and the request carries the server's token and the player's SteamID64.
const DIR = path.join(import.meta.dir, '../../addon/lua/traitordash')
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

const PRELUDE = `
  FCVAR_ARCHIVE = 128
  IsValid = function(v) return v ~= nil and v ~= false end
  CVARS = {}
  function CreateConVar(n, v) if CVARS[n] == nil then CVARS[n] = tostring(v) end return { GetBool = function() return CVARS[n] == "1" end } end
  NOW = 100
  function CurTime() return NOW end
  game = { GetMap = function() return "ttt_test" end }
  concommand = { Add = function() end }
  HOOKS = {}
  hook = { Add = function(ev, id, fn) HOOKS[ev] = HOOKS[ev] or {} HOOKS[ev][id] = fn end }
  function Say(ply, text) local r for _, fn in pairs(HOOKS.PlayerSay or {}) do r = fn(ply, text) if r ~= nil then return r end end return nil end
  timer = { Create = function() end, Exists = function() return false end, Remove = function() end, Simple = function() end }
  PRINTED = {}
  print = function(...) end
  util = { TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end }
  CALLS = {}
  REPLY = { code = 200, body = '{"success":true,"code":"K7F-3QX","ttl":300,"path":"/servers/srv-1/voice"}' }
  PENDING = nil
  HOLD = false
  function HTTP(req)
    CALLS[#CALLS + 1] = req
    if HOLD then PENDING = req return end
    if REPLY.fail then req.failed(REPLY.fail) else req.success(REPLY.code, REPLY.body) end
  end
  CONFIG = { url = "http://10.0.0.5:3000", token = "tok" }
  PUBLIC = "https://dash.example.org"
  TraitorDash = { GetConfig = function() return CONFIG end, GetPublicUrlRaw = function() return PUBLIC end }
  CHAT = {}
  function Player(id, bot)
    return { id = id, bot = bot, SteamID64 = function(s) return s.id end, IsBot = function(s) return s.bot end,
      IsTerror = function() return true end, Nick = function() return "x" end,
      ChatPrint = function(s, t) CHAT[#CHAT + 1] = { s.id, t } end }
  end
  ALICE = Player("76561198000000001", false)
  BOB = Player("76561198000000002", false)
  BOT = Player("0", true)
  PLAYERS = { ALICE, BOB }
  player = { GetAll = function() return PLAYERS end }
  function GetConVar() return nil end
`

function play(script: string, opts: { on?: boolean, files?: string[] } = {}) {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  addJsonDecode(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    run('util.JSONToTable = JS_JSON_DECODE')
    if (opts.on !== false) run('CVARS.traitordash_voice = "1"')
    for (const f of opts.files ?? ['util.lua', 'rolemenu.lua']) {
      // the role guide gives voice.lua the cleaning of the public address; it needs a few things of the game it does not use here
      if (f === 'rolemenu.lua') run('util.AddNetworkString = function() end net = {} roles = {} CLIENT = false SERVER = true')
      run(read(f))
    }
    run(read('voice.lua'))
    run(script)
    run(`
      local function enc(v)
        local t = type(v)
        if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
        if t == "number" or t == "boolean" then return tostring(v) end
        if t == "table" then
          if #v > 0 or next(v) == nil then local o = {} for i, x in ipairs(v) do o[i] = enc(x) end return "[" .. table.concat(o, ",") .. "]" end
          local o = {} for k, x in pairs(v) do if type(x) ~= "function" then o[#o + 1] = enc(tostring(k)) .. ":" .. enc(x) end end return "{" .. table.concat(o, ",") .. "}"
        end
        return "null"
      end
      local calls = {}
      for i, c in ipairs(CALLS) do calls[i] = { url = c.url, method = c.method, auth = c.headers.Authorization, body = c.body } end
      OUT_JSON = enc({ chat = CHAT, calls = calls, payload = LAST_PAYLOAD, result = RESULT })
    `)
    lua.lua_getglobal(L, to_luastring('OUT_JSON'))
    return JSON.parse(to_jsstring(lua.lua_tostring(L, -1))) as { chat: [string, string][], calls: { url: string, method: string, auth: string, body: string }[], payload: any, result: any }
  } finally { lua.lua_close(L) }
}
const A = '76561198000000001'

describe('!voice in voice.lua', () => {
  test('the line is hidden (the hook returns an empty string) and the code goes to the one player who asked, with the address to open', () => {
    const r = play('RESULT = Say(ALICE, "!voice")')
    expect(r.result).toBe('')
    expect(r.chat).toEqual([[A, 'Voice code K7F-3QX (5 minutes). Open https://dash.example.org/voice in your browser and type it there.']])
    expect(r.chat[0]![1]).not.toContain('/servers/') // the long address wraps over three chat lines
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({ url: 'http://10.0.0.5:3000/api/v1/voice-codes', method: 'POST', auth: 'Bearer tok' })
    expect(r.payload).toEqual({ steam_id: A })
  })

  test('it is not case sensitive and takes a space before it; with words after it the line is not ours', () => {
    expect(play('RESULT = Say(ALICE, "  !VOICE ")').result).toBe('')
    expect(play('RESULT = Say(ALICE, "!Voice")').chat).toHaveLength(1)
    for (const text of ['!voice please', 'hello !voice', '!voices', 'voice', '']) {
      const r = play(`RESULT = Say(ALICE, ${JSON.stringify(text)})`)
      expect(r.result, text).toBeUndefined()
      expect(r.calls, text).toEqual([])
      expect(r.chat, text).toEqual([])
    }
  })

  test('with traitordash_voice off it does nothing: the line is not hidden, nothing is asked, nothing is said', () => {
    const r = play('RESULT = Say(ALICE, "!voice")', { on: false })
    expect(r.result).toBeUndefined()
    expect(r.calls).toEqual([])
    expect(r.chat).toEqual([])
  })

  test('a bot gets nothing (and the line is hidden)', () => {
    const r = play('RESULT = Say(BOT, "!voice")')
    expect(r.calls).toEqual([])
    expect(r.chat).toEqual([])
    expect(r.result).toBe('')
  })

  test('without the bridge configured a short failure line is the answer and nothing is sent', () => {
    for (const cfg of ['CONFIG = { url = "http://x", token = "" }', 'CONFIG = {}']) {
      const r = play(`${cfg} RESULT = Say(ALICE, "!voice")`)
      expect(r.result).toBe('')
      expect(r.calls).toEqual([])
      expect(r.chat).toEqual([[A, 'Voice code unavailable, try again in a moment.']])
    }
  })

  test('one request per player every ten seconds: a repeat is hidden and ignored, and another player is not held up', () => {
    const r = play(`
      Say(ALICE, "!voice")
      NOW = NOW + 9.9
      RESULT = { again = Say(ALICE, "!voice"), bob = Say(BOB, "!voice") }
    `)
    expect(r.calls).toHaveLength(2) // Alice once, Bob once
    expect(r.result.again).toBe('')
    expect(r.chat.map(c => c[0])).toEqual([A, '76561198000000002'])
    const later = play(`
      Say(ALICE, "!voice")
      NOW = NOW + 10
      Say(ALICE, "!voice")
    `)
    expect(later.calls).toHaveLength(2)
  })

  test('a failure of the request, a refusal (429, 503, 401) and an answer that is not JSON all give the same short line', () => {
    for (const reply of ['{ fail = "timeout" }', '{ code = 429, body = "{}" }', '{ code = 503, body = "{}" }', '{ code = 401, body = "" }', '{ code = 200, body = "not json" }', '{ code = 200, body = "{}" }']) {
      const r = play(`REPLY = ${reply} RESULT = Say(ALICE, "!voice")`)
      expect(r.chat, reply).toEqual([[A, 'Voice code unavailable, try again in a moment.']])
      expect(r.result, reply).toBe('')
    }
  })

  test('only what has the shape of a code and of a path is printed; anything else the dashboard sends is not repeated to the player', () => {
    const bad = [
      '{"code":"K7F-3QX","path":"/servers/srv-1/voice?x=1"}', '{"code":"K7F-3QX","path":"https://evil.example/servers/a/voice"}', '{"code":"K7F-3QX","path":"/servers/a/voice/../../x"}',
      '{"code":"K7F-3QXZ","path":"/servers/a/voice"}', '{"code":"k7f-3qx","path":"/servers/a/voice"}', '{"code":"K7F3QX","path":"/servers/a/voice"}', '{"code":"K7F-3Q1","path":"/servers/a/voice"}',
      '{"code":"AAA-AAA","path":"/servers/a/voice"}', '{"code":"K7F-3QX\\nSay hi","path":"/servers/a/voice"}', '{"code":"K7F-3QX"}', '{"path":"/servers/a/voice"}', '{"code":5,"path":"/servers/a/voice"}',
    ]
    for (const body of bad) {
      const r = play(`REPLY = { code = 200, body = ${JSON.stringify(body)} } RESULT = Say(ALICE, "!voice")`)
      expect(r.chat, body).toEqual([[A, 'Voice code unavailable, try again in a moment.']])
    }
  })

  test('the address is the public https one when it is set and fine, else the bridge\'s own', () => {
    expect(play('PUBLIC = "http://plain.example.org" RESULT = Say(ALICE, "!voice")').chat[0]![1]).toContain('Open http://10.0.0.5:3000/voice ')
    expect(play('PUBLIC = "https://dash.example.org/" RESULT = Say(ALICE, "!voice")').chat[0]![1]).toContain('Open https://dash.example.org/voice ')
  })

  test('a player who left before the answer comes gets nothing printed (no error)', () => {
    const r = play(`
      HOLD = true
      Say(ALICE, "!voice")
      IsValid = function(v) return v ~= ALICE and v ~= nil end
      PENDING.success(200, REPLY.body)
    `)
    expect(r.chat).toEqual([])
  })
})
