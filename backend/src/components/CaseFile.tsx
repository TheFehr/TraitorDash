import { FAVICON, LOGO_EMOJI } from './brand'
import { ADMIN_CSS } from './AdminCss'
import { sectionsOf, type Section } from './SectionLinks'

// The shell of the public, read-only pages with the case-file look (RFC 15, RFC 16). One shell for the normal and the embedded layout: no
// script, an inline stylesheet, nothing from the site's own bundle, so the strict
// Content-Security-Policy of these pages holds and the same page works in the game's old browser.
// The look is a stack of case files: paper on a dark desk, the role's own colour on the tab and the
// stamp. The fonts are served by the app itself (src/fonts, OFL), so every client draws the same.

const FONTS = [
  ['Courier Prime', 400, 'courier-prime-400'],
  ['Courier Prime', 700, 'courier-prime-700'],
  ['Barlow Condensed', 600, 'barlow-condensed-600'],
  ['Barlow Condensed', 800, 'barlow-condensed-800'],
] as const

const BASE_CSS = FONTS.map(([family, weight, file]) =>
  `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:url(/fonts/${file}.woff2) format("woff2")}`).join('') + `
*{box-sizing:border-box}
body{margin:0;background:#1a1612 repeating-linear-gradient(90deg,rgba(0,0,0,.12) 0 2px,transparent 2px 7px);color:#e8eaed;font:17px/1.35 "Barlow Condensed","Arial Narrow",sans-serif;font-weight:600}
a{color:inherit;text-decoration:none}
.w{max-width:56rem;margin:0 auto;padding:1rem}
header.top{border-bottom:2px solid #2a303a;background:#14110e}
header.top .w{padding-top:.6rem;padding-bottom:.6rem}
header.top a{font-weight:800;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:1.7rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:.1rem 0}
h2{font-size:.85rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin:1.3rem 0 .4rem}
.crumbs{font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;color:#a89f8c;margin-bottom:.3rem}
.crumbs a{text-decoration:underline}
.sections{display:flex;flex-wrap:wrap;gap:.5rem;margin:.2rem 0 .9rem}
.sections a,.sections span{border:1px solid #6b6455;padding:.2rem .7rem;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase;color:#d9d0bd}
.sections span{background:#e9dfc4;color:#2b2418;border-color:#e9dfc4}
.muted{color:#a89f8c}
.bar{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:.7rem 0 .2rem;font-size:.9rem;letter-spacing:.1em;text-transform:uppercase;color:#b9b2a0}
.bar b,.bar strong{color:#fff}.bar .sp{flex:1}
.bar a{border:1px solid #8a7f65;padding:.05rem .6rem;color:#e9dfc4}.bar a.on{background:#e9dfc4;color:#2a2418;font-weight:800}
form.find{margin:.6rem 0 0;display:flex;gap:.4rem}
input[type=search]{background:#14110e;color:#fff;border:1px solid #8a7f65;padding:.3rem .6rem;font:inherit;font-weight:600}
button{background:#e9dfc4;color:#2a2418;border:0;padding:.35rem .9rem;font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:1.2rem .8rem;padding-top:1rem}
.f{display:block;position:relative;background:#e9dfc4;color:#2a2418;padding:.7rem .9rem .75rem;border-radius:0 .3rem .3rem .3rem;box-shadow:0 3px 0 rgba(0,0,0,.35);font-family:"Courier Prime","Courier New",monospace;font-weight:400}
.f:before{content:"";position:absolute;left:0;top:-.7rem;width:42%;height:.7rem;background:var(--c);border-radius:.3rem .3rem 0 0}
a.f:hover{transform:translateY(-3px)}
.f .ft{display:block;margin:0;font-size:1.1rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #2a2418;padding-bottom:.25rem;overflow-wrap:anywhere}
.f>span{display:block;font-size:.8rem;margin-top:.3rem}
.file,.f>span.file{font-family:"Courier Prime","Courier New",monospace;font-weight:400;font-size:.78rem;color:#5f5846;overflow-wrap:anywhere;letter-spacing:0;text-transform:none}
.f{min-width:0}
.f .num{overflow-wrap:anywhere}
.stamp{display:table;margin:0 0 .4rem auto;border:2px solid var(--c);color:var(--c);color:color-mix(in srgb,var(--c) 55%,#000);border-color:color-mix(in srgb,var(--c) 70%,#000);padding:0 .35rem;font-family:"Barlow Condensed",sans-serif;font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em;transform:rotate(-6deg)}
.f.card{transition:transform .1s}
.f.card:hover{transform:translateY(-3px)}
.f.card h2 a:after{content:"";position:absolute;top:0;left:0;right:0;bottom:0}
.f.card a.pill{position:relative;z-index:1}
.f.card:focus-within{outline:2px solid #e9b44c;outline-offset:2px}
.f.few,.f.off{background:#2a2620;color:#a89f8c;box-shadow:none}
.f.few{border:1px dashed #7a7058}.f.few:before,.f.off:before{background:#4a4334}.f.few .ft,.f.off .ft{border-color:#5a523f}
.f.few .stamp{border-color:#a89f8c;color:#d6cdb8;background:#1a1612}
.f.big .stamp.off{border-color:#b91c1c;color:#b91c1c;background:none;transform:rotate(-10deg)}
.f.few .need{color:#e9b44c;font-weight:700}
.f.off .ft{text-decoration:line-through}
.f.off .stamp{border-color:#ef4444;color:#f87171;background:#1a1612;transform:rotate(-10deg)}
.f.big{margin-top:1rem;padding:1.1rem 1.3rem 1.3rem;box-shadow:0 4px 0 rgba(0,0,0,.4)}
.f.big:before{width:30%}
.f.big h1{font-family:"Courier Prime","Courier New",monospace;font-weight:700;font-size:1.7rem;letter-spacing:.05em;border-bottom:2px solid #2a2418;padding-bottom:.35rem;margin:0}
.f.big h2{font-family:"Courier Prime","Courier New",monospace;color:#2a2418}
.f.big .stamp{font-size:.95rem}
.f.big .desc{font-size:1rem;margin:0;white-space:pre-line;overflow-wrap:anywhere}
.f.big .none{color:#5f5846;font-size:1rem}
.f.big .note{border:1px dashed #5f5846;padding:.35rem .6rem;margin:.7rem 0 0;font-size:.9rem}
.f.big .note.need{border-color:#a16207;color:#7c4a03;font-weight:700}
.f.big .note.dead{border-color:#b91c1c;color:#991b1b;font-weight:700}
.ledger{display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:.1rem 1.5rem;margin:0}
.ledger div{display:flex;justify-content:space-between;gap:.6rem;border-bottom:1px dotted #8a7f65;padding:.2rem 0;font-size:.95rem}
.ledger dt{color:#4a4334}.ledger dd{margin:0;font-weight:700;text-align:right}
table.set{width:100%;border-collapse:collapse;font-size:.92rem}
table.set th{font-family:"Barlow Condensed",sans-serif;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:#4a4334;text-align:left;padding:.2rem .4rem .2rem 0}
table.set td{border-top:1px dotted #8a7f65;padding:.22rem .4rem .22rem 0;vertical-align:top;overflow-wrap:anywhere}
table.set td.v{font-weight:700}table.set td.d{color:#5f5846}
`

/** The other public pages of the server, so none of them is a dead end. Not shown inside the game. */
export const Sections = ({ serverId, current }: { serverId: string, current?: Section }) => (
  <nav class="sections" aria-label="Sections">
    {sectionsOf(serverId).map(s => s.key === current ? <span aria-current="page">{s.label}</span> : <a href={s.href}>{s.label}</a>)}
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
      <meta name="referrer" content="no-referrer" />
      {embed && <meta name="robots" content="noindex" />}
      <title>{title}</title>
      <link rel="icon" href={FAVICON} />
      {/* CSS is a constant of this file, never user text: inserted as is, because escaping would turn its quotes into &quot; */}
      <style dangerouslySetInnerHTML={{ __html: BASE_CSS + EXTRA_CSS + (admin ? ADMIN_CSS : '') }} />
    </head>
    <body>
      {!embed && <SiteHeader viewer={viewer} wide={admin} />}
      <main class={admin ? 'w wide' : 'w'}>{children}</main>
      {/* htmx and Alpine come from our own bundle (frontend.ts, versions locked by bun.lock), not a CDN: a third-party script on an admin page can do anything the admin can. */}
      {admin && <script defer src="/public/frontend.js"></script>}
      {scripts.map(src => <script defer src={src}></script>)}
    </body>
  </html>
)

/** The query string a link carries: the layout and the player count stay, as does a search. */

// What the stats and maps pages add to the shell (RFC 16): numbers, win bars, the log of rounds, a
// result tag, the replay tape and the team split of a map.
const EXTRA_CSS = `
.topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.acct{display:flex;align-items:center;gap:.9rem;flex-wrap:wrap;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase}
.acct form{margin:0}
.acct a{text-decoration:underline}
.mark{border:1px solid #6b6455;padding:0 .4rem;font-size:.78rem;color:#e9dfc4}
.acct .mark.adm{border-color:#dc2626;color:#f87171}
.lnkbtn{background:none;border:0;padding:0;color:#e9b44c;font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-decoration:underline;cursor:pointer}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:1.1rem .8rem;padding-top:.9rem}
.f .num{font-size:1.5rem;font-weight:700;line-height:1;border:0;padding:0;margin:0;letter-spacing:0;text-transform:none}
.f .cap{font-family:"Barlow Condensed",sans-serif;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#4a4334;margin-top:.25rem}
.win{display:grid;grid-template-columns:7rem 1fr 3rem;gap:.5rem;align-items:center;padding:.12rem 0;font-size:.85rem}
.win s{display:block;height:.55rem;background:#b8aa85;text-decoration:none}
.win s i{display:block;height:100%;background:var(--c)}
.win em{font-style:normal;text-align:right;font-weight:700}
.win span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1.2rem .8rem;padding-top:.9rem}
table.log{width:100%;border-collapse:collapse;font-size:.88rem}
table.log th{font-family:"Barlow Condensed",sans-serif;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:#4a4334;text-align:left;padding:.15rem .5rem .25rem 0}
table.log td{border-top:1px dotted #8a7f65;padding:.28rem .5rem .28rem 0;white-space:nowrap}
table.log td.r,table.log th.r{text-align:right}
table.log a{text-decoration:underline}
.res,.tape,.pill{font-style:normal}
.res{display:inline-block;border:1.5px solid var(--c);padding:0 .3rem;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--c);color:color-mix(in srgb,var(--c) 55%,#000);border-color:color-mix(in srgb,var(--c) 70%,#000)}
.tape{display:inline-block;background:#2a2418;color:#e9dfc4;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.78rem;letter-spacing:.1em;padding:0 .45rem;text-transform:uppercase}
.tape.off{background:none;color:#5f5846;border:1px dashed #5f5846}
.dim{color:#5f5846}
.dots{display:flex;flex-wrap:wrap;gap:.2rem .9rem;font-size:.88rem}
.dots i{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--c);margin-right:.35rem}
.split{display:flex;height:.5rem;margin:.35rem 0 .2rem;background:#b8aa85}
.split i{display:block;height:100%;background:var(--c)}
.btn{display:inline-block;background:#2a2418;color:#e9dfc4;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;padding:.15rem .8rem}
.pill{display:inline-block;font-family:"Barlow Condensed",sans-serif;font-size:.8rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;border:1.5px solid currentColor;padding:0 .3rem;margin-right:.3rem;transform:rotate(-3deg)}
.pill.ok{color:#256b30}.pill.wait{color:#8a5206}.pill.mute{color:#5f5846}
.f.off .pill,.f.few .pill{color:#d6cdb8}
.good{color:#256b30;font-weight:700}.bad{color:#991b1b;font-weight:700}
.scrollx{overflow-x:auto}
[hidden]{display:none!important}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #e9b44c;outline-offset:2px}
.f strong{font-weight:700}
main>p.file,main>.foot.dark,.replay .main .foot.dark,main>form>p .dim{color:#a89f8c}
main>p .pill.ok{color:#4ade80}main>p .pill.wait{color:#fbbf24}main>p .pill.mute{color:#a89f8c}
.g.wide{grid-template-columns:repeat(auto-fill,minmax(min(100%,36rem),1fr))}
h2+.f,h2+.plans,h2+p+.f{margin-top:1.1rem}
.f .sections{margin:.6rem 0 0}
.f .sections a,.f .sections span{color:#2a2418;border-color:#5f5846}
.f .sections span{background:#2a2418;color:#e9dfc4;border-color:#2a2418}
.replay{display:grid;grid-template-columns:minmax(0,1fr) 17rem;gap:1.2rem}
@media (max-width:760px){.replay{grid-template-columns:minmax(0,1fr)}}
.replay .main{min-width:0}
.replay aside{display:flex;flex-direction:column;gap:1.3rem;min-width:0}
.scrub{position:relative;margin-top:.6rem}
.scrub input{width:100%;margin:0}
.ticks{position:absolute;left:0;right:0;top:0;height:1.2rem;pointer-events:none}
.tick{position:absolute;top:0;bottom:0;width:2px;background:#dc2626;pointer-events:none}
.tick-revive{background:#34d399}.tick-role{background:#a78bfa}
.time{font-family:"Courier Prime","Courier New",monospace;font-weight:400}
.tog.play{min-width:4.5rem}
.list{max-height:14rem;overflow-y:auto;margin:.2rem 0 0;padding:0;list-style:none}
.lnk{background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline;letter-spacing:0;text-transform:none}
.prow{display:flex;align-items:center;gap:.5rem;width:100%;background:none;border:0;padding:.15rem .3rem;margin:0;color:inherit;font:inherit;text-align:left;cursor:pointer;letter-spacing:0;text-transform:none}
.prow.sel{background:#2a2418;color:#e9dfc4}
.prow.sel .prole{color:#d9d0bd}
.prow.dead{opacity:.5;text-decoration:line-through}
.pdot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;flex:none}
.pname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prole{margin-left:auto;font-size:.8rem;color:#5f5846}
.warn{margin:.3rem 0 0;font-size:.85rem;color:#e9b44c}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.8rem}
.actions form{margin:0}
.view{position:relative;margin-top:.5rem}
.view canvas{display:block;width:100%;height:min(60vh,28rem);background:#14110e;touch-action:none}
.view [data-status]{position:absolute;left:0;right:0;top:0;bottom:0;margin:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 1rem;pointer-events:none;color:#a89f8c}
.view [data-status][hidden]{display:none}
.tools{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;align-items:center;margin:.6rem 0}
.tools .cap{display:inline-block;margin:0 .5rem 0 0}
.tools label{display:inline-flex;align-items:center;gap:.4rem;color:#d9d0bd}
.tools .cap{color:#a89f8c}
.tools input[type=checkbox]{accent-color:#e9dfc4}
.f .tools label,.f .tools .cap{color:#4a4334}
.f .tools input[type=checkbox]{accent-color:#2a2418}
.f .tog[aria-pressed=true]{background:#fff8e6;color:#2a2418;border:2px solid #2a2418;padding:calc(.05rem - 1px) calc(.7rem - 1px)}
.tog{background:#3a342a;border:1px solid #8a7f65;color:#d9d0bd;padding:.05rem .7rem;margin-right:.25rem;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.9rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.tog[aria-pressed=true]{background:#e9dfc4;color:#2a2418;border-color:#e9dfc4}
.scale{height:.6rem;margin:.5rem 0 .2rem}
.ends{display:flex;justify-content:space-between;font-size:.8rem}
.sw{display:inline-block;position:relative;width:1rem;height:1rem;vertical-align:-.2rem;margin-right:.4rem}
.sw .wd{position:absolute;left:2px;top:2px;width:4px;height:4px;background:#fff}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;margin-top:1rem}
.plans figure{margin:0}
.plans img{display:block;width:100%;max-height:60vh;object-fit:contain;background:#14110e}
.plans figcaption{font-size:.85rem;color:#a89f8c;margin-top:.2rem}
code{font-family:"Courier Prime","Courier New",monospace}
.foot{margin:.9rem 0 0;font-size:.85rem;color:#a89f8c}
.foot.dark{color:#5f5846}
form.inline{display:flex;flex-wrap:wrap;gap:.6rem 1rem;align-items:flex-end;margin-top:.7rem}
label{font-family:"Barlow Condensed",sans-serif;font-size:.8rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#4a4334}
label input{display:block;margin-top:.2rem;font-family:"Courier Prime","Courier New",monospace;font-weight:400;letter-spacing:0;text-transform:none}
.f input:not([type]),.f input[type=text],.f input[inputmode]{background:#fff8e6;border:1px solid #5f5846;color:#2a2418;padding:.25rem .5rem;font-size:.9rem;width:11rem}
.f input::placeholder{color:#5f5846;opacity:1}
input[type=search]::placeholder{color:#a89f8c;opacity:1}
input[type=checkbox]{accent-color:#2a2418}
button.btn{border:0;cursor:pointer}
.btn.danger{background:#991b1b;color:#fee2e2}
main>form>p>.btn.danger{border:1px solid #f87171}
.foot a{text-decoration:underline}
`

export const NotFound = ({ what, embed, viewer }: { what: string, embed: boolean, viewer?: Viewer | null }) => (
  <Shell title="Not found" embed={embed} viewer={viewer}>
    <h1>Not found</h1>
    <p class="muted">There is no such {what}.</p>
  </Shell>
)
