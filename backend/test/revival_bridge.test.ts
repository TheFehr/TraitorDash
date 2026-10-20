import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { addJsonDecode } from './helpers/bridge_harness'
import { validateTrack } from '../src/services/tracks'

// RFC 14, 4: runs the real addon/lua/traitordash/{stats,track}.lua against a fake of GMod/TTT2 with a
// clock the test controls, and checks what is recorded about role changes and revivals and what
// is sent. The fake follows the sources read for the RFC: the hooks TTT2UpdateSubrole and
// TTT2UpdateTeam (player, old, new), TTT2AddedEvent (name, event) with the respawn event, and the
// defibrillator's TTT2AttemptDefibPlayer (owner, body, weapon) whose answer must stay nil.
const DIR = path.join(import.meta.dir, '../../addon/lua/traitordash')
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

const PRELUDE = `
  WIN_NONE, WIN_TRAITOR, WIN_INNOCENT, WIN_TIMELIMIT = 1, 2, 3, 4
  TEAM_TRAITOR, TEAM_INNOCENT = "traitors", "innocents"
  FCVAR_ARCHIVE = 128
  isnumber = function(v) return type(v) == "number" end
  IsValid = function(v) return v ~= nil and v ~= false end
  local cvars = {}
  function CreateConVar(n, v)
    cvars[n] = tostring(v)
    return { GetBool = function() return cvars[n] == "1" end, GetFloat = function() return tonumber(cvars[n]) end }
  end
  cvars.traitordash_url = "https://td.test/"; cvars.traitordash_token = "tok"
  function GetConVar(n) return { GetString = function() return cvars[n] end } end
  function SetCv(n, v) cvars[n] = v end
  MAP = "ttt_test_map"
  game = { GetMap = function() return MAP end }
  concommand = { Add = function() end }
  engine = { TickInterval = function() return 0.015 end }
  FT = 0.015
  function FrameTime() return FT end

  -- The clock: CurTime is game time and moves only when the test says; SysTime is what a tick costs.
  NOW = 100; COST = 0.00005; SYS = 0
  function CurTime() return NOW end
  function SysTime() local v = SYS SYS = SYS + COST return v end

  local hooks = {}
  hook = { Add = function(ev, id, fn) hooks[ev] = hooks[ev] or {} hooks[ev][id] = fn end }
  function Fire(ev, ...) for _, fn in pairs(hooks[ev] or {}) do fn(...) end end

  -- RFC 14: timer.Simple (run by Flush), TTT2's respawn event name, the corpse lookup, hooks with answers.
  function Flush() local q = SIMPLE SIMPLE = {} for _, fn in ipairs(q) do fn() end end
  EVENT_RESPAWN = "respawn"
  BODIES = {}
  CORPSE = { GetPlayer = function(rag) return BODIES[rag] end }
  function FireRet(ev, ...) for _, fn in pairs(hooks[ev] or {}) do local v = fn(...) if v ~= nil then return v end end return nil end
  -- A revival the way TTT2 reports it: the player is alive again and a respawn event goes out.
  function Respawn(ply) ply.alive = true Fire("TTT2AddedEvent", EVENT_RESPAWN, { event = { sid64 = ply.sid, nick = ply:Nick() } }) end
  function Defib(owner, victim, class, reason)
    local rag = {} BODIES[rag] = victim
    local weapon = { GetClass = function() return class or "weapon_ttt_defibrillator" end, revivalReason = reason or "revived_by_player" }
    return FireRet("TTT2AttemptDefibPlayer", owner, rag, weapon)
  end

  -- timer: one repeating timer at a time is all the tracker uses.
  TIMERS = {}
  timer = {
    Create = function(n, d, r, fn) TIMERS[n] = { delay = d, fn = fn } end,
    Adjust = function(n, d) if TIMERS[n] then TIMERS[n].delay = d end return true end,
    Exists = function(n) return TIMERS[n] ~= nil end,
    Remove = function(n) TIMERS[n] = nil end,
  }
  -- Lets the clock run: each step waits the timer's current delay, then runs it, as the engine would.
  function Run(n, each)
    for i = 1, n do
      local t = TIMERS.TraitorDash_Track
      if not t then return i - 1 end
      NOW = NOW + (each or t.delay)
      t.fn()
    end
    return n
  end
  SIMPLE = {}
  timer.Simple = function(d, fn) SIMPLE[#SIMPLE + 1] = fn end
  function Count() local n = 0 for _ in pairs(TIMERS) do n = n + 1 end return n end

  PRINTED = {}
  local realprint = print
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end

  local function enc(v)
    local t = type(v)
    if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
    if t == "number" then if v ~= v or v == math.huge then return "null" end return tostring(v) end
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
  SENT = {}
  util = { TableToJSON = enc, JSONToTable = JS_JSON_DECODE }
  DATA = {}
  file = { Read = function(p, where) if where == "DATA" then return DATA[p] end return nil end }
  function HTTP(req) SENT[#SENT + 1] = req end

  local function mkply(sid, nick, role, team, x, y)
    local p = { sid = sid, x = x or 0, y = y or 0, z = 0, yaw = 0 }
    function p:IsPlayer() return true end
    function p:IsBot() return false end
    function p:EntIndex() return 1 end
    function p:IsTerror() return self.alive end
    function p:SteamID64() return self.sid end
    function p:Nick() return nick end
    function p:GetTeam() return self.team end
    function p:GetSubRoleData() if self.boomrole then error('role failed') end return { name = self.role } end
    function p:GetPos() if self.boom then error("GetPos failed") end return { x = self.x, y = self.y, z = self.z } end
    function p:EyeAngles() return { y = self.yaw } end
    p.alive = true; p.role = role; p.team = team
    return p
  end
  A = mkply("76561198000000001", "Alice", "traitor", "traitors", 800, -400)
  B = mkply("76561198000000002", "Bob", "innocent", "innocents", 80, 160)
  C = mkply("76561198000000003", "Cara", "detective", "innocents", 0, 0)
  SPEC = mkply("76561198000000009", "Spec", "innocent", "innocents"); SPEC.alive = false
  PLAYERS = { A, B, C, SPEC }
  player = { GetAll = function() return PLAYERS end }
  function Begin() Fire("TTTPrepareRound") Fire("TTTBeginRound") end
  function Accept(i, code) local r = SENT[i] if r and r.success then r.success(code or 200, "{}") end end
`

interface Run { sent: { url: string, auth: string, body: any }[], printed: string[], out: any }

function play(script: string, tracking = true): Run {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  addJsonDecode(L)
  const run = (code: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)))
  }
  try {
    run(PRELUDE)
    run(read('commands.lua'))
    run(read('config.lua'))
    run(read('track.lua'))
    run(read('stats.lua'))
    if (tracking) run('SetCv("traitordash_track", "1")')
    run(script)
    run(`
      local o = {}
      for i, s in ipairs(SENT) do o[i] = '{"url":"' .. s.url .. '","auth":"' .. s.headers.Authorization .. '","body":' .. s.body .. "}" end
      SENT_JSON = "[" .. table.concat(o, ",") .. "]"
      PRINTED_JSON = ENC(PRINTED)
      OUT_JSON = OUT ~= nil and ENC(OUT) or "null"
    `)
    const get = (n: string) => { lua.lua_getglobal(L, to_luastring(n)); return to_jsstring(lua.lua_tostring(L, -1)) }
    return { sent: JSON.parse(get('SENT_JSON')), printed: JSON.parse(get('PRINTED_JSON')), out: JSON.parse(get('OUT_JSON')) }
  } finally {
    lua.lua_close(L)
  }
}

const A = '76561198000000001', B = '76561198000000002', C = '76561198000000003'
const trackOf = (r: Run) => r.sent.find(s => s.url.endsWith('/api/v1/track'))?.body
const roundOf = (r: Run) => r.sent.find(s => s.url.endsWith('/api/v1/round'))?.body
const playerOf = (round: any, id: string) => round.players.find((p: any) => p.steam_id === id)

const end = `Fire("TTTEndRound", WIN_TRAITOR); Accept(1)`

describe('role changes (4.1)', () => {
  test('both hooks for one change give one role event with the settled role and team, and the report has the end state', () => {
    const r = play(`
      Begin(); Run(2)
      B.role, B.team = "zombie", "necromancers"
      Fire("TTT2UpdateSubrole", B, 1, 2); Fire("TTT2UpdateTeam", B, "innocents", "necromancers")
      Flush(); Run(2)
      ${end}
    `)
    expect(trackOf(r).events).toEqual([{ t: 400, p: B, k: 'role', role: 'zombie', team: 'necromancers' }])
    expect(playerOf(roundOf(r), B)).toMatchObject({ role: 'innocent', team: 'innocents', end_role: 'zombie', end_team: 'necromancers' })
    expect(playerOf(roundOf(r), A)).toMatchObject({ role: 'traitor', end_role: 'traitor', end_team: 'traitors' })
  })

  test('a change that ends where it started, and one before the round begins, give nothing', () => {
    const r = play(`
      Fire("TTTPrepareRound"); B.role = "sheriff"; Fire("TTT2UpdateSubrole", B, 1, 2); Flush(); B.role = "innocent"
      Fire("TTTBeginRound"); Run(1)
      B.role = "deputy"; Fire("TTT2UpdateSubrole", B, 1, 2); B.role = "innocent"; Flush()
      ${end}
    `)
    expect(trackOf(r).events).toBeUndefined()
    expect(playerOf(roundOf(r), B)).toMatchObject({ role: 'innocent', end_role: 'innocent' })
  })

  test('the change of a dead player is recorded; a getter that fails does not stop the tick or the round', () => {
    const r = play(`
      Begin(); Run(1)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      B.role = "ghost"; Fire("TTT2UpdateSubrole", B, 1, 2); Flush()
      C.boomrole = true; Fire("TTT2UpdateSubrole", C, 1, 2); Flush(); C.boomrole = nil
      Run(2)
      ${end}
    `)
    expect(trackOf(r).events).toEqual([{ t: 200, p: B, k: 'role', role: 'ghost', team: 'innocents' }])
    expect(r.printed.join('\n')).toMatch(/role change error/)
    expect(roundOf(r)).toBeTruthy()
  })

  test('two quick hooks for one player settle once; a hook for someone not in the round is ignored', () => {
    const r = play(`
      Begin(); Run(1)
      B.role = "x"; Fire("TTT2UpdateSubrole", B, 1, 2); Fire("TTT2UpdateTeam", B, "a", "b"); OUT = { queued = #SIMPLE }
      SPEC.role = "y"; Fire("TTT2UpdateSubrole", SPEC, 1, 2); Flush()
      ${end}
    `)
    expect(r.out.queued).toBe(1)
    expect(trackOf(r).events).toHaveLength(1)
  })

  test('1,025 changes stop at the cap and mark the track truncated', () => {
    const r = play(`
      Begin(); Run(1)
      for i = 1, 1025 do B.role = "r" .. (i % 2) .. "x" .. i; Fire("TTT2UpdateSubrole", B, 1, 2); Flush() end
      ${end}
    `)
    expect(trackOf(r).events).toHaveLength(1024)
    expect(trackOf(r).truncated).toBe(true)
  })

  test('with tracking off there is no track, but the end state and the report are right', () => {
    const r = play(`
      Begin()
      B.role, B.team = "zombie", "necromancers"; Fire("TTT2UpdateSubrole", B, 1, 2); Flush()
      Fire("TTTEndRound", "necromancers"); Accept(1)
    `, false)
    expect(trackOf(r)).toBeUndefined()
    expect(playerOf(roundOf(r), B)).toMatchObject({ end_role: 'zombie', end_team: 'necromancers', won: true })
  })
})

describe('the win check uses the team a player ended on (4.4)', () => {
  const won = (setup: string, result = 'necromancers') => {
    const r = play(`Begin(); ${setup}; Fire("TTTEndRound", "${result}"); Accept(1)`, false)
    return Object.fromEntries(roundOf(r).players.map((p: any) => [p.steam_id, p.won]))
  }
  test('a start-innocent converted to the winning team won; a start-traitor converted away from it did not', () => {
    const w = won(`
      B.role, B.team = "zombie", "necromancers"; Fire("TTT2UpdateSubrole", B, 1, 2); Flush()
      A.role, A.team = "innocent", "innocents"; Fire("TTT2UpdateSubrole", A, 1, 2); Flush()
    `)
    expect(w[B]).toBe(true)
    expect(w[A]).toBe(false)
  })
  test('a player with no change still wins or loses with the team they started on', () => {
    const w = won('', 'traitors')
    expect(w[A]).toBe(true)
    expect(w[B]).toBe(false)
  })
  test('a change that happens after the hooks is still seen by the last look at the end', () => {
    const w = won('B.role, B.team = "zombie", "necromancers"')
    expect(w[B]).toBe(true)
  })
})

describe('revivals (4.1, 4.2)', () => {
  test('a respawn event of a player who died gives a revive at its time, in the report and the track', () => {
    const r = play(`
      Begin(); Run(2)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      Run(1); NOW = NOW + 0.05; Respawn(B); Run(2)
      ${end}
    `)
    expect(trackOf(r).events).toEqual([{ t: 650, p: B, k: 'revive', how: 'role:innocent' }])
    expect(roundOf(r).revives).toEqual([{ victim: B, how: 'role:innocent', at: 0 }])
  })

  test('the same revival seen again by the tick comparison is one event, not two', () => {
    const r = play(`
      Begin(); Run(1)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A); Run(2)
      Respawn(B); Run(3)
      ${end}
    `)
    expect(trackOf(r).events.filter((e: any) => e.k === 'revive')).toHaveLength(1)
  })

  test('a revival no respawn event announced is seen at the next tick, with no source', () => {
    const r = play(`
      Begin(); Run(1)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A); Run(2)
      B.alive = true; Run(1)
      ${end}
    `)
    expect(trackOf(r).events).toEqual([{ t: 800, p: B, k: 'revive' }])
    expect(roundOf(r).revives).toEqual([])
  })

  test('players who stay alive, or a death that leaves the player alive, produce no revive', () => {
    const r = play(`
      Begin(); Run(2)
      Fire("TTT2PostPlayerDeath", B, nil, A) -- the hook fired, the player is still alive
      Run(3)
      ${end}
    `)
    expect(trackOf(r).events).toBeUndefined()
  })

  test('a respawn event for a player who did not die, or is not in the round, is ignored', () => {
    const r = play(`Begin(); Run(1); Respawn(C); Respawn(SPEC); Run(1); ${end}`)
    expect(roundOf(r).revives).toEqual([])
    expect(trackOf(r).events).toBeUndefined()
  })

  test('another kind of TTT2 event about a dead player is not a revival', () => {
    const r = play(`
      Begin(); Run(1)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      Fire("TTT2AddedEvent", "kill", { event = { sid64 = B.sid, nick = "Bob" } })
      Fire("TTT2AddedEvent", "bodyfound", { event = { sid64 = B.sid, nick = "Bob" } })
      Run(2); ${end}
    `)
    expect(roundOf(r).revives).toEqual([])
    expect(trackOf(r).events).toBeUndefined()
  })

  test('with tracking off the revivals still reach the report', () => {
    const r = play(`
      Begin(); B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A); Respawn(B)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `, false)
    expect(roundOf(r).revives).toHaveLength(1)
    expect(trackOf(r)).toBeUndefined()
  })

  test('the role the player died as names a revival with no defibrillator, also when the role changed on revival', () => {
    const r = play(`
      Begin(); B.role = "swapper"
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A)
      B.role = "innocent"; Respawn(B)
      ${end}
    `)
    expect(roundOf(r).revives[0]).toMatchObject({ victim: B, how: 'role:swapper' })
  })
})

describe('the defibrillator note (4.2)', () => {
  const died = `Begin(); Run(1); B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, C); Run(1)`

  test('an attempt followed by the revival names the reviver, the weapon and the reason, once', () => {
    const r = play(`
      ${died}
      Defib(A, B, "weapon_ttth_necrodefi", "revived_by_necromancer"); Respawn(B)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, C); Respawn(B) -- the note was used up
      ${end}
    `)
    const v = roundOf(r).revives
    expect(v[0]).toEqual({ victim: B, reviver: A, how: 'weapon_ttth_necrodefi', why: 'revived_by_necromancer', at: 0 })
    expect(v[1]).toMatchObject({ victim: B, how: 'role:innocent' })
    expect(v[1].reviver).toBeUndefined()
    expect(trackOf(r).events[0]).toMatchObject({ k: 'revive', by: A, how: 'weapon_ttth_necrodefi', why: 'revived_by_necromancer' })
  })

  test('the handler answers nothing, because an answer would block the revival', () => {
    const r = play(`${died} OUT = { answer = Defib(A, B) == nil, again = Defib(A, B, "x") == nil }`)
    expect(r.out).toEqual({ answer: true, again: true })
  })

  test('an attempt with no revival leaves no event, and a note older than 30 s is not used', () => {
    const r = play(`
      ${died}
      Defib(A, B)
      NOW = NOW + 31; Respawn(B)
      ${end}
    `)
    const v = roundOf(r).revives
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ how: 'role:innocent' })
    expect(v[0].reviver).toBeUndefined()
    const none = play(`${died} Defib(A, B) ${end}`)
    expect(roundOf(none).revives).toEqual([])
  })

  test('a second attempt replaces the first', () => {
    const r = play(`${died} Defib(A, B, "first") Defib(C, B, "second"); Respawn(B) ${end}`)
    expect(roundOf(r).revives[0]).toMatchObject({ reviver: C, how: 'second' })
  })

  test('an owner or a body that is not in the round gives no reviver or no note', () => {
    const r = play(`${died} Defib(SPEC, B); Respawn(B) ${end}`)
    expect(roundOf(r).revives[0].reviver).toBeUndefined()
    expect(roundOf(r).revives[0].how).toBe('weapon_ttt_defibrillator')
    const other = play(`${died} Defib(A, SPEC); Respawn(B) ${end}`)
    expect(roundOf(other).revives[0].how).toBe('role:innocent')
  })

  test('names with other characters than a class or role has are cleaned', () => {
    const r = play(`${died} Defib(A, B, "weapon x<b>/..", "why now!"); Respawn(B) ${end}`)
    expect(roundOf(r).revives[0]).toMatchObject({ how: 'weaponxb..', why: 'whynow' })
  })

  test('the stats switched off do nothing in any of the hooks', () => {
    const r = play(`SetCv("traitordash_stats", "0"); ${died} OUT = { answer = Defib(A, B) == nil } Respawn(B)`)
    expect(r.out.answer).toBe(true)
    expect(roundOf(r)).toBeUndefined()
  })
})

describe('what the bridge sends, as the backend sees it', () => {
  test('a round with a revival by the defibrillator, a conversion and a skipped revival passes the backend\'s own validation', () => {
    const r = play(`
      Begin(); Run(3)
      B.alive = false; Fire("TTT2PostPlayerDeath", B, nil, A); Run(2)
      Defib(C, B); Respawn(B); B.role, B.team = "zombie", "necromancers"
      Fire("TTT2UpdateSubrole", B, 1, 2); Fire("TTT2UpdateTeam", B, "innocents", "necromancers"); Run(1); Flush()
      C.alive = false; Fire("TTT2PostPlayerDeath", C, nil, A); Run(2); C.alive = true; Run(2)
      Fire("TTTEndRound", "necromancers"); Accept(1)
    `)
    const round = roundOf(r)
    const check = validateTrack(trackOf(r), { roundId: round.round_id, map: round.map, players: new Set(round.players.map((p: any) => p.steam_id)) })
    expect(check).toMatchObject({ ok: true })
    if (check.ok) {
      expect(check.track.events.map(e => e.k)).toEqual(['revive', 'role', 'revive'])
      expect(check.track.events.filter(e => e.k === 'revive')).toHaveLength(2)
      expect(check.track.events[0]).toMatchObject({ p: B, by: C, how: 'weapon_ttt_defibrillator' })
    }
  })
})
