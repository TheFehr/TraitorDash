// The tab icon is the same emoji as the logo, as an inline SVG data URI: no extra file or
// static route to serve, and it can never 404.
export const LOGO_EMOJI = '🕵️‍♂️'
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="80" text-anchor="middle" dominant-baseline="central">${LOGO_EMOJI}</text></svg>`
)}`
