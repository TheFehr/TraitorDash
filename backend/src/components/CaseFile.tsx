import { FAVICON, LOGO_EMOJI } from './brand'
import { ADMIN_CSS, FONT_URLS, PUBLIC_CSS } from './styles'
import { sectionsOf, type Section } from './SectionLinks'
import { sourceHash } from '../services/version'

/** A script of this site with the version of the code in its address: the files are served for a week without asking again, so a new build has to have a new address or browsers keep running the old one. */
const script = (src: string) => `${src}?v=${sourceHash()}`

// The shell of the public, read-only pages with the case-file look (RFC 15, RFC 16). One shell for the normal and the embedded layout: no
// script, an inline stylesheet, nothing from the site's own bundle, so the strict
// Content-Security-Policy of these pages holds and the same page works in the game's old browser.
// The look is a stack of case files: paper on a dark desk, the role's own colour on the tab and the
// stamp. The fonts are served by the app itself (src/fonts, OFL), so every client draws the same.

/** The other public pages of the server, so none of them is a dead end. Not shown inside the game. */
export const Sections = ({ serverId, current, admin = false }: { serverId: string, current?: Section, admin?: boolean }) => (
  <nav class="sections" aria-label="Sections">
    {sectionsOf(serverId).map(s => <a href={s.href} aria-current={s.key === current ? 'page' : undefined}>{s.label}</a>)}
    {admin && <a href={`/servers/${serverId}`} class="manage" data-manage title="The server's settings, for admins">⚙ Manage</a>}
  </nav>
)

/** Who is looking, for the header of a page on the website. */
export interface Viewer { steamId: string, admin: boolean }

const SiteHeader = ({ viewer, wide }: { viewer?: Viewer | null, wide?: boolean }) => (
  <header class="top">
    <div class={`w topbar${wide ? ' wide' : ''}`}>
      <a href="/" class="brand"><span>{LOGO_EMOJI}</span> TraitorDash</a>
      <div class="acct">
        {viewer?.admin && <a href="/servers">Servers</a>}
        {viewer?.admin && <span data-admin-mark class="mark adm">admin</span>}
        {viewer && !viewer.admin && <span data-user class="mark">{viewer.steamId}</span>}
        {viewer?.admin && <span class="muted">{viewer.steamId}</span>}
        {viewer
          ? <form method="post" action="/auth/logout"><button type="submit" class="lnkbtn">Logout</button></form>
          : <a href="/auth/steam">Sign in with Steam</a>}
      </div>
    </div>
  </header>
)

/**
 * The page around everything: the head, the stylesheet, and on the website the header with the account
 * links (`embed` takes it away, for the game's window). `scripts` are files of this site (`/public/...`);
 * a page that lists none has none.
 */
export const Shell = ({ title, embed, children, viewer, scripts = [], admin = false }: { title: string, embed: boolean, children: any, viewer?: Viewer | null, scripts?: string[], admin?: boolean }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="referrer" content="same-origin" />
      {embed && <meta name="robots" content="noindex" />}
      <title>{title}</title>
      <link rel="icon" href={FAVICON} />
      {/* The fonts are asked for at once and the faces say font-display:optional: a font that has not arrived at the first layout is not swapped in half way through (that moved the header and every line, 0.1 to 0.3 on a phone); it is used from the next page on. */}
      {FONT_URLS.map(href => <link rel="preload" as="font" type="font/woff2" href={href} crossorigin="" />)}
      {/* CSS is a constant of this file, never user text: inserted as is, because escaping would turn its quotes into &quot; */}
      <style dangerouslySetInnerHTML={{ __html: PUBLIC_CSS + (admin ? ADMIN_CSS : '') }} />
    </head>
    <body>
      {!embed && <SiteHeader viewer={viewer} wide={admin} />}
      <main class={admin ? 'w wide' : 'w'}>{children}</main>
      {/* htmx and Alpine come from our own bundle (frontend.ts, versions locked by bun.lock), not a CDN: a third-party script on an admin page can do anything the admin can. */}
      {admin && <script defer src={script('/public/frontend.js')}></script>}
      {scripts.map(src => <script defer src={script(src)}></script>)}
    </body>
  </html>
)

/** The query string a link carries: the layout and the player count stay, as does a search. */

// What the stats and maps pages add to the shell (RFC 16): numbers, win bars, the log of rounds, a
// result tag, the replay tape and the team split of a map.
export const NotFound = ({ what, embed, viewer }: { what: string, embed: boolean, viewer?: Viewer | null }) => (
  <Shell title="Not found" embed={embed} viewer={viewer}>
    <h1>Not found</h1>
    <p class="muted">There is no such {what}.</p>
  </Shell>
)
