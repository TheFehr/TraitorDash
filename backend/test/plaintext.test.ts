import { expect, test, describe } from 'bun:test'
import { stripTags } from '../src/services/plaintext'
import { cleanWorkshopText } from '../src/services/workshopText'
import { cleanDescription } from '../src/services/roleview'

describe('markup removed from text', () => {
  test('a tag is removed, the text around it stays', () => {
    expect(stripTags('a <b>bold</b> word')).toBe('a bold word')
  })

  test('a tag built from the pieces of another is removed too, not left behind', () => {
    expect(stripTags('<<b>script>alert(1)<</b>/script>')).toBe('alert(1)')
    expect(stripTags('<scr<i>ipt>x')).toBe('x')
  })

  test('a lone angle bracket is plain text', () => {
    expect(stripTags('3 < 5, and 7 is more')).toBe('3 < 5, and 7 is more')
  })

  test('the role description and the Workshop text use it', () => {
    expect(cleanDescription('hi <<b>script>x')).toBe('hi x')
    expect(cleanWorkshopText('Plays <<b>script>quietly in the dark and waits for a long while')).not.toContain('<')
  })
})
