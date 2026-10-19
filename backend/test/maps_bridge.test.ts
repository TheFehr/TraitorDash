import { expect, test, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { run } from './helpers/bridge_harness'

// RFC 10, bridge side: the bridge fingerprints every map file by reading only its first bytes,
// and sends the map report to POST /api/v1/maps when it starts.

// The fingerprint, as the RFC defines it: SHA-256 of the lowercase hex of the first 1036 bytes
// (the BSP header: identifier, version, 64 lump entries, map revision), a colon, and the file size
// in decimal. Hex text, because the bytes themselves are not safe to pass around as a Lua string.
// The backend computes the same value from the file it fetches (RFC 11); this is the shared vector.
export const header = (fill = 7) => {
  const b = Buffer.alloc(1036, fill)
  b.write('VBSP', 0, 'latin1')
  b.writeInt32LE(20, 4) // version
  b.writeInt32LE(904, 1032) // map revision
  return b
}
export const fingerprint = (h: Buffer, size: number) =>
  createHash('sha256').update(`${h.toString('hex')}:${size}`).digest('hex')

// A fake file system with the map files' first bytes: BYTES["maps/x.bsp"] = <binary string>.
const SETUP = `
  BYTES, FILES, OPENED, READS = {}, {}, {}, {}
  GAME_NAME = "terrortown"
  game = game or {}
  game.GetMap = function() return "ttt_a" end
  game.GetMapNext = function() return "ttt_b" end
  engine = { ActiveGamemode = function() return GAME_NAME end, GetGamemodes = function() return { { name = "terrortown", maps = "^ttt_" } } end, GetAddons = function() return {} end }
  local realFile = file
  file = setmetatable({
    Find = function(pattern, where)
      local out = {}
      for path in pairs(FILES) do local n = path:match("^maps/(.+%.bsp)$") if n then out[#out + 1] = n end end
      table.sort(out) return out, {}
    end,
    Size = function(path) return FILES[path] or -1 end,
    Open = function(path, mode, where)
      OPENED[#OPENED + 1] = path .. "|" .. tostring(mode) .. "|" .. tostring(where)
      local data = BYTES[path]
      if not data then return nil end
      return { Read = function(_, n) READS[#READS + 1] = n return data:sub(1, n) end, Close = function() end }
    end,
    Read = function(path, where) if where == "GAME" and path == "cfg/mapcycle.txt" then return nil end return realFile.Read(path, where) end,
  }, { __index = realFile })
  GetConVar = (function(real) return function(n)
    if n == "mapcyclefile" then return { GetString = function() return "mapcycle.txt" end } end
    return real(n)
  end end)(GetConVar)
  util.TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end
  function HEXOF(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end
`
const lua = (body: string) => run(`${SETUP}\n${body}`).result
// Lua long-bracket string literal that survives binary content: the bytes go in as \\ddd escapes.
const bin = (b: Buffer) => `"${[...b].map(x => `\\${String(x).padStart(3, '0')}`).join('')}"`

describe('TraitorDash.MapFingerprint', () => {
  const h = header()

  test('hashes the hex of the first 1036 bytes with the size, and reads nothing else', () => {
    const r = lua(`BYTES["maps/ttt_a.bsp"] = ${bin(h)} .. string.rep("x", 5000)
      RESULT = tostring(TraitorDash.MapFingerprint("maps/ttt_a.bsp", 243312804)) .. "|" .. table.concat(READS, ",") .. "|" .. OPENED[1]`)
    expect(r).toBe(`${fingerprint(h, 243312804)}|1036|maps/ttt_a.bsp|rb|GAME`)
  })

  test('matches the shared test vector (the backend\'s BSP reader checks the same literal)', () => {
    // header(7) with size 243312804: the value is written out, not computed, so both suites pin the same number.
    const r = lua(`BYTES["maps/ttt_a.bsp"] = ${bin(h)} RESULT = tostring(TraitorDash.MapFingerprint("maps/ttt_a.bsp", 243312804))`)
    expect(r).toBe('a6f7661d5ae421cdbe7b1b4da2d6eae9d9f3583faaa5b01ff31509698ff1f3d6')
  })

  test('the same bytes with another size is another fingerprint', () => {
    const r = lua(`BYTES["maps/ttt_a.bsp"] = ${bin(h)}
      RESULT = TraitorDash.MapFingerprint("maps/ttt_a.bsp", 1) .. "," .. TraitorDash.MapFingerprint("maps/ttt_a.bsp", 2)`).split(',')
    expect(r[0]).not.toBe(r[1])
  })

  test('another revision in the header is another fingerprint', () => {
    const h2 = header(); h2.writeInt32LE(905, 1032)
    const r = lua(`BYTES["maps/a.bsp"] = ${bin(h)} BYTES["maps/b.bsp"] = ${bin(h2)}
      RESULT = TraitorDash.MapFingerprint("maps/a.bsp", 9) .. "," .. TraitorDash.MapFingerprint("maps/b.bsp", 9)`).split(',')
    expect(r[0]).not.toBe(r[1])
  })

  test.each([
    ['a file that cannot be opened', 'nil'],
    ['a file that is not a map (wrong identifier)', '"PK\\003\\004" .. string.rep("a", 1100)'],
    ['a header cut short (fewer than 1036 bytes, for example at a zero byte)', '"VBSP" .. string.rep("a", 100)'],
    ['an empty file', '""'],
  ])('%s: unknown (nil), never a guess', (_, data) => {
    const r = lua(`BYTES["maps/x.bsp"] = ${data} RESULT = tostring(TraitorDash.MapFingerprint("maps/x.bsp", 100))`)
    expect(r).toBe('nil')
  })

  test('a size that is not a number: unknown', () => {
    expect(lua(`BYTES["maps/x.bsp"] = ${bin(h)} RESULT = tostring(TraitorDash.MapFingerprint("maps/x.bsp", nil))`)).toBe('nil')
  })

  test('without util.SHA256 it is unknown instead of an error', () => {
    expect(lua(`BYTES["maps/x.bsp"] = ${bin(h)} util.SHA256 = nil RESULT = tostring(TraitorDash.MapFingerprint("maps/x.bsp", 9))`)).toBe('nil')
  })
})

describe('CollectMaps carries the fingerprint', () => {
  test('every map on disk gets one, computed from its own file and size', () => {
    const h = header(3)
    const r = lua(`FILES = { ["maps/ttt_a.bsp"] = 500, ["maps/gm_x.bsp"] = 600 }
      BYTES["maps/ttt_a.bsp"] = ${bin(h)}
      local r = TraitorDash.CollectMaps()
      RESULT = tostring(r.maps[2].fingerprint) .. "|" .. tostring(r.maps[1].fingerprint)`)
    expect(r).toBe(`${fingerprint(h, 500)}|nil`)
  })
})

describe('TraitorDash.PushMaps', () => {
  const FILESET = `FILES = { ["maps/ttt_a.bsp"] = 500, ["maps/ttt_b.bsp"] = 600, ["maps/gm_x.bsp"] = 700 }
    BYTES["maps/ttt_a.bsp"] = ${bin(header())}`

  test('posts the report to /api/v1/maps with the token, a timeout and JSON', () => {
    const r = lua(`${FILESET} TraitorDash.PushMaps()
      local q = SENT[1]
      RESULT = q.method .. "|" .. q.url .. "|" .. q.headers.Authorization .. "|" .. q.headers["Content-Type"] .. "|" .. tostring(q.timeout) .. "|" .. q.body`)
    expect(r).toBe('POST|https://td.test/api/v1/maps|Bearer tok|application/json|30|{json}')
  })

  test('the payload carries the Workshop IDs of the mounted map addons, at most 300', () => {
    const r = lua(`${FILESET}
      local addons = {}
      for i = 1, 320 do addons[i] = { mounted = true, tags = "map", wsid = tostring(1000 + i) } end
      engine.GetAddons = function() return addons end
      TraitorDash.PushMaps()
      local ids = LAST_PAYLOAD.mapAddons
      RESULT = #ids .. "|" .. ids[1] .. "|" .. ids[300]`)
    expect(r).toBe('300|1001|1300')
  })

  test('the payload has the maps, the current/next map, the gamemode and the pool basis, and nothing else', () => {
    const r = lua(`${FILESET} TraitorDash.PushMaps()
      local p = LAST_PAYLOAD
      local function keys(t) local k = {} for key in pairs(t) do k[#k + 1] = key end table.sort(k) return table.concat(k, ",") end
      RESULT = keys(p) .. "|" .. keys(p.maps[2]) .. "|" .. keys(p.mapvote) .. "|" .. #p.maps .. "|" .. p.current .. "|" .. p.next .. "|" .. p.gamemode .. "|" .. p.pattern`)
    expect(r).toBe([
      'current,gamemode,mapAddons,maps,mapvote,next,pattern',
      'fingerprint,inCycle,inVotePool,isCurrent,matchesGamemode,name,onCooldown,size,votable',
      'configSource,poolBasis,present',
      '3', 'ttt_a', 'ttt_b', 'terrortown', '^ttt_',
    ].join('|'))
  })

  test('nothing about the vote addon\'s settings, ConVars or recent maps leaves the server', () => {
    const r = lua(`${FILESET}
      MapVote = { Config = { MapLimit = 12, MapPrefixes = { "ttt_" } } }
      TraitorDash.PushMaps()
      local mv = LAST_PAYLOAD.mapvote
      RESULT = tostring(mv.present) .. "|" .. tostring(mv.poolBasis) .. "|" .. tostring(mv.configSource) .. "|" .. tostring(mv.config) .. tostring(mv.convars) .. tostring(mv.recent) .. tostring(mv.prefixes)`)
    expect(r).toBe('true|prefixes|global|nilnilnilnil')
  })

  test('sends at most 500 maps', () => {
    const r = lua(`FILES = {} for i = 1, 600 do FILES[string.format("maps/ttt_%04d.bsp", i)] = i end
      TraitorDash.PushMaps() RESULT = #LAST_PAYLOAD.maps .. "|" .. LAST_PAYLOAD.maps[1].name .. "|" .. LAST_PAYLOAD.maps[500].name`)
    expect(r).toBe('500|ttt_0001|ttt_0500')
  })

  test('stays idle without a token (nothing is sent)', () => {
    expect(lua(`${FILESET} SetCv("traitordash_token", "") TraitorDash.PushMaps() RESULT = #SENT`)).toBe('0')
  })

  test('when maps.lua did not load there is nothing to send, and no error', () => {
    expect(lua(`TraitorDash.CollectMaps = nil TraitorDash.PushMaps() RESULT = #SENT`)).toBe('0')
  })

  test('a failure inside the collection is caught and printed, not thrown', () => {
    const r = lua(`TraitorDash.CollectMaps = function() error("boom") end
      TraitorDash.PushMaps() RESULT = #SENT .. "|" .. table.concat(PRINTS, "\\n")`)
    expect(r).toContain('0|')
    expect(r).toContain('boom')
  })

  test('says what happened: accepted, rejected with the reason, or unreachable', () => {
    const outcome = (call: string) => lua(`${FILESET} TraitorDash.PushMaps() ${call} RESULT = table.concat(PRINTS, "\\n")`)
    expect(outcome('SENT[1].success(200, "{}")')).toContain('Map report OK (3 maps)')
    expect(outcome('SENT[1].success(400, "bad maps")')).toContain('Map report rejected (HTTP 400): bad maps')
    expect(outcome('SENT[1].success(404, "Not Found")')).toContain('HTTP 404')
    expect(outcome('SENT[1].failed("unsuccessful")')).toContain('Map report failed: unsuccessful')
  })

  test('the token is never printed', () => {
    const r = lua(`${FILESET} TraitorDash.PushMaps() SENT[1].success(500, "x") RESULT = table.concat(PRINTS, "\\n")`)
    expect(r).not.toContain('tok"')
  })
})

describe('Init sends the map report with the first sync', () => {
  test('the first-sync timer runs the sync and then the map report', () => {
    const r = lua(`FILES = { ["maps/ttt_a.bsp"] = 5 }
      local first
      timer.Simple = function(secs, fn) if secs == 5 then first = fn end end
      TraitorDash.Sync = function() SYNCED = true end
      TraitorDash.Init()
      local before = #SENT
      first()
      local urls = {} for i = before + 1, #SENT do urls[#urls + 1] = SENT[i].url:match("/api/v1/%w+") end
      RESULT = tostring(SYNCED) .. "|" .. table.concat(urls, ",")`)
    expect(r).toBe('true|/api/v1/maps')
  })

  test('a failing map report does not stop the sync', () => {
    const r = lua(`local first
      timer.Simple = function(secs, fn) if secs == 5 then first = fn end end
      TraitorDash.Sync = function() SYNCED = true end
      TraitorDash.CollectMaps = function() error("boom") end
      TraitorDash.Init() first() RESULT = tostring(SYNCED)`)
    expect(r).toBe('true')
  })
})

// RFC 10, 4.5: a finished floor-plan scan is posted to /api/v1/mapplan.
describe('TraitorDash.PushMapPlan', () => {
  // What the scanner's Result() returns, with its diagnostics.
  const RESULT = `{
    mode = "reach", map = "ttt_a", cell = 64, minx = -801, miny = -1569, nx = 3, ny = 2, zmin = -2465, zmax = 9889,
    seeds = 107, traces = 14637, seconds = 0.08, columns = 530, floorCells = 5, crouchFloors = 1, ticks = 27, maxSliceMs = 3.5,
    rows = { "-160,48c|48|", "|272|-160" },
  }`
  const FILE = `FILES = { ["maps/ttt_a.bsp"] = 500 } BYTES["maps/ttt_a.bsp"] = ${bin(header())}`

  test('posts to /api/v1/mapplan with the token, a timeout and JSON', () => {
    const r = lua(`TraitorDash.PushMapPlan(${RESULT})
      local q = SENT[1]
      RESULT = q.method .. "|" .. q.url .. "|" .. q.headers.Authorization .. "|" .. q.headers["Content-Type"] .. "|" .. tostring(q.timeout)`)
    expect(r).toBe('POST|https://td.test/api/v1/mapplan|Bearer tok|application/json|60')
  })

  test('sends the grid and the scan\'s own statistics, and nothing else', () => {
    const r = lua(`TraitorDash.PushMapPlan(${RESULT})
      local k = {} for key in pairs(LAST_PAYLOAD) do k[#k + 1] = key end table.sort(k)
      RESULT = table.concat(k, ",") .. "|" .. #LAST_PAYLOAD.rows .. "|" .. LAST_PAYLOAD.map`)
    expect(r).toBe('cell,map,minx,miny,nx,ny,rows,seconds,seeds,traces,zmax,zmin|2|ttt_a')
  })

  test('adds the map file\'s fingerprint when it can be read', () => {
    const h = header()
    const r = lua(`${FILE} TraitorDash.PushMapPlan(${RESULT}) RESULT = tostring(LAST_PAYLOAD.fingerprint)`)
    expect(r).toBe(fingerprint(h, 500))
  })

  test('is idle without a token (nothing is sent)', () => {
    expect(lua(`SetCv("traitordash_token", "") TraitorDash.PushMapPlan(${RESULT}) RESULT = #SENT`)).toBe('0')
  })

  test('says what happened: accepted, rejected with the reason, or unreachable', () => {
    const outcome = (call: string) => lua(`TraitorDash.PushMapPlan(${RESULT}) ${call} RESULT = table.concat(PRINTS, "\\n")`)
    expect(outcome('SENT[1].success(200, "{}")')).toContain('Floor plan for ttt_a sent')
    expect(outcome('SENT[1].success(400, "bad rows")')).toContain('Floor plan rejected (HTTP 400): bad rows')
    expect(outcome('SENT[1].success(404, "Not Found")')).toContain('HTTP 404')
    expect(outcome('SENT[1].failed("unsuccessful")')).toContain('Floor plan failed: unsuccessful')
  })

  test('the token is never printed', () => {
    expect(lua(`TraitorDash.PushMapPlan(${RESULT}) SENT[1].success(500, "x") RESULT = table.concat(PRINTS, "\\n")`)).not.toContain('tok"')
  })
})
