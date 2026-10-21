import { expect, test } from 'bun:test'
import { HEX6, TEAMS, hex, teamColour, teamLabel } from '../src/teamColours'

test('every team in the table has a label and a colour that makes a valid #rrggbb', () => {
  for (const [key, t] of Object.entries(TEAMS)) {
    expect(t.label, key).not.toBe('')
    expect(HEX6.test(hex(t.colour)), key).toBe(true)
    expect(teamColour(key)).toBe(t.colour)
  }
})
test('singular names and case give the same team; an unknown team keeps a stable colour and its own name', () => {
  expect(teamColour('Traitor')).toBe(teamColour('traitors'))
  expect(teamColour('detective')).toBe(TEAMS.detectives!.colour)
  expect(teamLabel('detectives')).toBe('Detectives')
  expect(teamLabel('pirates')).toBe('pirates')
  expect(teamColour('pirates')).toBe(teamColour('pirates'))
  expect(teamColour('constructor')).toBe(teamColour('constructor'))
})
test('hex pads and HEX6 refuses anything else', () => {
  expect(hex(0x0a141e)).toBe('#0a141e')
  expect(hex(0)).toBe('#000000')
  for (const bad of ['#fff', '#FFFFFF', 'red', '#ff00aa;', '']) expect(HEX6.test(bad), bad).toBe(false)
})
