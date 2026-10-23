import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import { UTIL, COMMANDS, CONFIG, BRIDGE, PRELUDE, addSha256, run, poll, convar } from './helpers/bridge_harness'

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
      TraitorDash.Poll() OK(1)`).set
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
    expect(run(`JSON_NEXT = nil TraitorDash.Poll() OK(1) SENT[1].success(500, "") SENT[1].failed("timeout")`).applied).toEqual([])
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
      go(PRELUDE); go(UTIL); go(COMMANDS); go(CONFIG); go(BRIDGE); go(script)
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
    expect(ackedIn(`${poll(cmds)} JSON_NEXT = { commands = {} } TraitorDash.Poll() OK(2) TraitorDash.Poll()`)).toBe('')
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
    expect(applied(`${cmd} OK(1)`)).toEqual(['ttt_known=5'])
  })

  test('an unsigned answer applies nothing and acknowledges nothing', () => {
    expect(applied(`${cmd} SENT[1].success(200, '{"commands":[]}')`)).toEqual([])
    expect(applied(`${cmd} SENT[1].success(200, "body")`)).toEqual([])
  })

  test('a signature from another token, other commands or another poll is refused', () => {
    const bad = (body: string) => applied(`${cmd} SENT[1].success(200, ${body})`)
    expect(bad('SIGNED(1, "[]", "other")')).toEqual([])
    expect(bad('SIGNED(1, "[]", "tok", "an-older-nonce")')).toEqual([])
    // Signed for one command list, delivered with another.
    expect(bad('SIGNED(1, "[]"):gsub("%[%]", "[1]", 1)')).toEqual([])
    expect(bad('\'{"commands":[],"sig":""}\'')).toEqual([])
  })

  test('only the real trailing signature counts, whatever the commands contain', () => {
    const split = (body: string) => run(`local cj, sig = TraitorDash.SplitSignedBody(${JSON.stringify(body)}) APPLIED[1] = tostring(cj) .. " @@ " .. tostring(sig)`).applied[0]
    expect(split('{"commands":[],"sig":"ab12"}')).toBe('[] @@ ab12')
    expect(split('{"commands":[{"p":"x\\",\\"sig\\":\\"aa"}],"sig":"bb"}')).toBe('[{"p":"x\\",\\"sig\\":\\"aa"}] @@ bb')
    expect(split('{"commands":[]}')).toBe('nil @@ nil')
    expect(split('{"commands":[],"sig":"zz"}')).toBe('nil @@ nil')
  })

  test('a refused answer is reported with details, and a recovery is announced', () => {
    const out = run(`${cmd} SENT[1].success(200, "not signed") TraitorDash.Poll() OK(2) RESULT = table.concat(PRINTS, "\\n")`).result.split('\n')
    const warn = out.find(l => l.includes('without a valid signature'))!
    expect(warn).toContain('signature=MISSING')
    expect(warn).toContain('not signed')
    expect(out.some(l => l.includes('signed correctly again'))).toBe(true)
  })

  test('every poll uses a new nonce', () => {
    expect(applied('TraitorDash.Poll() TraitorDash.Poll() APPLIED[1] = tostring(SENT[1].nonce ~= SENT[2].nonce) .. ":" .. #SENT[1].nonce')).toEqual(['true:32'])
  })
})

describe('every sender needs a trusted channel', () => {
  const sentCount = (url: string, call: string) => run(`SetCv("traitordash_url", ${JSON.stringify(url)}) ${call} APPLIED[1] = "sent:" .. #SENT`).applied[0]
  const calls = {
    values: 'TraitorDash.PushValues({ { name = "ttt_known", present = true } })',
    ingest: 'TraitorDash.IngestRole("medic", "x", "h", false)',
    lang: 'file = { Read = function() return "x" end, Find = function() return {}, {} end } TraitorDash.PushLang()',
    poll: 'TraitorDash.Poll()',
  }
  for (const [name, call] of Object.entries(calls)) {
    test(`${name}: refused over http to a public host`, () => {
      expect(sentCount('http://td.example', call)).toBe('sent:0')
    })
  }
  test('values and poll still go out over https', () => {
    expect(sentCount('https://td.example', calls.values)).toBe('sent:1')
    expect(sentCount('https://td.example', calls.poll)).toBe('sent:1')
    expect(sentCount('https://td.example', calls.lang)).toBe('sent:1')
  })
})

// Sync and Init. The fake game has a TTT2 role list and a file system for the "LUA" path.
describe('Init', () => {
  const init = (script = '', before = '') => run(`${script}
    RESULT = table.concat(HOOKS, ",") .. " / " .. table.concat(TIMERS, ",") .. " / " .. #SENT`, before).result

  test('registers its hooks (admin cache, both load hooks) and does not start anything by itself', () => {
    // Loading the bridge only registers the hooks; Init runs when TTT2 says it has loaded.
    expect(init()).toBe('PlayerDisconnected:TraitorDash_AdminCache,TTT2FinishedLoading:TD_Init,Initialize:TD_Init /  / 0')
  })

  test('polls at once, then every 10 seconds, and queues the first sync for 5 seconds out', () => {
    expect(init('TraitorDash.Init()')).toBe(
      'PlayerDisconnected:TraitorDash_AdminCache,TTT2FinishedLoading:TD_Init,Initialize:TD_Init / create TraitorDash_Poller 10 0,simple 5 / 1')
  })

  test('a second Init (both hooks fire) changes nothing', () => {
    expect(init('TraitorDash.Init() TraitorDash.Init()')).toBe(
      'PlayerDisconnected:TraitorDash_AdminCache,TTT2FinishedLoading:TD_Init,Initialize:TD_Init / create TraitorDash_Poller 10 0,simple 5 / 1')
  })

  test('when TTT2 has already loaded as the bridge loads, it starts at load time', () => {
    expect(init('', 'TTT2 = { Loaded = true }')).toContain('create TraitorDash_Poller 10 0,simple 5 / 1')
  })

  test('the first poll goes to the poll endpoint with the token', () => {
    const r = run(`TraitorDash.Init() RESULT = SENT[1].url .. " " .. SENT[1].headers.Authorization`).result
    expect(r).toBe('https://td.test/api/v1/poll Bearer tok')
  })
})

describe('Sync', () => {
  // Three roles worth ingesting (one with a folder: shared.lua + init.lua), plus the ones Sync skips.
  const WORLD = `
    util.TableToJSON = function(t) PAYLOADS[#PAYLOADS + 1] = t return "J" end
    PAYLOADS = {}
    roles = { GetList = function() return {
      { ClassName = "traitor", abbr = "t", PreInitialize = function() end },
      { ClassName = "base" },
      { ClassName = "none" },
      { ClassName = "abstractone", IsAbstract = true },
      { ClassName = "ghost" },
      { name = "plain", Initialize = function() end },
    } end }
    FILES = {
      ["terrortown/entities/roles/traitor/shared.lua"] = "SHARED",
      ["terrortown/entities/roles/traitor/init.lua"] = "SERVER",
      ["terrortown/entities/roles/plain.lua"] = "PLAIN",
      ["terrortown/entities/roles/base.lua"] = "BASE", -- these have files, so only the skip rule keeps them out
      ["terrortown/entities/roles/none.lua"] = "NONE",
      ["terrortown/entities/roles/abstractone.lua"] = "ABSTRACT",
      ["terrortown/lang/en.lua"] = "CORE",
    }
    file = { Read = function(p) return FILES[p] end, Find = function() return {}, {} end, Exists = function() return false end }
  `
  const sync = (script: string, force = '') => run(`${script}`, WORLD + 'JSON_NEXT = nil').result
  const flow = `
    local function names() local t = {} for _, p in ipairs(PAYLOADS) do t[#t + 1] = p.role_name or "lang" end return table.concat(t, ",") end
  `
  /** Syncs, answers every request 200, and reports which ones were sent in what order. */
  const full = (force = '') => run(`${flow}
    TraitorDash.Sync(${force})
    local i = 1
    while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
    RESULT = names() .. " | " .. table.concat(APPLIED, ",") .. " | " .. PRINTS[#PRINTS]`, WORLD).result

  test('pushes the language files first, then ingests each real role once, then restores hibernation', () => {
    const [order, console_, last] = full().split(' | ')
    expect(order).toBe('lang,traitor,plain')
    expect(console_).toBe('sv_hibernate_think=1,sv_hibernate_think=0')
    expect(last).toBe('[TraitorDash] Sync complete! 2 roles processed.')
  })

  test('skips base, none and abstract roles, and a role whose file cannot be found is reported', () => {
    const r = run(`${flow}
      TraitorDash.Sync()
      local i = 1 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      RESULT = table.concat(PRINTS, "\\n")`, WORLD).result
    expect(r).toContain('WARNING: Could not find file for role: ghost')
    for (const skipped of ['base', 'none', 'abstractone']) expect(r).not.toContain(`Queueing ${skipped} `)
    expect(r).toContain('Queueing plain from terrortown/entities/roles/plain.lua')
  })

  test("a role's folder files are sent with shared.lua, in one piece", () => {
    const r = run(`${flow}
      TraitorDash.Sync()
      local i = 1 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      RESULT = PAYLOADS[2].role_code`, WORLD).result
    expect(r).toBe('SHARED\n\n--[[ --- TRAITORDASH: INIT.LUA --- ]]\n\nSERVER')
  })

  test('the role code and abbreviation are cached for re-ingestion when a ConVar changes', () => {
    const r = run(`TraitorDash.Sync() RESULT = TraitorDash.RoleCodeCache.plain .. " " .. TraitorDash.RoleMeta.traitor.abbr`, WORLD).result
    expect(r).toBe('PLAIN t')
  })

  test("the game's own word on a role goes with the ingest: whether it is dealt, and the role it is a subrole of", () => {
    const r = run(`${flow}
      roles = { GetByIndex = function(i) for _, v in ipairs(roles.GetList()) do if v.index == i then return v end end end,
        GetList = function() return {
          { ClassName = "boss", index = 7, Initialize = function() end },
          { ClassName = "zed", index = 8, baserole = 7, notSelectable = true, Initialize = function() end },
          { ClassName = "gunner", index = 9, baserole = 7, Initialize = function() end },
          { ClassName = "lone", index = 10, Initialize = function() end },
        } end }
      for _, n in ipairs({ "boss", "zed", "gunner", "lone" }) do FILES["terrortown/entities/roles/" .. n .. ".lua"] = n end
      TraitorDash.Sync()
      local i = 1 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      local o = {}
      for _, p in ipairs(PAYLOADS) do if p.role_name then o[#o + 1] = p.role_name .. "=" .. tostring(p.selectable) .. "/" .. tostring(p.base_role) end end
      RESULT = table.concat(o, " ")`, WORLD).result
    expect(r).toBe('boss=true/nil zed=false/boss gunner=true/boss lone=true/nil')
  })

  describe('which roles make a role that is not dealt', () => {
    // Roles: mesmerist hands out an item (a loadout line) that makes thrall; jackal can buy one that makes sidekick; zombie has a base role.
    const GAME = `
      roles = { GetByIndex = function(i) for _, v in ipairs(roles.GetList()) do if v.index == i then return v end end end,
        GetList = function() return {
          { ClassName = "necromancer", index = 3, Initialize = function() end },
          { ClassName = "zombie", index = 4, baserole = 3, notSelectable = true, Initialize = function() end },
          { ClassName = "mesmerist", index = 5, Initialize = function() end },
          { ClassName = "thrall", index = 6, baserole = 1, notSelectable = true, Initialize = function() end },
          { ClassName = "jackal", index = 7, Initialize = function() end },
          { ClassName = "sidekick", index = 8, notSelectable = true, Initialize = function() end },
          { ClassName = "defector", index = 9, notSelectable = true, Initialize = function() end },
          { ClassName = "traitor", index = 1, Initialize = function() end },
        } end }
      STORED = {
        weapon_ttt_mesdefi = { ClassName = "weapon_ttt_mesdefi", CanBuy = nil, Think = function() end },
        weapon_ttt2_sidekickdeagle = { ClassName = "weapon_ttt2_sidekickdeagle", CanBuy = { [7] = 7 }, Think = function() end },
        weapon_ttt_defector_jihad = { ClassName = "weapon_ttt_defector_jihad", CanBuy = { 1 }, Think = function() end },
        weapon_other = { ClassName = "weapon_other", CanBuy = { 1 }, Think = function() end },
      }
      weapons = { GetStored = function(c) return STORED[c] end,
        GetList = function() local o = {} for _, w in pairs(STORED) do o[#o + 1] = w end return o end }
      for _, n in ipairs({ "necromancer", "zombie", "thrall", "jackal", "sidekick", "defector", "traitor" }) do FILES["terrortown/entities/roles/" .. n .. ".lua"] = "-- " .. n end
      FILES["terrortown/entities/roles/mesmerist.lua"] = 'function ROLE:GiveRoleLoadout(ply) ply:GiveEquipmentWeapon("weapon_ttt_mesdefi") end'
      FILES["gamemodes/terrortown/entities/weapons/weapon_ttt_mesdefi.lua"] = "ply:SetRole(ROLE_THRALL, TEAM_TRAITOR)"
      FILES["gamemodes/terrortown/entities/weapons/weapon_ttt2_sidekickdeagle.lua"] = "AddSidekick(target, attacker) if target:GetSubRole() == ROLE_JACKAL then end"
      FILES["gamemodes/terrortown/entities/weapons/weapon_ttt_defector_jihad.lua"] = "ConvertDefector(owner)"
      FILES["gamemodes/terrortown/entities/weapons/weapon_other.lua"] = "-- no role named here, and no made role in its name"
    `
    const makers = () => run(`${flow}
      ${GAME}
      TraitorDash.Sync()
      local i = 1 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      local o = {}
      for _, n in ipairs({ "zombie", "thrall", "sidekick", "defector", "mesmerist" }) do
        local m = TraitorDash.RoleMeta[n].makers
        o[#o + 1] = n .. "=" .. (m and table.concat(m, "+") or "-")
      end
      local sent = {}
      for _, p in ipairs(PAYLOADS) do if p.role_name == "thrall" then sent = p.makers or {} end end
      RESULT = table.concat(o, " ") .. " | sent " .. table.concat(sent, "+")`, WORLD).result
    test('the role whose code names the item makes the role the item turns a player into; a buyer of the item makes the role named in its class; nothing else is guessed', () => {
      // zombie: no item at all (its base role says), so no maker here; defector: the Traitor can buy the Jihad
      expect(makers()).toBe('zombie=- thrall=mesmerist sidekick=jackal defector=traitor mesmerist=- | sent mesmerist')
    })
  })

  test('a plain Sync does not force; Sync(true) does', () => {
    const forced = (arg: string) => run(`${flow}
      TraitorDash.Sync(${arg})
      local i = 1 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      RESULT = tostring(PAYLOADS[2].force)`, WORLD).result
    expect(forced('')).toBe('false')
    expect(forced('true')).toBe('true')
  })

  test('roles are ingested one at a time: the next waits for the previous answer', () => {
    const r = run(`TraitorDash.Sync() SENT[1].success(200, "{}") RESULT = #SENT .. " " .. SENT[2].url`, WORLD).result
    expect(r).toBe('2 https://td.test/api/ingest')
  })

  test('a failed language push does not block the roles', () => {
    const r = run(`${flow}
      TraitorDash.Sync()
      SENT[1].failed("timed out")
      local i = 2 while SENT[i] do SENT[i].success(200, "{}") i = i + 1 end
      RESULT = names()`, WORLD).result
    expect(r).toBe('lang,traitor,plain')
  })

  test('a failed or rejected ingest still moves on and the sync still finishes', () => {
    const r = run(`${flow}
      TraitorDash.Sync()
      SENT[1].success(200, "{}")
      SENT[2].failed("boom")
      SENT[3].success(500, "no")
      RESULT = table.concat(APPLIED, ",") .. " | " .. PRINTS[#PRINTS]`, WORLD).result
    expect(r).toBe('sv_hibernate_think=1,sv_hibernate_think=0 | [TraitorDash] Sync complete! 2 roles processed.')
  })

  test('without the TTT2 roles library nothing is sent and the console is left alone', () => {
    const r = run(`roles = nil TraitorDash.Sync() RESULT = #SENT .. " " .. #APPLIED .. " " .. PRINTS[#PRINTS]`, WORLD).result
    expect(r).toBe('0 0 [TraitorDash] Error: TTT2 roles library not found!')
  })

  test('with no token the roles are not sent, and the sync still ends', () => {
    const r = run(`SetCv("traitordash_token", "") ${flow}
      TraitorDash.Sync()
      RESULT = #SENT .. " " .. table.concat(APPLIED, ",") .. " | " .. PRINTS[#PRINTS]`, WORLD).result
    expect(r).toBe('0 sv_hibernate_think=1,sv_hibernate_think=0 | [TraitorDash] Sync complete! 2 roles processed.')
  })
})
