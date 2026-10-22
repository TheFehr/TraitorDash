import { FAVICON } from './Layout'
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
.bar b{color:#fff}.bar .sp{flex:1}
.bar a{border:1px solid #4a4334;padding:.05rem .6rem;color:#e9dfc4}.bar a.on{background:#e9dfc4;color:#2a2418;font-weight:800}
form.find{margin:.6rem 0 0;display:flex;gap:.4rem}
input[type=search]{background:#14110e;color:#fff;border:1px solid #4a4334;padding:.3rem .6rem;font:inherit;font-weight:600}
button{background:#e9dfc4;color:#2a2418;border:0;padding:.35rem .9rem;font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:1.2rem .8rem;padding-top:1rem}
.f{display:block;position:relative;background:#e9dfc4;color:#2a2418;padding:.7rem .9rem .75rem;border-radius:0 .3rem .3rem .3rem;box-shadow:0 3px 0 rgba(0,0,0,.35);font-family:"Courier Prime","Courier New",monospace;font-weight:400}
.f:before{content:"";position:absolute;left:0;top:-.7rem;width:42%;height:.7rem;background:var(--c);border-radius:.3rem .3rem 0 0}
a.f:hover{transform:translateY(-3px)}
.f b{display:block;font-size:1.1rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #2a2418;padding-bottom:.25rem;overflow-wrap:anywhere}
.f span{display:block;font-size:.8rem;margin-top:.3rem}
.stamp{display:table;margin:0 0 .4rem auto;border:2px solid var(--c);color:var(--c);color:color-mix(in srgb,var(--c) 62%,#000);padding:0 .35rem;font-family:"Barlow Condensed",sans-serif;font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em;transform:rotate(-6deg)}
.f.few,.f.off{background:#2a2620;color:#a89f8c;box-shadow:none}
.f.few{border:1px dashed #5a523f}.f.few:before,.f.off:before{background:#4a4334}.f.few b,.f.off b{border-color:#5a523f}
.f.few .stamp{border-color:#a89f8c;color:#d6cdb8;background:#1a1612}
.f.big .stamp.off{border-color:#b91c1c;color:#b91c1c;background:none;transform:rotate(-10deg)}
.f.few .need{color:#e9b44c;font-weight:700}
.f.off b{text-decoration:line-through}
.f.off .stamp{border-color:#ef4444;color:#f87171;background:#1a1612;transform:rotate(-10deg)}
.f.big{margin-top:1rem;padding:1.1rem 1.3rem 1.3rem;box-shadow:0 4px 0 rgba(0,0,0,.4)}
.f.big:before{width:30%}
.f.big h1{font-family:"Courier Prime","Courier New",monospace;font-weight:700;font-size:1.7rem;letter-spacing:.05em;border-bottom:2px solid #2a2418;padding-bottom:.35rem;margin:0}
.f.big h2{font-family:"Courier Prime","Courier New",monospace;color:#2a2418}
.f.big .stamp{font-size:.95rem}
.f.big .desc{font-size:1rem;margin:0;white-space:pre-line;overflow-wrap:anywhere}
.f.big .none{color:#6b6350;font-size:1rem}
.f.big .note{border:1px dashed #6b6350;padding:.35rem .6rem;margin:.7rem 0 0;font-size:.9rem}
.f.big .note.need{border-color:#a16207;color:#7c4a03;font-weight:700}
.f.big .note.dead{border-color:#b91c1c;color:#991b1b;font-weight:700}
.ledger{display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:.1rem 1.5rem;margin:0}
.ledger div{display:flex;justify-content:space-between;gap:.6rem;border-bottom:1px dotted #8a7f65;padding:.2rem 0;font-size:.95rem}
.ledger dt{color:#4a4334}.ledger dd{margin:0;font-weight:700;text-align:right}
table.set{width:100%;border-collapse:collapse;font-size:.92rem}
table.set th{font-family:"Barlow Condensed",sans-serif;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:#4a4334;text-align:left;padding:.2rem .4rem .2rem 0}
table.set td{border-top:1px dotted #8a7f65;padding:.22rem .4rem .22rem 0;vertical-align:top;overflow-wrap:anywhere}
table.set td.v{font-weight:700}table.set td.d{color:#6b6350}
`

/** The other public pages of the server, so none of them is a dead end. Not shown inside the game. */
export const Sections = ({ serverId, current }: { serverId: string, current?: Section }) => (
  <nav class="sections" aria-label="Sections">
    {sectionsOf(serverId).map(s => s.key === current ? <span aria-current="page">{s.label}</span> : <a href={s.href}>{s.label}</a>)}
  </nav>
)

export const Shell = ({ title, embed, children }: { title: string, embed: boolean, children: any }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="referrer" content="no-referrer" />
      {embed && <meta name="robots" content="noindex" />}
      <title>{title}</title>
      <link rel="icon" href={FAVICON} />
      {/* CSS is a constant of this file, never user text: inserted as is, because escaping would turn its quotes into &quot; */}
      <style dangerouslySetInnerHTML={{ __html: BASE_CSS + EXTRA_CSS }} />
    </head>
    <body>
      {!embed && (
        <header class="top"><div class="w"><a href="/">TraitorDash</a></div></header>
      )}
      <main class="w">{children}</main>
    </body>
  </html>
)

/** The query string a link carries: the layout and the player count stay, as does a search. */

// What the stats and maps pages add to the shell (RFC 16): numbers, win bars, the log of rounds, a
// result tag, the replay tape and the team split of a map.
const EXTRA_CSS = `
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:1.1rem .8rem;padding-top:.9rem}
.f .num{font-size:1.5rem;font-weight:700;line-height:1;border:0;padding:0;margin:0;letter-spacing:0;text-transform:none}
.f .cap{font-family:"Barlow Condensed",sans-serif;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#4a4334;margin-top:.25rem}
.win{display:grid;grid-template-columns:7rem 1fr 3rem;gap:.5rem;align-items:center;padding:.12rem 0;font-size:.85rem}
.win s{display:block;height:.55rem;background:#cdbf9b;text-decoration:none}
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
.res{display:inline-block;border:1.5px solid var(--c);padding:0 .3rem;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--c);color:color-mix(in srgb,var(--c) 62%,#000)}
.tape{display:inline-block;background:#2a2418;color:#e9dfc4;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.78rem;letter-spacing:.1em;padding:0 .45rem;text-transform:uppercase}
.tape.off{background:none;color:#6b6350;border:1px dashed #8a7f65}
.dim{color:#6b6350}
.dots{display:flex;flex-wrap:wrap;gap:.2rem .9rem;font-size:.88rem}
.dots i{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--c);margin-right:.35rem}
.split{display:flex;height:.5rem;margin:.35rem 0 .2rem;background:#cdbf9b}
.split i{display:block;height:100%;background:var(--c)}
.btn{display:inline-block;background:#2a2418;color:#e9dfc4;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;padding:.15rem .8rem}
.pill{display:inline-block;font-family:"Barlow Condensed",sans-serif;font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;border:1.5px solid currentColor;padding:0 .3rem;margin-right:.3rem;transform:rotate(-3deg)}
.pill.ok{color:#2f7d3a}.pill.wait{color:#a16207}.pill.mute{color:#6b6350}
.f.off .pill,.f.few .pill{color:#d6cdb8}
.foot{margin:.9rem 0 0;font-size:.85rem;color:#a89f8c}
.foot a{text-decoration:underline}
`
