import { BRIDGE_SETTINGS, type BridgeSetting } from '../services/bridgeSettings'
import { When } from './kit'
import type { TracksInfo } from './StatsPages'

// RFC 23: the settings of a server, for admins, on one page that looks like the role settings page (same fields, the same save bar and toast).
// Two kinds sit side by side. The bridge's own settings are on the game server: what it runs with is what it reported, a save stages commands,
// and the page then waits for the next report to say "applied"; without a report (an older bridge, or none yet) there is nothing to change.
// The dashboard's own settings for the server (how many replays it keeps, RFC 12, 3.4) are here, take effect at once, and need no game server.

export interface BridgeSettingsState {
  reportedAt: string | null
  values: Record<string, { value: string, saved: string | null }>
  /** Names of settings whose commands are waiting for the game server. */
  pending: string[]
}

const GROUPS: BridgeSetting['group'][] = ['Round stats', 'Position tracking']
/** The names the dashboard's own settings have in the form (never a name the game server knows). */
const STORAGE = { count: 'storage_count', mb: 'storage_mb' } as const
const parse = (s: BridgeSetting, raw: string): boolean | number => (s.kind === 'bool' ? raw !== '0' : Number(raw))
const same = (a: string, b: string) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) === Number(b) : a === b)

export const ServerSettingsForm = ({ serverId, state, storage, now }: { serverId: string, state: BridgeSettingsState, storage: TracksInfo, now?: number }) => {
  const reported = state.reportedAt !== null
  const initial: Record<string, boolean | number> = {}
  for (const s of BRIDGE_SETTINGS) initial[s.name] = parse(s, state.values[s.name]?.value ?? s.default)
  const defaults: Record<string, boolean | number> = Object.fromEntries(BRIDGE_SETTINGS.map(s => [s.name, parse(s, s.default)]))
  const kinds = Object.fromEntries(BRIDGE_SETTINGS.map(s => [s.name, s.kind]))
  // the dashboard's own: the server's own limit as text (empty is the instance's default)
  const own = { [STORAGE.count]: storage.limits.own.count === null ? '' : String(storage.limits.own.count), [STORAGE.mb]: storage.limits.own.mb === null ? '' : String(storage.limits.own.mb) }
  Object.assign(initial, own)
  Object.assign(defaults, { [STORAGE.count]: '', [STORAGE.mb]: '' })

  const xData = `{
    initial: ${JSON.stringify(initial)},
    current: ${JSON.stringify(initial)},
    defaults: ${JSON.stringify(defaults)},
    kinds: ${JSON.stringify(kinds)},
    url: ${JSON.stringify(`/api/bridge-settings/${serverId}`)},
    limitsUrl: ${JSON.stringify(`/api/track-limits/${serverId}`)},
    sent: {},
    sentAt: 0,
    pending: ${JSON.stringify(state.pending)},
    saving: false,
    message: '',
    ok: true,
    dirtyKeys() { return Object.keys(this.current).filter(k => String(this.current[k]) !== String(this.initial[k])); },
    isDirty() { return this.dirtyKeys().length > 0; },
    atDefault(k) { return String(this.initial[k]) === String(this.defaults[k]); },
    status(k) {
      if (!(k in this.sent)) return '';
      return Date.now() - this.sentAt > 3600000 ? 'not applied' : 'waiting for the game server';
    },
    isBridge(k) { return k.indexOf('traitordash_') === 0; },
    wire(k) { const v = this.current[k]; return this.kinds[k] === 'bool' ? (v ? '1' : '0') : String(v); },
    async save() {
      const keys = this.dirtyKeys();
      if (keys.length === 0 || this.saving) return;
      const wrong = document.querySelector('#settings-form :invalid');
      if (wrong) {
        this.ok = false;
        this.message = (wrong.getAttribute('aria-label') || wrong.id) + ': ' + wrong.validationMessage;
        wrong.scrollIntoView({ block: 'center' });
        wrong.focus();
        return;
      }
      const mine = keys.filter(k => this.isBridge(k)), kept = keys.filter(k => !this.isBridge(k));
      this.saving = true;
      const said = [];
      try {
        if (mine.length > 0) {
          const body = new URLSearchParams();
          for (const k of mine) body.set(k, this.wire(k));
          const res = await fetch(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          for (const k of mine) { this.sent[k] = this.wire(k); this.initial[k] = this.current[k]; }
          this.sentAt = Date.now();
          said.push(data.commands_staged + ' change(s) queued for the server');
        }
        if (kept.length > 0) {
          const body = new URLSearchParams();
          body.set('count', String(this.current.storage_count).trim());
          body.set('mb', String(this.current.storage_mb).trim());
          const res = await fetch(this.limitsUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          for (const k of kept) this.initial[k] = this.current[k];
          said.push('the replay limits are saved');
        }
        this.ok = true;
        this.message = said.join('; ');
        setTimeout(() => { this.message = ''; }, 6000);
        if (mine.length > 0) this.watch();
      } catch (e) {
        this.ok = false;
        this.message = 'Save failed: ' + e.message;
      } finally {
        this.saving = false;
      }
    },
    watching: false,
    watch() {
      if (this.watching) return;
      this.watching = true;
      const tick = async () => {
        if (Object.keys(this.sent).length === 0 || Date.now() - this.sentAt > 3600000) { this.watching = false; return; }
        try {
          const res = await fetch(this.url, { headers: { Accept: 'application/json' } });
          const data = await res.json();
          for (const k of Object.keys(this.sent)) {
            const r = data.values && data.values[k];
            if (r && Number(r.value) === Number(this.sent[k])) {
              delete this.sent[k];
              this.initial[k] = this.kinds[k] === 'bool' ? r.value !== '0' : Number(r.value);
            }
          }
        } catch (e) { /* the next tick will do */ }
        setTimeout(tick, 4000);
      };
      setTimeout(tick, 3000);
    }
  }`

  return (
    <div class="cfg" x-data={xData}>
      <section class="pn">
        <h1>Settings</h1>
        <p class="muted">
          The bridge on the game server has a few settings of its own: a change made here is kept by the game server and applied after
          <code> server.cfg</code> at every start, and only the settings you change are sent. The connection to this dashboard (its address and
          the token) cannot be changed from here. The replay storage is the dashboard's own and takes effect at once.
        </p>
        <p class="muted" data-bridge-status>
          {reported
            ? <>The game server last reported these <When iso={`${state.reportedAt!.replace(' ', 'T').replace(/Z?$/, 'Z')}`} now={now} />.</>
            : <span data-not-reported>The game server has not reported its settings. It needs the current bridge; once it connects they appear here and can be changed.</span>}
        </p>

        <form id="settings-form" novalidate {...{ 'x-on:submit.prevent': 'save()' }}>
          {GROUPS.map(group => (
            <>
              <h3>{group}</h3>
              {BRIDGE_SETTINGS.filter(s => s.group === group).map(s => <SettingField s={s} reported={reported} saved={state.values[s.name]?.saved ?? null} running={state.values[s.name]?.value} />)}
            </>
          ))}
          <StorageFields storage={storage} />
        </form>
        <DeleteBotRounds serverId={serverId} bots={storage.botRounds} />
      </section>

      <p class="toast" x-show="message" x-text="message" x-bind:class="ok ? 'ok' : 'bad'" x-cloak="true" role="status"></p>

      <div x-show="isDirty()" x-cloak {...{ 'x-transition.opacity': '' }} class="savebar" role="alert">
        <div>
          <strong>⚠ Unsaved changes</strong>
          <span class="sub">Modifications detected</span>
        </div>
        <div>
          <button type="button" x-on:click="current = Object.assign({}, initial)" class="ab">Reset</button>{' '}
          <button form="settings-form" type="submit" class="ab main">
            <span x-show="!saving">Apply changes</span>
            <span x-show="saving" x-cloak="true">Saving…</span>
          </button>
        </div>
      </div>
    </div>
  )
}

const SettingField = ({ s, reported, saved, running }: { s: BridgeSetting, reported: boolean, saved: string | null, running?: string }) => {
  const name = s.name
  const range = s.kind !== 'bool' ? `${s.min} to ${s.max} ${s.unit}` : ''
  const fileDiffers = saved !== null && running !== undefined && !same(saved, running)
  const control = s.kind === 'bool'
    ? <input type="checkbox" class="switch" id={name} disabled={!reported} aria-label={s.label} x-model={`current['${name}']`} />
    : <input type="number" id={name} aria-label={s.label} min={s.min} max={s.max} step={s.kind === 'int' ? '1' : 'any'} required disabled={!reported} {...{ 'x-model.number': `current['${name}']` }} />
  return (
    <div class={s.kind === 'bool' ? 'fld row' : 'fld'} data-setting={name}>
      <div>
        <label class="fl" for={name}>
          {s.label}{' '}
          <span class={`src ${reported ? 'live' : 'default'}`} title={reported ? 'Reported by the game server' : 'Not reported yet'}>{reported ? 'live' : 'not reported'}</span>
          <span class="src missing" x-cloak="true" title="Not at its default" {...{ 'x-show': `!atDefault('${name}')` }}> changed</span>
          <span class="src default" x-cloak="true" x-text={`status('${name}')`} {...{ 'x-show': `status('${name}')` }}></span>
        </label>
        <span class="cv">{name}</span>
        <span class="hint">{s.explain}</span>
        <span class="hint">Takes effect {s.applies}.{' '}{range && <>Range {range}. </>}Default {s.kind === 'bool' ? (s.default === '1' ? 'on' : 'off') : `${s.default} ${s.unit}`}.</span>
        {fileDiffers && <span class="hint" data-file-differs>Set on the console since: the configuration file holds {saved}{s.unit ? ` ${s.unit}` : ''} and applies it at the next start.</span>}
        {reported && (
          <button type="button" class="ab" x-show={`current['${name}'] !== defaults['${name}']`} x-cloak="true" x-on:click={`current['${name}'] = defaults['${name}']`}>Reset to default</button>
        )}
      </div>
      {control}
    </div>
  )
}

/** How much room the replays use and the two limits (RFC 12, 3.4): fields like the others, saved with them, applied at once. */
const StorageFields = ({ storage: t }: { storage: TracksInfo }) => (
  <div id="replay-storage" data-storage>
    <h3>Replay storage</h3>
    <p class="muted" data-tracks-usage>
      {t.count} {t.count === 1 ? 'track' : 'tracks'}, {(t.bytes / 1048576).toFixed(1)} MB used of {t.limits.count} tracks / {t.limits.mb} MB
      {t.pinned > 0 && <> ({t.pinned} pinned, kept regardless; at most {t.ceiling.pinned})</>}.
    </p>
    <StorageField name={STORAGE.count} label="Replays to keep" unit="tracks" shown={t.limits.count} ceiling={t.ceiling.count}
      explain="How many replays the dashboard keeps for this server. When there are more, the oldest ones that are not pinned are removed. Empty uses the default of this instance." />
    <StorageField name={STORAGE.mb} label="Room for replays" unit="MB" shown={t.limits.mb} ceiling={t.ceiling.mb}
      explain="How much space the replays of this server may take together. When they take more, the oldest ones that are not pinned are removed. Empty uses the default of this instance." />
    <p class="hint">Pinned replays are never removed by these limits. 0 stores nothing: the game server still uploads, the dashboard discards what it gets.</p>
  </div>
)

const StorageField = ({ name, label, unit, shown, ceiling, explain }: { name: string, label: string, unit: string, shown: number, ceiling: number, explain: string }) => (
  <div class="fld" data-setting={name}>
    <div>
      <label class="fl" for={name}>
        {label}{' '}
        <span class="src live" title="Kept by the dashboard">dashboard</span>
        <span class="src missing" x-cloak="true" title="Not at its default" {...{ 'x-show': `!atDefault('${name}')` }}> changed</span>
      </label>
      <span class="hint">{explain}</span>
      <span class="hint">Takes effect at once. Range 0 to {ceiling} {unit}. Default {shown} {unit} (empty).</span>
      <button type="button" class="ab" x-show={`current['${name}'] !== defaults['${name}']`} x-cloak="true" x-on:click={`current['${name}'] = defaults['${name}']`}>Reset to default</button>
    </div>
    <input type="number" id={name} aria-label={label} min="0" max={ceiling} step="1" inputmode="numeric" placeholder={`default (${shown})`} {...{ 'x-model': `current['${name}']` }} />
  </div>
)

/** The rounds only test bots played in, with their replays (RFC 12, 3.4): a button of its own, a form of its own. */
const DeleteBotRounds = ({ serverId, bots }: { serverId: string, bots: number }) => bots > 0 ? (
  <form method="post" action={`/servers/${serverId}/rounds/delete-bots`} data-delete-bots class="inline"
    data-confirm={`Delete ${bots} test ${bots === 1 ? 'round' : 'rounds'} played only by bots, with their replays? This cannot be undone.`}>
    <button type="submit" class="ab danger">Delete {bots} test {bots === 1 ? 'round' : 'rounds'} (bots only)</button>
  </form>
) : null
