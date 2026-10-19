import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { addJsonDecode } from './helpers/bridge_harness'
import { validateTrack } from '../src/services/tracks'

// RFC 12, 3.2 and 3.3: runs the real addon/lua/traitordash/{stats,track}.lua against a minimal
// fake of GMod/TTT2 with a clock the test controls, plays rounds through the hooks and the timer,
// and checks what would have been recorded and POSTed.
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
    function p:GetTeam() return team end
    function p:GetSubRoleData() return { name = role } end
    function p:GetPos() if self.boom then error("GetPos failed") end return { x = self.x, y = self.y, z = self.z } end
    function p:EyeAngles() return { y = self.yaw } end
    p.alive = true
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
/** Rebuilds positions from first value + differences. */
const rebuild = (d: number[]) => { let at = 0; return d.map(x => (at += x)) }
const segOf = (track: any, id: string, i = 0) => track.players.find((p: any) => p.id === id).segments[i]

describe('track.lua: switched off', () => {
  test('with traitordash_track at 0 nothing is recorded, no timer is created, and the stats go out as before', () => {
    const r = play(`Begin() OUT = { timers = Count() } Fire("TTTEndRound", WIN_TRAITOR) Accept(1)`, false)
    expect(r.out.timers).toBe(0)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]!.url).toMatch(/\/api\/v1\/round$/)
    expect(r.printed.join('\n')).not.toMatch(/track\]/)
  })
})

describe('track.lua: recording', () => {
  test('the first sample is taken at the start; each tick adds one for every living player and none for the dead', () => {
    const r = play(`
      Begin()
      Run(3)
      B.alive = false
      Run(2)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const t = trackOf(r)
    expect(t.t).toHaveLength(6)
    expect(t.t[0]).toBe(0)
    expect(t.t.slice(1)).toEqual([200, 200, 200, 200, 200])
    expect(segOf(t, A).x).toHaveLength(6)
    expect(segOf(t, B).x).toHaveLength(4) // Bob dies before the 4th tick: samples at ticks 0-3
    expect(segOf(t, C).x).toHaveLength(6)
    expect(t.players.map((p: any) => p.id)).not.toContain('76561198000000009') // a spectator is never tracked
  })

  test('the first value is absolute and the rest differences, which rebuild the exact positions', () => {
    const r = play(`
      Begin()
      A.x, A.y, A.z, A.yaw = 808, -392, 24, 90; Run(1)
      A.x, A.y, A.z, A.yaw = 800, -400, 16, 270; Run(1)
      A.x, A.y, A.z, A.yaw = -4000, 4000, 96, -90; Run(1)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const s = segOf(trackOf(r), A)
    expect(rebuild(s.x)).toEqual([100, 101, 100, -500])
    expect(rebuild(s.y)).toEqual([-50, -49, -50, 500])
    expect(rebuild(s.z)).toEqual([0, 3, 2, 12])
    expect(rebuild(s.a)).toEqual([0, 64, 192, 192]) // yaw 0, 90, 270, -90 in 256 steps
    expect(s.from).toBe(0)
  })

  test('a death takes a final sample, records both positions and the weapon, and ends the victim\'s segment', () => {
    const r = play(`
      Begin()
      Run(2)
      B.x, B.y, B.z = 400, 160, 8
      A.x, A.y, A.z = 480, 80, 16
      NOW = NOW + 0.05
      B.alive = false
      Fire("TTT2PostPlayerDeath", B, { GetClass = function() return "weapon_ttt_m16" end }, A)
      Run(2)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const t = trackOf(r)
    expect(t.deaths).toHaveLength(1)
    expect(t.deaths[0]).toEqual({ victim: B, attacker: A, t: 450, vx: 50, vy: 20, vz: 1, ax: 60, ay: 10, az: 2, weapon: 'weapon_ttt_m16' })
    // the extra tick sits at the death time (0, 200, 400, then 50 ms later), and Bob has a sample there
    expect(t.t).toEqual([0, 200, 200, 50, 200, 200])
    const bob = segOf(t, B)
    expect(bob.x).toHaveLength(4)
    expect(rebuild(bob.x).pop()).toBe(50)
    // everybody else is sampled at that same tick
    expect(segOf(t, A).x).toHaveLength(6)
  })

  test('a death by the world has no attacker position; an unknown victim is ignored', () => {
    const r = play(`
      Begin()
      B.alive = false
      Fire("TTT2PostPlayerDeath", B, nil, nil)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(trackOf(r).deaths[0]).toMatchObject({ victim: B })
    expect(trackOf(r).deaths[0].attacker).toBeUndefined()
    expect(trackOf(r).deaths[0].ax).toBeUndefined()
  })

  test('a revived player continues in a second segment', () => {
    const r = play(`
      Begin()
      Run(2)
      B.alive = false; Run(2)
      B.alive = true; Run(2)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const t = trackOf(r)
    const bob = t.players.find((p: any) => p.id === B)
    expect(bob.segments).toHaveLength(2)
    expect(bob.segments[0].from).toBe(0)
    expect(bob.segments[0].x).toHaveLength(3)
    expect(bob.segments[1].from).toBe(5)
    expect(bob.segments[1].x).toHaveLength(2)
  })

  test('a player who leaves ends their segment; the others carry on', () => {
    const r = play(`
      Begin()
      Run(2)
      B.sid = nil; IsValidOld = IsValid
      IsValid = function(v) return v ~= nil and v ~= false and v ~= B end
      Run(2)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const t = trackOf(r)
    expect(segOf(t, B).x).toHaveLength(3)
    expect(segOf(t, A).x).toHaveLength(5)
  })
})

describe('track.lua: the sampling rate follows the cost', () => {
  const intervals = (extra: string, steps: number) => play(`
    Begin()
    local seen = {}
    for i = 1, ${steps} do ${extra} Run(1) seen[#seen + 1] = TIMERS.TraitorDash_Track and TIMERS.TraitorDash_Track.delay or -1 end
    OUT = seen
  `).out as number[]

  test('starts at the fastest interval and stays there while ticks are cheap', () => {
    expect(new Set(intervals('', 30))).toEqual(new Set([0.2]))
  })

  test('grows by half when the average cost is over the budget, up to the slowest value, never beyond', () => {
    const seen = intervals('COST = 0.0002', 80) // 0.2 ms... under budget; raise it below
    expect(Math.max(...seen)).toBe(0.2)
    const slow = intervals('COST = 0.0008', 80) // 0.8 ms, over the 0.5 ms budget
    expect(slow.filter(x => x > 0).every(x => x >= 0.2 - 1e-9 && x <= 1 + 1e-9)).toBe(true)
    expect(slow[0]).toBe(0.2)
    expect(slow.some(x => Math.abs(x - 0.3) < 1e-9)).toBe(true)
  })

  test('shrinks by a quarter again when it is cheap, never below the fastest value', () => {
    const seen = play(`
      SetCv("traitordash_track_budget_ms", "0.5")
      Begin()
      COST = 0.0008; Run(25)
      COST = 0.00005
      local seen = {}
      for i = 1, 60 do Run(1) seen[#seen + 1] = TIMERS.TraitorDash_Track and TIMERS.TraitorDash_Track.delay or -1 end
      OUT = seen
    `).out as number[]
    expect(seen[seen.length - 1]).toBe(0.2)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.2 - 1e-9)
    expect(seen.some(x => x > 0.2 + 1e-9)).toBe(true)
  })

  test('the limits follow the ConVars, including a fastest value below the default', () => {
    const r = play(`
      SetCv("traitordash_track_interval_min", "0.1")
      Begin()
      Run(3)
      OUT = { delay = TIMERS.TraitorDash_Track.delay }
    `)
    expect(r.out.delay).toBe(0.1)
    const floor = play(`SetCv("traitordash_track_interval_min", "0.01") Begin() OUT = { delay = TIMERS.TraitorDash_Track.delay }`)
    expect(floor.out.delay).toBe(0.1) // never below 0.1 s
  })

  test('a server whose frame is slow lengthens the interval; a very slow frame skips the tick and records a gap', () => {
    const r = play(`
      Begin()
      Run(2)
      FT = 0.03  -- twice the tick interval: busy
      Run(1)
      OUT = { busyDelay = TIMERS.TraitorDash_Track.delay }
      FT = 0.06  -- four times: skip
      Run(1)
      OUT.skipDelay = TIMERS.TraitorDash_Track.delay
      FT = 0.015
      Run(2)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(r.out.busyDelay).toBeGreaterThan(0.2)
    expect(r.out.skipDelay).toBeGreaterThan(r.out.busyDelay)
    const t = trackOf(r)
    const a = t.players.find((p: any) => p.id === A)
    expect(a.segments).toHaveLength(2) // the skipped tick ended the segment
    expect(a.segments[1].from).toBe(a.segments[0].x.length) // no tick was added for the skipped one
    expect(t.t.length).toBe(a.segments[0].x.length + a.segments[1].x.length)
    expect(r.printed.join('\n')).toMatch(/1 skipped/)
  })

  test('a server that cannot meet the budget even at the slowest interval gets a degraded track', () => {
    const r = play(`
      Begin()
      COST = 0.005 -- 5 ms a tick, ten times the budget
      Run(200)
      OUT = { left = Count() }
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(r.out.left).toBe(0) // sampling stopped
    expect(trackOf(r).degraded).toBe(true)
    expect(trackOf(r).truncated).toBe(false)
    expect(r.printed.join('\n')).toMatch(/DEGRADED/)
  })
})

describe('track.lua: caps', () => {
  test('after 20 000 ticks the track is cut and flagged truncated', () => {
    const r = play(`
      SetCv("traitordash_track_interval_max", "0.2")
      Begin()
      Run(20100)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const t = trackOf(r)
    expect(t.truncated).toBe(true)
    expect(t.t).toHaveLength(20000)
  })

  test('as the size approaches its cap the interval is raised to its slowest, and at the cap the track is cut', () => {
    const r = play(`
      SetCv("traitordash_track_interval_max", "1")
      PLAYERS = { SPEC }
      for i = 1, 127 do
        local p = setmetatable({ sid = tostring(76561198100000000 + i) }, { __index = A })
        p.x, p.y, p.z, p.yaw, p.alive = i * 8, 0, 0, 0, true
        PLAYERS[#PLAYERS + 1] = p
      end
      A.alive = true; A.sid = "76561198000000001"; PLAYERS[#PLAYERS + 1] = A
      Begin()
      local at = nil
      for i = 1, 4000 do
        if Run(1) == 0 then break end
        if not at and TIMERS.TraitorDash_Track and TIMERS.TraitorDash_Track.delay >= 1 - 1e-9 then at = i end
      end
      OUT = { slowedAt = at or -1, left = Count() }
      Fire("TTTEndRound", WIN_TRAITOR) -- (not uploaded here: encoding half a million samples is the test harness's slow part)
    `)
    expect(r.out.slowedAt).toBeGreaterThan(0)
    expect(r.out.left).toBe(0)
    expect(r.printed.join('\n')).toMatch(/TRUNCATED/)
  }, 60_000)
})

describe('track.lua: safety', () => {
  test('an error inside the timer is caught: sampling stops, the round still ends and reports', () => {
    const r = play(`
      Begin()
      Run(2)
      A.boom = true
      Run(1)
      OUT = { left = Count() }
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(r.out.left).toBe(0)
    expect(roundOf(r)).toBeTruthy()
    expect(trackOf(r).truncated).toBe(true)
    expect(r.printed.join('\n')).toMatch(/sampling error/)
  })

  test('the kill switch stops sampling at the next tick and nothing is sent', () => {
    const r = play(`
      Begin()
      Run(2)
      SetCv("traitordash_track", "0")
      Run(1)
      OUT = { left = Count() }
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(r.out.left).toBe(0)
    expect(r.sent.filter(s => s.url.endsWith('/api/v1/track'))).toHaveLength(0)
    expect(roundOf(r)).toBeTruthy()
  })

  test('with the stats switched off nothing is recorded either', () => {
    const r = play(`SetCv("traitordash_stats", "0") Begin() OUT = { timers = Count() } Fire("TTTEndRound", WIN_TRAITOR)`)
    expect(r.out.timers).toBe(0)
    expect(r.sent).toHaveLength(0)
  })

  test('the next round drops an unfinished recording and starts afresh', () => {
    const r = play(`
      Begin()
      Run(3)
      Begin()
      Run(1)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    expect(trackOf(r).t).toHaveLength(2)
  })
})

describe('track.lua: the upload', () => {
  test('the track is sent once the round was accepted, with the server token', () => {
    const r = play(`
      Begin(); Run(2)
      Fire("TTTEndRound", WIN_TRAITOR)
      OUT = { before = #SENT }
      Accept(1)
    `)
    expect(r.out.before).toBe(1) // only the round, until the backend accepts it
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1]!.url).toBe('https://td.test/api/v1/track')
    expect(r.sent[1]!.auth).toBe('Bearer tok')
    expect(r.sent[1]!.body.round_id).toBe(r.sent[0]!.body.round_id)
    expect(r.sent[1]!.body.map).toBe('ttt_test_map')
  })

  test('a rejected round drops the track', () => {
    const r = play(`Begin(); Run(2) Fire("TTTEndRound", WIN_TRAITOR) Accept(1, 400)`)
    expect(r.sent).toHaveLength(1)
  })

  test('a failed round drops the track, and nothing is retried', () => {
    const r = play(`
      Begin(); Run(2)
      Fire("TTTEndRound", WIN_TRAITOR)
      SENT[1].failed("timeout")
    `)
    expect(r.sent).toHaveLength(1)
  })

  test('a backend without the endpoint (404) is not asked again on that map, but is on another', () => {
    const r = play(`
      Begin(); Run(1) Fire("TTTEndRound", WIN_TRAITOR) Accept(1)
      SENT[2].success(404, "not found")
      Begin(); OUT = { sameMap = Count() }
      Fire("TTTEndRound", WIN_TRAITOR)
      MAP = "ttt_other"
      Begin(); OUT.otherMap = Count()
    `)
    expect(r.out.sameMap).toBe(0)
    expect(r.out.otherMap).toBe(1)
    expect(r.printed.join('\n')).toMatch(/no track endpoint/)
  })

  test('the map\'s fingerprint is added when it is known', () => {
    const r = play(`
      file.Size = function() return 1000 end
      TraitorDash.MapFingerprint = function(p, s) return string.rep("ab", 32) end
      Begin(); Run(1) Fire("TTTEndRound", WIN_TRAITOR) Accept(1)
    `)
    expect(trackOf(r).fingerprint).toBe('ab'.repeat(32))
  })

  test('a round with no samples sends no track', () => {
    const r = play(`PLAYERS = { SPEC } Begin() Fire("TTTEndRound", WIN_TRAITOR)`)
    expect(r.sent).toHaveLength(0) // no reportable players either
  })
})

describe('track.lua: the round-end line', () => {
  test('states ticks, interval range, cost, skips and size', () => {
    const r = play(`Begin(); Run(10); Fire("TTTEndRound", WIN_TRAITOR)`)
    const line = r.printed.find(l => l.includes('[TraitorDash:track] round'))!
    expect(line).toMatch(/11 ticks/)
    expect(line).toMatch(/\d+ samples, 0 skipped/)
    expect(line).toMatch(/interval 0\.20-0\.20 s/)
    expect(line).toMatch(/tick cost avg 0\.05\d ms worst 0\.05\d ms/)
    expect(line).toMatch(/about \d+ KB/)
  })
})

describe('what the bridge sends, as the backend sees it', () => {
  test('a recorded round with deaths, a revival and a gap passes the backend\'s own validation', () => {
    const r = play(`
      Begin()
      for i = 1, 20 do
        A.x = A.x + 13; A.y = A.y - 7; A.yaw = (A.yaw + 17) % 360
        B.x = B.x + 5
        if i == 5 then FT = 0.1 end
        if i == 6 then FT = 0.015 end
        if i == 8 then NOW = NOW + 0.05 B.alive = false Fire("TTT2PostPlayerDeath", B, nil, A) end
        if i == 14 then B.alive = true end
        Run(1)
      end
      C.alive = false; Fire("TTT2PostPlayerDeath", C, nil, nil)
      Fire("TTTEndRound", WIN_TRAITOR); Accept(1)
    `)
    const round = roundOf(r)
    const track = trackOf(r)
    const check = validateTrack(track, { roundId: round.round_id, map: round.map, players: new Set(round.players.map((p: any) => p.steam_id)) })
    expect(check).toMatchObject({ ok: true })
    if (check.ok) {
      expect(check.track.deaths).toHaveLength(2)
      expect(check.track.players.find(p => p.id === B)!.segments.length).toBeGreaterThanOrEqual(2)
    }
  })
})
