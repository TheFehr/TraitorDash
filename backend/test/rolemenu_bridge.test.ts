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
  timer = { Simple = function(d, fn) TIMERS[#TIMERS + 1] = fn end }
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
    return { id = id, role = role, SteamID64 = function(s) return s.id end,
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

function play(script: string, files: string[] = ['traitordash/rolemenu.lua', 'autorun/client/traitordash_roles_cl.lua']): Out {
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
  `
  const files = ['traitordash/rolemenu.lua', 'autorun/client/traitordash_roles_cl.lua']
  const run = (script: string) => {
    const src = (p: string) => '[==[' + read(p) + ']==]'
    return play(`${on} SENT = {} MENU_SRC = ${src('terrortown/menus/gamemode/traitordash_roles.lua')} SUB_SRC = ${src('terrortown/menus/gamemode/traitordash_roles/guide.lua')}
      ${menuScript}
      MENU.HasVisibleSubmenus = function() return true end
      ${script}`, files)
  }
  test('the tab is for everybody (not an admin menu), has TTT2\'s roles icon, and a page', () => {
    const o = run(`RESULT = { admin = MENU.IsAdminMenu and MENU:IsAdminMenu() or false, icon = MENU.icon, base = MENU.base, title = MENU.title, subBase = SUB.base, hasPopulate = type(SUB.Populate) == "function" }`)
    expect(o.out).toMatchObject({ admin: false, icon: 'vgui/ttt/vskin/helpscreen/roles', base: 'base_gamemodemenu', subBase: 'base_gamemodesubmenu', hasPopulate: true })
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
})
