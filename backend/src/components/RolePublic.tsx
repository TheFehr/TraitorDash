import { teamColour } from '../replaylogic'
import type { RoleView, RoleListEntry } from '../services/roleview'

// The public, read-only role pages (RFC 15). One shell for the normal and the embedded layout: no
// script, an inline stylesheet, nothing from the site's own bundle, so the strict
// Content-Security-Policy of these pages holds and the same page works in the game's old browser.

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#111827;color:#f3f4f6;font:15px/1.5 system-ui,sans-serif}
a{color:#fca5a5}a:hover{color:#fff}
.w{max-width:56rem;margin:0 auto;padding:1rem}
header.top{border-bottom:1px solid #374151;background:#1f2937}
header.top .w{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
h1{font-size:1.6rem;margin:.2rem 0}h2{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:#9ca3af;margin:1.4rem 0 .5rem}
.crumbs{font-size:.8rem;color:#9ca3af;margin-bottom:.4rem}
.badge{display:inline-block;border-radius:.4rem;padding:.05rem .5rem;font-size:.75rem;font-weight:700;color:#111827;margin-left:.4rem;vertical-align:middle}
.off{background:#4b5563;color:#e5e7eb}
.card{background:#1f2937;border:1px solid #374151;border-radius:.6rem;padding:.8rem 1rem}
.desc{white-space:pre-line;overflow-wrap:anywhere}
.muted{color:#9ca3af}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:.6rem}
.grid div b{display:block;font-size:1.15rem}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.35rem .5rem;border-top:1px solid #374151;vertical-align:top}
th{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;border-top:0}
td.v{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
input[type=search]{background:#374151;color:#fff;border:1px solid #4b5563;border-radius:.4rem;padding:.35rem .6rem}
button{background:#dc2626;color:#fff;border:0;border-radius:.4rem;padding:.4rem .8rem;font-weight:700}
`

const Shell = ({ title, embed, children }: { title: string, embed: boolean, children: any }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="referrer" content="no-referrer" />
      {embed && <meta name="robots" content="noindex" />}
      <title>{title}</title>
      <style>{CSS}</style>
    </head>
    <body>
      {!embed && (
        <header class="top"><div class="w"><a href="/" style="font-weight:800;text-decoration:none">TraitorDash</a></div></header>
      )}
      <main class="w">{children}</main>
    </body>
  </html>
)

const q = (embed: boolean) => (embed ? '?embed=1' : '')
const hex = (team: string) => '#' + teamColour(team).toString(16).padStart(6, '0')
const Team = ({ team }: { team: string }) => team ? <span class="badge" style={`background:${hex(team)}`}>{team}</span> : null

export const RoleListPage = ({ server, roles, query, embed, admin }: { server: { id: string, name: string }, roles: RoleListEntry[], query: string, embed: boolean, admin: boolean }) => (
  <Shell title={`Roles | ${server.name}`} embed={embed}>
    <div class="crumbs">{embed ? server.name : <><a href={`/servers/${server.id}/stats`}>{server.name}</a> / Roles</>}</div>
    <h1>Roles on this server</h1>
    <form method="get" action={`/servers/${server.id}/roles`} style="margin:.6rem 0">
      {embed && <input type="hidden" name="embed" value="1" />}
      <input type="search" name="q" value={query} placeholder="Search a role" maxlength={64} aria-label="Search a role" />{' '}
      <button type="submit">Search</button>
    </form>
    {roles.length === 0 ? <p class="muted">{query ? 'No role matches that search.' : 'This server has not reported any roles yet.'}</p> : (
      <div class="card"><table>
        <thead><tr><th>Role</th><th>Team</th><th>Distribution</th><th>Min players</th></tr></thead>
        <tbody>
          {roles.map(r => (
            <tr>
              <td><a href={`/servers/${server.id}/roles/${encodeURIComponent(r.name)}${q(embed)}`}>{r.name}</a>{!r.enabled && <span class="badge off">disabled</span>}</td>
              <td><Team team={r.team} /></td><td>{r.pct}</td><td>{r.minPlayers}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    )}
    {admin && !embed && <p class="muted" style="margin-top:1rem">You can change role settings from the <a href={`/servers/${server.id}`}>server's admin page</a>.</p>}
  </Shell>
)

export const RolePage = ({ server, role, embed, admin }: { server: { id: string, name: string }, role: RoleView, embed: boolean, admin: boolean }) => (
  <Shell title={`${role.name} | ${server.name}`} embed={embed}>
    <div class="crumbs"><a href={`/servers/${server.id}/roles${q(embed)}`}>All roles</a> / {role.name}</div>
    <h1>{role.name}<Team team={role.team} />{!role.enabled && <span class="badge off">disabled on this server</span>}</h1>
    <h2>What it does</h2>
    {role.description
      ? <div class="card desc">{role.description}</div>
      : <p class="card muted">The addon does not describe this role.</p>}
    <h2>How it appears on this server</h2>
    <div class="card grid">
      {role.numbers.map(n => <div><span class="muted">{n.label}</span><b>{n.text === '—' ? 'not reported yet' : n.text}</b></div>)}
    </div>
    {role.settings && (
      <>
        <h2>Settings</h2>
        {role.settings.length === 0 ? <p class="muted">No settings reported yet.</p> : (
          <div class="card"><table>
            <thead><tr><th>Setting</th><th>Now</th><th>Default</th></tr></thead>
            <tbody>{role.settings.map(s => <tr><td>{s.label}</td><td class="v">{s.value ?? '—'}</td><td class="v muted">{s.default ?? '—'}</td></tr>)}</tbody>
          </table></div>
        )}
      </>
    )}
    {admin && !embed && <p style="margin-top:1rem"><a href={`/servers/${server.id}/roles/${encodeURIComponent(role.name)}/config`}>Edit settings</a></p>}
  </Shell>
)

export const RoleNotFound = ({ embed }: { embed: boolean }) => (
  <Shell title="Not found" embed={embed}>
    <h1>Not found</h1>
    <p class="muted">There is no such server or role.</p>
  </Shell>
)
