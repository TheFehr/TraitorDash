import { expect, test, describe } from 'bun:test'
import { FAVICON, LOGO_EMOJI } from '../src/components/brand'
import { AdminHomePage } from '../src/components/AdminPages'

describe('Tab icon', () => {
  const html = String(<AdminHomePage steamId="76561198000000001" servers={[]} />)
  const href = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? ''

  test('has an icon link, as an inline SVG so there is nothing extra to serve', () => {
    expect(href.startsWith('data:image/svg+xml,')).toBe(true)
    expect(href).toBe(FAVICON)
  })

  test('the icon is the logo emoji', () => {
    const svg = decodeURIComponent(href.replace('data:image/svg+xml,', ''))
    expect(svg).toContain('<svg')
    expect(svg).toContain(LOGO_EMOJI)
    expect(html).toContain(`<span>${LOGO_EMOJI}</span> TraitorDash`) // same emoji in the header logo
  })

  test('the data URI is safe inside the attribute (no raw quotes, angle brackets or spaces)', () => {
    expect(href).not.toMatch(/["<> ]/)
  })
})
