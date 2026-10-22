import { expect, test } from 'bun:test'
import { prettyMap } from '../src/mapName'

test('the prefix and the version tags at the end go; the words stay, in capitals', () => {
  const cases: Record<string, string> = {
    ttt_aircraft_v1b: 'Aircraft',
    ttt_community_bowling_v5a: 'Community Bowling',
    ttt_community_bowling_re_v1b: 'Community Bowling Re',
    ttt_lttp_kakariko_a5_fixed: 'Lttp Kakariko',
    ttt_rooftops_2016_v1: 'Rooftops',
    ttt_island_2024: 'Island',
    ttt_terrortrain_2020_b5: 'Terrortrain',
    ttt_minecraft_b5: 'Minecraft',
    ttt_67thway_rework_b1: '67thway Rework',
    ttt_skyscraper: 'Skyscraper',
    gm_construct: 'Construct',
    cs_office: 'Office',
  }
  for (const [file, name] of Object.entries(cases)) expect(prettyMap(file), file).toBe(name)
})

test('a version tag in the middle stays,, a lone prefix is just capitalised', () => {
  expect(prettyMap('ttt_v2_arena')).toBe('V2 Arena')
  expect(prettyMap('ttt_v2')).toBe('V2')
  expect(prettyMap('ttt')).toBe('Ttt')
  expect(prettyMap('')).toBe('')
})

test('a name with no underscores or an unknown prefix is only capitalised', () => {
  expect(prettyMap('arena')).toBe('Arena')
  expect(prettyMap('xyz_dust_v2')).toBe('Xyz Dust')
})
