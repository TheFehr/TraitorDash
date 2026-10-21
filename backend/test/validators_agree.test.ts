import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'
import { NAME, FINGERPRINT, STEAM_ID, STEAM_ID64, WSID, ROUND_ID, SMALL_INT } from '../src/services/validators'
import { parsePlayers } from '../src/services/roleview'

// The same rules exist in TypeScript (services/validators.ts) and in Lua (traitordash/util.lua).
// Both are run against one list of cases; where the Lua side is stricter on purpose, that is stated.
const UTIL = fs.readFileSync(path.join(import.meta.dir, '../../addon/lua/traitordash/util.lua'), 'utf8')

/** Calls `fn` of TraitorDash.Util with a JSON-free list of Lua literals and returns what each call gave, as strings. */
function lual(fn: string, args: string[]): string[] {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  try {
    const run = (code: string) => { if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1))) }
    run(UTIL)
    run(`OUT = {} for _, v in ipairs({ ${args.map(a => `{ ${a} }`).join(', ')} }) do OUT[#OUT + 1] = tostring((TraitorDash.Util.${fn}(v[1]))) end OUT = table.concat(OUT, "|")`)
    lua.lua_getglobal(L, to_luastring('OUT'))
    return to_jsstring(lua.lua_tostring(L, -1)).split('|')
  } finally { lua.lua_close(L) }
}
const q = (s: string) => JSON.stringify(s)

describe('names', () => {
  const cases = ['haunter', 'a', 'x'.repeat(64), 'x'.repeat(65), '', 'a b', 'a/b', 'a..b', 'ttt_a', 'ttt-a.1', 'Ünï', 'a\n', '..', '.', '_x', '-x', '.x']
  test('Lua accepts only what TypeScript accepts; the two differ only on a leading "." "_" or "-"', () => {
    const lu = lual('ValidName', cases.map(q))
    cases.forEach((c, i) => {
      const ts = NAME.test(c), l = lu[i] === 'true'
      if (l) expect(ts, c).toBe(true)
      else if (ts) expect(/^[._-]/.test(c), c).toBe(true) // stricter on purpose: an address never starts that way
    })
  })
  test('the fixed ends of the range', () => {
    const lu = lual('ValidName', ['"x"', `"${'x'.repeat(64)}"`, `"${'x'.repeat(65)}"`, '""'])
    expect(lu).toEqual(['true', 'true', 'false', 'false'])
  })
})

describe('server ids', () => {
  test('letters, digits and dashes up to 64', () => {
    const ids = ['abc-123', 'a'.repeat(64), 'a'.repeat(65), '', 'a_b', 'a b', 'a.b']
    expect(lual('ValidServerId', ids.map(q))).toEqual(['true', 'true', 'false', 'false', 'false', 'false', 'false'])
  })
})

describe('player counts', () => {
  test('Lua and parsePlayers give the same answer for every number from 0 to 130', () => {
    const nums = Array.from({ length: 131 }, (_, i) => i)
    const lu = lual('PlayerCount', nums.map(String))
    nums.forEach(n => expect(lu[n] === 'nil' ? null : Number(lu[n]), String(n)).toBe(parsePlayers(String(n))))
    expect(lual('PlayerCount', ['1.5', '-1', '129'])).toEqual(['nil', 'nil', 'nil'])
    expect(SMALL_INT.test('128') && SMALL_INT.test('1')).toBe(true)
  })
})

describe('public addresses', () => {
  test('the client and the server file agree on what a base is', () => {
    const bases = ['https://dash.example.org', 'https://dash.example.org:8443', 'https://dash.example.org/td', 'http://dash.example.org', 'https://', 'https://-x.org', 'https://.x.org', 'https://a.org/x y', 'https://a.org/' + 'x'.repeat(200), 'ftp://a.org']
    expect(lual('ValidBase', bases.map(q))).toEqual(['true', 'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false'])
  })
})

describe('the other shapes (TypeScript only)', () => {
  test('are what the routes rely on', () => {
    expect(FINGERPRINT.test('ab'.repeat(32))).toBe(true)
    expect(FINGERPRINT.test('AB'.repeat(32))).toBe(false)
    expect(STEAM_ID.test('76561198000000000') && STEAM_ID.test('999000000007')).toBe(true)
    expect(STEAM_ID.test('1234')).toBe(false)
    expect(STEAM_ID64.test('76561198000000000')).toBe(true)
    expect(STEAM_ID64.test('999000000007')).toBe(false)
    expect(WSID.test('3725258931')).toBe(true)
    expect(WSID.test('1234567890123')).toBe(false)
    expect(ROUND_ID.test('round-000001')).toBe(true)
    expect(ROUND_ID.test('short')).toBe(false)
  })
})
