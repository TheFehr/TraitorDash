import { expect, test } from 'bun:test'
import { HEX6, TEAMS, hex, teamColour, teamColoursOf, teamHexOf, teamLabel } from '../src/teamColours'

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

// A team's colour is the game's: the colour of the role that carries the team's name.

const roles = [
  { role_name: 'jackal', team: 'jackals', color: '#1dd1e0' },
  { role_name: 'sidekick', team: 'jackals', color: '#aa00aa' },      // not the namesake: ignored
  { role_name: 'traitor', team: 'traitors', color: '#c80000' },
  { role_name: 'necromancer', team: 'necromancers', color: '#12ab34' },
  { role_name: 'infected', team: 'infected', color: '#99ff00' },      // team and role share a name
  { role_name: 'hitman', team: 'nones', color: 'not a colour' },
]

test('the namesake role gives the team its colour, other roles of the team do not', () => {
  const t = teamColoursOf(roles)
  expect(t).toEqual({ jackals: '#1dd1e0', traitors: '#c80000', necromancers: '#12ab34', infected: '#99ff00' })
})

test('a team with no such role, or a role with no valid colour, keeps the table colour', () => {
  const t = teamColoursOf(roles)
  expect(teamHexOf(t, 'innocents')).toBe(hex(teamColour('innocents')))
  expect(teamHexOf(t, 'nones')).toBe(hex(teamColour('nones')))
  expect(teamHexOf(undefined, 'jackals')).toBe('#f97316')
})

test('a result is found by the team name in either form, in any case', () => {
  const t = teamColoursOf(roles)
  expect(teamHexOf(t, 'jackals')).toBe('#1dd1e0')
  expect(teamHexOf(t, 'Jackal')).toBe('#1dd1e0')
  expect(teamHexOf(t, 'TRAITORS')).toBe('#c80000')
  expect(teamHexOf(t, 'infected')).toBe('#99ff00')
  expect(teamHexOf(t, null)).toBe(hex(teamColour(null)))
})