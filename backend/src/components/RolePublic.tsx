import type { RoleView, RoleListEntry } from '../services/roleview'
import { Sections, Shell } from './CaseFile'

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
      {!embed && <Sections serverId={server.id} current="roles" />}
      <h1>Role files</h1>
      <form class="find" method="get" action={base}>
        {embed && <input type="hidden" name="embed" value="1" />}
        {players !== null && <input type="hidden" name="players" value={String(players)} />}
        <input type="search" name="q" value={query} placeholder="Search a role" maxlength={64} aria-label="Search a role" />
        <button type="submit">Search</button>
      </form>
      <div class="bar">
        {players !== null
          ? <><span>Round of <strong>{players} players</strong></span><span>·</span><span><strong>{open}</strong> can appear</span><span>·</span><span>{roles.length - open} put away</span></>
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
                <h2 class="ft">{r.name}</h2>
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
      {!embed && <Sections serverId={server.id} current="roles" />}
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
              {!role.workshop && role.facts && <p class="desc">{role.facts}</p>}
              {role.workshop && (
                <>
                  <p class="desc">{role.workshop.text}</p>
                  <p class="none">
                    From the Workshop page of {role.workshop.title}
                    {role.workshop.alsoCovers.length > 0 && `, which also covers ${role.workshop.alsoCovers.join(', ')}`}
                    {!embed && <> · <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${role.workshop.wsid}`} rel="noopener noreferrer">open it</a></>}
                  </p>
                </>
              )}
            </>}
        <h2>How it appears on this server</h2>
        <dl class="ledger">
          {role.numbers.map(n => <div><dt>{n.label}</dt><dd>{n.text !== '—' ? n.text : n.synced ? 'no such setting' : 'not reported yet'}</dd></div>)}
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
