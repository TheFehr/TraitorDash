import { FAVICON } from './Layout'
import type { RoleView, RoleListEntry } from '../services/roleview'

// The public, read-only role pages (RFC 15). One shell for the normal and the embedded layout: no
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

const CSS = FONTS.map(([family, weight, file]) =>
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

const Shell = ({ title, embed, children }: { title: string, embed: boolean, children: any }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="referrer" content="no-referrer" />
      {embed && <meta name="robots" content="noindex" />}
      <title>{title}</title>
      <link rel="icon" href={FAVICON} />
      {/* CSS is a constant of this file, never user text: inserted as is, because escaping would turn its quotes into &quot; */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
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
const qs = (o: { embed?: boolean, players?: number | null, q?: string }) => {
  const parts: string[] = []
  if (o.embed) parts.push('embed=1')
  if (o.players) parts.push(`players=${o.players}`)
  if (o.q) parts.push(`q=${encodeURIComponent(o.q)}`)
  return parts.length ? '?' + parts.join('&') : ''
}

type State = 'ok' | 'few' | 'off'
/** A disabled role stays disabled whatever the count; otherwise a role is put away while the round has fewer players than it needs. */
const stateOf = (r: { enabled: boolean, min: number | null }, players: number | null): State =>
  !r.enabled ? 'off' : players !== null && r.min !== null && r.min > players ? 'few' : 'ok'
const more = (n: number) => `${n} more player${n === 1 ? '' : 's'} needed`
const PICKS = [6, 8, 10, 12]

export const RoleListPage = ({ server, roles, query, embed, admin, players = null }: { server: { id: string, name: string }, roles: RoleListEntry[], query: string, embed: boolean, admin: boolean, players?: number | null }) => {
  const base = `/servers/${server.id}/roles`
  // Roles that can appear first, then the ones put away for lack of players, then the disabled ones; each group keeps its order.
  const rank = { ok: 0, few: 1, off: 2 }
  roles = roles.map((r, i) => ({ r, i, k: rank[stateOf(r, players)] })).sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.r)
  const open = roles.filter(r => stateOf(r, players) === 'ok').length
  return (
    <Shell title={`Roles | ${server.name}`} embed={embed}>
      <div class="crumbs">{embed ? server.name : <><a href={`/servers/${server.id}/stats`}>{server.name}</a> / Roles</>}</div>
      <h1>Role files</h1>
      <form class="find" method="get" action={base}>
        {embed && <input type="hidden" name="embed" value="1" />}
        {players !== null && <input type="hidden" name="players" value={String(players)} />}
        <input type="search" name="q" value={query} placeholder="Search a role" maxlength={64} aria-label="Search a role" />
        <button type="submit">Search</button>
      </form>
      <div class="bar">
        {players !== null
          ? <><span>Round of <b>{players} players</b></span><span>·</span><span><b>{open}</b> can appear</span><span>·</span><span>{roles.length - open} put away</span></>
          : <span>Players in the round</span>}
        <span class="sp"></span>
        {PICKS.map(n => <a class={n === players ? 'on' : ''} href={base + qs({ embed, players: n, q: query })}>{n}</a>)}
        <a class={players === null ? 'on' : ''} href={base + qs({ embed, q: query })}>all</a>
      </div>
      {roles.length === 0 ? <p class="muted">{query ? 'No role matches that search.' : 'This server has not reported any roles yet.'}</p> : (
        <div class="g">
          {roles.map(r => {
            const state = stateOf(r, players)
            return (
              <a class={`f ${state === 'ok' ? '' : state}`} style={`--c:${r.color}`} href={`${base}/${encodeURIComponent(r.name)}${qs({ embed, players })}`}>
                <i class="stamp">{state === 'off' ? 'disabled' : state === 'few' ? `needs ${r.min}+` : r.team || 'no team'}</i>
                <b>{r.name}</b>
                <span>Chance: {r.pct}</span>
                {state === 'few' ? <span class="need">{more(r.min! - players!)}</span> : <span>Needs: {r.min === null ? 'not reported' : `${r.min}+ players`}</span>}
              </a>
            )
          })}
        </div>
      )}
      {admin && !embed && <p class="muted" style="margin-top:1.2rem">You can change role settings from the <a href={`/servers/${server.id}`} style="text-decoration:underline">server's admin page</a>.</p>}
    </Shell>
  )
}

export const RolePage = ({ server, role, embed, admin, players = null }: { server: { id: string, name: string }, role: RoleView, embed: boolean, admin: boolean, players?: number | null }) => {
  const state = stateOf(role, players)
  return (
    <Shell title={`${role.name} | ${server.name}`} embed={embed}>
      <div class="crumbs"><a href={`/servers/${server.id}/roles${qs({ embed, players })}`}>All roles</a> / {role.name}</div>
      <article class="f big" style={`--c:${role.color}`}>
        <i class={`stamp ${state === 'off' ? 'off' : ''}`}>{state === 'off' ? 'disabled' : role.team || 'no team'}</i>
        <h1>{role.name}</h1>
        {state === 'off' && <p class="note dead">Disabled on this server.</p>}
        {state === 'few' && <p class="note need">Not in play yet: it needs {role.min}+ players, and this round has {players}. {more(role.min! - players!)}.</p>}
        <h2>What it does</h2>
        {role.description
          ? <p class="desc">{role.description}</p>
          : <>
              <p class="none">The addon does not describe this role.</p>
              {role.facts && <p class="desc">{role.facts}</p>}
            </>}
        <h2>How it appears on this server</h2>
        <dl class="ledger">
          {role.numbers.map(n => <div><dt>{n.label}</dt><dd>{n.text === '—' ? 'not reported yet' : n.text}</dd></div>)}
        </dl>
        {role.settings && (
          <>
            <h2>Settings</h2>
            {role.settings.length === 0 ? <p class="none">No settings reported yet.</p> : (
              <table class="set">
                <thead><tr><th>Setting</th><th>Now</th><th>Default</th></tr></thead>
                <tbody>{role.settings.map(s => <tr><td>{s.label}</td><td class="v">{s.value ?? '—'}</td><td class="d">{s.default ?? '—'}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
      </article>
      {admin && !embed && <p style="margin-top:1rem"><a href={`/servers/${server.id}/roles/${encodeURIComponent(role.name)}/config`} style="text-decoration:underline">Edit settings</a></p>}
    </Shell>
  )
}

export const RoleNotFound = ({ embed }: { embed: boolean }) => (
  <Shell title="Not found" embed={embed}>
    <h1>Not found</h1>
    <p class="muted">There is no such server or role.</p>
  </Shell>
)
