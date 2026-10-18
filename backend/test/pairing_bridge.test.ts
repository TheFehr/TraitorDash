import { expect, test, describe } from 'bun:test'
import { run } from './helpers/bridge_harness'

// RFC 9, bridge side: `traitordash_connect <url> <code>` trades a pairing code for the server's
// token and stores it in data/traitordash/config.json (RFC 8). The harness' fake HTTP records the
// request; the test then plays the backend's answer by calling success()/failed() itself.

const TOKEN = 'a1'.repeat(32) // 64 hex characters
const ANSWER = JSON.stringify({ token: TOKEN, server_id: 'srv-1', name: 'Main' })

// A real JSON decoder and a flat encoder, so the config file the bridge writes can be read back.
const SETUP = `
  util.JSONToTable = JSON_DECODE
  util.TableToJSON = function(t)
    LAST_PAYLOAD = t
    local keys = {} for k in pairs(t) do if type(t[k]) == "string" then keys[#keys + 1] = k end end table.sort(keys)
    local parts = {} for _, k in ipairs(keys) do parts[#parts + 1] = string.format('"%s":"%s"', k, t[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  SYNCS, POLLS = 0, 0
  TraitorDash.Sync = function() SYNCS = SYNCS + 1 end
  TraitorDash.Poll = function() POLLS = POLLS + 1 end
  SERVER = nil
  function CONNECT(args, ply) CONCMDS.traitordash_connect(ply, "traitordash_connect", args) end
`
// The setup runs after the bridge is loaded, so it cannot be `before`.
const connect = (args: string[], opts: { before?: string, then?: string } = {}) => {
  const r = run(`
    ${SETUP}
    ${opts.before ?? ''}
    CONNECT({${args.map(a => JSON.stringify(a)).join(', ')}})
    ${opts.then ?? ''}
    RESULT = table.concat(PRINTS, "\\n")
      .. "\\n#SENT=" .. #SENT
      .. "\\n#SYNCS=" .. SYNCS
      .. "\\n#CONFIG=" .. tostring(DATA["traitordash/config.json"])
      .. "\\n#FILES=" .. (function() local n = {} for k in pairs(DATA) do n[#n + 1] = k end table.sort(n) return table.concat(n, ",") end)()
  `)
  const out = r.result
  const get = (k: string) => (out.match(new RegExp(`^#${k}=(.*)$`, 'm')) ?? [])[1]
  return {
    printed: out.split('\n').filter(l => !l.startsWith('#')),
    sent: Number(get('SENT')),
    syncs: Number(get('SYNCS')),
    config: get('CONFIG') === 'nil' ? null : JSON.parse(get('CONFIG')!),
    files: get('FILES') ?? '',
  }
}

/** Connects, then lets the backend answer the one request with `status` and `body`. */
const answered = (status: number, body: string, args = ['https://dash.example', 'ABCDE-FGHJK'], before = '') =>
  connect(args, { before, then: `SENT[1].success(${status}, ${JSON.stringify(body)})` })

const noSecret = (r: { printed: string[] }) => expect(r.printed.join('\n')).not.toContain(TOKEN)

describe('traitordash_connect: before anything is sent', () => {
  test('without a url and a code it prints the usage and sends nothing', () => {
    for (const args of [[], ['https://dash.example']]) {
      const r = connect(args)
      expect(r.printed.join('\n')).toContain('Usage: traitordash_connect <url> <code>')
      expect(r.sent).toBe(0)
    }
  })

  test('a public http:// url is refused before a request is made', () => {
    const r = connect(['http://dash.example.com', 'ABCDE-FGHJK'])
    expect(r.sent).toBe(0)
    expect(r.printed.join('\n')).toContain('https://')
    expect(r.files).toBe('')
  })

  test('a code that cannot be one is refused before a request is made', () => {
    for (const code of ['ABCDE', 'ABCDE-FGHJK-LMNPQ', 'ABCDE-FGHJU', 'ABC!E-FGHJK', '']) {
      const r = connect(['https://dash.example', code])
      expect(r.sent).toBe(0)
      expect(r.printed.join('\n')).toContain('does not look like a pairing code')
    }
  })

  test('only a superadmin or the console may run it', () => {
    const r = connect(['https://dash.example', 'ABCDE-FGHJK'], {
      before: 'CONNECT = function(args) CONCMDS.traitordash_connect({ IsSuperAdmin = function() return false end }, "x", args) end',
    })
    expect(r.sent).toBe(0)
    expect(r.printed.join('')).toBe('')
  })

  test('if the result cannot be stored, it stops before redeeming (redeeming rotates the token)', () => {
    const r = connect(['https://dash.example', 'ABCDE-FGHJK'], { before: 'WRITE_LIMIT = 0' })
    expect(r.sent).toBe(0)
    expect(r.printed.join('\n')).toContain('Cannot write to data/traitordash')
  })

  test('the write probe leaves nothing behind', () => {
    const r = connect(['https://dash.example', 'ABCDE-FGHJK'])
    expect(r.sent).toBe(1)
    expect(r.files).toBe('')
  })
})

describe('traitordash_connect: the request', () => {
  const request = (args: string[]) => {
    const r = run(`${SETUP} CONNECT({${args.map(a => JSON.stringify(a)).join(', ')}})
      local q = SENT[1]
      RESULT = q.method .. "|" .. q.url .. "|" .. q.body .. "|" .. tostring(q.timeout) .. "|" .. tostring(q.headers["Content-Type"]) .. "|" .. tostring(q.headers["Authorization"])`)
    return r.result.split('|')
  }

  test('posts the normalised code to /api/v1/pair, with a timeout and no credentials', () => {
    expect(request(['https://dash.example/', 'abcde-fghjk'])).toEqual(
      ['POST', 'https://dash.example/api/v1/pair', '{"code":"ABCDEFGHJK"}', '15', 'application/json', 'nil'])
  })

  test('fixes the usual look-alikes in the code', () => {
    expect(request(['https://dash.example', 'o0i1l-LIO00'])[2]).toBe('{"code":"0011111000"}')
  })

  test('a private-network http:// address is allowed, like for the token', () => {
    expect(request(['http://192.168.1.5:3000', 'ABCDE-FGHJK'])[1]).toBe('http://192.168.1.5:3000/api/v1/pair')
  })
})

describe('traitordash_connect: a good answer', () => {
  test('writes url and token to config.json, reloads, and starts the sync', () => {
    const r = answered(200, ANSWER)
    expect(r.config).toEqual({ url: 'https://dash.example', token: TOKEN })
    expect(r.syncs).toBe(1)
    expect(r.printed.join('\n')).toContain('Connected as «Main». Syncing roles')
    noSecret(r)
  })

  test('the new configuration is in effect straight away', () => {
    const r = run(`${SETUP} SetCv("traitordash_url", "") SetCv("traitordash_token", "")
      TraitorDash.GetConfig() -- the old (empty) configuration is already cached
      CONNECT({ "https://dash.example", "ABCDE-FGHJK" })
      SENT[1].success(200, ${JSON.stringify(ANSWER)})
      local c = TraitorDash.GetConfig()
      RESULT = tostring(c.url) .. "|" .. c.token .. "|" .. c.source`)
    expect(r.result).toBe(`https://dash.example|${TOKEN}|file`)
  })

  test('creates the data folder first', () => {
    const r = run(`${SETUP} CONNECT({ "https://dash.example", "ABCDE-FGHJK" }) RESULT = table.concat(DIRS, ",")`)
    expect(r.result).toBe('traitordash')
  })

  test('the cleaned url is what is stored, not what was typed', () => {
    const r = answered(200, ANSWER, ['https://dash.example///', 'ABCDE-FGHJK'])
    expect(r.config.url).toBe('https://dash.example')
  })
})

describe('traitordash_connect: answers that must not be trusted or stored', () => {
  test.each([
    ['a token that is not 64 hex characters', JSON.stringify({ token: 'short', name: 'Main' })],
    ['an uppercase-hex token of the right length', JSON.stringify({ token: TOKEN.toUpperCase(), name: 'Main' })],
    ['a token that is not a string', JSON.stringify({ token: 5, name: 'Main' })],
    ['no token', JSON.stringify({ name: 'Main' })],
    ['a name that is not a string', JSON.stringify({ token: TOKEN, name: 5 })],
    ['a body that is not JSON', 'not json at all'],
    ['an empty body', ''],
  ])('%s', (_, body) => {
    const r = answered(200, body)
    expect(r.config).toBeNull()
    expect(r.syncs).toBe(0)
    expect(r.printed.join('\n')).toContain('unexpected answer')
    expect(r.printed.join('\n')).not.toContain('Connected')
    noSecret(r)
  })

  test('a token delivered with an error status is not stored', () => {
    const r = answered(500, ANSWER)
    expect(r.config).toBeNull()
    noSecret(r)
  })
})

describe('traitordash_connect: failures say one clear thing and store nothing', () => {
  test.each([
    [400, '{"error":"invalid or expired code"}', 'invalid or expired'],
    [429, '{"error":"Too many attempts; try again later"}', 'Too many attempts'],
    [404, 'Not Found', 'does not support pairing'],
    [500, 'oops', 'HTTP 500'],
  ])('HTTP %d', (status, body, expected) => {
    const r = answered(status, body)
    expect(r.printed.join('\n')).toContain(expected)
    expect(r.config).toBeNull()
    expect(r.syncs).toBe(0)
  })

  test('a network error', () => {
    const r = connect(['https://dash.example', 'ABCDE-FGHJK'], { then: 'SENT[1].failed("unsuccessful")' })
    expect(r.printed.join('\n')).toContain('Could not reach https://dash.example: unsuccessful')
    expect(r.config).toBeNull()
  })

  test('if the token cannot be saved after redeeming, it says so and does not pretend', () => {
    // The probe is the one write that works; the config write is lost.
    const r = answered(200, ANSWER, ['https://dash.example', 'ABCDE-FGHJK'], 'WRITE_LIMIT = 1')
    expect(r.config).toBeNull()
    expect(r.syncs).toBe(0)
    const text = r.printed.join('\n')
    expect(text).toContain('could not be saved')
    expect(text).toContain('Regen token')
    expect(text).not.toContain('Connected')
    noSecret(r)
  })

  test('two connects at once: the second is refused until the first has finished', () => {
    const r = run(`${SETUP}
      CONNECT({ "https://dash.example", "ABCDE-FGHJK" })
      CONNECT({ "https://dash.example", "ABCDE-FGHJK" })
      local during = #SENT
      SENT[1].failed("x")
      CONNECT({ "https://dash.example", "ABCDE-FGHJK" })
      RESULT = during .. "|" .. #SENT .. "|" .. table.concat(PRINTS, "\\n")`)
    const [during, after, ...rest] = r.result.split('|')
    expect(during).toBe('1')
    expect(after).toBe('2')
    expect(rest.join('|')).toContain('already in progress')
  })

  test('the pairing code is never printed', () => {
    const r = answered(400, '{"error":"invalid or expired code"}')
    expect(r.printed.join('\n')).not.toMatch(/ABCDE/)
  })
})

describe('when pairing.lua is missing', () => {
  test('the bridge still loads and has no traitordash_connect', () => {
    // bridge.lua includes pairing.lua under pcall, like config.lua.
    expect(require('fs').readFileSync(`${import.meta.dir}/../../addon/lua/traitordash/bridge.lua`, 'utf8'))
      .toMatch(/pcall\(include, "traitordash\/pairing\.lua"\)/)
  })
})
