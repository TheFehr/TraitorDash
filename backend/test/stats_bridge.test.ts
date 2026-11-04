import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { addJsonDecode } from './helpers/bridge_harness'

// Runs the real addon/lua/traitordash/stats.lua against a minimal fake of GMod/TTT2, plays a
// round through the hooks, and returns what the bridge would have POSTed.
const COMMANDS_LUA = path.join(import.meta.dir, '../../addon/lua/traitordash/commands.lua')
const CONFIG_LUA = path.join(import.meta.dir, '../../addon/lua/traitordash/config.lua')
const STATS = path.join(import.meta.dir, '../../addon/lua/traitordash/stats.lua')

const PRELUDE = `
  WIN_NONE, WIN_TRAITOR, WIN_INNOCENT, WIN_TIMELIMIT = 1, 2, 3, 4
  TEAM_TRAITOR, TEAM_INNOCENT = "traitors", "innocents"
  FCVAR_ARCHIVE = 128
  isnumber = function(v) return type(v) == "number" end
  IsValid = function(v) return v ~= nil and v ~= false end
  local cvars = {}
  function CreateConVar(n, v) cvars[n] = tostring(v) return { GetBool = function() return cvars[n] == "1" end } end
  cvars.traitordash_url = "https://td.test/"; cvars.traitordash_token = "tok"
  function GetConVar(n) return { GetString = function() return cvars[n] end } end
  function SetCv(n, v) cvars[n] = v end
  game = { GetMap = function() return "ttt_test_map" end }
  SysTime = os.clock
  concommand = { Add = function() end }

  local hooks = {}
  hook = { Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end }
  function Fire(ev, ...) for _, fn in pairs(hooks[ev] or {}) do fn(...) end end

  local function enc(v)
    local t = type(v)
    if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
    if t == "number" or t == "boolean" then return tostring(v) end
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
  SENT = {}
  util = { TableToJSON = enc, JSONToTable = JS_JSON_DECODE }
  -- The server's data folder (RFC 8): DATA["traitordash/config.json"] = "<json>".
  DATA = {}
  file = { Read = function(p, where) if where == "DATA" then return DATA[p] end return nil end }
  function HTTP(req) SENT[#SENT + 1] = { url = req.url, auth = req.headers.Authorization, body = req.body } end

  local function mkply(sid, nick, role, team, alive)
    local p = { sid = sid }
    function p:IsPlayer() return true end
    function p:IsBot() return self.bot == true end
    function p:EntIndex() return self.idx or 0 end
    function p:IsTerror() return self.alive end
    function p:SteamID64() return self.sid end
    function p:Nick() return nick end
    function p:GetTeam() return team end
    function p:GetSubRoleData() return { name = role } end
    p.alive = alive ~= false
    return p
  end
  A = mkply("76561198000000001", "Alice", "traitor", "traitors")
  B = mkply("76561198000000002", "Bob", "innocent", "innocents")
  C = mkply("76561198000000003", "Cara", "detective", "innocents")
  BOT = mkply(nil, "Bot", "innocent", "innocents"); BOT.bot = true; BOT.idx = 7
  SPEC = mkply("76561198000000009", "Spec", "innocent", "innocents", false)
  player = { GetAll = function() return { A, B, C, BOT, SPEC } end }
`

function play(script: string): any[] {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  addJsonDecode(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
    }
  }
  try {
    run(PRELUDE)
    run(fs.readFileSync(COMMANDS_LUA, 'utf8'))
    run(fs.existsSync(CONFIG_LUA) ? fs.readFileSync(CONFIG_LUA, 'utf8') : '')
    run(fs.readFileSync(STATS, 'utf8'))
    run(script)
    run('SENT_JSON = "[" .. table.concat((function() local o = {} for i, s in ipairs(SENT) do o[i] = \'{"url":"\' .. s.url .. \'","auth":"\' .. s.auth .. \'","body":\' .. s.body .. "}" end return o end)(), ",") .. "]"')
    lua.lua_getglobal(L, to_luastring('SENT_JSON'))
    return JSON.parse(to_jsstring(lua.lua_tostring(L, -1)))
  } finally {
    lua.lua_close(L)
  }
}

describe('stats.lua', () => {
  test('a normal round posts roles, deaths, survival and the winners once', () => {
    const [sent, ...rest] = play(`
      Fire("TTTPrepareRound")
      Fire("TTTBeginRound")
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      Fire("TTTEndRound", WIN_TRAITOR)
    `)
    expect(rest).toHaveLength(0)
    expect(sent.url).toBe('https://td.test/api/v1/round')
    expect(sent.auth).toBe('Bearer tok')

    const b = sent.body
    expect(b.map).toBe('ttt_test_map')
    expect(b.result).toBe('traitors')
    expect(b.round_id).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    // bots (no SteamID64) and spectators are not reported
    expect(b.players.map((p: any) => p.nick).sort()).toEqual(['Alice', 'Bob', 'Cara'])
    const by = Object.fromEntries(b.players.map((p: any) => [p.nick, p]))
    expect(by.Alice).toMatchObject({ role: 'traitor', team: 'traitors', survived: true, won: true })
    expect(by.Bob).toMatchObject({ role: 'innocent', survived: false, won: false })
    expect(by.Cara).toMatchObject({ role: 'detective', survived: true, won: false })
    expect(b.deaths).toEqual([{ victim: '76561198000000002', attacker: '76561198000000001', at: 0 }])
  })

  test('a time limit counts as an innocent win; a world death has no attacker', () => {
    const [sent] = play(`
      Fire("TTTBeginRound")
      A.alive = false; Fire("TTT2PostPlayerDeath", A, nil, nil)
      Fire("TTTEndRound", WIN_TIMELIMIT)
    `)
    expect(sent.body.result).toBe('timelimit')
    expect(sent.body.deaths[0].attacker).toBeUndefined()
    const by = Object.fromEntries(sent.body.players.map((p: any) => [p.nick, p]))
    expect(by.Bob.won).toBe(true)
    expect(by.Alice.won).toBe(false)
  })

  test('bots are reported only with traitordash_stats_bots, under a synthetic numeric id', () => {
    const [sent] = play(`SetCv("traitordash_stats_bots", "1") Fire("TTTBeginRound") Fire("TTTEndRound", WIN_TRAITOR)`)
    // the mock cvar reads the string "1"; CreateConVar default "0" is replaced by SetCv
    expect(sent.body.players.map((p: any) => p.steam_id)).toContain('999000000007')
  })

  test('survived means alive at the end: a revived player survived, a player who left did not', () => {
    const [sent] = play(`
      Fire("TTTBeginRound")
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      B.alive = true  -- revived before the round ended
      C.alive = false; Fire("TTT2PostPlayerDeath", C, nil, A)
      C.alive = true
      player.GetAll = function() return { A, B, BOT, SPEC } end -- C disconnected
      Fire("TTTEndRound", WIN_TRAITOR)
    `)
    const by = Object.fromEntries(sent.body.players.map((p: any) => [p.nick, p]))
    expect(by.Alice.survived).toBe(true)
    expect(by.Bob.survived).toBe(true) // died, was revived, alive at the end
    expect(by.Cara.survived).toBe(false) // left the server
    expect(sent.body.deaths.map((d: any) => d.victim)).toEqual(['76561198000000002', '76561198000000003']) // both deaths are still recorded
  })

  test('nothing is sent for a round-end without a round, a double end, or when disabled', () => {
    expect(play(`Fire("TTTEndRound")`)).toHaveLength(0)
    expect(play(`Fire("TTTBeginRound") Fire("TTTEndRound", WIN_INNOCENT) Fire("TTTEndRound", WIN_INNOCENT)`)).toHaveLength(1)
    expect(play(`SetCv("traitordash_stats", "0") Fire("TTTBeginRound") Fire("TTTEndRound", WIN_INNOCENT)`)).toHaveLength(0)
  })

  test('an error inside a hook is contained and does not reach the caller', () => {
    // A broken player object would throw inside the begin hook; Fire must still return.
    const sent = play(`
      A.GetSubRoleData = function() error("boom") end
      Fire("TTTBeginRound")
      Fire("TTTEndRound", WIN_TRAITOR)
    `)
    expect(sent).toHaveLength(0)
  })
})

describe('transport', () => {
  test('nothing is sent over plain http to a public host, and a private address is fine', () => {
    const round = 'Fire("TTTPrepareRound") Fire("TTTBeginRound") Fire("TTTEndRound", WIN_TRAITOR)'
    expect(play(`SetCv("traitordash_url", "http://td.example") ${round}`)).toHaveLength(0)
    expect(play(`SetCv("traitordash_url", "http://192.168.1.5:3000") ${round}`)).toHaveLength(1)
  })
})

describe('configuration (RFC 8)', () => {
  const round = 'Fire("TTTPrepareRound") Fire("TTTBeginRound") Fire("TTTEndRound", WIN_TRAITOR)'
  const withConfig = (cfg: unknown) => `DATA["traitordash/config.json"] = ${JSON.stringify(JSON.stringify(cfg))}`

  test('a round goes to the URL and token in data/traitordash/config.json', () => {
    const [sent] = play(`${withConfig({ url: 'https://file.example', token: 'filetoken' })} ${round}`)
    expect(sent.url).toBe('https://file.example/api/v1/round')
    expect(sent.auth).toBe('Bearer filetoken')
  })

  test('with nothing configured nothing is sent, and no Lua error is logged every round', () => {
    // The last entry reports how many printed lines looked like a Lua runtime error.
    const out = play(`SetCv("traitordash_url", "") SetCv("traitordash_token", "")
      local errors = 0
      print = function(...) if tostring((...)):find("attempt to", 1, true) or tostring((...)):find("error", 1, true) then errors = errors + 1 end end
      ${round}
      SENT[#SENT + 1] = { url = "errors:" .. errors, auth = "", body = "null" }`)
    expect(out.map((r: any) => r.url)).toEqual(['errors:0'])
  })

  test('if the configuration could not be loaded at all, nothing is sent (fail closed)', () => {
    expect(play(`TraitorDash.GetConfig = nil ${round}`)).toHaveLength(0)
  })

  test('stats.lua does not read the ConVars itself', () => {
    expect(/GetConVar\(\s*["']traitordash_(url|token)["']/.test(fs.readFileSync(STATS, 'utf8'))).toBe(false)
  })
})

describe('contract with POST /api/v1/round', () => {
  test('a round exactly as stats.lua sends it is accepted and stored by the backend', async () => {
    process.env.TRAITORDASH_DB = ':memory:'
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
    const api = (await import('../src/routes/api')).default
    const { Store } = await import('../src/services/Store')
    const db = (await import('../src/services/Database')).default

    const [sent] = play(`
      Fire("TTTPrepareRound")
      Fire("TTTBeginRound")
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      A.alive = false; Fire("TTT2PostPlayerDeath", A, nil, A)
      Fire("TTTEndRound", WIN_INNOCENT)
    `)
    const server = Store.addServer('Contract')
    const res = await api.request('/v1/round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
      body: JSON.stringify(sent.body),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).stored).toBe(true)

    const round = db.query('SELECT * FROM rounds WHERE server_id = ?').get(server.id) as any
    expect(round.round_id).toBe(sent.body.round_id)
    expect((db.query('SELECT COUNT(*) n FROM round_players WHERE server_id = ?').get(server.id) as any).n).toBeGreaterThan(0)
    expect((db.query('SELECT COUNT(*) n FROM deaths WHERE server_id = ?').get(server.id) as any).n).toBe(2)
  })
})

// RFC 21: what a death was done with and where, and the damage summed for the round. The fake gives players a place and
// a health, hits are a damage info with an attacker, an inflictor and an amount, and the hook is fired the way the game does.
const HITS = `
  for _, p in ipairs({ A, B, C, BOT, SPEC }) do
    p.pos = { x = 100.4, y = -200.6, z = 8 }
    function p:GetPos() return self.pos end
    function p:GetMaxHealth() return 100 end
  end
  local W = function(class) return { GetClass = function() return class end } end
  GUN, SHOTGUN = W("weapon_ttt_m16"), W("weapon_zm_shotgun")
  A.GetActiveWeapon = function() return GUN end
  function Hit(victim, attacker, amount, inflictor, took)
    local info = { GetAttacker = function() return attacker end, GetInflictor = function() return inflictor end, GetDamage = function() return amount end }
    Fire("PostEntityTakeDamage", victim, info, took ~= false)
  end
`

describe('stats.lua: weapons and damage (RFC 21)', () => {
  const roundOf = (script: string) => play(HITS + `Fire("TTTPrepareRound") Fire("TTTBeginRound")\n${script}\nFire("TTTEndRound", WIN_TRAITOR)`)[0]!.body
  const entry = (b: any, w: string, friendly = false) => b.damage.find((e: any) => e.weapon === w && !!e.friendly === friendly)

  test('hits are summed for each attacker, weapon and kind; a pellet is a hit', () => {
    const b = roundOf(`Hit(B, A, 30, A) Hit(B, A, 25.4, GUN) Hit(C, A, 10, SHOTGUN) Hit(C, A, 10, SHOTGUN)`)
    expect(entry(b, 'weapon_ttt_m16')).toMatchObject({ attacker: '76561198000000001', damage: 55.4, hits: 2 })
    expect(entry(b, 'weapon_zm_shotgun')).toMatchObject({ damage: 20, hits: 2 })
    expect(b.damage).toHaveLength(2)
  })

  test('damage to the own team is kept apart', () => {
    const b = roundOf(`Hit(B, A, 10, GUN) Hit(A, A, 5, GUN) Hit(C, B, 7, SHOTGUN)`)
    expect(entry(b, 'weapon_ttt_m16')).toMatchObject({ damage: 10, hits: 1 }) // Alice is a traitor, Bob is not: not friendly
    expect(entry(b, 'weapon_zm_shotgun', true)).toMatchObject({ attacker: '76561198000000002', damage: 7, friendly: true }) // two innocents
    expect(entry(b, 'weapon_zm_shotgun', false)).toBeUndefined()
  })

  test('overkill is capped at the victim\'s health; a hit that was not taken, on a prop or the world, on oneself, on a bot or by a player not in the round adds nothing', () => {
    const b = roundOf(`
      Hit(B, A, 250, GUN)
      Hit(B, A, 10, GUN, false)
      Hit(B, A, 0.2, GUN)
      Hit(B, nil, 10, GUN)
      Hit(A, A, 10, GUN)
      Hit(BOT, A, 10, GUN)
      Hit(B, BOT, 10, GUN)
      Hit(B, SPEC, 10, GUN)
      Hit({ IsPlayer = function() return false end }, A, 10, GUN)
    `)
    expect(b.damage).toHaveLength(1)
    expect(b.damage[0]).toMatchObject({ weapon: 'weapon_ttt_m16', damage: 100, hits: 1 })
  })

  test('the weapon comes from the inflictor, the held weapon when that is the player, and "unknown" when there is none', () => {
    const b = roundOf(`Hit(B, A, 10, A) Hit(C, B, 10, nil)`)
    expect(entry(b, 'weapon_ttt_m16')).toBeDefined()
    expect(b.damage.find((e: any) => e.attacker === '76561198000000002').weapon).toBe('unknown')
  })

  test('a death carries the weapon and the place; a world death has the world as the weapon', () => {
    const b = roundOf(`
      B.alive = false; Fire("TTT2PostPlayerDeath", B, GUN, A)
      C.alive = false; Fire("TTT2PostPlayerDeath", C, W("worldspawn"), nil)
    `)
    expect(b.deaths[0]).toMatchObject({ victim: '76561198000000002', attacker: '76561198000000001', weapon: 'weapon_ttt_m16', x: 100, y: -201, z: 8 })
    expect(b.deaths[1]).toMatchObject({ weapon: 'worldspawn' })
  })

  test('a death with a player that has no position is still reported, without one', () => {
    const [sent] = play(`Fire("TTTPrepareRound") Fire("TTTBeginRound") B.alive = false Fire("TTT2PostPlayerDeath", B, nil, A) Fire("TTTEndRound", WIN_TRAITOR)`)
    expect(sent.body.deaths[0].x).toBeUndefined()
    expect(sent.body.deaths[0].victim).toBe('76561198000000002')
  })

  test('at most 1,024 entries; the next one is dropped, the ones there go on adding', () => {
    const b = roundOf(`
      for i = 1, 1100 do Hit(B, A, 1, W("w" .. i)) end
      Hit(B, A, 1, W("w1"))
    `)
    expect(b.damage).toHaveLength(1024)
    expect(entry(b, 'w1')).toMatchObject({ hits: 2 })
  })

  test('the hook returns nothing, an error in it does not reach the game, and with the stats switched off it does nothing', () => {
    const r = play(HITS + `
      Fire("TTTPrepareRound") Fire("TTTBeginRound")
      local fn
      OUT = {}
      Fire("PostEntityTakeDamage", B, nil, true) -- a broken damage info: caught
      SetCv("traitordash_stats", "0")
      Hit(B, A, 10, GUN)
      Fire("TTTEndRound", WIN_TRAITOR)
    `)
    expect(r).toHaveLength(0)
  })
})
