// What the admin pages add to the case-file stylesheet (RFC 17, stage 2): the same shell, fonts and
// colours as the public pages, but dense dark panels, tables and forms instead of paper, for long
// sessions. Hand-written like the rest (no `@layer`, no `inset`, nothing a 2020 browser lacks).
export const ADMIN_CSS = `
[x-cloak]{display:none!important}
.w.wide{max-width:78rem}
.contents{display:contents}
.sro{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0}
.pn{display:block;position:relative;background:#221e18;color:#e8eaed;border:1px solid #3a342a;padding:.9rem 1.1rem 1rem;border-radius:0 .3rem .3rem .3rem;box-shadow:0 3px 0 rgba(0,0,0,.35);min-width:0;margin-top:1rem}
.pn:before{content:"";position:absolute;left:-1px;top:-.7rem;width:34%;height:.7rem;background:var(--c,#e9b44c);border-radius:.3rem .3rem 0 0}
a.pn:hover{border-color:#e9b44c}
.pn .ft{margin:0 0 .5rem;font-family:"Courier Prime","Courier New",monospace;font-size:1.1rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;overflow-wrap:anywhere}
.pn h1{font-family:"Courier Prime","Courier New",monospace;font-size:1.5rem;margin:0 0 .5rem}
.pn h3{font-size:.85rem;letter-spacing:.14em;text-transform:uppercase;color:#a89f8c;margin:1.2rem 0 .5rem}
.pn p{margin:.3rem 0}
.cv,.pn code,.code{font-family:"Courier Prime","Courier New",monospace;font-weight:400}
.cv{font-size:.8rem;color:#a89f8c;overflow-wrap:anywhere}
.hint{display:block;font-size:.85rem;color:#b9b2a0;margin-top:.1rem}
.pn .pill.ok{color:#4ade80}.pn .pill.mute{color:#a89f8c}.pn .pill.wait{color:#fbbf24}
.pn .go{color:#e9b44c;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.tiles>.pn{margin-top:0}
.toolbar label input{margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:1.5rem 1rem;padding-top:.7rem}
.tile{display:flex;justify-content:space-between;align-items:center;gap:.8rem;margin-top:0}
.tile.off{background:#1c1914;color:#b9b2a0}
.tile .go{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:#e9b44c;white-space:nowrap}
.tile .val{display:block;font-family:"Courier Prime","Courier New",monospace;font-weight:400;font-size:.85rem;color:#93c5fd}
.stack{display:flex;flex-direction:column;gap:2rem}
.team{display:inline-block;font-size:1.3rem;letter-spacing:.1em;margin:0 0 .2rem;padding:.05rem .7rem;border:1px solid;background:#14110e}
.status{display:inline-flex;align-items:center;gap:.5rem;padding:.3rem .8rem;border:1px solid #6b6455;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:.9rem}
.status i{width:.7rem;height:.7rem;border-radius:50%;background:#6b6455}
.status.on{border-color:#4ade80;color:#4ade80}.status.on i{background:#4ade80}
.status.wait{color:#fbbf24}.status.wait i{background:#fbbf24}
.status small{display:block;font-size:.8rem;font-weight:600;color:#b9b2a0;letter-spacing:.03em;text-transform:none}
.head{display:flex;flex-wrap:wrap;gap:1rem;justify-content:space-between;align-items:flex-start}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.7rem 1.4rem;padding:.7rem 1rem;background:#221e18;border:1px solid #3a342a}
.toolbar label{display:inline-flex;align-items:center;gap:.5rem;color:#d9d0bd}
.toolbar .count{margin-left:auto;font-family:"Courier Prime","Courier New",monospace;font-weight:400;font-size:.85rem;color:#a89f8c}
select,input[type=number],input[type=text].dk,.dk{background:#14110e;color:#f1ece0;border:1px solid #8a7f65;padding:.3rem .6rem;font:inherit;font-weight:600}
input[type=number],input[type=text].dk{font-family:"Courier Prime","Courier New",monospace;font-weight:400;width:100%}
.fld input:invalid{border-color:#f87171;background:#2a1414}
.fld input[type=text],.fld input[type=number]{width:100%}
.toolbar input[type=search]{flex:1;min-width:10rem}
input.switch{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:2.7rem;height:1.45rem;margin:0;border-radius:1rem;background:#4a4334;border:1px solid #8a7f65;cursor:pointer}
input.switch:before{content:"";position:absolute;left:.15rem;top:.12rem;width:1rem;height:1rem;border-radius:50%;background:#e9dfc4;transition:left .15s}
input.switch:checked{background:#256b30;border-color:#4ade80}
input.switch:checked:before{left:1.35rem}
.ab{display:inline-block;background:#3a342a;color:#e9dfc4;border:1px solid #8a7f65;padding:.2rem .85rem;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
a.ab:hover,button.ab:hover{border-color:#e9b44c;color:#fff}
.ab.main{background:#e9dfc4;color:#2a2418;border-color:#e9dfc4}
.ab.go{background:none;color:#4ade80;border-color:#4ade80}
.ab.danger{background:none;color:#fca5a5;border-color:#f87171}
table.data{width:100%;border-collapse:collapse}
table.data th{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:#a89f8c;text-align:left;padding:.3rem .8rem .5rem;border-bottom:1px solid #6b6455}
table.data td{padding:.7rem .8rem;border-top:1px solid #3a342a;vertical-align:middle}
table.data tbody tr:hover{background:#2a251e}
table.data td.r,table.data th.r{text-align:right;white-space:nowrap}
table.data{min-width:40rem}
table.data .cv{font-size:.8rem;overflow-wrap:normal;white-space:nowrap}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:#6b6455;margin-right:.5rem}
.dot.on{background:#4ade80}.dot.wait{background:#fbbf24}
.ok-t{color:#4ade80}.bad-t{color:#f87171}.wait-t{color:#fbbf24}
.call{border:1px solid;border-left-width:5px;padding:.8rem 1rem;background:#1c1914;margin-top:1rem}
.call.ok{border-color:#4ade80}.call.wait{border-color:#fbbf24}.call.bad{border-color:#f87171}
.call h3{margin:0 0 .3rem;color:inherit;font-size:1rem}
.call.ok h3{color:#4ade80}.call.wait h3{color:#fbbf24}.call.bad h3{color:#fca5a5}
.copy{display:flex;gap:.7rem;align-items:stretch;margin-top:.6rem}
.copy .code{flex:1;background:#14110e;border:1px solid #3a342a;padding:.6rem .8rem;word-break:break-all;user-select:all;font-size:.9rem}
details{margin-top:.8rem;color:#b9b2a0}
summary{cursor:pointer;color:#d9d0bd}
form.add{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:.5rem}
form.add input{flex:1;min-width:14rem}
.cfg{display:flex;flex-direction:column;gap:1.4rem}
.cfg form{display:flex;flex-direction:column;gap:.7rem;margin-top:.8rem}
.fld{display:flex;flex-direction:column;gap:.4rem;padding:.7rem .9rem;background:#1c1914;border:1px solid #3a342a}
.fld:hover{border-color:#6b6455}
.fld.row{flex-direction:row;align-items:center;justify-content:space-between;gap:1rem}
.fld label.fl{font-size:1rem;letter-spacing:.02em;text-transform:none;color:#f1ece0;font-weight:700;cursor:pointer;display:block}
.fld input[type=range]{width:100%;accent-color:#e9b44c}
.fld .val{font-family:"Courier Prime","Courier New",monospace;font-weight:400;color:#fca5a5}
.src{margin-left:.4rem;font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.src.live{color:#4ade80}.src.default{color:#a89f8c}.src.missing{color:#f87171}
.fld.info{color:#93c5fd;border-color:#1e3a5f;background:#14202e;font-style:italic}
.fld.hintbox{color:#fbbf24;border-color:#6b4a06;background:#2a2008}
.fld.bad{color:#fca5a5;border-color:#7f1d1d}
.toast{position:fixed;bottom:6.2rem;left:50%;transform:translateX(-50%);z-index:101;width:min(40rem,calc(100% - 2rem));margin:0;padding:.6rem 1rem;background:#14110e;border:2px solid;font-weight:700}
.toast.ok{border-color:#4ade80;color:#4ade80}.toast.bad{border-color:#f87171;color:#fca5a5}
.savebar{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);z-index:100;width:min(40rem,calc(100% - 2rem));display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;justify-content:space-between;padding:.8rem 1.1rem;background:#991b1b;color:#fff;border:2px solid #f87171;border-radius:.4rem;box-shadow:0 8px 24px rgba(0,0,0,.6)}
.savebar strong{display:block;font-size:1.1rem;letter-spacing:.04em}
.savebar span.sub{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:#fecaca}
.savebar .ab{background:none;color:#fff;border-color:#fecaca}
.savebar .ab.main{background:#fff;color:#991b1b;border-color:#fff}
.lay{display:grid;grid-template-columns:15.5rem minmax(0,1fr);gap:1.5rem;align-items:start}
.side{position:sticky;top:1rem;background:#221e18;border:1px solid #3a342a;display:flex;flex-direction:column;max-height:calc(100vh - 2rem)}
.side .find{padding:.7rem;border-bottom:1px solid #3a342a}
.side .find input{width:100%;background:#14110e;color:#f1ece0;border:1px solid #8a7f65;padding:.3rem .6rem;font:inherit;font-weight:600}
.side .rbody{display:flex;flex-direction:column;min-height:0;flex:1}
.side .rbar{display:none;justify-content:space-between;padding:.6rem .9rem;cursor:pointer;color:#d9d0bd;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
#role-list{overflow-y:auto;padding:.4rem;flex:1}
.ritem{display:flex;justify-content:space-between;gap:.5rem;padding:.35rem .6rem;color:#e8eaed;border-left:3px solid transparent}
.ritem:hover{background:#2a251e;border-left-color:#e9b44c}
.ritem.off{color:#a89f8c;font-style:italic}
.ritem span+span{color:#a89f8c}
#roles-toggle:focus-visible+.rbar{outline:2px solid #e9b44c}
@media (max-width:760px){
.lay{grid-template-columns:minmax(0,1fr)}
.side{position:static;max-height:none}
.side .rbar{display:flex}
.side .rbody{display:none;max-height:60vh}
#roles-toggle:checked~.rbody{display:flex}
.tile .go{display:none}
}
`
