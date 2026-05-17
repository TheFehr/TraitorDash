
export const RoleConfigForm = ({ serverId, role, schema }: { serverId: string, role: string, schema: any[] }) => {
  return (
    <div class="bg-gray-800 rounded-lg p-6 shadow-2xl border border-gray-700">
      <h2 class="text-3xl font-bold mb-6 text-red-400 border-b border-gray-700 pb-2">
        Configuring Role: <span class="text-white">{role}</span>
      </h2>
      
      <form hx-post={`/api/save/${serverId}/${role}`} hx-swap="none" class="space-y-6">
        {Array.isArray(schema) ? schema.map((item) => renderElement(item)) : (
          <div class="p-4 bg-red-500/10 border border-red-500/50 rounded-xl text-red-400">
             Warning: No configuration options were extracted for this role.
          </div>
        )}
        
        <div class="pt-6">
          <button 
            type="submit" 
            class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-lg transition duration-200 transform hover:scale-[1.02] shadow-lg"
          >
            Save Configuration
          </button>
        </div>
      </form>
    </div>
  )
}

const cleanLabel = (label: string) => {
  if (!label) return 'Unknown Setting'
  
  // If the label is marked as an unresolved key (e.g. [label_something]), keep it as is
  if (label.startsWith('[') && label.endsWith(']')) {
    return label
  }

  return label
    .replace(/^label_|^header_|^ttt2_/, '') // Remove prefixes
    .replace(/_/g, ' ') // Replace underscores with spaces
    .replace(/\b\w/g, (c) => c.toUpperCase()) // Capitalize
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
      // conVarData can be numeric or boolean (represented as 0/1 usually)
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
                checked={!!val}
                class="peer absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer"
              />
              <label 
                for={convar} 
                class="block overflow-hidden h-6 rounded-full bg-gray-600 cursor-pointer peer-checked:bg-green-500 transition"
              ></label>
            </div>
          </div>
        )
      } else {
        // Render as a generic numeric slider/input for other types
        const isPct = args.key.includes('pct')
        return (
          <div class="p-4 bg-gray-700/30 rounded-lg border border-gray-600/50 space-y-2 hover:bg-gray-700/50 transition" x-data={`{ value: ${val || 0} }`}>
            <div class="flex justify-between items-center">
              <label class="font-medium text-gray-200">{label}</label>
              <span class="text-blue-400 font-mono text-sm" x-text="value"></span>
            </div>
            <input 
              type="range" 
              name={convar}
              min={0} 
              max={isPct ? 1 : 100} 
              step={isPct ? 0.01 : 1}
              x-model="value"
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
              class="peer absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer"
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
        <div class="p-4 bg-gray-700/50 rounded-lg space-y-2 hover:bg-gray-700 transition" x-data={`{ value: ${args.min || 0} }`}>
          <div class="flex justify-between items-center">
            <label class="font-medium text-gray-200">{label}</label>
            <span class="text-red-400 font-mono text-sm" x-text="value"></span>
          </div>
          <input 
            type="range" 
            name={convar}
            min={args.min} 
            max={args.max} 
            step={args.decimal === 0 ? 1 : 0.1}
            x-model="value"
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
