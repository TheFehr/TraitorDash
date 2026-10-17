import { expect, test, describe } from 'bun:test'
import { Extractor } from '../src/services/Extractor'
import { ExtractorCore } from '../src/services/ExtractorCore'

const sanitize = (code: string): string => (ExtractorCore as any).sanitizeCode(code)

// A role whose settings-menu label is `expr`; returns what the dashboard would show.
const labelOf = async (expr: string) => {
  const code = `function ROLE:AddToSettingsMenu(p) p:MakeHelp({ label = ${expr} }) end`
  return (await Extractor.extractSchema(code, {}, {}, 'probe', [])).schema[0].args.label
}

describe('GMod syntax in code is still translated', () => {
  test('operators', () => {
    expect(sanitize('if !x then end')).toBe('if  not x then end')
    expect(sanitize('a != b')).toBe('a ~= b')
    expect(sanitize('a && b || c')).toBe('a  and  b  or  c')
  })

  test('comments', () => {
    expect(sanitize('x = 1 // trailing, with ! and && inside')).toBe('x = 1 -- trailing, with ! and && inside')
    expect(sanitize('/* multi-line\ncomment */ local a = 1;')).toBe('--[[ multi-line\ncomment ]] local a = 1;')
    expect(sanitize('/* has ]] inside */')).toBe('--[==[ has ]] inside ]==]')
  })

  test('a bare continue becomes a call, a field called continue is left alone', () => {
    expect(sanitize('for i=1,3 do if i==2 then continue end end')).toContain('then __td_continue() end')
    expect(sanitize('x.continue = 1 y:continue()')).toBe('x.continue = 1 y:continue()')
    expect(sanitize('local continued = 1')).toBe('local continued = 1')
  })
})

describe('text inside strings and comments is never rewritten', () => {
  test('the cases the audit found', async () => {
    expect(await labelOf('"Disguise enabled!"')).toBe('Disguise enabled!')
    expect(await labelOf('"see http://example.com/x"')).toBe('see http://example.com/x')
    expect(await labelOf('"a && b || continue"')).toBe('a && b || continue')
  })

  test('single quotes, escaped quotes and a backslash before the closing quote', async () => {
    expect(await labelOf(`'single quoted!'`)).toBe('single quoted!')
    expect(await labelOf(`"she said \\"hi!\\" // not a comment"`)).toBe('she said "hi!" // not a comment')
    expect(await labelOf(`"ends with a backslash \\\\"`)).toBe('ends with a backslash \\')
  })

  test('long strings and long comments', async () => {
    expect(await labelOf('[[long ! string // with && stuff]]')).toBe('long ! string // with && stuff')
    expect(await labelOf('[==[level two ]] still ! inside]==]')).toBe('level two ]] still ! inside')
    expect(sanitize('--[[ comment with ! // && ]] x = 1')).toBe('--[[ comment with ! // && ]] x = 1')
    expect(sanitize('-- plain comment with !')).toBe('-- plain comment with !')
  })

  test('code after a string on the same line is still translated', () => {
    expect(sanitize('x = "a!" .. (!y and "b")')).toBe('x = "a!" .. ( not y and "b")')
    expect(sanitize('t = { "keep//this", !flag }')).toBe('t = { "keep//this",  not flag }')
  })

  test('numbers are not read as words', () => {
    expect(sanitize('x = 1e5 y = 0xFF')).toBe('x = 1e5 y = 0xFF')
  })

  test('a quote inside a comment does not start a string', () => {
    expect(sanitize(`-- don't !\nx = !y`)).toBe(`-- don't !\nx =  not y`)
    expect(sanitize(`// it's a comment !\nx = !y`)).toBe(`-- it's a comment !\nx =  not y`)
  })

  test('an unterminated string ends at the line break instead of swallowing the file', () => {
    expect(sanitize('x = "oops\ny = !z')).toBe('x = "oops\ny =  not z')
  })
})

describe('a whole role file', () => {
  test('GMod operators in code and punctuation in labels together', async () => {
    const code = `
      local function enabled() return !false && true end
      function ROLE:AddToSettingsMenu(p)
        for i = 1, 2 do
          if i == 1 then continue end // skip the first
          p:MakeCheckbox({ label = "Enable it! (see http://wiki/x)", convar = "ttt_x_" .. i })
        end
        /* done */
      end
    `
    const { schema } = await Extractor.extractSchema(code, {}, {}, 'probe', [])
    // `continue` is a no-op call while extracting, so both iterations contribute an entry.
    expect(schema.map((e: any) => e.args.convar)).toEqual(['ttt_x_1', 'ttt_x_2'])
    for (const e of schema) expect(e.args.label).toBe('Enable it! (see http://wiki/x)')
  })
})
