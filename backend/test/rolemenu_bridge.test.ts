import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// RFC 15, section 7 (bridge): the server's part of the role guide (rolemenu.lua), the client's part
// (autorun/client/traitordash_roles_cl.lua) and the two TTT2 menu files, run against a small fake of
// GMod's net, hook, timer, HTTP and menu classes. Server and client share one Lua state here; the
// only thing between them is the fake net, which carries strings, as the real one does.
const ADDON = path.join(import.meta.dir, '../../addon/lua')
const read = (p: string) => fs.readFileSync(path.join(ADDON, p), 'utf8')

const PRELUDE = `
  SERVER, CLIENT = true, true
  IsValid = function(v) return v ~= nil and v ~= false end
  NOW = 0
  function SysTime() return NOW end
  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end

  util = { AddNetworkString = function() end,
    TableToJSON = function(t) LAST_JSON = t return "{json}" end,
    JSONToTable = function(s) local t = {} for k, v in s:gmatch('"([%w_]+)"%s*:%s*"([^"]*)"') do t[k] = v end return t end }

  -- the fake net: strings only, like the messages in question
  SENT, RECV, READ, CUR = {}, {}, {}, nil
  net = {
    Start = function(n) CUR = { name = n, vals = {} } end,
    WriteString = function(s) CUR.vals[#CUR.vals + 1] = s end,
    Send = function(p) SENT[#SENT + 1] = { name = CUR.name, vals = CUR.vals, to = p } end,
    Broadcast = function() SENT[#SENT + 1] = { name = CUR.name, vals = CUR.vals, to = "all" } end,
    Receive = function(n, fn) RECV[n] = fn end,
    ReadString = function() return table.remove(READ, 1) end,
  }
  function Deliver(i) local m = SENT[i] READ = { table.unpack(m.vals) } RECV[m.name]() end

  HOOKS = {}
  hook = { Add = function(ev, id, fn) HOOKS[ev] = HOOKS[ev] or {} HOOKS[ev][id] = fn end }
  TIMERS = {}
  TIMERS_NAMED = {}
  timer = { Simple = function(d, fn) TIMERS[#TIMERS + 1] = fn end, Create = function(n, d, r, fn) TIMERS_NAMED[n] = { delay = d, reps = r, fn = fn } end }
  PLAYERS = {}
  player = { GetAll = function() return PLAYERS end }
  IsValid = function(o) return o ~= nil end
  function RunTimers() local t = TIMERS TIMERS = {} for _, fn in ipairs(t) do fn() end end
  CMDS = {}
  concommand = { Add = function(n, fn) CMDS[n] = fn end }

  -- the dashboard: what HTTP() does
  HTTPCALLS, HTTPREPLY = {}, { code = 200, body = '{"server_id":"srv-1"}' }
  function HTTP(req)
    HTTPCALLS[#HTTPCALLS + 1] = req
    if HTTPREPLY.fail then req.failed(HTTPREPLY.fail) else req.success(HTTPREPLY.code, HTTPREPLY.body) end
  end

  PUBLIC = "https://dash.example.org"
  TraitorDash = { GetConfig = function() return { url = "http://10.0.0.5:3000", token = "tok", rawUrl = "http://10.0.0.5:3000" } end,
    GetPublicUrlRaw = function() return PUBLIC end }

  KNOWN = { "innocent", "traitor", "haunter", "sheriff" }
  roles = { GetList = function() local o = {} for _, n in ipairs(KNOWN) do o[#o + 1] = { name = n } end return o end }

  CHAT = {}
  function Player(id, role)
    return { id = id, role = role, SteamID64 = function(s) return s.id end, IsBot = function() return false end,
      ChatPrint = function(s, t) CHAT[#CHAT + 1] = { s.id, t } end,
      GetSubRoleData = function(s) return { name = s.role } end }
  end
  ALICE = Player("1", "haunter")

  -- the client
  CHATTEXT = {}
  chat = { AddText = function(...) local o = {} for _, v in ipairs({ ... }) do if type(v) == "string" then o[#o + 1] = v end end CHATTEXT[#CHATTEXT + 1] = table.concat(o) end }
  Color = function() return {} end
  Material = function(n) return n end
  menusIndexed = {}
  HELPSCRN = { calls = {}, ShowMainMenu = function(s) s.calls[#s.calls + 1] = "main" end,
    ShowSubmenu = function(s, m) s.calls[#s.calls + 1] = "sub:" .. tostring(m.type) end }
  OPENED = {}
  vgui = { Create = function(class, parent) local p = { class = class, Dock = function() end, OpenURL = function(s, u) OPENED[#OPENED + 1] = u end } return p end }
  FILL = 1
`

type Out = { printed: string[], sent: any[], chat: any[], chatText: string[], http: number, opened: string[], helpscrn: string[], out: any }

function play(script: string, files: string[] = ['traitordash/util.lua', 'traitordash/rolemenu.lua', 'autorun/client/traitordash_roles_cl.lua']): Out {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    for (const f of files) run(read(f))
    run(script)
    run(`
      local function enc(v)
        local t = type(v)
        if t == "string" then return '"' .. v:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"') .. '"' end
        if t == "number" or t == "boolean" then return tostring(v) end
        if t == "nil" then return "null" end
        if t == "table" then
          if #v > 0 or next(v) == nil then local o = {} for i, x in ipairs(v) do o[i] = enc(x) end return "[" .. table.concat(o, ",") .. "]" end
          local o = {} for k, x in pairs(v) do if type(x) ~= "function" then o[#o + 1] = enc(tostring(k)) .. ":" .. enc(x) end end return "{" .. table.concat(o, ",") .. "}"
        end
        return "null"
      end
      __OUT = enc({ printed = PRINTED, sent = SENT, chat = CHAT, chatText = CHATTEXT, http = #HTTPCALLS, opened = OPENED, helpscrn = HELPSCRN.calls, out = RESULT })
    `)
    lua.lua_getglobal(L, to_luastring('__OUT'))
    return JSON.parse(to_jsstring(lua.lua_tostring(L, -1)))
  } finally { lua.lua_close(L) }
}

const on = `RunTimers()`  // whoami answers at once in the fake
const sentOpens = (o: Out) => o.sent.filter(m => m.name === 'TraitorDash_RolesOpen').map(m => m.vals[0])

describe('rolemenu.lua: turning on', () => {
  test('with an https public_url and a good whoami it is on and broadcasts the base and the id, only strings', () => {
    const o = play(`${on} RESULT = { state = TraitorDash.RoleGuide.state }`)
    expect(o.out.state).toBe('on')
    expect(o.sent).toEqual([{ name: 'TraitorDash_RolesInit', vals: ['https://dash.example.org', 'srv-1'], to: 'all' }])
    expect(o.http).toBe(1)
  })
  test('without a public_url, with an http one, or with an unusable one it is off, says why once, and sends nothing', () => {
    for (const url of ['', 'http://dash.example.org', 'ftp://x', 'https://', 'https://bad host', 'javascript:alert(1)', 'https://x.org/a?b']) {
      const o = play(`PUBLIC = ${JSON.stringify(url)} ${on} TraitorDash.RoleGuide.Start() RESULT = { state = TraitorDash.RoleGuide.state }`)
      expect(o.out.state, url).toBe('off')
      expect(o.printed.filter(p => p.includes('Role guide is off')).length, url).toBe(1)
      expect(o.sent, url).toEqual([])
      expect(o.http, url).toBe(0) // the dashboard is not asked at all
    }
  })
  test('whoami failing (404 from an old dashboard, 500, a network error, a bad id) turns it off with the reason, once', () => {
    for (const reply of ['{ code = 404, body = "" }', '{ code = 500, body = "" }', '{ fail = "timeout" }', '{ code = 200, body = \'{"server_id":"a/../b"}\' }', '{ code = 200, body = "{}" }']) {
      const o = play(`HTTPREPLY = ${reply} ${on} TraitorDash.RoleGuide.Start() RESULT = { state = TraitorDash.RoleGuide.state }`)
      expect(o.out.state, reply).toBe('off')
      expect(o.printed.filter(p => p.includes('Role guide is off')).length, reply).toBe(1)
      expect(o.sent, reply).toEqual([])
    }
    expect(play(`HTTPREPLY = { code = 404, body = "" } ${on}`).printed.join('\n')).toContain('too old')
  })
  test('the bridge not being configured keeps it off without any request', () => {
    const o = play(`TraitorDash.GetConfig = function() return { url = nil, token = "" } end ${on} RESULT = { state = TraitorDash.RoleGuide.state }`)
    expect(o.out.state).toBe('off')
    expect(o.http).toBe(0)
  })
  test('a player who joins later gets the init five seconds after spawning, only when it is on', () => {
    const on1 = play(`${on} SENT = {} HOOKS.PlayerInitialSpawn.TraitorDash_RoleGuide(ALICE) RunTimers()`)
    expect(on1.sent).toEqual([{ name: 'TraitorDash_RolesInit', vals: ['https://dash.example.org', 'srv-1'], to: expect.anything() }])
    const off = play(`PUBLIC = "" ${on} HOOKS.PlayerInitialSpawn.TraitorDash_RoleGuide(ALICE) RunTimers()`)
    expect(off.sent).toEqual([])
  })
})

describe('rolemenu.lua: the game vouches for its players (RFC 16, 4)', () => {
  const A = '76561198000000011', B = '76561198000000012'
  const KEY_A = A + '.1900000000.abcDEF123_-', KEY_B = B + '.1900000000.zzzDEF123_-'
  // after the guide is on: two players, and a dashboard that answers the key request with KEYS
  const keyed = (script: string, keys = `{ { steam_id = "${A}", key = "${KEY_A}" }, { steam_id = "${B}", key = "${KEY_B}" } }`) => play(`${on}
    PLAYERS = { Player("${A}", "traitor"), Player("${B}", "innocent") } PA, PB = PLAYERS[1], PLAYERS[2]
    KEYS = ${keys} util.JSONToTable = function() return { keys = KEYS } end
    HTTPREPLY = { code = 200, body = "{}" } SENT = {} HTTPCALLS = {}
    ${script}`)
  const client = (script: string) => play(`${on} SENT = {} ${script}`)
  const keySends = (o: Out) => o.sent.filter(m => m.name === 'TraitorDash_RolesKey')

  test('asks for a key per player with the server token and sends each one its own, and only its own', () => {
    const o = keyed(`RESULT = { n = TraitorDash.RoleGuide.IssueKeys(PLAYERS), body = LAST_JSON.players, url = HTTPCALLS[1].url, auth = HTTPCALLS[1].headers.Authorization }`)
    expect(o.out).toEqual({ n: 2, body: ['76561198000000011', '76561198000000012'], url: 'http://10.0.0.5:3000/api/v1/ingame-keys', auth: 'Bearer tok' })
    const sends = keySends(o)
    expect(sends.map(m => m.vals)).toEqual([[KEY_A], [KEY_B]])
    expect(sends[0].to.id).toBe(A)
    expect(sends[1].to.id).toBe(B)
  })
  test('bots, ids that are not SteamID64s and a player counted twice are left out', () => {
    const o = keyed(`local bot = Player("${B}", "x") bot.IsBot = function() return true end
      local odd = Player("1", "x")
      RESULT = { n = TraitorDash.RoleGuide.IssueKeys({ PA, PA, bot, odd }), body = LAST_JSON.players }`)
    expect(o.out).toEqual({ n: 1, body: [A] })
  })
  test('a key that does not look like one, one for somebody who is not asked for, or for a player who left is not sent', () => {
    const o = keyed(`TraitorDash.RoleGuide.IssueKeys(PLAYERS)`, `{ { steam_id = "${A}", key = "<script>" }, { steam_id = "${B}", key = "${KEY_B}" }, { steam_id = "76561198000000099", key = "${KEY_A}" } }`)
    expect(keySends(o).map(m => m.vals)).toEqual([[KEY_B]])
    const left = keyed(`HTTP = function(req) HTTPCALLS[#HTTPCALLS + 1] = req SAVED = req end TraitorDash.RoleGuide.IssueKeys(PLAYERS) IsValid = function(p) return p ~= PB end SAVED.success(200, "{}")`)
    expect(keySends(left).map(m => m.vals)).toEqual([[KEY_A]])
  })
  test('entries that are not { steam_id, key } pairs, or whose id is a number, are skipped without an error', () => {
    const o = keyed(`TraitorDash.RoleGuide.IssueKeys(PLAYERS)`, `{ "x", 5, {}, { steam_id = 7.6561198e16, key = "${KEY_A}" }, { steam_id = "${B}", key = "${KEY_B}" } }`)
    expect(keySends(o).map(m => m.vals)).toEqual([[KEY_B]])
  })
  test('a key longer than 100 characters is not sent', () => {
    const o = keyed(`TraitorDash.RoleGuide.IssueKeys(PLAYERS)`, `{ { steam_id = "${A}", key = "${A}.1900000000.${'x'.repeat(100)}" } }`)
    expect(keySends(o)).toEqual([])
  })
  test('nothing is asked while the guide is off, or without a configuration, or with nobody there', () => {
    const off = play(`PUBLIC = "" ${on} PLAYERS = { Player("${A}", "x") } HTTPCALLS = {} RESULT = { n = TraitorDash.RoleGuide.IssueKeys(PLAYERS), http = #HTTPCALLS }`)
    expect(off.out).toEqual({ n: 0, http: 0 })
    const none = keyed(`TraitorDash.GetConfig = function() return { url = nil, token = "" } end RESULT = { n = TraitorDash.RoleGuide.IssueKeys(PLAYERS), http = #HTTPCALLS }`)
    expect(none.out).toEqual({ n: 0, http: 0 })
    expect(keyed(`RESULT = { n = TraitorDash.RoleGuide.IssueKeys({}), http = #HTTPCALLS }`).out).toEqual({ n: 0, http: 0 })
  })
  test('a failing or refusing dashboard sends nothing and says so once', () => {
    for (const reply of ['{ code = 500, body = "" }', '{ fail = "timeout" }', '{ code = 429, body = "x" }']) {
      const o = keyed(`HTTPREPLY = ${reply} util.JSONToTable = function() return nil end TraitorDash.RoleGuide.IssueKeys(PLAYERS) TraitorDash.RoleGuide.IssueKeys(PLAYERS)`)
      expect(keySends(o), reply).toEqual([])
      expect(o.printed.filter(p => p.includes('Could not get keys')).length, reply).toBe(1)
    }
  })
  test('when the guide comes on everybody there gets a key; a player who joins gets one after five seconds, together with others who join at once', () => {
    const start = play(`PLAYERS = { Player("${A}", "x") } KEYS = { { steam_id = "${A}", key = "${KEY_A}" } } util.JSONToTable = function() return { server_id = "srv-1", keys = KEYS } end
      HTTPREPLY = { code = 200, body = "ok" } ${on}`)
    expect(play(`${on}`).http).toBe(1) // whoami only: nobody in the game
    expect(start.http).toBe(2)         // whoami, then the keys
    const joined = keyed(`SENT = {} HTTPCALLS = {} local hook = HOOKS.PlayerInitialSpawn.TraitorDash_RoleGuide
      hook(PA) hook(PB) RunTimers() RESULT = { before = #HTTPCALLS } RunTimers() RESULT.after = #HTTPCALLS RESULT.n = #LAST_JSON.players`)
    expect(joined.out).toEqual({ before: 0, after: 1, n: 2 })
    expect(keySends(joined).length).toBe(2)
  })
  test('the console says once how many keys the dashboard gave', () => {
    const o = keyed(`TraitorDash.RoleGuide.IssueKeys(PLAYERS) TraitorDash.RoleGuide.IssueKeys(PLAYERS)`)
    expect(o.printed.filter(p => p.includes('Got 2 key(s)')).length).toBe(1)
  })
  test('the keys are renewed every ten minutes, for everybody in the game', () => {
    const o = keyed(`local t = TIMERS_NAMED.TraitorDash_RoleGuideKeys RESULT = { delay = t.delay, reps = t.reps } t.fn()`)
    expect(o.out).toEqual({ delay: 600, reps: 0 })
    expect(keySends(o).length).toBe(2)
  })
})

describe('traitordash_roles_cl.lua: the key', () => {
  const client = (script: string) => play(`${on} SENT = {} ${script}`)
  const KEY = '76561198000000011.1900000000.abcDEF123_-'
  const url = (script: string) => client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org", "abc-1") ${script}`).out
  test('with a key the page address goes through the game sign-in, which carries the page to open, encoded', () => {
    const o = url(`TraitorDash.RoleGuideClient.SetKey("${KEY}") RESULT = { s = TraitorDash.RoleGuideClient.SectionUrl("stats"), m = TraitorDash.RoleGuideClient.SectionUrl("maps") }`)
    expect(o.s).toBe(`https://d.example.org/auth/game?k=${KEY}&to=%2Fservers%2Fabc-1%2Fstats%3Fembed%3D1`)
    expect(o.m).toBe(`https://d.example.org/auth/game?k=${KEY}&to=%2Fservers%2Fabc-1%2Fmaps%3Fembed%3D1`)
  })
  test('without a key, or with one that does not look like one, it is the page itself', () => {
    expect(url(`RESULT = { s = TraitorDash.RoleGuideClient.SectionUrl("stats") }`).s).toBe('https://d.example.org/servers/abc-1/stats?embed=1')
    for (const bad of ['', 'x', 'a&b.1.c', '1.2.<s>', '1.2.' + 'x'.repeat(120), '../../x']) {
      expect(url(`TraitorDash.RoleGuideClient.SetKey("${bad}") RESULT = { s = TraitorDash.RoleGuideClient.SectionUrl("maps") }`).s, bad).toBe('https://d.example.org/servers/abc-1/maps?embed=1')
    }
    expect(url(`TraitorDash.RoleGuideClient.SetKey(nil) RESULT = { s = TraitorDash.RoleGuideClient.SectionUrl("maps") }`).s).toBe('https://d.example.org/servers/abc-1/maps?embed=1')
  })
  test('OpenExternal opens only a path under this server in the player\'s browser, through the sign-in when there is a key', () => {
    const o = url(`EXT = {} gui = { OpenURL = function(u) EXT[#EXT + 1] = u end } local g = TraitorDash.RoleGuideClient
      local ok = g.OpenExternal("/servers/abc-1/maps/ttt_a")
      g.lastOpen = nil g.SetKey("${KEY}")
      local keyed = g.OpenExternal("/servers/abc-1/rounds/round-000001/replay")
      RESULT = { ok = ok, keyed = keyed, urls = EXT }`)
    expect(o).toEqual({ ok: true, keyed: true, urls: [
      'https://d.example.org/servers/abc-1/maps/ttt_a',
      `https://d.example.org/auth/game?k=${KEY}&to=%2Fservers%2Fabc-1%2Frounds%2Fround-000001%2Freplay`,
    ] })
  })
  test('OpenExternal refuses another server, odd characters, dot-dot, a long path, a non-string, and a second open within a second', () => {
    const o = url(`EXT = {} gui = { OpenURL = function(u) EXT[#EXT + 1] = u end } local g = TraitorDash.RoleGuideClient
      local r = {}
      for i, p in ipairs({ "/servers/other/maps/x", "/servers/abc-1/maps/../x", "/servers/abc-1/maps/x?a=1", "//evil.example/servers/abc-1/", "servers/abc-1/x", "/auth/steam", "/servers/abc-1/" .. string.rep("a", 300) }) do
        g.lastOpen = nil r[i] = g.OpenExternal(p)
      end
      g.lastOpen = nil r[8] = g.OpenExternal(nil) r[9] = g.OpenExternal(42)
      g.lastOpen = nil g.OpenExternal("/servers/abc-1/maps/a") r[10] = g.OpenExternal("/servers/abc-1/maps/b")
      RESULT = { r = r, n = #EXT }`)
    expect(o).toEqual({ r: [false, false, false, false, false, false, false, false, false, false], n: 1 })
  })
  test('a later bad key removes the earlier one; the role guide never uses the key', () => {
    const o = url(`TraitorDash.RoleGuideClient.SetKey("${KEY}") TraitorDash.RoleGuideClient.SetKey("junk")
      RESULT = { s = TraitorDash.RoleGuideClient.SectionUrl("stats") }`)
    expect(o.s).toBe('https://d.example.org/servers/abc-1/stats?embed=1')
    const roles = url(`TraitorDash.RoleGuideClient.SetKey("${KEY}") player = nil RESULT = { r = TraitorDash.RoleGuideClient.Url("sheriff") }`)
    expect(roles.r).toBe('https://d.example.org/servers/abc-1/roles/sheriff?embed=1')
  })
  test('the first key is announced once in the console, so a missing key is visible', () => {
    const o = client(`TraitorDash.RoleGuideClient.SetKey("${KEY}") TraitorDash.RoleGuideClient.SetKey("${KEY}")`)
    expect(o.printed.filter(p => p.includes('vouched for you')).length).toBe(1)
  })
  test('the message from the server sets the key', () => {
    const o = client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org", "abc-1") READ = { "${KEY}" } RECV.TraitorDash_RolesKey() RESULT = { key = TraitorDash.RoleGuideClient.key }`)
    expect(o.out.key).toBe(KEY)
  })
})

describe('rolemenu.lua: asking for a role', () => {
  const ask = (text: string, extra = '') => play(`${on} SENT = {} ${extra} RESULT = { r = HOOKS.PlayerSay.TraitorDash_RoleGuide(ALICE, ${JSON.stringify(text)}) }`)
  test('!role with no name names the player\'s own role', () => {
    expect(sentOpens(ask('!role'))).toEqual(['haunter'])
  })
  test('!role Haunter, !role haunter and a padded one resolve to the same role, in the game\'s spelling; the chat line is hidden', () => {
    for (const t of ['!role Haunter', '!role haunter', '!role  haunter ', '!ROLE HAUNTER']) {
      const o = ask(t)
      expect(sentOpens(o), t).toEqual(['haunter'])
      expect(o.out.r, t).toBe('')
    }
  })
  test('!roles asks for the list, and other chat is left alone', () => {
    expect(sentOpens(ask('!roles'))).toEqual([''])
    for (const t of ['hello', '!roleplay', '!rolesx', '!roles extra', 'please !role']) {
      const o = ask(t)
      expect(sentOpens(o), t).toEqual([])
      expect(o.out.r, t).toBeUndefined()
    }
  })
  test('an unknown name answers in chat and sends nothing', () => {
    const o = ask('!role ghost')
    expect(sentOpens(o)).toEqual([])
    expect(o.chat[0][1]).toContain('No role by that name')
    expect(JSON.stringify(o.chat)).not.toContain('ghost') // not echoed
  })
  test('names with / ? .. %, a null byte, spaces inside, or 200 characters are refused before any lookup', () => {
    for (const t of ['!role ../x', '!role a/b', '!role a?b', '!role ha%75nter', '!role hau nter', '!role ' + 'a'.repeat(200), '!role <script>', '!role haunter;x']) {
      const o = ask(t)
      expect(sentOpens(o), t).toEqual([])
      expect(o.chat.length, t).toBe(1)
    }
  })
  test('a name that is not plain is refused even if the game has a role by that name', () => {
    const o = play(`KNOWN = { "we/ird", "..", "a b", "ok" } ${on} SENT = {} local say = HOOKS.PlayerSay.TraitorDash_RoleGuide
      NOW = 0 say(ALICE, "!role we/ird") NOW = 3 say(ALICE, "!role ..") NOW = 6 say(ALICE, "!role ok")`)
    expect(sentOpens(o)).toEqual(['ok'])
  })
  test('a player with no role yet is told, and nothing is sent', () => {
    const o = play(`${on} SENT = {} ALICE.role = "none" HOOKS.PlayerSay.TraitorDash_RoleGuide(ALICE, "!role")`)
    expect(sentOpens(o)).toEqual([])
    expect(o.chat[0][1]).toContain('no role yet')
  })
  test('two requests within 2 seconds send one message; after 2 seconds another', () => {
    const o = play(`${on} SENT = {}
      local say = HOOKS.PlayerSay.TraitorDash_RoleGuide
      say(ALICE, "!role traitor") NOW = 1 say(ALICE, "!role traitor") NOW = 2.5 say(ALICE, "!role traitor")`)
    expect(sentOpens(o)).toEqual(['traitor', 'traitor'])
  })
  test('the limit is per player', () => {
    const o = play(`${on} SENT = {} local bob = Player("2", "traitor")
      HOOKS.PlayerSay.TraitorDash_RoleGuide(ALICE, "!role") HOOKS.PlayerSay.TraitorDash_RoleGuide(bob, "!role")`)
    expect(sentOpens(o)).toEqual(['haunter', 'traitor'])
  })
  test('with the guide off the player is told so and nothing is sent', () => {
    const o = play(`PUBLIC = "" ${on} SENT = {} HOOKS.PlayerSay.TraitorDash_RoleGuide(ALICE, "!role traitor")`)
    expect(sentOpens(o)).toEqual([])
    expect(o.chat[0][1]).toContain('not available')
  })
  test('the console command works like !role <name>, and from the server console prints the state', () => {
    const o = play(`${on} SENT = {} CMDS.traitordash_role(ALICE, "traitordash_role", { "Sheriff" }) CMDS.traitordash_role(nil, "traitordash_role", {})`)
    expect(sentOpens(o)).toEqual(['Sheriff'].map(s => s.toLowerCase()))
    expect(o.printed.join('\n')).toContain('Role guide: on')
  })
})

describe('the client: building the address', () => {
  const client = (script: string) => play(`${on} SENT = {} ${script}`)
  test('nothing contacts the dashboard from the client: the only request is the server\'s own whoami', () => {
    const o = client(`Deliver = Deliver  -- init is delivered below
      SENT = {} TraitorDash.RoleGuide.SendInit(nil) Deliver(1) local c = TraitorDash.RoleGuideClient RESULT = { url = c.Url("") }`)
    expect(o.http).toBe(1)
    expect(o.out.url).toBe('https://dash.example.org/servers/srv-1/roles?embed=1')
  })
  test('<base>/servers/<id>/roles[/<name>]?embed=1; only plain names get an address', () => {
    const o = client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org/td", "abc-1")
      local c = TraitorDash.RoleGuideClient RESULT = { list = c.Url(), role = c.Url("haunter"), odd = c.Url("a b"), slash = c.Url("a/b") or "nil", dots = c.Url("..") }`)
    expect(o.out.list).toBe('https://d.example.org/td/servers/abc-1/roles?embed=1')
    expect(o.out.role).toBe('https://d.example.org/td/servers/abc-1/roles/haunter?embed=1')
    expect(o.out.odd).toBeUndefined()   // not a plain name: no address at all
    expect(o.out.slash).toBe('nil')
    expect(o.out.dots).toBeUndefined()  // "." and ".." are not names
  })
  test('the number of players in the game goes on the address, as a whole number from 1 to 128 only', () => {
    const url = (count: string) => client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org", "abc-1")
      player = { GetCount = function() return ${count} end }
      local c = TraitorDash.RoleGuideClient RESULT = { list = c.Url(), role = c.Url("haunter") }`).out
    expect(url('7').list).toBe('https://d.example.org/servers/abc-1/roles?embed=1&players=7')
    expect(url('7').role).toBe('https://d.example.org/servers/abc-1/roles/haunter?embed=1&players=7')
    expect(url('128').list).toContain('players=128')
    for (const bad of ['0', '129', '-1', '2.5', '"7"', 'nil', '1/0', '0/0']) expect(url(bad).list, bad).toBe('https://d.example.org/servers/abc-1/roles?embed=1')
  })
  test('without a player library the address has no count', () => {
    const o = client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org", "abc-1") player = nil RESULT = { list = TraitorDash.RoleGuideClient.Url() }`)
    expect(o.out.list).toBe('https://d.example.org/servers/abc-1/roles?embed=1')
  })
  test('a base that is not https, or an id with odd characters, switches it off', () => {
    for (const [b, i] of [['http://x.org', 'a'], ['javascript:1', 'a'], ['https://x.org', 'a/b'], ['https://x.org', ''], ['https://x.org?x=1', 'a'], ['https://x y', 'a']]) {
      const o = client(`local c = TraitorDash.RoleGuideClient c.SetInit(${JSON.stringify(b)}, ${JSON.stringify(i)}) RESULT = { ok = c.Available(), url = c.Url("x") }`)
      expect(o.out.ok, `${b} ${i}`).toBe(false)
      expect(o.out.url).toBeUndefined()
    }
  })
  test('a net message that carries an address instead of a name opens nothing', () => {
    const o = client(`local c = TraitorDash.RoleGuideClient c.SetInit("https://d.example.org", "abc")
      table.insert(menusIndexed, { type = "traitordash_roles" })
      for _, bad in ipairs({ "https://evil.example/x", "http://evil", "//evil", "a/b", "x?y" }) do READ = { bad } RECV.TraitorDash_RolesOpen() end
      RESULT = { wanted = c.wanted }`)
    expect(o.helpscrn).toEqual([])
    expect(o.out.wanted).toBeUndefined()
  })
  test('a role message opens the F1 menu on the tab and the tab takes that role once, then shows the list', () => {
    const o = client(`local c = TraitorDash.RoleGuideClient c.SetInit("https://d.example.org", "abc")
      table.insert(menusIndexed, { type = "traitordash_roles" })
      READ = { "haunter" } RECV.TraitorDash_RolesOpen()
      RESULT = { first = c.TakeUrl(), second = c.TakeUrl() }`)
    expect(o.helpscrn).toEqual(['main', 'sub:traitordash_roles'])
    expect(o.out.first).toBe('https://d.example.org/servers/abc/roles/haunter?embed=1')
    expect(o.out.second).toBe('https://d.example.org/servers/abc/roles?embed=1')
    expect(o.chatText.filter(t => t.includes('Opening the role guide from d.example.org'))).toHaveLength(1)
  })
  test('without the menu class the player is told to open the tab by hand', () => {
    const o = client(`TraitorDash.RoleGuideClient.SetInit("https://d.example.org", "abc") READ = { "haunter" } RECV.TraitorDash_RolesOpen()`)
    expect(o.helpscrn).toEqual([])
    expect(o.chatText.join('\n')).toContain('Open the Server roles tab')
  })
  test('unavailable: no address and nothing opens', () => {
    const o = client(`local c = TraitorDash.RoleGuideClient READ = { "haunter" } RECV.TraitorDash_RolesOpen() RESULT = { url = c.Url("x"), ok = c.Available() }`)
    expect(o.out.ok).toBe(false)
    expect(o.helpscrn).toEqual([])
  })
})

describe('the TTT2 menu files', () => {
  // a fake of the class scopes the loader provides: one table per file, then the file runs against it
  const menuScript = `
    local function loadscope(src, scope)
      local env = setmetatable({ [scope] = {} }, { __index = _G })
      local fn = assert(load(src, "menu", "t", env))
      fn()
      return env[scope]
    end
    MENU = loadscope(MENU_SRC, "CLGAMEMODEMENU")
    SUB = loadscope(SUB_SRC, "CLGAMEMODESUBMENU")
    STATS = loadscope(STATS_SRC, "CLGAMEMODESUBMENU")
    MAPS = loadscope(MAPS_SRC, "CLGAMEMODESUBMENU")
  `
  const files = ['traitordash/util.lua', 'traitordash/rolemenu.lua', 'autorun/client/traitordash_roles_cl.lua']
  const run = (script: string) => {
    const src = (p: string) => '[==[' + read(p) + ']==]'
    return play(`${on} SENT = {} MENU_SRC = ${src('terrortown/menus/gamemode/traitordash_roles.lua')} SUB_SRC = ${src('terrortown/menus/gamemode/traitordash_roles/guide.lua')} STATS_SRC = ${src('terrortown/menus/gamemode/traitordash_roles/stats.lua')} MAPS_SRC = ${src('terrortown/menus/gamemode/traitordash_roles/maps.lua')}
      ${menuScript}
      MENU.HasVisibleSubmenus = function() return true end
      ${script}`, files)
  }
  test('the tab is for everybody (not an admin menu), has TTT2\'s roles icon, and a page', () => {
    const o = run(`RESULT = { admin = MENU.IsAdminMenu and MENU:IsAdminMenu() or false, icon = MENU.icon, base = MENU.base, title = MENU.title, subBase = SUB.base, hasPopulate = type(SUB.Populate) == "function" }`)
    expect(o.out).toMatchObject({ admin: false, icon: 'vgui/ttt/vskin/helpscreen/roles', base: 'base_gamemodemenu', subBase: 'base_gamemodesubmenu', hasPopulate: true })
  })
  test('the tab is called Server info, and holds three pages: the role guide, the round stats and the maps', () => {
    const o = run(`RESULT = { title = MENU.title, roles = SUB.title, stats = STATS.title, maps = MAPS.title, order = { SUB.priority, STATS.priority, MAPS.priority }, bases = { STATS.base, MAPS.base } }`)
    expect(o.out).toEqual({ title: 'Server info', roles: 'Server roles', stats: 'Round stats', maps: 'Maps', order: [50, 40, 30], bases: ['base_gamemodesubmenu', 'base_gamemodesubmenu'] })
  })
  test('the stats and maps pages open exactly their built address (embedded), and nothing when the guide is unavailable', () => {
    const on1 = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1) STATS:Populate({}) MAPS:Populate({})`)
    expect(on1.opened).toEqual(['https://dash.example.org/servers/srv-1/stats?embed=1', 'https://dash.example.org/servers/srv-1/maps?embed=1'])
    expect(run(`STATS:Populate({}) MAPS:Populate({})`).opened).toEqual([])
  })
  test('a page built before the first key came is opened again with it, once; later keys do not reset the page', () => {
    const o = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1) local KEY = "76561198000000011.1900000000.abcDEF123_-" STATS:Populate({}) MAPS:Populate({}) OPENED = {}
      TraitorDash.RoleGuideClient.SetKey("" .. KEY .. "")
      local after = #OPENED
      TraitorDash.RoleGuideClient.SetKey("76561198000000011.1900000000.xyzDEF123_-")
      RESULT = { urls = OPENED, again = #OPENED - after }`)
    expect(o.out.urls.length).toBe(2)
    for (const u of o.out.urls) expect(u).toContain('/auth/game?k=76561198000000011.1900000000.abcDEF123_-')
    expect(o.out.urls.some((u: string) => u.includes('stats'))).toBe(true)
    expect(o.out.urls.some((u: string) => u.includes('maps'))).toBe(true)
    expect(o.out.again).toBe(0)
  })
  test('a page that is gone is dropped and not opened again, and the role guide page is never one of those reloaded', () => {
    const o = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1) local KEY = "76561198000000011.1900000000.abcDEF123_-" STATS:Populate({}) SUB:Populate({}) OPENED = {}
      IsValid = function() return false end
      TraitorDash.RoleGuideClient.SetKey("" .. KEY .. "")
      RESULT = { n = #OPENED, left = #TraitorDash.RoleGuideClient.panels }`)
    expect(o.out).toEqual({ n: 0, left: 0 })
  })
  test('SectionUrl knows only the two sections; any other name builds nothing', () => {
    const o = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1) local g = TraitorDash.RoleGuideClient
      RESULT = { a = g.SectionUrl("stats"), b = g.SectionUrl("maps"), c = g.SectionUrl("../x") or "nil", d = g.SectionUrl("roles") or "nil", e = g.SectionUrl(nil) or "nil" }`)
    expect(o.out).toEqual({ a: 'https://dash.example.org/servers/srv-1/stats?embed=1', b: 'https://dash.example.org/servers/srv-1/maps?embed=1', c: 'nil', d: 'nil', e: 'nil' })
  })
  test('ShouldShow is false until the server has said where the guide is, and true after', () => {
    const o = run(`local before = MENU:ShouldShow() TraitorDash.RoleGuide.SendInit(nil) Deliver(1) RESULT = { before = before, after = MENU:ShouldShow() }`)
    expect(o.out).toEqual({ before: false, after: true })
  })
  test('Populate opens exactly the built address, on the wanted role, in a docked browser panel; unavailable it builds nothing', () => {
    const on1 = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1) TraitorDash.RoleGuideClient.wanted = "sheriff" SUB:Populate({})`)
    expect(on1.opened).toEqual(['https://dash.example.org/servers/srv-1/roles/sheriff?embed=1'])
    const off = run(`SUB:Populate({})`)
    expect(off.opened).toEqual([])
  })
  test('the browser panel is as tall as the scrolling area it sits in, never a thin strip', () => {
    const o = run(`TraitorDash.RoleGuide.SendInit(nil) Deliver(1)
      local scroll = { GetCanvas = function() end, GetTall = function() return 480 end }
      local inner = { GetParent = function() return scroll end }
      local made
      local real = vgui.Create
      vgui.Create = function(c, p) made = real(c, p) made.tall = 0 made.SetTall = function(s, t) s.tall = t end made.GetTall = function(s) return s.tall end return made end
      SUB:Populate(inner) made:Think()
      local first = made.tall
      scroll.GetTall = function() return 100 end made:Think()
      RESULT = { first = first, small = made.tall }`)
    expect(o.out).toEqual({ first: 480, small: 300 })
  })
})
