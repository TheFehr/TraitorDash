import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { run } from './helpers/bridge_harness'

// RFC 23, stage 1: the bridge's own settings that the dashboard may change: what it accepts (a list, with a kind and a range for each),
// what it refuses, how it keeps a setting for the next start, how it applies it at start, and how it reports what it runs with.

const addon = path.join(import.meta.dir, '../../addon/lua/traitordash')
const source = (f: string) => fs.readFileSync(path.join(addon, f), 'utf8')

// A real JSON encoder and decoder, ConVars that change when they are set, and the ConVars of stats.lua and track.lua.
const PREPARE = `
  local function enc(v)
    local t = type(v)
    if t == "string" then return '"' .. v:gsub('[\\\\"]', '\\\\%0') .. '"' end
    if t == "number" then return tostring(v) end
    if t == "boolean" then return tostring(v) end
    if t == "table" then
      if #v > 0 then local out = {} for i, x in ipairs(v) do out[i] = enc(x) end return "[" .. table.concat(out, ",") .. "]" end
      local keys = {} for k in pairs(v) do keys[#keys + 1] = k end table.sort(keys)
      local out = {} for _, k in ipairs(keys) do out[#out + 1] = enc(tostring(k)) .. ":" .. enc(v[k]) end
      return "{" .. table.concat(out, ",") .. "}"
    end
    return "null"
  end
  ENC = enc
  util.JSONToTable = JSON_DECODE
  util.TableToJSON = function(t) LAST_PAYLOAD = t return enc(t) end
  RunConsoleCommand = function(n, v) APPLIED[#APPLIED + 1] = n .. "=" .. tostring(v) SetCv(n, tostring(v)) end
  for name, default in pairs({ traitordash_stats = "1", traitordash_stats_debug = "1", traitordash_stats_bots = "0", traitordash_track = "0",
      traitordash_track_interval_min = "0.2", traitordash_track_interval_max = "1", traitordash_track_budget_ms = "0.5" }) do CreateConVar(name, default) end
  CHANGES = {}
  cvars = { AddChangeCallback = function(n, fn, id) CHANGES[#CHANGES + 1] = n .. ":" .. id end }
  game = { GetMap = function() return "ttt_test" end, ConsoleCommand = function() end }
  CONFIG_JSON = function(t) DATA["traitordash/config.json"] = enc(t) end
`
const value = (script: string) => run(`${PREPARE}\n${script}`).result
const lines = (script: string) => run(`${PREPARE}\n${script}\nRESULT = table.concat(PRINTS, "\\n")`).result.split('\n')

describe('the list', () => {
  test('has the fourteen settings, with their kinds, ranges and defaults, and nothing that is the connection', () => {
    const r = JSON.parse(value('RESULT = ENC(TraitorDash.SettingList)'))
    expect(r.map((s: any) => s.name)).toEqual(['traitordash_stats', 'traitordash_stats_debug', 'traitordash_stats_bots', 'traitordash_track',
      'traitordash_track_interval_min', 'traitordash_track_interval_max', 'traitordash_track_budget_ms', 'traitordash_track_max_ticks', 'traitordash_track_prep', 'traitordash_track_parts', 'traitordash_track_props', 'traitordash_track_chat', 'traitordash_voice', 'traitordash_voice_mute_game'])
    expect(r.find((s: any) => s.name === 'traitordash_track_interval_min')).toMatchObject({ kind: 'number', min: 0.05, max: 2, default: '0.2' })
    expect(r.find((s: any) => s.name === 'traitordash_track_max_ticks')).toMatchObject({ kind: 'int', min: 1000, max: 100000, default: '40000' })
    for (const never of ['traitordash_url', 'traitordash_token', 'traitordash_public_url']) expect(r.some((s: any) => s.name === never)).toBe(false)
  })

  test('each default is the default of the ConVar the setting belongs to', () => {
    const files = source('stats.lua') + source('track.lua') + source('voice.lua')
    const r = JSON.parse(value('RESULT = ENC(TraitorDash.SettingList)'))
    for (const s of r) {
      const m = files.match(new RegExp(`CreateConVar\\("${s.name}", "([^"]*)"`))
      expect(m, s.name).not.toBeNull()
      expect(m![1], s.name).toBe(s.default)
    }
  })
})

describe('a value', () => {
  const check = (name: string, v: string) => value(`local ok, why = TraitorDash.CheckSettingValue("${name}", "${v}") RESULT = tostring(ok) .. "|" .. tostring(why)`)
  test('is 0 or 1 for an on/off setting, a number in its range for the others, written the same way each time', () => {
    expect(check('traitordash_track', '1')).toBe('1|nil')
    expect(check('traitordash_track', '0')).toBe('0|nil')
    for (const bad of ['2', 'on', 'true', '01', '-1', '1.0', '']) expect(check('traitordash_track', bad)).toMatch(/^nil\|/)
    expect(check('traitordash_track_interval_min', '0.1')).toBe('0.1|nil')
    expect(check('traitordash_track_interval_min', '.5')).toBe('0.5|nil')
    expect(check('traitordash_track_interval_min', '0.50')).toBe('0.5|nil')
    expect(check('traitordash_track_interval_min', '2')).toBe('2|nil')
    for (const bad of ['0.04', '2.01', '5', '0', '1e2', '0x1', '1..2', 'NaN', '-0.5', '0.1.1', '123456789']) expect(check('traitordash_track_interval_min', bad)).toMatch(/^nil\|/)
    expect(check('traitordash_track_budget_ms', '0.05')).toBe('0.05|nil')
    expect(check('traitordash_track_budget_ms', '5')).toBe('5|nil')
    expect(check('traitordash_track_budget_ms', '5.1')).toMatch(/^nil\|out of range/)
  })
  test('a whole number in its range is written as it is (never as 4e+04), and nothing else is taken for the limit of ticks', () => {
    for (const ok of ['1000', '40000', '100000', '1234']) expect(check('traitordash_track_max_ticks', ok)).toBe(`${ok}|nil`)
    expect(check('traitordash_track_max_ticks', '040000')).toBe('40000|nil')
    for (const bad of ['999', '100001', '1.5', '4e4', '-5', '', '0x10', '40000.', '.5', '123456789']) expect(check('traitordash_track_max_ticks', bad)).toMatch(/^nil\|/)
    expect(check('traitordash_track_max_ticks', '999')).toMatch(/^nil\|out of range \(1000 to 100000\)/)
    expect(check('traitordash_track_max_ticks', '1.5')).toMatch(/^nil\|not a whole number/)
  })
  test('is refused for a name that is not on the list, whatever the value', () => {
    for (const name of ['traitordash_token', 'traitordash_url', 'traitordash_public_url', 'rcon_password', 'ttt_known', 'sv_password', 'traitordash_nothing'])
      expect(check(name, '1')).toBe('nil|not a setting the dashboard may change')
  })
})

describe('a setting command', () => {
  const parse = (p: string) => value(`local n, v, w = TraitorDash.ParseSettingCommand(${JSON.stringify(p)}) RESULT = tostring(n) .. "|" .. tostring(v) .. "|" .. tostring(w)`)
  test('is exactly `name value`', () => {
    expect(parse('traitordash_track 1')).toBe('traitordash_track|1|nil')
    expect(parse('traitordash_track_interval_min 0.15')).toBe('traitordash_track_interval_min|0.15|nil')
  })
  test('is refused when it is anything else: another name, more words, a second command, a quote, a newline, too long, not a string', () => {
    const refused = ['traitordash_token abc', 'traitordash_url 1', 'traitordash_track 1 2', 'traitordash_track 1; quit', 'traitordash_track "1"',
      'traitordash_track 1\nquit', 'traitordash_track  1', ' traitordash_track 1', 'traitordash_track', 'rcon_password 1', 'ttt_known 1', '', 'traitordash_track 1'.padEnd(90, '1')]
    for (const p of refused) expect(parse(p), JSON.stringify(p)).toMatch(/^nil\|/)
    expect(value('local n = TraitorDash.ParseSettingCommand(nil) RESULT = tostring(n)')).toBe('nil')
    expect(value('local n = TraitorDash.ParseSettingCommand({}) RESULT = tostring(n)')).toBe('nil')
  })
  test('names the setting when only its value was wrong', () => {
    expect(parse('traitordash_track 7')).toBe('nil|must be 0 or 1|traitordash_track')
  })
})

describe('applying a setting', () => {
  test('sets the ConVar with one console command and keeps it in the file, next to what the file already holds', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ version = 1, url = "https://dash.example", token = "tok" })
      TraitorDash.HandleSettingCommand("traitordash_track 1")
      TraitorDash.HandleSettingCommand("traitordash_track_interval_min 0.1")
      RESULT = DATA["traitordash/config.json"]`)
    expect(r.applied).toEqual(['traitordash_track=1', 'traitordash_track_interval_min=0.1'])
    expect(JSON.parse(r.result)).toEqual({ version: 1, url: 'https://dash.example', token: 'tok', settings: { traitordash_track: '1', traitordash_track_interval_min: '0.1' } })
  })
  test('makes the file when there is none, and says so in the console', () => {
    const r = run(`${PREPARE}
      TraitorDash.HandleSettingCommand("traitordash_stats_debug 0")
      RESULT = DATA["traitordash/config.json"] .. "|" .. table.concat(PRINTS, "\\n")`)
    const [file, said] = r.result.split('|')
    expect(JSON.parse(file!)).toEqual({ version: 1, settings: { traitordash_stats_debug: '0' } })
    expect(said).toContain('SETTING: traitordash_stats_debug 0')
  })
  test('a file that is not valid JSON is not overwritten: the setting still applies, for now, and the console says it is not kept', () => {
    const r = run(`${PREPARE}
      DATA["traitordash/config.json"] = "{ not json"
      TraitorDash.HandleSettingCommand("traitordash_track 1")
      RESULT = DATA["traitordash/config.json"] .. "|" .. table.concat(PRINTS, "\\n")`)
    expect(r.applied).toEqual(['traitordash_track=1'])
    expect(r.result).toContain('{ not json|')
    expect(r.result).toContain('not kept for the next start')
  })
  test('a file that cannot be written is said too', () => {
    const r = run(`${PREPARE}
      WRITE_LIMIT = 0
      TraitorDash.HandleSettingCommand("traitordash_track 1")
      RESULT = table.concat(PRINTS, "\\n")`)
    expect(r.applied).toEqual(['traitordash_track=1'])
    expect(r.result).toContain('could not be written')
  })
  test('a refused command changes nothing and writes nothing', () => {
    const r = run(`${PREPARE}
      TraitorDash.HandleSettingCommand("traitordash_token abc")
      TraitorDash.HandleSettingCommand("traitordash_track 9")
      TraitorDash.HandleSettingCommand("traitordash_track 1; quit")
      RESULT = tostring(DATA["traitordash/config.json"]) .. "|" .. table.concat(PRINTS, "\\n")`)
    expect(r.applied).toEqual([])
    expect(r.result.startsWith('nil|')).toBe(true)
    expect(r.result.match(/Refused a setting command/g)).toHaveLength(3)
  })
  test('a ConVar that is not there (tracking did not load) is refused', () => {
    const r = run(`${PREPARE}
      SetCv("traitordash_track", nil)
      RESULT = tostring(TraitorDash.ApplySetting("traitordash_track", "1")) .. "|" .. tostring(select(2, TraitorDash.ApplySetting("traitordash_track", "1")))`)
    expect(r.result).toBe('false|that ConVar does not exist on this server')
  })
})

describe('at start', () => {
  test('what the file holds is applied over what server.cfg said, and only where it differs', () => {
    const r = run(`${PREPARE}
      SetCv("traitordash_track_budget_ms", "0.5")
      CONFIG_JSON({ settings = { traitordash_track = "1", traitordash_track_budget_ms = "0.50", traitordash_stats = "1" } })
      RESULT = tostring(TraitorDash.ApplySavedSettings()) .. "|" .. table.concat(PRINTS, "\\n")`)
    expect(r.applied).toEqual(['traitordash_track=1']) // the budget is the same number, the stats setting is already 1
    expect(r.result).toContain('1|')
    expect(r.result).toContain('Settings from the dashboard applied: traitordash_track=1')
  })
  test('a value that does not pass, a name that is not on the list and a file that is not JSON are ignored', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ settings = { traitordash_track = "7", traitordash_token = "x", rcon_password = "y", traitordash_track_interval_min = "9" } })
      TraitorDash.ApplySavedSettings()
      DATA["traitordash/config.json"] = "garbage"
      TraitorDash.ApplySavedSettings()
      RESULT = "ok"`)
    expect(r.applied).toEqual([])
  })
  test('starting applies them, watches the ConVars for changes and plans the reports', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ settings = { traitordash_track = "1" } })
      TraitorDash.StartSettings()
      RESULT = table.concat(CHANGES, ",") .. "|" .. table.concat(TIMERS, ",")`)
    expect(r.applied).toEqual(['traitordash_track=1'])
    const [changes, timers] = r.result.split('|')
    expect(changes!.split(',')).toHaveLength(7)
    expect(changes).toContain('traitordash_track:TraitorDash_Settings')
    expect(timers).toContain('simple 5')
    expect(timers).toContain('simple 8')
    expect(timers).toContain('create TraitorDash_ReportSettingsEvery 600 0')
  })
})

describe('the report', () => {
  const CONNECTED = `CONFIG_JSON({ url = "https://dash.example", token = "tok" }) TraitorDash.ReloadConfig()`
  test('says what each setting is now, to the settings address, with the token', () => {
    const r = run(`${PREPARE}
      ${CONNECTED}
      TraitorDash.ReportSettings()
      RESULT = SENT[1].url .. "|" .. SENT[1].headers.Authorization .. "|" .. ENC(LAST_PAYLOAD)`)
    const [url, auth, body] = r.result.split('|')
    expect(url).toBe('https://dash.example/api/v1/settings')
    expect(auth).toBe('Bearer tok')
    expect(JSON.parse(body!)).toEqual({ format: 1, settings: {
      traitordash_stats: '1', traitordash_stats_debug: '1', traitordash_stats_bots: '0', traitordash_track: '0',
      traitordash_track_interval_min: '0.2', traitordash_track_interval_max: '1', traitordash_track_budget_ms: '0.5' } })
  })
  test('says where the file holds another value than the one that runs, and nothing about anything else', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ url = "https://dash.example", token = "tok", settings = { traitordash_track = "1" } })
      TraitorDash.ReloadConfig()
      TraitorDash.ReportSettings()
      RESULT = ENC(LAST_PAYLOAD)`)
    const body = JSON.parse(r.result)
    expect(body.saved).toEqual({ traitordash_track: '1' })
    expect(JSON.stringify(body)).not.toContain('tok')
  })
  test('is not sent without a configuration', () => {
    expect(run(`${PREPARE}
      SetCv("traitordash_token", "")
      TraitorDash.ReportSettings()
      RESULT = tostring(#SENT)`).result).toBe('0')
  })
  test('a dashboard that does not know the address is left alone for five minutes, then asked again, and the console says so once', () => {
    const r = run(`${PREPARE}
      ${CONNECTED}
      local now = 1000
      SysTime = function() return now end
      TraitorDash.ReportSettings()
      SENT[1].success(404)
      TraitorDash.ReportSettings()            -- at once: not sent
      now = now + 299 TraitorDash.ReportSettings() -- still not
      local before = #SENT
      now = now + 2 TraitorDash.ReportSettings()   -- five minutes later: asked again (the ten-minute timer does this)
      SENT[#SENT].success(404)
      now = now + 301 TraitorDash.ReportSettings()
      SENT[#SENT].success(404)
      RESULT = before .. "|" .. #SENT .. "|" .. table.concat(PRINTS, "\\n")`)
    const [before, total, said] = r.result.split('|')
    expect(before).toBe('1'); expect(total).toBe('3')
    expect(said!.match(/does not know the settings report/g)).toHaveLength(1) // twice asked, once told
    expect(said).toContain('older than this bridge'); expect(said).toContain('every ten minutes')
  })
  test('the dashboard that learns the address is heard from at the next try, on the same map, and a later failure is told again', () => {
    const r = run(`${PREPARE}
      ${CONNECTED}
      local now = 1000
      SysTime = function() return now end
      TraitorDash.ReportSettings()
      SENT[1].success(404)
      now = now + 600 TraitorDash.ReportSettings()
      SENT[2].success(200)                              -- the dashboard was updated: this is it
      now = now + 600 TraitorDash.ReportSettings()
      SENT[3].success(404)                              -- and, later, not again
      RESULT = #SENT .. "|" .. table.concat(PRINTS, "\\n")`)
    const [total, said] = r.result.split('|')
    expect(total).toBe('3')
    expect(said!.match(/does not know the settings report/g)).toHaveLength(2) // told once before it worked and once after
  })
  test('a failure to send and a refusal are told once, and not again until a report has got through', () => {
    const r = run(`${PREPARE}
      ${CONNECTED}
      TraitorDash.ReportSettings() SENT[1].failed("timedout")
      TraitorDash.ReportSettings() SENT[2].failed("timedout")
      TraitorDash.ReportSettings() SENT[3].success(200)
      TraitorDash.ReportSettings() SENT[4].success(500)
      TraitorDash.ReportSettings() SENT[5].success(500)
      RESULT = table.concat(PRINTS, "\\n")`)
    expect(r.result.match(/could not be sent \(timedout\)/g)).toHaveLength(1)
    expect(r.result.match(/rejected \(HTTP 500\)/g)).toHaveLength(1)
  })
})

describe('from the dashboard, through a poll', () => {
  test('a signed `setting` command is applied, one that is not on the list is refused, and both are acknowledged', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ url = "https://dash.example", token = "tok" }) TraitorDash.ReloadConfig()
      TraitorDash.Poll()
      OK(1, '[{"id":7,"type":"setting","payload":"traitordash_track 1"},{"id":8,"type":"setting","payload":"traitordash_token evil"},{"id":9,"type":"setting","payload":"traitordash_track_budget_ms 0.3"}]')
      RESULT = ENC(TraitorDash.PendingAcks) .. "|" .. table.concat(PRINTS, "\\n")`)
    expect(r.applied).toEqual(['traitordash_track=1', 'traitordash_track_budget_ms=0.3'])
    expect(JSON.parse(r.result.split('|')[0]!)).toEqual([7, 8, 9])
    expect(r.result).toContain('Refused a setting command')
  })
  test('the old command for a ConVar still refuses a traitordash_ name', () => {
    const r = run(`${PREPARE}
      CONFIG_JSON({ url = "https://dash.example", token = "tok" }) TraitorDash.ReloadConfig()
      TraitorDash.Poll()
      OK(1, '[{"id":1,"type":"convar","payload":"traitordash_track 1"}]')
      RESULT = "done"`)
    expect(r.applied).toEqual([])
  })
})

describe('the console command', () => {
  test('lists each setting with its value, marks a default, and says what the dashboard set', () => {
    const out = lines(`
      CONFIG_JSON({ settings = { traitordash_track = "1", traitordash_stats_debug = "1" } })
      SetCv("traitordash_track", "1") SetCv("traitordash_stats_debug", "0")
      CONCMDS.traitordash_settings(nil)`)
    const text = out.join('\n')
    expect(text).toMatch(/traitordash_track\s+1 \(set by the dashboard\)/)
    expect(text).toMatch(/traitordash_stats_bots\s+0 \(default\)/)
    expect(text).toMatch(/traitordash_stats_debug\s+0 \(the dashboard set 1; this changed since\)/)
  })
})
