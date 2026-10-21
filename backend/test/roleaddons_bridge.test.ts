import { expect, test, describe } from 'bun:test'
import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import fs from 'fs'
import path from 'path'

// roleaddons.lua: which Workshop addon holds each role, read from the file list at the start of the
// addon's .gma. The GMA bytes are built here the way gmad writes them.
const LUA_DIR = path.join(import.meta.dir, '../../addon/lua/traitordash')
const UTIL = fs.readFileSync(path.join(LUA_DIR, 'util.lua'), 'utf8')
const SRC = fs.readFileSync(path.join(LUA_DIR, 'roleaddons.lua'), 'utf8')

const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])])
function gma(files: string[], o: { version?: number, title?: string, required?: string[], cut?: number } = {}): Buffer {
  const version = o.version ?? 3
  const parts: Buffer[] = [Buffer.from('GMAD'), Buffer.from([version]), Buffer.alloc(16, 1)]
  if (version >= 2) { for (const r of o.required ?? []) parts.push(cstr(r)); parts.push(cstr('')) }
  parts.push(cstr(o.title ?? 'An addon'), cstr('{"description":"x"}'), cstr('someone'), Buffer.alloc(4, 1))
  files.forEach((f, i) => { const idx = Buffer.alloc(4); idx.writeUInt32LE(i + 1); parts.push(idx, cstr(f), Buffer.alloc(8, 2), Buffer.alloc(4, 3)) })
  parts.push(Buffer.alloc(4)) // end of the list
  parts.push(Buffer.alloc(100, 9)) // file contents: never read
  const all = Buffer.concat(parts)
  return o.cut !== undefined ? all.subarray(0, o.cut) : all
}

const PRELUDE = `
  SERVER = true
  PRINTED = {}
  print = function(...) local o = {} for i = 1, select("#", ...) do o[i] = tostring((select(i, ...))) end PRINTED[#PRINTED + 1] = table.concat(o, " ") end
  IsValid = function(v) return v ~= nil and v ~= false end
  local t = 0
  function SysTime() t = t + 0.001 return t end
  CMDS = {}
  concommand = { Add = function(n, fn) CMDS[n] = fn end }
  WRITTEN, READS = {}, {}
  file = { CreateDir = function() end, Write = function(p, c) WRITTEN[p] = c end }
  util = { TableToJSON = function(v) return "json" end }
  local function unhex(h) return (h:gsub("%x%x", function(x) return string.char(tonumber(x, 16)) end)) end
  -- a file object over a binary string, counting how much was read
  function FakeFile(data) local pos = 1 return {
    Read = function(self, n) local s = data:sub(pos, pos + n - 1) pos = pos + #s READS[#READS + 1] = #s return s end,
    Close = function() end } end
  FILES, OPENS, ONLY = {}, {}, nil
  file.Open = function(p, mode, where) OPENS[#OPENS + 1] = p .. "|" .. tostring(where) local d = FILES[p] if d and (not ONLY or ONLY == where) then return FakeFile(unhex(d)) end end
  ADDONS = {}
  engine = { GetAddons = function() return ADDONS end }
  function FILE(path, buf) FILES[path] = buf end
`
function play(script: string, files: Record<string, Buffer> = {}): any {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  try {
    const run = (code: string) => { if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1))) }
    run(PRELUDE); run(UTIL); run(SRC)
    for (const [p, b] of Object.entries(files)) run(`FILE(${JSON.stringify(p)}, "${b.toString('hex')}")`)
    run(script)
    run(`
      local function enc(v)
        local t = type(v)
        if t == "string" then return '"' .. v:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"') .. '"' end
        if t == "number" or t == "boolean" then return tostring(v) end
        if t == "nil" then return "null" end
        if t == "table" then
          if #v > 0 or next(v) == nil then local o = {} for i, x in ipairs(v) do o[i] = enc(x) end return "[" .. table.concat(o, ",") .. "]" end
          local o = {} for k, x in pairs(v) do if type(x) ~= "function" then o[#o + 1] = enc(tostring(k)) .. ":" .. enc(x) end end return "{" .. table.concat(o, ",") .. "}"
        end
        return "null"
      end
      __OUT = enc({ opens = OPENS, result = RESULT, printed = PRINTED, written = WRITTEN, reads = READS })
    `)
    lua.lua_getglobal(L, to_luastring('__OUT'))
    return JSON.parse(to_jsstring(lua.lua_tostring(L, -1)))
  } finally { lua.lua_close(L) }
}

const R = 'lua/terrortown/entities/roles/'
describe('reading the file list of a GMA', () => {
  const list = (buf: Buffer) => play(`
    local names = {}
    local data = FILES.x
    local title, count = TraitorDash.ReadGmaFiles(FakeFile((data:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end))), function(n) names[#names + 1] = n end)
    RESULT = { title = title, count = count, names = names, why = not title and count or nil }`, { x: buf }).result
  test('version 3, with required content: title, count and every name', () => {
    const r = list(gma([`${R}arsonist/shared.lua`, 'materials/a.vmt'], { title: 'TTT2 Arsonist', required: ['gm_construct'] }))
    expect(r).toMatchObject({ title: 'TTT2 Arsonist', count: 2, names: [`${R}arsonist/shared.lua`, 'materials/a.vmt'] })
  })
  test('version 1 has no required content list', () => {
    expect(list(gma(['a.lua'], { version: 1 })).names).toEqual(['a.lua'])
  })
  test('a list longer than one chunk is read across the chunks, and the contents are never read', () => {
    const many = Array.from({ length: 4000 }, (_, i) => `materials/some/long/folder/name/${i}.vmt`)
    const buf = gma([...many, `${R}late/shared.lua`])
    const out = play(`local c = 0 local last
      local title, count = TraitorDash.ReadGmaFiles(FakeFile((FILES.x:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end))), function(n) c = c + 1 last = n end)
      RESULT = { count = count, last = last }`, { x: buf })
    expect(out.result).toEqual({ count: 4001, last: `${R}late/shared.lua` })
    expect(out.reads.length).toBeGreaterThan(2)
    expect(out.reads.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(buf.length)
  })
  test('compressed or foreign data, an unknown version and a cut-off file are named, not crashed on', () => {
    expect(list(Buffer.from('LZMA-not-a-gma-at-all'))).toMatchObject({ why: expect.stringContaining('not a GMA') })
    expect(list(gma(['a.lua'], { version: 9 }))).toMatchObject({ why: 'unknown GMA version 9' })
    expect(list(gma(['a.lua', 'b.lua'], { cut: 70 }))).toMatchObject({ why: 'cut short' })
    expect(list(Buffer.alloc(0))).toMatchObject({ why: expect.stringContaining('not a GMA') })
  })
})

describe('addon paths as the operating system writes them', () => {
  const abs = '/home/container/steam_cache/content/4000/777/pack.gma'
  const files = { 'steam_cache/content/4000/777/pack.gma': gma([`${R}arsonist/shared.lua`], { title: 'Pack' }) }
  const addons = `ADDONS = { { wsid = "777", title = "Pack", file = "${abs}", mounted = true } } ONLY = "BASE_PATH"`
  test('the leading folders are dropped until a search root accepts the rest', () => {
    const o = play(`${addons} RESULT = TraitorDash.FindRoleAddons()`, files)
    expect(o.result.roles.arsonist).toEqual([{ wsid: '777', title: 'Pack' }])
    expect(o.result.opened).toEqual({ BASE_PATH: 1 })
    expect(o.result.unreadable).toEqual([])
    expect(o.opens[0]).toBe(`${abs}|GAME`) // the plain path is tried first
  })
  test('when nothing opens, the addon is reported with the reason and the command still finishes', () => {
    const o = play(`ADDONS = { { wsid = "777", title = "Pack", file = "${abs}", mounted = true } } CMDS.traitordash_roleaddons(nil)`)
    expect(o.printed.some((l: string) => l.includes('outside every search path'))).toBe(true)
    expect(o.printed.some((l: string) => l.includes('0 roles found in 0 addons (1 could not be read)'))).toBe(true)
  })
  test('a long list of unreadable addons is cut to five lines and a count', () => {
    const many = Array.from({ length: 12 }, (_, i) => `{ wsid = "${100 + i}", title = "T${i}", file = "/x/${i}.gma", mounted = true }`).join(',')
    const o = play(`ADDONS = { ${many} } CMDS.traitordash_roleaddons(nil)`)
    expect(o.printed.filter((l: string) => l.includes('could not read')).length).toBe(5)
    expect(o.printed.some((l: string) => l.includes('7 more could not be read'))).toBe(true)
  })
})

describe('which role a path belongs to', () => {
  test('the role folder, the single file and the sh_ file; nothing else', () => {
    const cases = [`${R}arsonist/shared.lua`, `${R}Arsonist/cl_init.lua`, `${R}haunter.lua`, `${R}sh_ghost.lua`, 'lua/other/arsonist/shared.lua', 'materials/arsonist.vmt', `${R}`, `${R}x/y/z.lua`]
    const r = play(`RESULT = {} for i, p in ipairs({${cases.map(c => JSON.stringify(c)).join(',')}}) do RESULT[i] = TraitorDash.RoleOfPath(p) or "none" end`).result
    expect(r).toEqual(['arsonist', 'arsonist', 'haunter', 'ghost', 'none', 'none', 'none', 'x'])
  })
})

describe('finding the addon of each role', () => {
  const addons = `ADDONS = {
    { wsid = "111", title = "Arsonist pack", file = "cache/workshop/111.gma", mounted = true },
    { wsid = "222", title = "Other", file = "cache/workshop/222.gma", mounted = true },
    { wsid = "333", title = "Not mounted", file = "cache/workshop/333.gma", mounted = false },
    { wsid = "444", title = "Compressed", file = "cache/workshop/444.gma", mounted = true },
    { wsid = "555", title = "Missing", file = "cache/workshop/555.gma", mounted = true },
    { wsid = "x6", title = "Bad id", file = "cache/workshop/666.gma", mounted = true },
  }`
  const files = {
    'cache/workshop/111.gma': gma([`${R}arsonist/shared.lua`, `${R}arsonist/cl_init.lua`, `${R}pyro/shared.lua`], { title: 'Arsonist pack' }),
    'cache/workshop/222.gma': gma([`${R}pyro/shared.lua`, 'materials/x.vmt']),
    'cache/workshop/333.gma': gma([`${R}hidden/shared.lua`]),
    'cache/workshop/444.gma': Buffer.from('not a gma, compressed'),
    'cache/workshop/666.gma': gma([`${R}badid/shared.lua`]),
  }
  test('each role lists the addons that hold it; unmounted addons and bad ids are skipped; unreadable ones are reported', () => {
    const r = play(`${addons} RESULT = TraitorDash.FindRoleAddons()`, files).result
    expect(Object.keys(r.roles).sort()).toEqual(['arsonist', 'pyro'])
    expect(r.roles.arsonist).toEqual([{ wsid: '111', title: 'Arsonist pack' }])
    expect(r.roles.pyro).toEqual([{ wsid: '111', title: 'Arsonist pack' }, { wsid: '222', title: 'Other' }])
    expect(r.scanned).toBe(3)
    expect(r.unreadable.map((u: any) => u.wsid)).toEqual(['444', '555'])
    expect(r.unreadable[1].why).toContain('cannot open')
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })
  test('the command prints one line per role and a summary, writes the file, and is for the console and superadmins', () => {
    const o = play(`${addons} CMDS.traitordash_roleaddons(nil)`, files)
    expect(o.printed.some((l: string) => l.includes('arsonist <- Arsonist pack (111)'))).toBe(true)
    expect(o.printed.some((l: string) => l.includes('pyro <- Arsonist pack (111), Other (222)'))).toBe(true)
    expect(o.printed.some((l: string) => l.includes('could not read Compressed (444)'))).toBe(true)
    expect(o.printed.some((l: string) => l.includes('2 roles found in 3 addons (2 could not be read)'))).toBe(true)
    expect(o.written['traitordash/roleaddons.json']).toBe('json')
    const refused = play(`${addons} CMDS.traitordash_roleaddons({ IsSuperAdmin = function() return false end })`, files)
    expect(refused.printed).toEqual([])
    expect(Object.keys(refused.written)).toEqual([])
    const allowed = play(`${addons} CMDS.traitordash_roleaddons({ IsSuperAdmin = function() return true end })`, files)
    expect(allowed.written['traitordash/roleaddons.json']).toBe('json')
  })
  test('no addons at all is not an error', () => {
    const o = play(`ADDONS = {} CMDS.traitordash_roleaddons(nil)`)
    expect(o.printed.some((l: string) => l.includes('0 roles found in 0 addons'))).toBe(true)
  })
})
