import { expect, test, describe } from 'bun:test'
import { normalizeConVarValue, formatConVarCommand } from '../src/services/convars'

describe('normalizeConVarValue', () => {
  test('accepts numbers, words and role names', () => {
    expect(normalizeConVarValue('0.15')).toBe('0.15')
    expect(normalizeConVarValue('400')).toBe('400')
    expect(normalizeConVarValue('detective')).toBe('detective')
    expect(normalizeConVarValue('-1')).toBe('-1')
  })

  test('normalises on/off/true/false to 1/0', () => {
    expect(normalizeConVarValue('on')).toBe('1')
    expect(normalizeConVarValue('TRUE')).toBe('1')
    expect(normalizeConVarValue('off')).toBe('0')
    expect(normalizeConVarValue('false')).toBe('0')
  })

  test('rejects anything that could start a second console command or break quoting', () => {
    for (const bad of ['1\nquit', '1;quit', '1\r\nquit', 'a"b', '$(x)', '1 // c', 'a\\b', '`x`']) {
      expect(normalizeConVarValue(bad)).toBeNull()
    }
  })

  test('rejects non-strings and overlong values', () => {
    expect(normalizeConVarValue(undefined)).toBeNull()
    expect(normalizeConVarValue(['1'] as any)).toBeNull()
    expect(normalizeConVarValue('a'.repeat(65))).toBeNull()
  })
})

describe('formatConVarCommand', () => {
  test('quotes only empty values and values with spaces', () => {
    expect(formatConVarCommand('ttt_x', '1')).toBe('ttt_x 1')
    expect(formatConVarCommand('ttt_x', '')).toBe('ttt_x ""')
    expect(formatConVarCommand('ttt_x', 'a b')).toBe('ttt_x "a b"')
  })
})
