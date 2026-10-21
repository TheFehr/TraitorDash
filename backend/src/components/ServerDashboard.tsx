import { isServerOnline } from '../services/ServerUtils'
import { Heartbeat } from './Heartbeat'
import { METRICS, type MetricKey, type RoleMetrics } from '../services/roles'

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

  const teamColors: any = {
    traitors: 'border-red-500/30 text-red-500',
    innocents: 'border-green-500/30 text-green-500',
    detectives: 'border-blue-500/30 text-blue-500',
    necromancers: 'border-purple-500/30 text-purple-500',
    jackals: 'border-orange-500/30 text-orange-500',
    infecteds: 'border-teal-500/30 text-teal-500',
    nones: 'border-gray-500/30 text-gray-500',
    unknown: 'border-gray-500/30 text-gray-500'
  }

  const teamLabels: any = {
    traitors: 'Traitors',
    innocents: 'Innocents',
    detectives: 'Detectives',
    necromancers: 'Necromancers',
    jackals: 'Jackals',
    infecteds: 'Infected',
    nones: 'Neutral / Other',
    unknown: 'Uncategorized'
  }

  // Define sort order
  const order = ['innocents', 'traitors', 'detectives', 'necromancers', 'jackals', 'infecteds', 'nones', 'unknown']
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    return order.indexOf(a[0]) - order.indexOf(b[0])
  })

  return (
    <div class="container mx-auto p-4 sm:p-8">
      <header class="mb-8 sm:mb-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex gap-2">
            <a href="/" class="hover:text-white transition">Dashboard</a>
            <span>/</span>
            <span class="text-red-500">{server.name}</span>
          </nav>
          <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">{server.name}</h1>
          <p class="text-gray-400 text-lg">Server Role Registry</p>
          <a href={`/servers/${server.id}/stats`} class="inline-block mt-4 px-4 py-2 rounded-lg border border-gray-700 text-sm font-bold text-gray-300 hover:text-white hover:border-red-500 transition">
            📊 Round stats
          </a>
          <a href={`/servers/${server.id}/maps`} class="inline-block mt-4 ml-2 px-4 py-2 rounded-lg border border-gray-700 text-sm font-bold text-gray-300 hover:text-white hover:border-red-500 transition">
            🗺 Maps
          </a>
        </div>
        <div class={`px-4 py-2 rounded-xl border ${isOnline ? 'border-green-500/50 bg-green-500/10 text-green-400' : 'border-gray-700 bg-gray-800 text-gray-500'} flex items-center gap-3 shadow-xl self-start`}>
           <div class={`w-3 h-3 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-700'}`}></div>
           <div>
             <span class="block font-black uppercase text-sm tracking-tighter">{isOnline ? 'System Online' : 'System Dead'}</span>
             <span class="block text-xs opacity-80">Last heartbeat: <Heartbeat lastSeen={server.last_seen} /></span>
           </div>
        </div>
      </header>

      <div class="space-y-12" x-data={filterState}>
        {sortedGroups.length > 0 && (
          <div class="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 bg-gray-800/60 border border-gray-700 rounded-xl">
            <label class="flex items-center gap-3 cursor-pointer select-none">
              <span class="relative inline-block w-12 h-6">
                <input
                  type="checkbox"
                  x-model="enabledOnly"
                  class="peer absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-6"
                />
                <span class="block overflow-hidden h-6 rounded-full bg-gray-600 peer-checked:bg-green-500 transition"></span>
              </span>
              <span class="text-sm font-bold text-gray-200">Enabled only</span>
            </label>

            <select
              x-model="team"
              class="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-red-500"
            >
              <option value="all">All teams</option>
              {sortedGroups.map(([team]) => (
                <option value={team}>{teamLabels[team] || team}</option>
              ))}
            </select>

            <input
              type="search"
              x-model="q"
              placeholder="Filter roles..."
              class="flex-1 min-w-[10rem] bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-red-500"
            />

            <label class="flex items-center gap-2 text-sm text-gray-300">
              <span>Sort by</span>
              <select
                x-model="sortBy"
                class="bg-gray-700 border border-gray-600 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="name">Name</option>
                {(Object.entries(METRICS) as [MetricKey, { label: string }][]).map(([key, m]) => (
                  <option value={key}>{m.label}</option>
                ))}
              </select>
              <button
                type="button"
                x-on:click="desc = !desc"
                class="px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-sm font-bold hover:bg-gray-600 transition"
                title="Reverse the order"
                x-text="desc ? '\u2193 high to low' : '\u2191 low to high'"
              ></button>
            </label>

            <label class="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-300">
              <input type="checkbox" x-model="flat" class="accent-red-500" />
              <span>One list (ignore teams)</span>
            </label>

            <span class="text-xs text-gray-500 font-mono" x-text="`Showing ${shown()} of ${total()}`"></span>
          </div>
        )}

        <p
          x-show="shown() === 0"
          x-cloak="true"
          class="p-8 text-center text-gray-500 bg-gray-800/20 rounded-xl border-2 border-dashed border-gray-700"
        >
          No roles match these filters.
        </p>

        {sortedGroups.length === 0 ? (
          <div class="p-20 bg-gray-800/20 rounded-3xl border-2 border-dashed border-gray-700 text-center shadow-inner">
             <div class="text-6xl mb-6 opacity-20 italic font-black">Empty</div>
             <h3 class="text-xl font-bold text-gray-500">No roles detected for this node.</h3>
             <p class="text-gray-600 mt-2">Ensure the TraitorLink bridge is running on the game server.</p>
          </div>
        ) : (
          <div
            class="space-y-12"
            x-bind:style="{ display: flat ? 'grid' : '', gridTemplateColumns: flat ? 'repeat(auto-fill, minmax(18rem, 1fr))' : '', gap: flat ? '1.5rem' : '' }"
          >
          {sortedGroups.map(([team, roleList]: [string, any]) => (
            <section class="space-y-6" x-show="sectionVisible($el)" x-bind:class="flat ? 'contents' : ''">
              <div class="flex items-center gap-4" x-show="!flat">
                <h2 class={`text-2xl font-black uppercase tracking-tighter px-4 py-1 rounded-lg border bg-gray-800/50 ${teamColors[team] || teamColors.unknown}`}>
                  {teamLabels[team] || team}
                </h2>
                <div class="h-px flex-1 bg-gray-700/50"></div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" x-bind:style="{ display: flat ? 'contents' : '' }">
                {roleList.map((role: { name: string, colour?: string, enabled: boolean, metrics?: RoleMetrics }) => (
                  <a
                    href={`/servers/${server.id}/roles/${role.name}/config`}
                    data-role={role.name}
                    data-team={team}
                    data-enabled={role.enabled ? '1' : '0'}
                    {...metricAttributes(role.metrics)}
                    x-show="visible($el)"
                    x-bind:style="{ order: rank($el) }"
                    style={role.colour && /^#[0-9a-f]{6}$/.test(role.colour) ? `border-left: 4px solid ${role.colour}` : undefined}
                    class={`bg-gray-800 rounded-xl p-6 border border-gray-700 hover:border-red-500 transition group flex justify-between items-center shadow-lg hover:shadow-red-500/10 ${role.enabled ? '' : 'opacity-60'}`}
                  >
                    <div class="min-w-0">
                      <span class="text-xl font-bold group-hover:text-red-400 transition">
                        {role.name}
                        {!role.enabled && (
                          <span class="ml-2 align-middle text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-gray-700 text-gray-400">disabled</span>
                        )}
                      </span>
                      <span
                        class="block mt-1 text-sm font-mono text-blue-300"
                        x-show="sortBy !== 'name'"
                        x-cloak="true"
                        x-text="valueText($el.closest('[data-role]'))"
                      ></span>
                    </div>
                    <span class="text-red-500 opacity-0 group-hover:opacity-100 transition font-black uppercase text-xs">Configure →</span>
                  </a>
                ))}
              </div>
            </section>
          ))}
          </div>
        )}
      </div>
    </div>
  )
}
