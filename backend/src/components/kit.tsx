import { ago } from '../format'
import { hex, teamColour, teamLabel } from '../teamColours'
import { pct } from '../format'
import type { WinRow } from '../services/stats'
import type { Viewer } from './CaseFile'

// The parts the public pages are made of (RFC 17): the same few pieces everywhere, in the case-file
// look of CaseFile.tsx. A page says what it shows; how it looks is decided here and in the stylesheet.

/** What a page needs to know about the request: where it is shown and who is looking. */
export interface Ctx {
  /** Shown in the game's window: no header, no admin controls, every link keeps `embed=1`. */
  embed: boolean
  viewer: Viewer | null
  /** "Chrome 86": what the visitor's browser says it is (named at the foot of a page in the game). */
  browser?: string | null
  /** Open sign-in: whether a visitor who is not signed in can be offered the Steam login. */
  signinOpen?: boolean
  now?: number
}

/** Whether admin controls are shown: an admin on the website, never in the game's window. */
export const adminOf = (ctx: Ctx): boolean => !!ctx.viewer?.admin && !ctx.embed

type Param = string | number | boolean | null | undefined
/** A query string from the parameters that have a value; `true` is "1". */
export const qs = (params: Record<string, Param>): string => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === '') continue
    parts.push(`${k}=${v === true ? '1' : encodeURIComponent(String(v))}`)
  }
  return parts.length ? '?' + parts.join('&') : ''
}

/** A link on the page: the path of this server plus the parameters, with `embed` kept. */
export const link = (ctx: Ctx, path: string, params: Record<string, Param> = {}): string =>
  path + qs({ embed: ctx.embed, ...params })

/** A team's colour as `#rrggbb`. */
export const teamHex = (team: string | null): string => hex(teamColour(team))

export const Crumbs = ({ children }: { children: any }) => <div class="crumbs">{children}</div>

/** The server's name; for an admin on the website it is the way back to the server's settings. */
export const ServerName = ({ ctx, server }: { ctx: Ctx, server: { id: string, name: string } }) => (
  adminOf(ctx) ? <a href={`/servers/${server.id}`}>{server.name}</a> : <>{server.name}</>
)

/** The result of a round, as a tag in the team's colour. */
export const Result = ({ result }: { result: string }) => <i class="res" style={`--c:${teamHex(result)}`}>{teamLabel(result)}</i>

/** A share of a whole as a labelled bar. */
export const Bar = ({ label, part, whole, colour, title }: { label: string, part: number, whole: number, colour: string, title?: string }) => {
  const share = whole > 0 ? Math.round((part / whole) * 100) : 0
  return <div class="win" title={title}><span>{label}</span><s><i style={`--c:${colour};width:${share}%`}></i></s><em>{share}%</em></div>
}

/** One number with its caption. */
export const Num = ({ label, value }: { label: string, value: any }) => (
  <div class="f"><div class="num">{value}</div><div class="cap">{label}</div></div>
)

/** The time something happened, readable at a glance and exact on hover. */
export const When = ({ iso, now }: { iso: string | null, now?: number }) => (
  iso ? <time datetime={iso} title={iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}>{ago(iso, now)}</time> : <span>–</span>
)

/** Win rate colour: green at or above half, red below, grey with nothing to go on. */
export const rateClass = (part: number, whole: number): string => (whole === 0 ? 'dim' : part / whole >= 0.5 ? 'good' : 'bad')

/** Teams or roles with how they did. */
export const WinTable = ({ title, rows, empty }: { title: string, rows: WinRow[], empty: string }) => (
  <div class="f" style="--c:#9ca3af">
    <h2 class="ft">{title}</h2>
    {rows.length === 0 ? <span>{empty}</span> : (
      <div class="scrollx">
        <table class="log">
          <tr><th>Name</th><th class="r">Played</th><th class="r">Win %</th><th class="r">Survived</th></tr>
          {rows.map(r => (
            <tr>
              <td>{r.name}</td>
              <td class="r">{r.played}</td>
              <td class="r"><span class={rateClass(r.wins, r.played)}>{pct(r.wins, r.played)}</span> <span class="dim">({r.wins})</span></td>
              <td class="r dim">{pct(r.survived, r.played)}</td>
            </tr>
          ))}
        </table>
      </div>
    )}
  </div>
)

/** What the page takes the visitor for: said at the foot of a page in the game, so a missing session shows. */
export const Who = ({ ctx }: { ctx: Ctx }) => (
  ctx.embed
    ? <p class="foot" data-viewer>{ctx.viewer ? `Signed in as ${ctx.viewer.steamId}.` : 'Not signed in.'}{ctx.browser ? ` Browser: ${ctx.browser}.` : ''}</p>
    : null
)

/** "Chrome 86" from a User-Agent header: what the game's built-in browser is, which decides what its pages may use. */
export const browserOf = (userAgent: string | null | undefined): string | null => {
  const m = /Chrome\/(\d{1,3})/.exec(userAgent ?? '')
  return m ? `Chrome ${m[1]}` : null
}

/** Sub-tabs of a page: the current one is not a link. */
export const Tabs = ({ label, items, current }: { label: string, items: { key: string, label: string, href: string }[], current: string }) => (
  <nav class="sections" aria-label={label}>
    {items.map(i => i.key === current ? <span aria-current="page">{i.label}</span> : <a href={i.href}>{i.label}</a>)}
  </nav>
)

/** The pills of a bar (sort, switches): the current one is marked. */
export const Pills = ({ label, items, current }: { label: string, items: { key: string, label: string, href: string }[], current: string }) => (
  <div class="bar"><span>{label}</span>{items.map(i => <a class={i.key === current ? 'on' : ''} href={i.href}>{i.label}</a>)}</div>
)
