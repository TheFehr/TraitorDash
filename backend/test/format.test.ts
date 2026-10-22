import { expect, test } from 'bun:test'
import { clock, duration, pct, kd, mb, mapSize } from '../src/format'

test('clock and duration write m:ss, never negative; an unknown length is a dash', () => {
  expect(clock(0)).toBe('0:00')
  expect(clock(61_999)).toBe('1:01')
  expect(clock(-5000)).toBe('0:00')
  expect(duration(125)).toBe('2:05')
  expect(duration(0)).toBe('0:00')
  expect(duration(null)).toBe('–')
})
test('percent rounds, and has a dash for nothing to divide by', () => {
  expect(pct(1, 3)).toBe('33%')
  expect(pct(2, 3)).toBe('67%')
  expect(pct(0, 0)).toBe('–')
})
test('kills per death: no deaths counts as one', () => {
  expect(kd(10, 4)).toBe('2.50')
  expect(kd(3, 0)).toBe('3.00')
  expect(kd(0, 0)).toBe('0.00')
})
test('sizes: one decimal under 10 MB, whole above; map sizes are whole megabytes', () => {
  expect(mb(5 * 1024 * 1024)).toBe('5.0')
  expect(mb(10 * 1024 * 1024)).toBe('10')
  expect(mapSize(23 * 1024 * 1024)).toBe('23 MB')
  expect(mapSize(null)).toBe('–')
})

import { ago } from '../src/format'
test('ago: just now, minutes, hours, days; a time in the future is just now; nothing known is a dash', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  expect(ago('2026-10-22T11:59:30Z', now)).toBe('just now')
  expect(ago('2026-10-22T11:55:00Z', now)).toBe('5 min ago')
  expect(ago('2026-10-22T10:00:00Z', now)).toBe('2 h ago')
  expect(ago('2026-10-19T12:00:00Z', now)).toBe('3 d ago')
  expect(ago('2026-10-22T12:05:00Z', now)).toBe('just now')
  expect(ago(null, now)).toBe('–')
  expect(ago('not a date', now)).toBe('–')
})
