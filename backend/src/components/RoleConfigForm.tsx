import type { LiveConVar } from '../services/Store'

export type FieldKind = 'toggle' | 'number' | 'text'

/** Control for a conVarData value. Decided from the value's type and the key, never from a hard cap. */
export const kindForConVarData = (key: string, value: any): FieldKind => {
  if (typeof value === 'boolean') return 'toggle'
  if (typeof value === 'number') {
    // 0/1 flags (…Enable, togglable) are toggles; every other number is a number.
    if ((value === 0 || value === 1) && /enable|togglable|enabled$/i.test(key)) return 'toggle'
    return 'number'
  }
  return 'text'
}

const normalizedType = (item: any) => String(item?.type || '').toLowerCase()

type Source = 'live' | 'default' | 'missing'
type Live = Record<string, LiveConVar>

const isFlag = (v: string | null | undefined) => v === '0' || v === '1'

/** Parse a ConVar string the way its control will edit it. */
const parseLive = (kind: FieldKind, raw: string): any => {
  if (kind === 'toggle') return raw !== '0' && raw !== '' && raw.toLowerCase() !== 'false'
  if (kind === 'number') return Number.isNaN(Number(raw)) ? raw : Number(raw)
  return raw
}

/**
 * Control for a ConVar only the server told us about (no schema entry), decided from its
 * default and value. TTT2 creates its role ConVars WITHOUT bounds (min/max come back
 * null), so a 0/1 setting counts as a toggle unless the server reports bounds that
 * say otherwise.
 */
export const kindForLive = (lv: LiveConVar): FieldKind => {
  const boundsAllowFlag = (lv.min === null && lv.max === null) || (lv.min === 0 && lv.max === 1)
  if (isFlag(lv.default) && isFlag(lv.value) && boundsAllowFlag) return 'toggle'
  if (lv.default !== null && lv.default !== '' && !Number.isNaN(Number(lv.default))) return 'number'
  return 'text'
}

/** Suffix of a ConVar name after ttt_<role-or-abbr>_ (ttt_surv_credits_starting -> credits_starting). */
export const suffixOf = (convar: string) => convar.replace(/^ttt_[a-z0-9]+_/i, '')

export const SUFFIX_TO_KEY: Record<string, string> = {
  enabled: 'togglable', pct: 'pct', max: 'maximum', min_players: 'minPlayers', karma_min: 'minKarma',
  random: 'random', traitor_button: 'traitorButton', credits_starting: 'credits',
  credits_award_dead_enb: 'creditsAwardDeadEnable', credits_award_kill_enb: 'creditsAwardKillEnable',
  shop_fallback: 'shopFallback',
}

type Field = { convar: string, kind: FieldKind, initial: any, source: Source, fromServer: boolean }

/**
 * Everything the form can save. The starting value is what the server reported when it
 * did; otherwise the role's extracted default. Settings that exist on the server but are
 * not in the role file's schema (random, traitor_button, ...) are added as extras.
 */
const collectFields = (schema: any[], live: Live, role: string): Field[] => {
  const fields: Field[] = []
  const seen = new Set<string>()

  const push = (convar: string, kind: FieldKind, fallback: any) => {
    const lv = live[convar]
    let source: Source = 'default'
    let initial = fallback
    if (lv && !lv.present) source = 'missing'
    else if (lv && lv.value !== null) { source = 'live'; initial = parseLive(kind, lv.value) }
    fields.push({ convar, kind, initial, source, fromServer: false })
    seen.add(convar)
  }

  for (const item of Array.isArray(schema) ? schema : []) {
    const convar = item.args?.convar || item.args?.serverConvar
    if (!convar || seen.has(convar)) continue
    const type = normalizedType(item)

    if (type === 'convardata') {
      const kind = kindForConVarData(item.args.key || '', item.args.value)
      push(convar, kind, kind === 'toggle' ? Boolean(item.args.value) : (item.args.value ?? ''))
    } else if (type === 'makecheckbox') push(convar, 'toggle', false)
    else if (type === 'makeslider') push(convar, 'number', item.args.min || 0)
    else push(convar, 'text', '')
  }

  for (const [convar, lv] of Object.entries(live)) {
    if (seen.has(convar) || lv.role !== role || !lv.present || lv.value === null) continue
    const kind = kindForLive(lv)
    fields.push({ convar, kind, initial: parseLive(kind, lv.value), source: 'live', fromServer: true })
    seen.add(convar)
  }
  return fields
}

export const RoleConfigForm = ({ serverId, role, schema, live = {} }: { serverId: string, role: string, schema: any[], live?: Live }) => {
  const fields = collectFields(schema, live, role)
  const kinds: Record<string, FieldKind> = Object.fromEntries(fields.map(f => [f.convar, f.kind]))
  const initial: Record<string, any> = Object.fromEntries(fields.map(f => [f.convar, f.initial]))
  const extras = fields.filter(f => f.fromServer)

  // Only fields the admin actually changed are sent. Sending everything would overwrite
  // live server settings with the role's extracted defaults.
  const xData = `{
    initial: ${JSON.stringify(initial)},
    current: ${JSON.stringify(initial)},
    kinds: ${JSON.stringify(kinds)},
    url: ${JSON.stringify(`/api/save/${serverId}/${role}`)},
    saving: false,
    message: '',
    ok: true,
    dirtyKeys() {
      return Object.keys(this.current).filter(k => String(this.current[k]) !== String(this.initial[k]));
    },
    isDirty() { return this.dirtyKeys().length > 0 },
    async save() {
      const keys = this.dirtyKeys();
      if (keys.length === 0 || this.saving) return;
      // The browser's own check would stop the submit without a word on a phone: say which setting is wrong.
      const wrong = document.querySelector('#config-form :invalid');
      if (wrong) {
        const lab = document.querySelector('label[for="' + wrong.id + '"]');
        const name = (lab && lab.firstChild && lab.firstChild.textContent) || wrong.id;
        this.ok = false;
        this.message = name.trim() + ': ' + wrong.validationMessage;
        wrong.scrollIntoView({ block: 'center' });
        wrong.focus();
        return;
      }
      const body = new URLSearchParams();
      for (const k of keys) {
        const v = this.current[k];
        body.set(k, this.kinds[k] === 'toggle' ? (v ? '1' : '0') : String(v));
      }
      this.saving = true;
      try {
        const res = await fetch(this.url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        this.initial = Object.assign({}, this.current);
        this.ok = true;
        this.message = data.commands_staged + ' change(s) queued for the server';
        setTimeout(() => { this.message = ''; }, 6000);
      } catch (e) {
        this.ok = false;
        this.message = 'Save failed: ' + e.message;
      } finally {
        this.saving = false;
      }
    }
  }`

  return (
    <div class="cfg" x-data={xData}>
      <section class="pn" style="--c:#e9b44c">
        <h1>
          Configuring Role: <span style="color:#e9b44c">{role}</span>
        </h1>
        <p class="muted">
          <span class="src live" style="margin:0">live</span> values were reported by the game server;{' '}
          <span class="src default" style="margin:0">default</span> ones have not been reported yet and show the role's default.
          Only the settings you change are sent.
        </p>

        <form id="config-form" novalidate {...{ 'x-on:submit.prevent': 'save()' }}>
          {Array.isArray(schema) ? schema.map((item) => renderElement(item, live)) : (
            <div class="fld bad">
              Warning: No configuration options were extracted for this role.
            </div>
          )}
          {extras.length > 0 && (
            <>
              <h3>Other settings found on the server</h3>
              {extras.map(f => renderExtra(f, live[f.convar]!))}
            </>
          )}
        </form>

      </section>

      {/* The result of a save, where the button is: the card is usually scrolled out of sight by then */}
      <p class="toast" x-show="message" x-text="message" x-bind:class="ok ? 'ok' : 'bad'" x-cloak="true" role="status"></p>

      {/* Floating save banner */}
      <div x-show="isDirty()" x-cloak {...{ "x-transition.opacity": "" }} class="savebar" role="alert">
        <div>
          <strong>⚠ Unsaved changes</strong>
          <span class="sub">Modifications detected</span>
        </div>
        <div>
          <button type="button" x-on:click="current = Object.assign({}, initial)" class="ab">Reset</button>{' '}
          <button form="config-form" type="submit" class="ab main">
            <span x-show="!saving">Apply changes</span>
            <span x-show="saving" x-cloak="true">Saving…</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export const cleanLabel = (label: string) => {
  if (!label) return 'Unknown Setting'
  
  if (label.startsWith('[') && label.endsWith(']')) {
    return label
  }

  return label
    .replace(/^label_|^header_|^ttt2_/, '') 
    .replace(/_/g, ' ') 
    .replace(/\b\w/g, (c) => c.toUpperCase()) 
}

// conVarData settings carry no label in the role file: the in-game ones come from
// TTT2's own translation files (label_roles_* / help_roles_*), which the headless
// extractor never loads and the game server only has client-side. These are TTT2's
// own English strings, copied from lua/terrortown/lang/en.lua in
// https://github.com/TTT-2/TTT2 (checked against v0.14.6b behaviour, 2026-10).
// Re-check there if TTT2 changes them. Keys without an official string
// (shopFallback) get a plain label; anything unknown is de-camel-cased below.
const CONVAR_LABELS: Record<string, { label: string, hint?: string }> = {
  togglable: { label: 'Enable role' },
  pct: {
    label: 'Role distribution per player',
    hint: "Percentage of players assigned this role: 0.2 means every fifth player receives it (so at least 5 players are needed).",
  },
  maximum: { label: 'Upper limit of players assigned for this role', hint: '0 = no limit' },
  minPlayers: { label: 'Lower limit of players to consider distribution' },
  minKarma: { label: 'Lower limit of Karma to consider distribution' },
  random: { label: 'Chance this role is distributed' },
  traitorButton: { label: 'Role can use Traitor buttons' },
  credits: { label: 'Starting credits' },
  creditsAwardDeadEnable: { label: 'Enable credits award for certain percentage of dead enemies' },
  creditsAwardKillEnable: { label: 'Enable credits award for high value player kill' },
  shopFallback: { label: 'Shop fallback' },
}

export const humanizeKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())

export const conVarDataText = (key: string) => {
  const known = CONVAR_LABELS[key]
  return { label: known?.label ?? humanizeKey(key), hint: known?.hint }
}

const SOURCE_TAG: Record<Source, { text: string, cls: string, title: string }> = {
  live: { text: 'live', cls: 'live', title: 'Value reported by the game server' },
  default: { text: 'default', cls: 'default', title: "Not reported by the server yet: showing the role's default" },
  missing: { text: 'not on server', cls: 'missing', title: 'The server has no ConVar with this name, so saving it would be refused' },
}

/** Label line, a live/default tag, the real ConVar name and an optional hint. */
const FieldLabel = ({ label, hint, convar, forId, source }: { label: string, hint?: string, convar: string, forId?: string, source: Source }) => {
  const tag = SOURCE_TAG[source]
  return (
    <div>
      <label class="fl" for={forId}>
        {label} <span class={`src ${tag.cls}`} title={tag.title}>{tag.text}</span>
      </label>
      <span class="cv">{convar}</span>
      {hint && <span class="hint">{hint}</span>}
    </div>
  )
}

const sourceOf = (lv: LiveConVar | undefined): Source =>
  lv && !lv.present ? 'missing' : lv && lv.value !== null ? 'live' : 'default'

/** The on/off switch every toggle uses; it is a checkbox, so the keyboard and the label work. */
const Switch = ({ id, model }: { id?: string, model: string }) => (
  <input type="checkbox" class="switch" id={id} x-model={model} />
)

/** One editable ConVar: toggle, number (bounded by what the server reports) or text. */
const ConVarControl = (props: { convar: string, kind: FieldKind, label: string, hint?: string, lv?: LiveConVar, isPct?: boolean, fractional?: boolean }) => {
  const { convar, kind, label, hint, lv, isPct, fractional } = props
  const source = sourceOf(lv)
  const field = <FieldLabel label={label} hint={hint} convar={convar} forId={convar} source={source} />

  if (kind === 'toggle') {
    return (
      <div class="fld row">
        {field}
        <Switch id={convar} model={`current['${convar}']`} />
      </div>
    )
  }

  if (kind === 'number') {
    // Bounds are the server's own when it reported them; a fraction (pct) is otherwise 0..1.
    const min = lv?.min ?? 0
    const max = lv?.max ?? (isPct ? 1 : undefined)
    const frac = Boolean(isPct || fractional || lv?.default?.includes('.') || lv?.value?.includes('.'))
    return (
      <div class="fld">
        {field}
        <input
          type="number"
          id={convar}
          min={min}
          max={max}
          step={frac ? 0.01 : 1}
          {...{ 'x-model.number': `current['${convar}']` }}
        />
      </div>
    )
  }

  return (
    <div class="fld">
      {field}
      <input type="text" class="dk" id={convar} x-model={`current['${convar}']`} />
    </div>
  )
}

/** A setting the server has but the role file does not declare (random, traitor_button, ...). */
const renderExtra = (f: Field, lv: LiveConVar) => {
  const key = SUFFIX_TO_KEY[suffixOf(f.convar)]
  const text = key ? conVarDataText(key) : { label: humanizeKey(suffixOf(f.convar)), hint: undefined }
  return <ConVarControl convar={f.convar} kind={f.kind} label={text.label} hint={text.hint} lv={lv} isPct={key === 'pct'} />
}

const renderElement = (item: any, live: Live) => {
  const { type, args } = item
  const label = cleanLabel(args.label || args.key)
  const convar = args.convar || args.serverConvar || 'unknown_convar'

  switch (String(type || '').toLowerCase()) {
    case 'makehelp':
      return (
        <div class="fld info">
          <span><span aria-hidden="true">ℹ </span>{label}</span>
        </div>
      )

    case 'error':
      return (
        <div class="fld hintbox">
          <span><strong>Extraction hint:</strong> {label}</span>
        </div>
      )

    case 'convardata': {
      const text = conVarDataText(args.key || '')
      return (
        <ConVarControl
          convar={convar}
          kind={kindForConVarData(args.key || '', args.value)}
          label={text.label}
          hint={text.hint}
          lv={live[convar]}
          isPct={/pct/i.test(args.key || '')}
          fractional={typeof args.value === 'number' && !Number.isInteger(args.value)}
        />
      )
    }

    case 'makecheckbox':
      return (
        <div class="fld row">
          <label class="fl" for={convar}>{label}</label>
          <Switch id={convar} model={`current['${convar}']`} />
        </div>
      )

    case 'makeslider':
      return (
        <div class="fld">
          <div style="display:flex;justify-content:space-between">
            <label class="fl" for={convar}>{label}</label>
            <span class="val" x-text={`current['${convar}']`}></span>
          </div>
          <input
            type="range"
            id={convar}
            min={args.min}
            max={args.max}
            step={args.decimal === 0 ? 1 : 0.1}
            x-model={`current['${convar}']`}
          />
        </div>
      )

    case 'makecombobox':
      return (
        <div class="fld">
          <label class="fl" for={convar}>{label}</label>
          <select id={convar} x-model={`current['${convar}']`}>
            {args.choices?.map((choice: string) => (
              <option value={choice}>{choice}</option>
            ))}
          </select>
        </div>
      )

    case 'maketextentry':
      return (
        <div class="fld">
          <label class="fl" for={convar}>{label}</label>
          <input type="text" class="dk" id={convar} x-model={`current['${convar}']`} placeholder="..." />
        </div>
      )

    default:
      return (
        <div class="fld muted">
          Unsupported element type: {type}
        </div>
      )
  }
}
