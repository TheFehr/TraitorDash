import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import { run } from './helpers/bridge_harness'

// RFC 8: the bridge's configuration (backend URL and token) comes from
// data/traitordash/config.json first, then from the traitordash_url / traitordash_token ConVars.
// The harness' ConVars default to url 'https://td.test/"' (cleaned to https://td.test) and token "tok".

const addon = path.join(import.meta.dir, '../../addon/lua/traitordash')
const source = (f: string) => fs.readFileSync(path.join(addon, f), 'utf8')

const FILE = 'traitordash/config.json'
/** Puts `text` into the fake data folder and makes util.JSONToTable parse it for real. */
const withFile = (text: string) => `DATA[${JSON.stringify(FILE)}] = ${JSON.stringify(text)} util.JSONToTable = JSON_DECODE`
const withConfig = (cfg: unknown) => withFile(JSON.stringify(cfg))
const NO_CONVARS = 'SetCv("traitordash_url", "") SetCv("traitordash_token", "")'

/** What GetConfig() returns, flattened: url|token|urlSource|tokenSource|source. */
const flat = (script: string) => run(`${script}
  local c = TraitorDash.GetConfig()
  RESULT = tostring(c.url) .. "|" .. tostring(c.token) .. "|" .. c.urlSource .. "|" .. c.tokenSource .. "|" .. c.source`).result

/** Everything the bridge printed while `script` ran, one line per entry. */
const printed = (script: string): string[] => {
  const r = run(`${script}\nRESULT = table.concat(PRINTS, "\\n")`).result
  return r ? r.split('\n') : []
}

describe('where the configuration comes from', () => {
  test('ConVars only: today\'s behaviour is unchanged', () => {
    expect(flat('')).toBe('https://td.test|tok|convar|convar|convar')
  })

  test('the file only', () => {
    expect(flat(`${NO_CONVARS} ${withConfig({ url: 'https://file.example', token: 'filetoken' })}`))
      .toBe('https://file.example|filetoken|file|file|file')
  })

  test('both: the file wins', () => {
    expect(flat(withConfig({ url: 'https://file.example/', token: 'filetoken' })))
      .toBe('https://file.example|filetoken|file|file|file')
  })

  test('a file with one of the two keys falls back to the ConVar for the other', () => {
    expect(flat(withConfig({ token: 'filetoken' }))).toBe('https://td.test|filetoken|convar|file|file')
    expect(flat(withConfig({ url: 'https://file.example' }))).toBe('https://file.example|tok|file|convar|file')
  })

  test('neither: nothing is configured', () => {
    expect(flat(NO_CONVARS)).toBe('nil||none|none|none')
  })

  test('empty strings, wrong types and unknown keys in the file are ignored', () => {
    expect(flat(withConfig({ url: '', token: '' }))).toBe('https://td.test|tok|convar|convar|convar')
    expect(flat(withConfig({ url: 5, token: true }))).toBe('https://td.test|tok|convar|convar|convar')
    expect(flat(withConfig({ url: ['x'], token: { a: 1 } }))).toBe('https://td.test|tok|convar|convar|convar')
    expect(flat(withConfig({ token: 'filetoken', colour: 'red', version: 1 }))).toBe('https://td.test|filetoken|convar|file|file')
  })

  test('a URL from the file is held to the same transport rule as a ConVar', () => {
    const r = flat(withConfig({ url: 'http://public.example', token: 'filetoken' }))
    expect(r.startsWith('nil|filetoken|file|file|file')).toBe(true)
  })

  test('the raw URL is kept, so status can say what was refused', () => {
    expect(run(`${withConfig({ url: 'http://public.example', token: 't' })}
      RESULT = TraitorDash.GetConfig().rawUrl`).result).toBe('http://public.example')
  })
})

describe('a broken file', () => {
  test('invalid JSON falls back to the ConVars and says so once', () => {
    const script = `${withFile('{ not json')}`
    expect(flat(script)).toBe('https://td.test|tok|convar|convar|convar')
    const lines = printed(`${script} TraitorDash.GetConfig() TraitorDash.GetConfig() TraitorDash.GetConfig()`)
    expect(lines.filter(l => l.includes('config.json is not valid JSON; using server.cfg values.'))).toHaveLength(1)
  })

  test('JSON that is not an object is just as invalid', () => {
    for (const text of ['"a string"', '42', 'null', '']) {
      const lines = printed(`${withFile(text)} TraitorDash.GetConfig()`)
      // An absent/empty file is not an error; anything else that is not an object is.
      const warned = lines.some(l => l.includes('not valid JSON'))
      expect([text, warned]).toEqual([text, text !== '' ])
    }
  })

  test('a missing file is not an error and prints nothing', () => {
    expect(printed('TraitorDash.GetConfig()').filter(l => l.includes('config.json'))).toEqual([])
  })
})

describe('when the file is read', () => {
  test('once, not on every call (a poll every 10 seconds must not touch the disk)', () => {
    const r = run(`${withConfig({ token: 't' })}
      for i = 1, 5 do TraitorDash.GetConfig() end
      RESULT = tostring(FILE_READS)`).result
    expect(r).toBe('1')
  })

  test('ConVar changes still apply at once, only the file is cached', () => {
    const r = run(`SetCv("traitordash_token", "first") local a = TraitorDash.GetConfig().token
      SetCv("traitordash_token", "second") local b = TraitorDash.GetConfig().token
      RESULT = a .. "," .. b .. "," .. FILE_READS`).result
    expect(r).toBe('first,second,1')
  })

  test('ReloadConfig picks up a changed file', () => {
    const r = run(`${withConfig({ token: 'old' })}
      local a = TraitorDash.GetConfig().token
      DATA[${JSON.stringify(FILE)}] = '{"token":"new"}'
      local before = TraitorDash.GetConfig().token
      TraitorDash.ReloadConfig()
      RESULT = a .. "," .. before .. "," .. TraitorDash.GetConfig().token .. "," .. FILE_READS`).result
    expect(r).toBe('old,old,new,2')
  })

  test('ReloadConfig lets the warn-once messages speak again', () => {
    const script = `${withConfig({ url: 'http://public.example', token: 't' })}
      TraitorDash.GetConfig() TraitorDash.GetConfig()
      TraitorDash.ReloadConfig()
      TraitorDash.GetConfig() TraitorDash.GetConfig()`
    expect(printed(script).filter(l => l.includes('Not talking to the backend'))).toHaveLength(2)
  })
})

describe('traitordash_reload', () => {
  const reload = (who: string, extra = '') => run(`${withConfig({ token: 'old' })}
    TraitorDash.GetConfig()
    DATA[${JSON.stringify(FILE)}] = '{"token":"new"}'
    ${extra}
    CONCMDS.traitordash_reload(${who})
    RESULT = TraitorDash.GetConfig().token`).result

  test('is registered and re-reads the file from the server console', () => {
    expect(reload('nil')).toBe('new')
  })

  test('a superadmin may use it, any other player may not', () => {
    expect(reload('{ IsSuperAdmin = function() return true end }')).toBe('new')
    expect(reload('{ IsSuperAdmin = function() return false end }')).toBe('old')
  })

  test('it says what it did, without the token', () => {
    const lines = printed(`${withConfig({ url: 'https://file.example', token: 'SECRETFILETOKEN' })}
      TraitorDash.GetConfig() CONCMDS.traitordash_reload(nil)`)
    const line = lines.find(l => l.toLowerCase().includes('configuration reloaded'))
    expect(line).toBeDefined()
    expect(line).toContain('file')
    expect(lines.join('\n')).not.toContain('SECRETFILETOKEN')
  })
})

describe('every sender uses the configuration', () => {
  const FILE_CFG = withConfig({ url: 'https://file.example', token: 'filetoken' })
  const calls: Record<string, string> = {
    poll: 'TraitorDash.Poll()',
    ingest: 'util.TableToJSON = function() return "J" end TraitorDash.IngestRole("medic", "x", "h", false)',
    values: 'TraitorDash.PushValues({ { name = "ttt_known", present = true } })',
    lang: 'file.Find = function() return {}, {} end file.Read = function(p, w) if w == "LUA" then return "x" end return DATA[p] end TraitorDash.PushLang()',
  }
  for (const [name, call] of Object.entries(calls)) {
    test(`${name}: goes to the URL in the file with the token in the file`, () => {
      const r = run(`${FILE_CFG} ${call} RESULT = SENT[1].url .. " " .. SENT[1].headers.Authorization`).result
      expect(r.startsWith('https://file.example/')).toBe(true)
      expect(r.endsWith('Bearer filetoken')).toBe(true)
    })
  }

  test('with nothing configured every sender stays idle', () => {
    for (const [name, call] of Object.entries(calls)) {
      const sent = run(`${NO_CONVARS} ${call} RESULT = tostring(#SENT)`).result
      expect([name, sent]).toEqual([name, '0'])
    }
  })

  test('if the configuration could not be loaded at all, nothing is sent (fail closed)', () => {
    for (const [name, call] of Object.entries(calls)) {
      const sent = run(`TraitorDash.GetConfig = nil ${call} RESULT = tostring(#SENT)`).result
      expect([name, sent]).toEqual([name, '0'])
    }
  })

  test('no sender reads the ConVars itself any more', () => {
    for (const f of ['bridge.lua', 'stats.lua']) {
      const code = source(f)
      expect([f, /cv_token|cv_url/.test(code)]).toEqual([f, false])
      expect([f, /GetConVar\(\s*["']traitordash_(url|token)["']/.test(code)]).toEqual([f, false])
    }
  })
})

describe('telling the owner what is missing', () => {
  const init = (script = '') => printed(`${script} TraitorDash.Init()`)
  const missing = (lines: string[]) => lines.filter(l => l.includes('Not configured'))

  test('a configured bridge says nothing about configuration', () => {
    expect(missing(init())).toEqual([])
  })

  test('no token anywhere: one message, once, even if Init runs twice', () => {
    const lines = missing(init('SetCv("traitordash_token", "") TraitorDash.Init()'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('no token')
    expect(lines[0]).toContain('config.json')
  })

  test('no token anywhere: the message names the pairing command first', () => {
    const [line] = missing(init('SetCv("traitordash_token", "")'))
    expect(line).toContain('traitordash_connect "<url>" <code>')
    expect(line!.indexOf('traitordash_connect')).toBeLessThan(line!.indexOf('config.json'))
  })

  test('no URL anywhere: its own message', () => {
    const lines = missing(init('SetCv("traitordash_url", "")'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('no dashboard URL')
  })

  test('a token in the file counts as configured', () => {
    expect(missing(init(`SetCv("traitordash_token", "") ${withConfig({ token: 'filetoken' })}`))).toEqual([])
  })

  test('an invalid file is reported at init', () => {
    expect(init(withFile('{ nope')).some(l => l.includes('config.json is not valid JSON'))).toBe(true)
  })

  test('the file overriding a ConVar that someone set is mentioned, by name only', () => {
    const lines = init(`SetCv("traitordash_token", "cvtoken") ${withConfig({ url: 'https://file.example', token: 'filetoken' })}`)
    expect(lines.filter(l => l.includes('config.json overrides traitordash_token'))).toHaveLength(1)
    expect(lines.filter(l => l.includes('config.json overrides traitordash_url'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('cvtoken')
    expect(lines.join('\n')).not.toContain('filetoken')
  })

  test('no override message when the ConVar is the default, empty or the same value', () => {
    // traitordash_url left at its shipped default, token empty: nothing was "set" in server.cfg.
    const defaults = init(`SetCv("traitordash_url", "http://localhost:3000") SetCv("traitordash_token", "") ${withConfig({ url: 'https://file.example', token: 'filetoken' })}`)
    expect(defaults.filter(l => l.includes('overrides'))).toEqual([])
    const same = init(`SetCv("traitordash_token", "same") ${withConfig({ token: 'same' })}`)
    expect(same.filter(l => l.includes('overrides'))).toEqual([])
  })
})

describe('traitordash_status', () => {
  const status = (script = '') => printed(`${script} CONCMDS.traitordash_status(nil)`)

  test('says where each value comes from and how long the token is, never the token', () => {
    const lines = status(withConfig({ url: 'https://file.example', token: 'SECRETFILETOKEN' }))
    expect(lines.some(l => l.includes('URL: https://file.example') && l.includes('file'))).toBe(true)
    expect(lines.some(l => l.includes('Token: set') && l.includes('15 characters') && l.includes('file'))).toBe(true)
    expect(lines.join('\n')).not.toContain('SECRETFILETOKEN')
  })

  test('values from server.cfg are labelled as such', () => {
    const lines = status()
    expect(lines.some(l => l.includes('URL: https://td.test') && l.includes('server.cfg'))).toBe(true)
    expect(lines.some(l => l.includes('Token: set') && l.includes('3 characters') && l.includes('server.cfg'))).toBe(true)
  })

  test('an unconfigured bridge says so', () => {
    const lines = status(NO_CONVARS)
    expect(lines.some(l => l.includes('Token: not set'))).toBe(true)
    expect(lines.some(l => l.includes('URL: (not set)'))).toBe(true)
  })

  test('a refused URL is shown with the reason', () => {
    const lines = status(withConfig({ url: 'http://public.example', token: 't' }))
    expect(lines.some(l => l.includes('http://public.example') && l.toLowerCase().includes('refused'))).toBe(true)
  })
})

describe('the token is never printed', () => {
  test('whatever the configuration and whatever the bridge does', () => {
    const SECRETS = ['SECRETFILETOKEN', 'SECRETCVTOKEN']
    const scenarios = [
      `SetCv("traitordash_token", "SECRETCVTOKEN")`,
      withConfig({ url: 'https://file.example', token: 'SECRETFILETOKEN' }),
      `SetCv("traitordash_token", "SECRETCVTOKEN") ${withConfig({ url: 'https://file.example', token: 'SECRETFILETOKEN' })}`,
      `SetCv("traitordash_token", "SECRETCVTOKEN") ${withFile('{ broken')}`,
      `SetCv("traitordash_token", "SECRETCVTOKEN") ${withConfig({ url: 'http://public.example', token: 'SECRETFILETOKEN' })}`,
    ]
    for (const scenario of scenarios) {
      const lines = printed(`${scenario}
        TraitorDash.Init()
        TraitorDash.Poll()
        if SENT[1] and SENT[1].success then SENT[1].success(200, "not signed") end
        if SENT[1] and SENT[1].failed then SENT[1].failed("timeout") end
        TraitorDash.IngestRole("medic", "x", "h", false)
        if SENT[#SENT] and SENT[#SENT].success then SENT[#SENT].success(500, "no") end
        CONCMDS.traitordash_status(nil)
        CONCMDS.traitordash_reload(nil)`)
      for (const secret of SECRETS) expect([scenario, lines.join('\n').includes(secret)]).toEqual([scenario, false])
    }
  })
})
