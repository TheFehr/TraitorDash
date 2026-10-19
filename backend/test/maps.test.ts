import { expect, test, describe } from 'bun:test'
import { run } from './helpers/bridge_harness'

// Prototype: what can the bridge tell the backend about a server's maps? Everything GMod exposes
// is collected (maps on disk, the gamemode's map pattern, the map cycle, a map-vote addon's
// prefixes), so one run on the real server shows which signal is authoritative.

const SETUP = `
  -- FILES["maps/x.bsp"] = size; CYCLE = text of the map cycle file or nil
  FILES, CYCLE, GAMEMODES = {}, nil, {}
  GAME_NAME = "terrortown"
  game = game or {}
  game.GetMap = function() return "ttt_current" end
  game.GetMapNext = function() return "ttt_next" end
  engine = {
    ActiveGamemode = function() return GAME_NAME end,
    GetGamemodes = function() return GAMEMODES end,
    GetAddons = function() return ADDONS or {} end,
  }
  local realFile = file
  file = setmetatable({
    Find = function(pattern, where)
      local out = {}
      for path in pairs(FILES) do
        local name = path:match("^maps/(.+%.bsp)$")
        if name and pattern == "maps/*.bsp" and where == "GAME" then out[#out + 1] = name end
      end
      table.sort(out)
      return out, {}
    end,
    Size = function(path, where) return FILES[path] or -1 end,
    Read = function(path, where)
      if where == "GAME" and path == "cfg/mapcycle.txt" then return CYCLE end
      return realFile.Read(path, where)
    end,
  }, { __index = realFile })
  GetConVar = (function(real) return function(n)
    if n == "mapcyclefile" then return { GetString = function() return "mapcycle.txt" end } end
    return real(n)
  end end)(GetConVar)
  util.TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end
  util.JSONToTable = JSON_DECODE
  SUPER = { IsSuperAdmin = function() return true end }
  PLAIN = { IsSuperAdmin = function() return false end }
  function MAPS() return TraitorDash.CollectMaps() end
  function BYNAME(r) local t = {} for _, m in ipairs(r.maps) do t[m.name] = m end return t end
`
const out = (body: string) => run(`${SETUP}\n${body}`).result

describe('CollectMaps', () => {
  test('lists the maps on disk without the extension, with their sizes', () => {
    expect(out(`FILES = { ["maps/ttt_a.bsp"] = 100, ["maps/ttt_b.bsp"] = 250 }
      local r = MAPS() RESULT = #r.maps .. " " .. r.maps[1].name .. ":" .. r.maps[1].size .. " " .. r.maps[2].name .. ":" .. r.maps[2].size`)).toBe('2 ttt_a:100 ttt_b:250')
  })

  test('reports the running and the next map and the active gamemode', () => {
    expect(out('local r = MAPS() RESULT = r.current .. " " .. r.next .. " " .. r.gamemode')).toBe('ttt_current ttt_next terrortown')
  })

  test('marks which maps match the gamemode\'s map pattern', () => {
    expect(out(`GAMEMODES = { { name = "sandbox", maps = "^gm_" }, { name = "terrortown", maps = "^ttt_" } }
      FILES = { ["maps/ttt_a.bsp"] = 1, ["maps/gm_flat.bsp"] = 1, ["maps/de_dust.bsp"] = 1 }
      local r = MAPS() local m = BYNAME(r)
      RESULT = r.pattern .. " " .. tostring(m.ttt_a.matchesGamemode) .. " " .. tostring(m.gm_flat.matchesGamemode) .. " " .. tostring(m.de_dust.matchesGamemode)`)).toBe('^ttt_ true false false')
  })

  test('without a pattern for the active gamemode nothing claims to match', () => {
    expect(out(`GAMEMODES = { { name = "sandbox", maps = "^gm_" } }
      FILES = { ["maps/ttt_a.bsp"] = 1 }
      local r = MAPS() RESULT = tostring(r.pattern) .. " " .. tostring(BYNAME(r).ttt_a.matchesGamemode)`)).toBe('nil nil')
  })

  test('a broken pattern does not break the inventory', () => {
    expect(out(`GAMEMODES = { { name = "terrortown", maps = "[" } }
      FILES = { ["maps/ttt_a.bsp"] = 1 }
      local r = MAPS() RESULT = #r.maps .. " " .. tostring(BYNAME(r).ttt_a.matchesGamemode)`)).toBe('1 nil')
  })

  test('reads the map cycle: comments and blank lines are skipped, names are trimmed', () => {
    expect(out(`CYCLE = "// our rotation\\nttt_a\\n\\n  ttt_b  \\r\\n// ttt_off\\n"
      FILES = { ["maps/ttt_a.bsp"] = 1, ["maps/ttt_b.bsp"] = 1, ["maps/ttt_c.bsp"] = 1 }
      local r = MAPS() local m = BYNAME(r)
      RESULT = r.cycle.file .. " " .. table.concat(r.cycle.maps, ",") .. " " .. tostring(m.ttt_a.inCycle) .. tostring(m.ttt_b.inCycle) .. tostring(m.ttt_c.inCycle)`)).toBe('cfg/mapcycle.txt ttt_a,ttt_b truetruefalse')
  })

  test('a cycle entry with no map on disk is reported as missing', () => {
    expect(out(`CYCLE = "ttt_a\\nttt_gone\\n"
      FILES = { ["maps/ttt_a.bsp"] = 1 }
      local r = MAPS() RESULT = table.concat(r.cycle.missing, ",")`)).toBe('ttt_gone')
  })

  test('no map cycle file is not an error', () => {
    expect(out(`FILES = { ["maps/ttt_a.bsp"] = 1 }
      local r = MAPS() RESULT = tostring(r.cycle.maps == nil or #r.cycle.maps == 0) .. " " .. tostring(BYNAME(r).ttt_a.inCycle)`)).toBe('true false')
  })

  test('picks up a map-vote addon\'s prefixes when one is installed', () => {
    expect(out(`MapVote = { Config = { MapPrefixes = { "ttt_", "mu_" }, RTVPlayerCount = 3 } }
      local r = MAPS() RESULT = tostring(r.mapvote.present) .. " " .. table.concat(r.mapvote.prefixes, ",")`)).toBe('true ttt_,mu_')
    expect(out('local r = MAPS() RESULT = tostring(r.mapvote.present)')).toBe('false')
  })

  test('counts the mounted addons that are maps', () => {
    expect(out(`ADDONS = { { mounted = true, tags = "map,fun" }, { mounted = true, tags = "gamemode" }, { mounted = false, tags = "map" } }
      local r = MAPS() RESULT = r.addons.mounted .. " " .. r.addons.maps`)).toBe('2 1')
  })
})

describe('the map vote: config file, cooldown list and ConVars', () => {
  const FILES3 = `FILES = { ["maps/ttt_a.bsp"] = 1, ["maps/ttt_b.bsp"] = 1, ["maps/ttt_current.bsp"] = 1, ["maps/gm_flat.bsp"] = 1 }`
  const CONFIG = (extra = '') => `DATA["mapvote/config.txt"] = '{"MapPrefixes":["ttt_"],"MapLimit":24,"AllowCurrentMap":false,"EnableCooldown":true${extra}}'`
  const FLAGS = 'local r = MAPS() local m = BYNAME(r) local function f(n) return tostring(m[n].inVotePool) .. "/" .. tostring(m[n].onCooldown) .. "/" .. tostring(m[n].isCurrent) .. "/" .. tostring(m[n].votable) end'

  test('without the addon\'s global, the prefixes come from data/mapvote/config.txt', () => {
    expect(out(`${CONFIG()}\nlocal r = MAPS() RESULT = r.mapvote.configSource .. " " .. table.concat(r.mapvote.prefixes, ",") .. " " .. math.floor(r.mapvote.config.MapLimit)`)).toBe('file ttt_ 24')
  })

  test('the addon\'s own config, when it is loaded, wins over the file', () => {
    expect(out(`${CONFIG()}\nMapVote = { Config = { MapPrefixes = { "mu_" } } }\nlocal r = MAPS() RESULT = r.mapvote.configSource .. " " .. table.concat(r.mapvote.prefixes, ",")`)).toBe('merged mu_')
    expect(out(`MapVote = { Config = { MapPrefixes = { "mu_" } } }\nlocal r = MAPS() RESULT = r.mapvote.configSource`)).toBe('global')
  })

  test('an addon config table with none of the known keys does not shadow the file', () => {
    // seen on the real server: MapVote.Config exists but is empty (or keyed differently)
    expect(out(`${CONFIG()}\nMapVote = { Config = {} }\nlocal r = MAPS() RESULT = r.mapvote.configSource .. " " .. table.concat(r.mapvote.prefixes, ",")`)).toBe('file ttt_')
    expect(out(`${CONFIG()}\nMapVote = { Config = { SomethingElse = 1 } }\nlocal r = MAPS() RESULT = r.mapvote.configSource`)).toBe('file')
  })

  test('settings merge per key: the loaded config wins, the file fills what it lacks (seen on the real server)', () => {
    // the addon's table has only MapLimit and AllowCurrentMap; the prefixes exist only in the file
    expect(out(`${CONFIG()}\nMapVote = { Config = { MapLimit = 12, AllowCurrentMap = false } }
      local r = MAPS() RESULT = r.mapvote.configSource .. " " .. table.concat(r.mapvote.prefixes, ",") .. " " .. math.floor(r.mapvote.config.MapLimit)`)).toBe('merged ttt_ 12')
  })

  test('with no prefixes anywhere the gamemode pattern decides the pool, and says so', () => {
    expect(out(`GAMEMODES = { { name = "terrortown", maps = "^ttt_" } }\n${FILES3}\nMapVote = { Config = { MapLimit = 12 } }\n${FLAGS}
      RESULT = r.mapvote.poolBasis .. " " .. f("ttt_a") .. " " .. f("gm_flat") .. " " .. f("ttt_current")`)).toBe('gamemode true/false/false/true false/false/false/false true/false/true/false')
  })

  test('prefixes beat the gamemode pattern, and name themselves as the basis', () => {
    expect(out(`GAMEMODES = { { name = "terrortown", maps = "^gm_" } }\n${CONFIG()}\n${FILES3}\n${FLAGS}
      RESULT = r.mapvote.poolBasis .. " " .. f("ttt_a") .. " " .. f("gm_flat")`)).toBe('prefixes true/false/false/true false/false/false/false')
  })

  test('with neither prefixes nor a pattern there is no pool basis', () => {
    expect(out(`${FILES3}\n${FLAGS} RESULT = tostring(r.mapvote.poolBasis) .. " " .. f("ttt_a")`)).toBe('nil nil/false/false/nil')
  })

  test('lists the key names the addon exposes, to find where its settings live', () => {
    expect(out(`MapVote = { Config = { Alpha = 1, Beta = 2 }, Start = function() end, Votes = {} }
      local r = MAPS() RESULT = table.concat(r.mapvote.globalKeys, ",") .. " | " .. table.concat(r.mapvote.configKeys, ",")`)).toBe('Config,Start,Votes | Alpha,Beta')
  })

  test('the mapvote_ ConVars are the live values: they override the file', () => {
    expect(out(`${CONFIG()}\n${FILES3}\nREAL_CVARS.mapvote_allowcurrentmap = "1"\n${FLAGS}
      RESULT = f("ttt_current")`)).toBe('true/false/true/true')
    expect(out(`${CONFIG()}\n${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp"]'\nREAL_CVARS.mapvote_enablecooldown = "0"\n${FLAGS}
      RESULT = f("ttt_b")`)).toBe('true/true/false/true')
    // and a ConVar set to 0 beats a file that says true
    expect(out(`DATA["mapvote/config.txt"] = '{"MapPrefixes":["ttt_"],"AllowCurrentMap":true}'\n${FILES3}\nREAL_CVARS.mapvote_allowcurrentmap = "0"\n${FLAGS}
      RESULT = f("ttt_current")`)).toBe('true/false/true/false')
  })

  test('flags each map: in the vote pool, on cooldown, the current map, votable right now', () => {
    expect(out(`${CONFIG()}\n${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp"]'\n${FLAGS}
      RESULT = f("ttt_a") .. " " .. f("ttt_b") .. " " .. f("ttt_current") .. " " .. f("gm_flat")`))
      .toBe('true/false/false/true true/true/false/false true/false/true/false false/false/false/false')
  })

  test('AllowCurrentMap and EnableCooldown change what is votable', () => {
    expect(out(`DATA["mapvote/config.txt"] = '{"MapPrefixes":["ttt_"],"AllowCurrentMap":true,"EnableCooldown":false}'\n${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp"]'\n${FLAGS}
      RESULT = f("ttt_b") .. " " .. f("ttt_current")`)).toBe('true/true/false/true true/false/true/true')
  })

  test('a config that does not mention the cooldown or the current map gets MapVote\'s defaults (cooldown on, current map out)', () => {
    expect(out(`DATA["mapvote/config.txt"] = '{"MapPrefixes":["ttt_"]}'\n${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp"]'\n${FLAGS}
      RESULT = f("ttt_b") .. " " .. f("ttt_current") .. " " .. f("ttt_a")`)).toBe('true/true/false/false true/false/true/false true/false/false/true')
  })

  test('recent maps that are no longer on disk are listed', () => {
    expect(out(`${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp","ttt_gone.bsp"]'\nlocal r = MAPS() RESULT = table.concat(r.mapvote.recent, ",") .. " " .. table.concat(r.mapvote.recentMissing, ",")`)).toBe('ttt_b,ttt_gone ttt_gone')
  })

  test('the mapvote_ ConVars that exist are reported, without the prefix', () => {
    expect(out(`REAL_CVARS.mapvote_maplimit = "9" REAL_CVARS.mapvote_timelimit = "30"\nlocal r = MAPS() RESULT = r.mapvote.convars.maplimit .. " " .. r.mapvote.convars.timelimit .. " " .. tostring(r.mapvote.convars.rtvplayercount)`)).toBe('9 30 nil')
  })

  test('with no config anywhere nothing claims to be in the pool', () => {
    expect(out(`${FILES3}\n${FLAGS} RESULT = f("ttt_a") .. " " .. r.mapvote.configSource`)).toBe('nil/false/false/nil none')
  })

  test('a broken config file does not break the inventory', () => {
    expect(out(`DATA["mapvote/config.txt"] = "not json"\n${FILES3}\nlocal r = MAPS() RESULT = #r.maps .. " " .. r.mapvote.configSource`)).toBe('4 none')
  })

  test('the console summary counts the vote pool and what is votable now', () => {
    const r = run(`${SETUP}\n${CONFIG()}\n${FILES3}\nDATA["mapvote/recentmaps.txt"] = '["ttt_b.bsp"]'\nCONCMDS.traitordash_maps(nil, "traitordash_maps", {})\nRESULT = table.concat(PRINTS, "\\n")`).result
    expect(r).toContain('3 in the vote pool (1 votable now)')
  })
})

describe('traitordash_maps', () => {
  const cmd = (body: string) => run(`${SETUP}\n${body}\nRESULT = table.concat(PRINTS, "\\n") .. "\\n#FILES=" .. (function() local n = {} for k in pairs(DATA) do n[#n + 1] = k end table.sort(n) return table.concat(n, ",") end)()`).result

  test('is superadmin or console only', () => {
    const r = cmd('CONCMDS.traitordash_maps(PLAIN, "traitordash_maps", {})')
    expect(r).toContain('#FILES=')
    expect(r).not.toContain('maps.json')
  })

  test('writes data/traitordash/maps.json and prints a summary', () => {
    const r = cmd(`GAMEMODES = { { name = "terrortown", maps = "^ttt_" } }
      CYCLE = "ttt_a\\n"
      FILES = { ["maps/ttt_a.bsp"] = 1, ["maps/gm_flat.bsp"] = 1 }
      CONCMDS.traitordash_maps(nil, "traitordash_maps", {})`)
    expect(r).toContain('#FILES=traitordash/maps.json')
    expect(r).toContain('2 maps on disk')
    expect(r).toContain('1 match the gamemode pattern')
    expect(r).toContain('1 in the map cycle')
  })
})
