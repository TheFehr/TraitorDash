import { HEX6, TEAMS, hex, teamColour, teamLabel } from '../teamColours'
import { isServerOnline } from '../services/ServerUtils'
import { Heartbeat } from './Heartbeat'
import { METRICS, type MetricKey, type RoleMetrics } from '../services/roles'
import { Sections } from './CaseFile'
import { Crumbs } from './kit'

// Filter, sort and grouping state for the role overview, run by Alpine in the browser.
// - "Enabled only" is ON by default; unknown enabled state counts as enabled (services/roles.ts).
// - Sorting reorders the tiles with CSS `order`, so it works inside each team section and,
//   with "Group by team" off, across all of them. The sorted value is printed on every card.
// - The choices are remembered per browser.
// - Style bindings use the OBJECT form on purpose: the string form replaces the whole `style`
//   attribute and wipes the `display: none` that x-show sets, which made hidden roles reappear
//   as soon as the sort changed (found by running the real page in a simulated DOM).
const buildFilterState = () => `{
  enabledOnly: true,
  team: 'all',
  q: '',
  sortBy: 'name',
  desc: false,
  flat: false,
  metrics: ${JSON.stringify(Object.fromEntries(Object.entries(METRICS).map(([key, m]) => [key, m.label])))},
  init() {
    try {
      const saved = JSON.parse(localStorage.getItem('traitordash.overview') || '{}');
      if (typeof saved.enabledOnly === 'boolean') this.enabledOnly = saved.enabledOnly;
      if (saved.sortBy === 'name' || this.metrics[saved.sortBy]) this.sortBy = saved.sortBy;
      if (typeof saved.desc === 'boolean') this.desc = saved.desc;
      if (typeof saved.flat === 'boolean') this.flat = saved.flat;
    } catch (e) {}
    const persist = () => {
      try {
        localStorage.setItem('traitordash.overview', JSON.stringify({
          enabledOnly: this.enabledOnly, sortBy: this.sortBy, desc: this.desc, flat: this.flat,
        }));
      } catch (e) {}
    };
    this.$watch('enabledOnly', persist);
    this.$watch('desc', persist);
    this.$watch('flat', persist);
    // A new metric starts highest-first (what you usually want from a number); name starts A-Z.
    this.$watch('sortBy', (value) => { this.desc = value !== 'name'; persist(); });
  },
  visible(el) {
    const d = el.dataset;
    return (!this.enabledOnly || d.enabled === '1')
      && (this.team === 'all' || d.team === this.team)
      && (!this.q || d.role.toLowerCase().includes(this.q.trim().toLowerCase()));
  },
  tiles() { return Array.from(this.$root.querySelectorAll('[data-role]')); },
  shown() { return this.tiles().filter((t) => this.visible(t)).length; },
  total() { return this.tiles().length; },
  sectionVisible(el) { return Array.from(el.querySelectorAll('[data-role]')).some((t) => this.visible(t)); },
  sortValue(el) {
    if (this.sortBy === 'name') return el.dataset.role.toLowerCase();
    const raw = el.dataset[this.sortBy];
    return raw === undefined || raw === '' ? null : Number(raw);
  },
  // Position of every tile in the current sort. Roles with no value always sort last.
  ranks() {
    const byName = (a, b) => a.el.dataset.role.localeCompare(b.el.dataset.role);
    const list = this.tiles().map((el) => ({ el, v: this.sortValue(el) }));
    list.sort((a, b) => {
      if (a.v === null && b.v === null) return byName(a, b);
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
      return (this.desc ? -c : c) || byName(a, b);
    });
    return new Map(list.map((x, i) => [x.el, i]));
  },
  rank(el) { const r = this.ranks().get(el); return r === undefined ? 0 : r; },
  // What the card shows for the active sort ("Max players: 2"); nothing when sorting by name.
  valueText(el) {
    if (this.sortBy === 'name') return '';
    const text = el.dataset[this.sortBy + 'Text'];
    return this.metrics[this.sortBy] + ': ' + (text || '\u2014');
  },
}`
export const filterState = buildFilterState()

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** data-<metric>="<number>" and data-<metric>-text="<what the card prints>" for every sortable value. */
const metricAttributes = (metrics?: RoleMetrics): Record<string, string> => {
  const attrs: Record<string, string> = {}
  for (const key of Object.keys(METRICS) as MetricKey[]) {
    const m = metrics?.[key]
    attrs[`data-${kebab(key)}`] = m?.sort === null || m === undefined ? '' : String(m.sort)
    attrs[`data-${kebab(key)}-text`] = m?.text ?? '\u2014'
  }
  return attrs
}

export const ServerDashboard = ({ server, roles }: { server: any, roles: any[] }) => {
  const isOnline = isServerOnline(server.last_seen)

  // Group roles by team
  const groups = roles.reduce((acc: any, role: any) => {
    let teamKey = role.team || 'unknown'
    
    // Detective variants (baserole 2) group with the detective. is_policing is NOT
    // used here: Survivalist is policing but an innocent-based role.
    if (role.baserole === 2 || role.role_name === 'detective') {
      teamKey = 'detectives'
    }

    if (!acc[teamKey]) acc[teamKey] = []
    acc[teamKey].push({ name: role.role_name, colour: role.colour, enabled: role.enabled !== false, metrics: role.metrics })
    return acc
  }, {})

  // Define sort order
  const order = Object.keys(TEAMS)
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    return order.indexOf(a[0]) - order.indexOf(b[0])
  })

  return (
    <>
      <Crumbs><a href="/">Dashboard</a> / {server.name}</Crumbs>
      <div class="head">
        <div>
          <h1>{server.name}</h1>
          <p class="muted" style="margin:0 0 .6rem">Server role registry</p>
          <Sections serverId={server.id} />
        </div>
        <div class={`status ${isOnline ? 'on' : ''}`}>
          <i></i>
          <div>
            {isOnline ? 'System online' : 'System dead'}
            <small>Last heartbeat: <Heartbeat lastSeen={server.last_seen} /></small>
          </div>
        </div>
      </div>

      <div class="stack" style="margin-top:1.2rem" x-data={filterState}>
        {sortedGroups.length > 0 && (
          <div class="toolbar">
            <label>
              <input type="checkbox" class="switch" x-model="enabledOnly" />
              <span>Enabled only</span>
            </label>

            <select x-model="team" aria-label="Team">
              <option value="all">All teams</option>
              {sortedGroups.map(([team]) => (
                <option value={team}>{teamLabel(team)}</option>
              ))}
            </select>

            <input type="search" x-model="q" placeholder="Filter roles..." aria-label="Filter roles" />

            <label>
              <span>Sort by</span>
              <select x-model="sortBy">
                <option value="name">Name</option>
                {(Object.entries(METRICS) as [MetricKey, { label: string }][]).map(([key, m]) => (
                  <option value={key}>{m.label}</option>
                ))}
              </select>
              <button
                type="button"
                x-on:click="desc = !desc"
                class="ab"
                title="Reverse the order"
                x-text="desc ? '\u2193 high to low' : '\u2191 low to high'"
              ></button>
            </label>

            <label>
              <input type="checkbox" x-model="flat" />
              <span>One list (ignore teams)</span>
            </label>

            <span class="count" x-text="`Showing ${shown()} of ${total()}`"></span>
          </div>
        )}

        <p x-show="shown() === 0" x-cloak="true" class="muted" style="text-align:center;padding:2rem;border:2px dashed #3a342a;margin:0">
          No roles match these filters.
        </p>

        {sortedGroups.length === 0 ? (
          <div class="pn" style="--c:#6b6455">
            <h2 class="ft">No roles detected for this server</h2>
            <p class="muted">Make sure the TraitorLink bridge is running on the game server.</p>
          </div>
        ) : (
          <div
            class="stack"
            x-bind:style="{ display: flat ? 'grid' : '', gridTemplateColumns: flat ? 'repeat(auto-fill, minmax(17rem, 1fr))' : '', gap: flat ? '1.5rem 1rem' : '' }"
          >
          {sortedGroups.map(([team, roleList]: [string, any]) => (
            <section x-show="sectionVisible($el)" x-bind:class="flat ? 'contents' : ''">
              <h2 class="team" x-show="!flat" style={`color:${hex(teamColour(team))};border-color:${hex(teamColour(team))}`}>
                {teamLabel(team)}
              </h2>
              <div class="tiles" x-bind:style="{ display: flat ? 'contents' : '' }">
                {roleList.map((role: { name: string, colour?: string, enabled: boolean, metrics?: RoleMetrics }) => (
                  <a
                    href={`/servers/${server.id}/roles/${role.name}/config`}
                    data-role={role.name}
                    data-team={team}
                    data-enabled={role.enabled ? '1' : '0'}
                    {...metricAttributes(role.metrics)}
                    x-show="visible($el)"
                    x-bind:style="{ order: rank($el) }"
                    style={role.colour && HEX6.test(role.colour) ? `--c:${role.colour}` : undefined}
                    class={`pn tile${role.enabled ? '' : ' off'}`}
                  >
                    <div style="min-width:0">
                      <strong class="ft" style="font-size:1.1rem;margin:0;border:0">
                        {role.name}
                        {!role.enabled && <span class="pill mute" style="margin-left:.5rem">disabled</span>}
                      </strong>
                      <span
                        class="val"
                        x-show="sortBy !== 'name'"
                        x-cloak="true"
                        x-text="valueText($el.closest('[data-role]'))"
                      ></span>
                    </div>
                    <span class="go">Configure →</span>
                  </a>
                ))}
              </div>
            </section>
          ))}
          </div>
        )}
      </div>
    </>
  )
}
