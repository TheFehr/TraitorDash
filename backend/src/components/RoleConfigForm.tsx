
export const RoleConfigForm = ({ serverId, role, schema }: { serverId: string, role: string, schema: any[] }) => {
  const initialValues: Record<string, any> = {}
  if (Array.isArray(schema)) {
    schema.forEach(item => {
      if (item.args?.convar || item.args?.serverConvar) {
        const key = item.args.convar || item.args.serverConvar
        if (item.type === 'MakeCheckBox') {
           initialValues[key] = false 
        } else if (item.type === 'conVarData') {
           initialValues[key] = item.args.value
        } else if (item.type === 'MakeSlider') {
           initialValues[key] = item.args.min || 0
        } else {
           initialValues[key] = ''
        }
      }
    })
  }

  const xData = `{ 
    initial: ${JSON.stringify(initialValues)}, 
    current: ${JSON.stringify(initialValues)},
    isDirty() {
      return JSON.stringify(this.initial) !== JSON.stringify(this.current);
    }
  }`

  return (
    <div class="space-y-6" x-data={xData}>
      <div class="bg-gray-800 rounded-lg p-6 shadow-2xl border border-gray-700">
        <h2 class="text-3xl font-bold mb-6 text-red-400 border-b border-gray-700 pb-2">
          Configuring Role: <span class="text-white">{role}</span>
        </h2>
        
        <form 
          id="config-form"
          hx-post={`/api/save/${serverId}/${role}`} 
          hx-swap="none" 
          hx-on="htmx:afterRequest: this.dispatchEvent(new CustomEvent('saved'))"
          class="space-y-6"
          x-on:saved="initial = Object.assign({}, current)"
        >
          {Array.isArray(schema) ? schema.map((item) => renderElement(item)) : (
            <div class="p-4 bg-red-500/10 border border-red-500/50 rounded-xl text-red-400">
               Warning: No configuration options were extracted for this role.
            </div>
          )}
        </form>
      </div>

      {/* Floating Save Banner */}
      <div 
        x-show="isDirty()" 
        x-cloak
        x-transition:enter="transition ease-out duration-300"
        x-transition:enter-start="translate-y-full opacity-0"
        x-transition:enter-end="translate-y-0 opacity-100"
        x-transition:leave="transition ease-in duration-300"
        x-transition:leave-start="translate-y-0 opacity-100"
        x-transition:leave-end="translate-y-full opacity-0"
        class="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] w-full max-w-2xl px-4"
      >
        <div class="bg-red-600 text-white p-4 rounded-2xl shadow-2xl flex items-center justify-between border-2 border-red-400 backdrop-blur-lg bg-opacity-90">
          <div class="flex items-center gap-4">
            <span class="text-2xl">⚠️</span>
            <div>
              <p class="font-black leading-tight">Unsaved Changes</p>
              <p class="text-xs text-red-100 opacity-80 uppercase tracking-widest font-bold">Modifications detected</p>
            </div>
          </div>
          <div class="flex gap-3">
             <button 
               type="button"
               x-on:click="current = Object.assign({}, initial)"
               class="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg font-bold text-sm transition"
             >
               Reset
             </button>
             <button 
               form="config-form"
               type="submit" 
               class="px-6 py-2 bg-white text-red-600 hover:bg-red-50 rounded-lg font-black shadow-lg transition active:scale-95"
             >
               Apply Changes
             </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const cleanLabel = (label: string) => {
  if (!label) return 'Unknown Setting'
  
  if (label.startsWith('[') && label.endsWith(']')) {
    return label
  }

  return label
    .replace(/^label_|^header_|^ttt2_/, '') 
    .replace(/_/g, ' ') 
    .replace(/\b\w/g, (c) => c.toUpperCase()) 
}

const renderElement = (item: any) => {
  const { type, args } = item
  const label = cleanLabel(args.label || args.key)
  const convar = args.convar || args.serverConvar || 'unknown_convar'

  switch (type) {
    case 'MakeHelp':
      return (
        <div class="p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg text-blue-300 text-sm flex gap-3 italic">
          <span class="font-black not-italic opacity-50">ℹ</span>
          {label}
        </div>
      )

    case 'Error':
      return (
        <div class="p-4 bg-yellow-500/10 border border-yellow-500/50 rounded-lg text-yellow-400 text-sm">
          <span class="font-bold mr-2">Extraction Hint:</span> {label}
        </div>
      )

    case 'conVarData':
      const val = args.value
      if (typeof val === 'boolean' || (typeof val === 'number' && (val === 0 || val === 1) && !args.key.match(/pct|maximum|min|credits|karma/i))) {
        return (
          <div class="flex items-center justify-between p-4 bg-gray-700/30 rounded-lg border border-gray-600/50 hover:bg-gray-700/50 transition">
            <label class="font-medium text-gray-200 cursor-pointer" for={convar}>{label}</label>
            <div class="relative inline-block w-12 h-6 transition duration-200 ease-in">
              <input 
                type="checkbox" 
                name={convar} 
                id={convar}
                x-model={`current['${convar}']`}
                class="peer absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-6"
              />
              <label 
                for={convar} 
                class="block overflow-hidden h-6 rounded-full bg-gray-600 cursor-pointer peer-checked:bg-green-500 transition"
              ></label>
            </div>
          </div>
        )
      } else {
        const isPct = args.key.includes('pct')
        return (
          <div class="p-4 bg-gray-700/30 rounded-lg border border-gray-600/50 space-y-2 hover:bg-gray-700/50 transition">
            <div class="flex justify-between items-center">
              <label class="font-medium text-gray-200">{label}</label>
              <span class="text-blue-400 font-mono text-sm" x-text={`current['${convar}']`}></span>
            </div>
            <input 
              type="range" 
              name={convar}
              min={0} 
              max={isPct ? 1 : 100} 
              step={isPct ? 0.01 : 1}
              x-model={`current['${convar}']`}
              class="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>
        )
      }

    case 'MakeCheckBox':
      return (
        <div class="flex items-center justify-between p-4 bg-gray-700/50 rounded-lg hover:bg-gray-700 transition">
          <label class="font-medium text-gray-200 cursor-pointer" for={convar}>{label}</label>
          <div class="relative inline-block w-12 h-6 transition duration-200 ease-in">
            <input 
              type="checkbox" 
              name={convar} 
              id={convar}
              x-model={`current['${convar}']`}
              class="peer absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-6"
            />
            <label 
              for={convar} 
              class="block overflow-hidden h-6 rounded-full bg-gray-600 cursor-pointer peer-checked:bg-green-500 transition"
            ></label>
          </div>
        </div>
      )

    case 'MakeSlider':
      return (
        <div class="p-4 bg-gray-700/50 rounded-lg space-y-2 hover:bg-gray-700 transition">
          <div class="flex justify-between items-center">
            <label class="font-medium text-gray-200">{label}</label>
            <span class="text-red-400 font-mono text-sm" x-text={`current['${convar}']`}></span>
          </div>
          <input 
            type="range" 
            name={convar}
            min={args.min} 
            max={args.max} 
            step={args.decimal === 0 ? 1 : 0.1}
            x-model={`current['${convar}']`}
            class="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-red-500"
          />
        </div>
      )

    case 'MakeComboBox':
      return (
        <div class="p-4 bg-gray-700/50 rounded-lg space-y-2 hover:bg-gray-700 transition">
          <label class="block font-medium text-gray-200">{label}</label>
          <select 
            name={convar}
            x-model={`current['${convar}']`}
            class="w-full bg-gray-600 border border-gray-500 text-white rounded-lg p-2 focus:ring-2 focus:ring-red-500 outline-none"
          >
            {args.choices?.map((choice: string) => (
              <option value={choice}>{choice}</option>
            ))}
          </select>
        </div>
      )

    case 'MakeTextEntry':
      return (
        <div class="p-4 bg-gray-700/50 rounded-lg space-y-2 hover:bg-gray-700 transition">
          <label class="block font-medium text-gray-200">{label}</label>
          <input 
            type="text" 
            name={convar}
            x-model={`current['${convar}']`}
            placeholder="..."
            class="w-full bg-gray-600 border border-gray-500 text-white rounded-lg p-2 focus:ring-2 focus:ring-red-500 outline-none"
          />
        </div>
      )

    default:
      return (
        <div class="p-2 text-sm text-gray-500 italic">
          Unsupported element type: {type}
        </div>
      )
  }
}
