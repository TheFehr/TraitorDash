import { expect, test, describe } from 'bun:test'
import { Layout, LOGO_EMOJI } from '../src/components/Layout'

describe('Layout favicon', () => {
  const html = String(<Layout path="/"><p>hi</p></Layout>)
  const href = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? ''

  test('has an icon link, as an inline SVG so there is nothing extra to serve', () => {
    expect(href.startsWith('data:image/svg+xml,')).toBe(true)
  })

  test('the icon is the logo emoji', () => {
    const svg = decodeURIComponent(href.replace('data:image/svg+xml,', ''))
    expect(svg).toContain('<svg')
    expect(svg).toContain(LOGO_EMOJI)
    expect(html).toContain(`<span>${LOGO_EMOJI}</span> TraitorDash`) // same emoji in the nav logo
  })

  test('the data URI is safe inside the attribute (no raw quotes, angle brackets or spaces)', () => {
    expect(href).not.toMatch(/["<> ]/)
  })
})
