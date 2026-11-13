// The stylesheets of the pages (RFC 17): hand-written, nothing a 2020 browser lacks (no @layer, no inset, no oklch). One
// palette and two font stacks as variables, so a colour is changed in one place. `PUBLIC_CSS` is what every page gets;
// `ADMIN_CSS` is added on the admin pages and only overrides or adds (dense dark panels, tables and forms instead of paper).

const FONTS = [
  ['Courier Prime', 400, 'courier-prime-400'],
  ['Courier Prime', 700, 'courier-prime-700'],
  ['Barlow Condensed', 600, 'barlow-condensed-600'],
  ['Barlow Condensed', 800, 'barlow-condensed-800'],
] as const
/** The font files the faces load, for the preload links of the shell (a font that is already there at the first layout never moves the text). */
export const FONT_URLS = FONTS.map(([, , file]) => `/fonts/${file}.woff2`)
const FONT_FACES = FONTS.map(([family, weight, file]) =>
  `@font-face{font-family:"${family}";font-weight:${weight};font-display:optional;src:url(/fonts/${file}.woff2) format("woff2")}`).join('')

/** The palette, named by what it is used for rather than by its colour, and the spacing scale (RFC 30: five steps and the height of a card's tab; a gap, a margin or a layout padding is one of them, see docs/UI_DESIGN.md). */
const ROOT = `:root{--ink:#2a2418;--paper:#e9dfc4;--muted:#a89f8c;--good:#4ade80;--dim:#5f5846;--amber:#e9b44c;--night:#14110e;--rule:#8a7f65;--ink2:#4a4334;--bad:#f87171;--warn:#fbbf24;--line:#3a342a;--soft:#d9d0bd;--edge:#6b6455;--mist:#b9b2a0;--deep:#991b1b;--blush:#fca5a5;--desk:#1a1612;--mono:"Courier Prime","Courier New",monospace;--cond:"Barlow Condensed",sans-serif;--space-1:.25rem;--space-2:.5rem;--space-3:.8rem;--space-4:1.2rem;--space-5:2rem;--tab:.7rem;--gutter:1rem}
`

const BASE = `
*{box-sizing:border-box}
html{scrollbar-gutter:stable}
body{margin:0;background:var(--desk) repeating-linear-gradient(90deg,rgba(0,0,0,.12) 0 2px,transparent 2px 7px);color:#e8eaed;font:17px/1.35 "Barlow Condensed","Arial Narrow",sans-serif;font-weight:600}
a{color:inherit;text-decoration:none}
.w{max-width:56rem;margin:0 auto;padding:var(--gutter)}
header.top{border-bottom:2px solid #2a303a;background:var(--night)}
header.top .w{padding-top:var(--space-2);padding-bottom:var(--space-2)}
header.top a{font-weight:800;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:1.7rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0}
h2{font-size:.85rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin:var(--space-4) 0 var(--space-2)}
.crumbs{font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:var(--space-1)}
.crumbs a{text-decoration:underline}
.sections{display:flex;flex-wrap:wrap;gap:var(--space-2);margin:var(--space-1) 0 var(--space-3)}
.sections a,.sections span[aria-current]{border:1px solid var(--edge);padding:.2rem .7rem;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase;color:var(--soft)}
.sections a:hover{border-color:var(--paper);color:#fff}
.sections a.manage{margin-left:auto;border-style:dashed}
.sections a[aria-current]:hover{color:var(--ink)}
.sections a[aria-current],.sections span[aria-current]{background:var(--paper);color:var(--ink);border-color:var(--paper)}
.muted{color:var(--muted)}
.f .muted{color:var(--dim)}
.f.few .muted,.f.off .muted{color:var(--muted)}
.bar{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin:var(--space-3) 0 var(--space-1);font-size:.9rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mist)}
.bar b,.bar strong{color:#fff}.bar .sp{flex:1}
.bar a{border:1px solid var(--rule);padding:.05rem .6rem;color:var(--paper)}.bar a.on{background:var(--paper);color:var(--ink)}
form.find{margin:var(--space-2) 0 0;display:flex;gap:var(--space-2)}
input[type=search]{background:var(--night);color:#fff;border:1px solid var(--rule);padding:.3rem .6rem;font:inherit;font-weight:600}
button{background:var(--paper);color:var(--ink);border:0;padding:.35rem .9rem;font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.g,.pair,.nums{display:grid;gap:var(--space-4) var(--space-3);padding-top:calc(var(--tab) + var(--space-2))}
.g{grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))}
.f,.pn{display:block;position:relative;min-width:0;border-radius:0 .3rem .3rem .3rem;box-shadow:0 3px 0 rgba(0,0,0,.35)}
.f:before,.pn:before{content:"";position:absolute;top:calc(-1 * var(--tab));height:var(--tab);background:var(--c);border-radius:.3rem .3rem 0 0}
.f .ft,.pn .ft{font-size:1.1rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;overflow-wrap:anywhere}
/* paper: the public pages */
.f{background:var(--paper);color:var(--ink);padding:var(--space-3);font-family:var(--mono);font-weight:400;--st-ok:#256b30;--st-wait:#8a5206;--st-mute:var(--dim)}
.f:before{left:0;width:42%}
a.f:hover{transform:translateY(-3px)}
.f .ft{display:block;margin:0;border-bottom:2px solid var(--ink);padding-bottom:var(--space-1)}
.f>span{display:block;font-size:.8rem;margin-top:var(--space-1)}
.file,.f>span.file{font-family:var(--mono);font-weight:400;font-size:.78rem;color:var(--dim);overflow-wrap:anywhere;letter-spacing:0;text-transform:none}
.f .num{overflow-wrap:anywhere}
.stamp{display:table;margin:0 0 var(--space-2) auto;border:2px solid var(--c);color:var(--c);color:color-mix(in srgb,var(--c) 55%,#000);border-color:color-mix(in srgb,var(--c) 70%,#000);padding:0 .35rem;font-family:var(--cond);font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em;transform:rotate(-6deg)}
.f.card{transition:transform .1s}
.f.card:hover{transform:translateY(-3px)}
.f.card h2 a:after{content:"";position:absolute;top:0;left:0;right:0;bottom:0}
.f.card a.pill{position:relative;z-index:1}
.f.card:focus-within{outline:2px solid var(--amber);outline-offset:2px}
.f .via{color:var(--ink2);font-style:italic}
.f.few,.f.off{background:#2a2620;color:var(--muted);box-shadow:none}
.f.few{border:1px dashed #7a7058}.f.few:before,.f.off:before{background:var(--ink2)}.f.few .ft,.f.off .ft{border-color:#5a523f}
.f.few .stamp{border-color:var(--muted);color:#d6cdb8;background:var(--desk)}
.f.big .stamp.off{border-color:#b91c1c;color:#b91c1c;background:none;transform:rotate(-10deg)}
.f.few .need{color:var(--amber);font-weight:700}
.f.off .ft{text-decoration:line-through}
.f.off .stamp{border-color:#ef4444;color:var(--bad);background:var(--desk);transform:rotate(-10deg)}
.f.big{margin-top:var(--space-4);padding:var(--space-4);box-shadow:0 4px 0 rgba(0,0,0,.4)}
.f.big:before{width:30%}
.f.big h1{font-family:var(--mono);font-weight:700;font-size:1.7rem;letter-spacing:.05em;border-bottom:2px solid var(--ink);padding-bottom:var(--space-1);margin:0}
.f.big h2{font-family:var(--mono);color:var(--ink)}
.f.big .stamp{font-size:.95rem}
.f.big .desc{font-size:1rem;margin:0;white-space:pre-line;overflow-wrap:anywhere}
.f.big .none{color:var(--dim);font-size:1rem}
.f.big .note{border:1px dashed var(--dim);padding:var(--space-1) var(--space-2);margin:var(--space-3) 0 0;font-size:.9rem}
.f.big .note.need{border-color:#a16207;color:#7c4a03;font-weight:700}
.f.big .note.dead{border-color:#b91c1c;color:var(--deep);font-weight:700}
.ledger{display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:.1rem 1.5rem;margin:0}
.ledger div{display:flex;justify-content:space-between;gap:var(--space-2);border-bottom:1px dotted var(--rule);padding:.2rem 0;font-size:.95rem}
.ledger dt{color:var(--ink2)}.ledger dd{margin:0;font-weight:700;text-align:right}
table.set{width:100%;border-collapse:collapse;font-size:.92rem}
table.set th{font-family:var(--cond);font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);text-align:left;padding:.2rem .4rem .2rem 0}
table.set td{border-top:1px dotted var(--rule);padding:.22rem .4rem .22rem 0;vertical-align:top;overflow-wrap:anywhere}
table.set td.v{font-weight:700}table.set td.d{color:var(--dim)}
`

const EXTRA = `
/* small helpers: a tab colour for a card, and the margins the pages repeat, one per step of the scale (the margins win over the card rules): mtN is the space above, mbN below, mlN to the left, spN the space above with the other margins 0 */
.c-gray{--c:#9ca3af}.c-red{--c:#dc2626}.c-green{--c:#22c55e}.c-violet{--c:#a78bfa}.c-mint{--c:#34d399}.c-blue{--c:#2563eb}.c-edge{--c:var(--edge)}
.mt1{margin-top:var(--space-1)!important}.mt2{margin-top:var(--space-2)!important}.mt3{margin-top:var(--space-3)!important}.mt4{margin-top:var(--space-4)!important}
.sp1{margin:var(--space-1) 0 0!important}.sp2{margin:var(--space-2) 0 0!important}.sp3{margin:var(--space-3) 0 0!important}
.m0{margin:0!important}.ml2{margin-left:var(--space-2)!important}.mb2{margin:0 0 var(--space-2)!important}
/* a column of cards: the room above for the first card's tab, and one gap between the cards (the voice page, a server's role groups) */
.stack{display:flex;flex-direction:column;gap:var(--space-4);padding-top:calc(var(--tab) + var(--space-2))}
.ul{text-decoration:underline}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}
.acct{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase}
.acct form{margin:0}
.acct a{text-decoration:underline}
.mark{border:1px solid var(--edge);padding:0 .4rem;font-size:.78rem;color:var(--paper)}
.acct .mark.adm{border-color:#dc2626;color:var(--bad)}
.lnkbtn{background:none;border:0;padding:0;color:var(--amber);font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-decoration:underline;cursor:pointer}
.nums{grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr))}
.f .num{font-size:1.5rem;font-weight:700;line-height:1;border:0;padding:0;margin:0;letter-spacing:0;text-transform:none}
.f .cap{font-family:var(--cond);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);margin-top:var(--space-1)}
.win{display:grid;grid-template-columns:7rem 1fr 3rem;gap:var(--space-2);align-items:center;padding:.12rem 0;font-size:.85rem}
.win s{display:block;height:.55rem;background:#b8aa85;text-decoration:none}
.win s i{display:block;height:100%;background:var(--c)}
.win em{font-style:normal;text-align:right;font-weight:700}
.win span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pair{grid-template-columns:repeat(auto-fit,minmax(17rem,1fr))}
table.log{width:100%;border-collapse:collapse;font-size:.88rem}
table.log th{font-family:var(--cond);font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink2);text-align:left;padding:.15rem .5rem .25rem 0}
table.log td{border-top:1px dotted var(--rule);padding:.28rem .5rem .28rem 0;white-space:nowrap}
table.log td.r,table.log th.r{text-align:right}
table.log a{text-decoration:underline}
.res,.tape,.pill{font-style:normal}
.res{display:inline-block;border:1.5px solid var(--c);padding:0 .3rem;font-family:var(--cond);font-weight:800;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--c);color:color-mix(in srgb,var(--c) 55%,#000);border-color:color-mix(in srgb,var(--c) 70%,#000)}
.tape{display:inline-block;background:var(--ink);color:var(--paper);font-family:var(--cond);font-weight:800;font-size:.78rem;letter-spacing:.1em;padding:0 .45rem;text-transform:uppercase}
.tape.off{background:none;color:var(--dim);border:1px dashed var(--dim)}
.dim{color:var(--dim)}
.dots{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-3);font-size:.88rem}
.dots i{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--c);margin-right:var(--space-1)}
.split{display:flex;height:.5rem;margin:var(--space-1) 0 var(--space-1);background:#b8aa85}
.split i{display:block;height:100%;background:var(--c)}
.btn{display:inline-block;background:var(--ink);color:var(--paper);font-family:var(--cond);font-weight:800;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;padding:.15rem .8rem}
.pill{display:inline-block;font-family:var(--cond);font-size:.8rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;border:1.5px solid currentColor;padding:0 .3rem;margin-right:var(--space-1);transform:rotate(-3deg)}
.pill.ok{color:var(--st-ok,var(--good))}.pill.wait{color:var(--st-wait,var(--warn))}.pill.mute{color:var(--st-mute,var(--muted))}
.f.off .pill,.f.few .pill{color:#d6cdb8}
.good{color:#256b30;font-weight:700}.bad{color:var(--deep);font-weight:700}
.scrollx{overflow-x:auto}
[hidden]{display:none!important}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.f strong{font-weight:700}
main>p.file,main>.foot.dark,.replay .main .foot.dark,main>form>p .dim{color:var(--muted)}
.g.wide{grid-template-columns:repeat(auto-fill,minmax(min(100%,36rem),1fr))}
h2+.f,h2+.plans,h2+p+.f{margin-top:var(--space-4)}
.f .sections{margin:var(--space-2) 0 0}
.f .sections a,.f .sections span[aria-current]{color:var(--ink);border-color:var(--dim)}
.filt{display:grid;grid-template-columns:4.6rem 1fr;gap:var(--space-3);align-items:baseline;margin:var(--space-3) 0 0;font-size:.85rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
.f .ft+.filt{margin-top:var(--space-3)}.filt+.filt{margin-top:var(--space-2)}.filt+p,.filt+div{margin-top:var(--space-3)}
.filt .chips{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.filt a{border:1px solid var(--dim);padding:.12rem .65rem;color:var(--ink);line-height:1.35;white-space:nowrap}
.filt a:hover{border-color:var(--ink)}.filt a.on{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:800}
.filt .n{margin-left:var(--space-1);opacity:.6;font-weight:400}.filt a.on .n{opacity:.75}
@media (max-width:30rem){.filt{grid-template-columns:1fr;gap:var(--space-1)}}
.f .bar{color:var(--ink2)}
.f .bar a{color:var(--ink);border-color:var(--dim)}
.f .bar a.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.f .sections a:hover{color:var(--ink);border-color:var(--ink)}
.f .sections a[aria-current],.f .sections a[aria-current]:hover,.f .sections span[aria-current]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.replay{display:grid;grid-template-columns:minmax(0,1fr) 17rem;gap:var(--space-4)}
@media (max-width:760px){.replay{grid-template-columns:minmax(0,1fr)}}
.replay .main{min-width:0}
.replay.theater{position:fixed;inset:0;z-index:50;overflow:auto;background:var(--desk);padding:var(--space-3) var(--space-4);align-content:start}
.replay.theater .view canvas{height:calc(100vh - 11rem);min-height:18rem}
html.theater{overflow:hidden}
.replay aside{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
.scrub{position:relative;margin-top:var(--space-2)}
.scrub input{width:100%;margin:0}
.ticks{position:absolute;left:0;right:0;top:0;height:1.2rem;pointer-events:none}
.tick{position:absolute;top:0;bottom:0;width:2px;background:#dc2626;pointer-events:none}
.tick-revive{background:#34d399}.tick-role{background:#a78bfa}
.time{font-family:var(--mono);font-weight:400;min-width:13ch}
/* room kept for what the script fills in, so that the panels below do not move when the track arrives (measured at 1100 and 390 px: the time text was 10 px wider before the round starts, "-0:05 / 4:55"; the players list grew from 0 to 224 px; the selected player's line from 0 to 46; the map note from 0 to 18 or 37; the level row left with 33 or 77 px) */
.replay [data-players]{min-height:min(14rem,calc(var(--n,0) * 1.73rem))}
.replay [data-deaths]{min-height:min(14rem,calc(var(--n,0) * 3.4rem))}
.replay [data-player-events]{height:7rem}
.replay [data-selected-role]{min-height:2.7em}
.replay [data-background]{min-height:1.35em}
@media (max-width:30rem){.replay [data-background]{min-height:2.7em}}
.replay .gone{visibility:hidden}
.tog.play{min-width:4.5rem}
.list{max-height:14rem;overflow-y:auto;margin:var(--space-1) 0 0;padding:0;list-style:none}
.lnk{background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline;letter-spacing:0;text-transform:none}
.prow{display:flex;align-items:center;gap:var(--space-2);width:100%;background:none;border:0;padding:.15rem .3rem;margin:0;color:inherit;font:inherit;text-align:left;cursor:pointer;letter-spacing:0;text-transform:none}
.prow.sel{background:var(--ink);color:var(--paper)}
.prow.sel .prole{color:var(--soft)}
.prow.dead{opacity:.5;text-decoration:line-through}
.pdot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;flex:none}
.pname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prole{margin-left:auto;font-size:.8rem;color:var(--dim)}
.warn{margin:var(--space-1) 0 0;font-size:.85rem;color:var(--amber)}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}
.actions form{margin:0}
.view{position:relative;margin-top:var(--space-2)}
.view canvas{display:block;width:100%;height:min(60vh,28rem);background:var(--night);touch-action:none}
.view [data-status]{position:absolute;left:0;right:0;top:0;bottom:0;margin:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 var(--space-3);pointer-events:none;color:var(--muted)}
.view [data-status][hidden]{display:none}
.view.nogl{background:var(--night)}
.view.nogl [data-status]{position:static;display:block;padding:var(--space-4);text-align:left;overflow-wrap:anywhere;color:var(--soft)}
.tools{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4);align-items:center;margin:var(--space-2) 0}
.tools .cap{display:inline-block;margin:0 var(--space-2) 0 0;font-family:var(--cond);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.tools label{display:inline-flex;align-items:center;gap:var(--space-2);color:var(--soft)}
.tools .cap{color:var(--muted)}
.tools input[type=checkbox]{accent-color:var(--paper)}
.f .tools label,.f .tools .cap{color:var(--ink2)}
.f .tools input[type=checkbox]{accent-color:var(--ink)}
/* pressed on paper: the second pixel of the frame is an inset shadow, so border and padding stay the base .tog's whatever overrides its padding (.vc .tog) */
.f .tog[aria-pressed=true]{background:#fff8e6;color:var(--ink);border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.tog{background:var(--line);border:1px solid var(--rule);color:var(--soft);padding:.05rem .7rem;margin-right:var(--space-1);font-family:var(--cond);font-weight:800;font-size:.9rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.tog[aria-pressed=true]{background:var(--paper);color:var(--ink);border-color:var(--paper)}
.vc{display:flex;flex-direction:column;gap:var(--space-3)}
.vc p{margin:0}
.vc .row{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-3);align-items:center}
.vc .cap{margin:0 0 var(--space-1)}
.vc .tog{margin-right:0;padding:.3rem .9rem;font-size:1rem}
.vc .jn{min-width:9.5rem}
.vc [data-status]{flex:1 1 11rem;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc [data-count]{display:inline-block;min-width:2ch}
.vc [data-who]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc input[type=range]{width:11rem;accent-color:var(--ink);margin:0}
.vc input[type=text]{width:3rem;text-align:center}
.vc .person{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-3);align-items:center;padding:var(--space-1) 0;border-top:1px solid var(--dim)}
.vc .pname{flex:0 0 11rem;min-width:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc .pct{min-width:3rem;text-align:right}
.lvl{position:relative;width:18rem;max-width:100%;height:1rem;border:1px solid var(--dim);background:linear-gradient(to right,#fff8e6 0,#fff8e6 43.75%,#d9ecd3 43.75%,#d9ecd3 85%,#f2cfc9 85%,#f2cfc9 100%)}
.lvl i{position:absolute;left:0;top:25%;height:50%;width:0;background:var(--ink2)}
.lvl i.open{background:#256b30}
.lvl b{position:absolute;top:-.25rem;bottom:-.25rem;width:2px;margin-left:-1px;background:#991b1b}
.lvl b.c{background:none;width:0;border-left:2px dashed #991b1b}
.vc .ft{margin-bottom:0}
.vc .note{min-height:1.4em}
.vc .lvl-read{display:flex;gap:var(--space-3);align-items:flex-start;min-height:1.6em}
/* The two status lines under the buttons always hold a text, and are as tall as the fullest one (lines of 1.35em: the longest note, the
   measurement result, wraps to 2 lines from 730 px up, 3 from 505, 4 from 410, 5 from 360 and 6 below, measured in Chromium from 320 to 1100). */
.vc .mnote,.vc .cnote{min-height:2.7em}
@media (max-width:729px){.vc .mnote,.vc .cnote{min-height:4.05em}}
@media (max-width:504px){.vc .mnote,.vc .cnote{min-height:5.4em}}
@media (max-width:409px){.vc .mnote,.vc .cnote{min-height:6.75em}}
@media (max-width:359px){.vc .mnote,.vc .cnote{min-height:8.1em}}
.vc .checks{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-3);align-items:center}
.vc .check{display:inline-flex;align-items:center;gap:var(--space-1);cursor:pointer}
.vc .check input{margin:0}
.vc .check:has(input:disabled){opacity:.55;cursor:default}
.vc .db{min-width:6.5rem}
.vc .talk{min-width:5rem}
.vc .lvl-legend{font-size:.85rem}
.vc summary{cursor:pointer;font-weight:700}
.vc .vform{display:flex;flex-direction:column;gap:var(--space-1)}
.vc input.code{width:9rem;text-align:left;text-transform:uppercase;letter-spacing:.12em;font-size:1.1rem}
.vc .vmsg{min-height:1.4em;color:var(--deep);font-weight:700}
@media (max-width:780px){.vc .vmsg{min-height:2.8em}}
@media (max-width:440px){.vc .vmsg{min-height:4.2em}}
.vc .lnkbtn,.vc p a{color:var(--ink)}
.vc p a{text-decoration:underline}
.scale{height:.6rem;margin:var(--space-2) 0 var(--space-1)}
.ends{display:flex;justify-content:space-between;font-size:.8rem}
.sw{display:inline-block;position:relative;width:1rem;height:1rem;vertical-align:-.2rem;margin-right:var(--space-2)}
.sw .wd{position:absolute;left:2px;top:2px;width:4px;height:4px;background:#fff}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:var(--space-3);margin-top:var(--space-4)}
.plans figure{margin:0}
.plans img{display:block;width:100%;max-height:60vh;object-fit:contain;background:var(--night)}
.plans figcaption{font-size:.85rem;color:var(--muted);margin-top:var(--space-1)}
code{font-family:var(--mono)}
.foot{margin:var(--space-3) 0 0;font-size:.85rem;color:var(--muted)}
.foot.dark{color:var(--dim)}
form.inline{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-3);align-items:flex-end;margin-top:var(--space-3)}
label{font-family:var(--cond);font-size:.8rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
label input{display:block;margin-top:var(--space-1);font-family:var(--mono);font-weight:400;letter-spacing:0;text-transform:none}
.f input:not([type]),.f input[type=text],.f input[inputmode]{background:#fff8e6;border:1px solid var(--dim);color:var(--ink);padding:.25rem .5rem;font-size:.9rem;width:11rem}
.f input::placeholder{color:var(--dim);opacity:1}
input[type=search]::placeholder{color:var(--muted);opacity:1}
input[type=checkbox]{accent-color:var(--ink)}
button.btn{border:0;cursor:pointer}
.btn.danger{background:var(--deep);color:#fee2e2}
main>form>p>.btn.danger{border:1px solid var(--bad)}
.foot a{text-decoration:underline}
`

export const PUBLIC_CSS = FONT_FACES + ROOT + BASE + EXTRA

export const ADMIN_CSS = `
[x-cloak]{display:none!important}
.w.wide{max-width:78rem}
.contents{display:contents}
.sro{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0}
/* dark: the admin pages */
.pn{background:#221e18;color:#e8eaed;border:1px solid var(--line);padding:var(--space-3) var(--space-4);margin-top:var(--space-4)}
.pn:before{left:-1px;width:34%;background:var(--c,var(--amber))}
a.pn:hover{border-color:var(--amber)}
.pn .ft{margin:0 0 var(--space-2);font-family:var(--mono)}
.pn h1{font-family:var(--mono);font-size:1.5rem;margin:0 0 var(--space-2)}
.pn h3{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:var(--space-4) 0 var(--space-2)}
.pn p{margin:var(--space-1) 0}
.cv,.pn code,.code{font-family:var(--mono);font-weight:400}
.cv{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}
.hint{display:block;font-size:.85rem;color:var(--mist);margin-top:0}
.pn .go{color:var(--amber);font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.tiles>.pn{margin-top:0}
.toolbar label input{margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:var(--space-4) var(--space-3);padding-top:calc(var(--tab) + var(--space-2))}
.tile{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);margin-top:0}
.tile.off{background:#1c1914;color:var(--mist)}
.tile .go{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--amber);white-space:nowrap}
.tile .val{display:block;min-height:1.35em;font-family:var(--mono);font-weight:400;font-size:.85rem;color:#93c5fd}
/* the big parts of an admin page: the group sections of a server's roles */
.parts{display:flex;flex-direction:column;gap:var(--space-5)}
.team{display:inline-block;font-size:1.3rem;letter-spacing:.1em;margin:0 0 var(--space-1);padding:.05rem .7rem;border:1px solid;background:var(--night)}
.status{display:inline-flex;align-items:center;gap:var(--space-2);padding:.3rem .8rem;border:1px solid var(--edge);font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:.9rem}
.status i{width:.7rem;height:.7rem;border-radius:50%;background:var(--edge)}
.status.on{border-color:var(--good);color:var(--good)}.status.on i{background:var(--good)}
.status.wait{color:var(--warn)}.status.wait i{background:var(--warn)}
.status small{display:block;font-size:.8rem;font-weight:600;color:var(--mist);letter-spacing:.03em;text-transform:none}
.head{display:flex;flex-wrap:wrap;gap:var(--space-3);justify-content:space-between;align-items:flex-start}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3) var(--space-4);padding:var(--space-3) var(--space-3);background:#221e18;border:1px solid var(--line)}
.toolbar label{display:inline-flex;align-items:center;gap:var(--space-2);color:var(--soft)}
.toolbar .count{margin-left:auto;font-family:var(--mono);font-weight:400;font-size:.85rem;color:var(--muted)}
select,input[type=number],input[type=text].dk,.dk{background:var(--night);color:#f1ece0;border:1px solid var(--rule);padding:.3rem .6rem;font:inherit;font-weight:600}
input[type=number],input[type=text].dk{font-family:var(--mono);font-weight:400;width:100%}
.fld input:invalid{border-color:var(--bad);background:#2a1414}
.fld input[type=text],.fld input[type=number]{width:100%}
.toolbar input[type=search]{flex:1;min-width:10rem}
input.switch{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:2.7rem;height:1.45rem;margin:0;border-radius:1rem;background:var(--ink2);border:1px solid var(--rule);cursor:pointer}
input.switch:before{content:"";position:absolute;left:.15rem;top:.12rem;width:1rem;height:1rem;border-radius:50%;background:var(--paper);transition:left .15s}
input.switch:checked{background:#256b30;border-color:var(--good)}
input.switch:checked:before{left:1.35rem}
.ab{display:inline-block;background:var(--line);color:var(--paper);border:1px solid var(--rule);padding:.2rem .85rem;font-family:var(--cond);font-weight:800;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
a.ab:hover,button.ab:hover{border-color:var(--amber);color:#fff}
.ab.main{background:var(--paper);color:var(--ink);border-color:var(--paper)}
.ab.go{background:none;color:var(--good);border-color:var(--good)}
.ab.danger{background:none;color:var(--blush);border-color:var(--bad)}
table.data{width:100%;border-collapse:collapse}
table.data th{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:left;padding:var(--space-1) var(--space-3) var(--space-2);border-bottom:1px solid var(--edge)}
table.data td{padding:var(--space-3);border-top:1px solid var(--line);vertical-align:middle}
table.data tbody tr:hover{background:#2a251e}
table.data td.r,table.data th.r{text-align:right;white-space:nowrap}
table.data{min-width:40rem}
table.data .cv{font-size:.8rem;overflow-wrap:normal;white-space:nowrap}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--edge);margin-right:var(--space-2)}
.dot.on{background:var(--good)}.dot.wait{background:var(--warn)}
.ok-t{color:var(--good)}.wait-t{color:var(--warn)}
.call{border:1px solid;border-left-width:5px;padding:var(--space-3);background:#1c1914;margin-top:var(--space-3)}
.call.ok{border-color:var(--good)}.call.wait{border-color:var(--warn)}.call.bad{border-color:var(--bad)}
.call h3{margin:0 0 var(--space-1);color:inherit;font-size:1rem}
.call.ok h3{color:var(--good)}.call.wait h3{color:var(--warn)}.call.bad h3{color:var(--blush)}
.copy{display:flex;gap:var(--space-3);align-items:stretch;margin-top:var(--space-2)}
.copy .ab{min-width:4.6rem;text-align:center}
.copy .code{flex:1;background:var(--night);border:1px solid var(--line);padding:var(--space-2) var(--space-3);word-break:break-all;user-select:all;font-size:.9rem}
details{margin-top:var(--space-3);color:var(--mist)}
summary{cursor:pointer;color:var(--soft)}
form.add{display:flex;flex-wrap:wrap;gap:var(--space-3);margin-top:var(--space-2)}
form.add input{flex:1;min-width:14rem}
.cfg{display:flex;flex-direction:column;gap:var(--space-4)}
.cfg form{display:flex;flex-direction:column;gap:var(--space-3);margin-top:var(--space-3)}
.jump{position:sticky;top:0;z-index:20;display:flex;gap:var(--space-4);align-items:baseline;overflow-x:auto;white-space:nowrap;background:#221e18;border-bottom:1px solid var(--edge);padding:0 var(--space-1);margin-top:var(--space-3)}
.jump .lead{font-size:.8rem;opacity:.75}
.jump a{font-weight:600;font-size:.9rem;text-decoration:none;color:var(--paper);opacity:.75;padding:.55rem .15rem;border-bottom:3px solid transparent}
.jump a[aria-current=true]{opacity:1;border-bottom-color:var(--bad)}
.jump a span{font-weight:400}
.jump .dot{color:var(--bad)}
.cfg [data-group]{scroll-margin-top:3.4rem}
.cfg{padding-bottom:6.5rem}
.fh{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-1) var(--space-3)}
.fh .fl{flex:1 1 auto;min-width:0}
.fx{flex:none;display:flex;align-items:center;gap:var(--space-2);min-height:1.9rem;white-space:nowrap}
.fx .src{margin-left:0}
@media (max-width:30rem){.fh{flex-direction:column}.fx{flex-wrap:wrap;white-space:normal}}
.cfg .sub{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.75;margin:var(--space-3) 0 0}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
.fld{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);background:#1c1914;border:1px solid var(--line)}
.fld:hover{border-color:var(--edge)}
.fld.row{flex-direction:row;align-items:center;justify-content:space-between;gap:var(--space-3)}
.fld label.fl{font-size:1rem;letter-spacing:.02em;text-transform:none;color:#f1ece0;font-weight:700;cursor:pointer;display:block}
.fld input[type=range]{width:100%;accent-color:var(--amber)}
.fld .val{font-family:var(--mono);font-weight:400;color:var(--blush)}
.src{margin-left:var(--space-2);font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.src.live{color:var(--good)}.src.default{color:var(--muted)}.src.missing{color:var(--bad)}
.fld.info{color:#93c5fd;border-color:#1e3a5f;background:#14202e;font-style:italic}
.fld.hintbox{color:var(--warn);border-color:#6b4a06;background:#2a2008}
.fld.bad{color:var(--blush);border-color:#7f1d1d}
.toast{position:fixed;bottom:6.2rem;left:50%;transform:translateX(-50%);z-index:101;width:min(40rem,calc(100% - 2rem));margin:0;padding:var(--space-2) var(--space-3);background:var(--night);border:2px solid;font-weight:700}
.toast.ok{border-color:var(--good);color:var(--good)}.toast.bad{border-color:var(--bad);color:var(--blush)}
.savebar{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);z-index:100;width:min(40rem,calc(100% - 2rem));display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);background:var(--deep);color:#fff;border:2px solid var(--bad);border-radius:.4rem;box-shadow:0 8px 24px rgba(0,0,0,.6)}
.savebar strong{display:block;font-size:1.1rem;letter-spacing:.04em}
.savebar span.sub{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:#fecaca}
.savebar .ab{background:none;color:#fff;border-color:#fecaca}
.savebar .ab.main{background:#fff;color:var(--deep);border-color:#fff}
.lay{display:grid;grid-template-columns:15.5rem minmax(0,1fr);gap:var(--space-4);align-items:start}
.side{position:sticky;top:1rem;background:#221e18;border:1px solid var(--line);display:flex;flex-direction:column;max-height:calc(100vh - 2rem)}
.side .find{padding:var(--space-3);border-bottom:1px solid var(--line)}
.side .find input{width:100%;background:var(--night);color:#f1ece0;border:1px solid var(--rule);padding:.3rem .6rem;font:inherit;font-weight:600}
.side .rbody{display:flex;flex-direction:column;min-height:0;flex:1}
.side .rbar{display:none;justify-content:space-between;padding:var(--space-2) var(--space-3);cursor:pointer;color:var(--soft);font-weight:800;letter-spacing:.1em;text-transform:uppercase}
#role-list{overflow-y:auto;padding:var(--space-2);flex:1}
.ritem{display:flex;justify-content:space-between;gap:var(--space-2);padding:.35rem .6rem;color:#e8eaed;border-left:3px solid transparent}
.ritem:hover{background:#2a251e;border-left-color:var(--amber)}
.ritem.off{color:var(--muted);font-style:italic}
.ritem span+span{color:var(--muted)}
#roles-toggle:focus-visible+.rbar{outline:2px solid var(--amber)}
@media (max-width:760px){
.lay{grid-template-columns:minmax(0,1fr)}
.side{position:static;max-height:none}
.side .rbar{display:flex}
.side .rbody{display:none;max-height:60vh}
#roles-toggle:checked~.rbody{display:flex}
.tile .go{display:none}
}
`
