import { lauxlib, lua, lualib, to_luastring, to_jsstring } from 'fengari'
import path from 'path'

export class Extractor {
  private static mockEnv: string | null = null

  private static async getMockEnv(): Promise<string> {
    if (this.mockEnv === null) {
      // Try multiple potential paths for the mock_env.lua file
      const paths = [
        'src/lua/mock_env.lua',
        'backend/src/lua/mock_env.lua',
        path.join(import.meta.dir, '../lua/mock_env.lua')
      ]
      
      for (const p of paths) {
        const file = Bun.file(p)
        if (await file.exists()) {
          this.mockEnv = await file.text()
          break
        }
      }

      if (this.mockEnv === null) {
        throw new Error('Could not find mock_env.lua')
      }
    }
    return this.mockEnv
  }

  private static sanitizeCode(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, (match) => {
        // Convert /* */ to --[[ ]]
        return '--[[' + match.substring(2, match.length - 2) + ']]'
      })
      .replace(/!=/g, '~=')
      .replace(/!/g, ' not ')
      .replace(/&&/g, ' and ')
      .replace(/\|\|/g, ' or ')
      .replace(/\/\//g, '--') // Single line comments
      .replace(/\bcontinue\b/g, '__td_continue()') // GMod Lua 'continue' keyword
  }

  public static async extractSchema(roleCode: string, convarState?: Record<string, string>): Promise<{ team: string, isPolicingRole: boolean, baserole: number, schema: any[] }> {
    const L = lauxlib.luaL_newstate()
    lualib.luaL_openlibs(L)

    try {
      // 1. Load Mock Environment
      const mockEnv = await this.getMockEnv()
      if (lauxlib.luaL_dostring(L, to_luastring(mockEnv)) !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1))
        console.error('[Extractor] Mock Env Error:', err)
        throw new Error(`Failed to load mock environment: ${err}`)
      }

      // Inject ConVar state if provided
      if (convarState) {
        lua.lua_newtable(L)
        for (const [key, value] of Object.entries(convarState)) {
          lua.lua_pushstring(L, to_luastring(key))
          lua.lua_pushstring(L, to_luastring(value))
          lua.lua_settable(L, -3)
        }
        lua.lua_setglobal(L, to_luastring('__TD_CONVAR_STATE'))
      } else {
        lua.lua_newtable(L)
        lua.lua_setglobal(L, to_luastring('__TD_CONVAR_STATE'))
      }

      // 2. Sanitize and Load Role Code
      const sanitizedCode = this.sanitizeCode(roleCode)
      if (lauxlib.luaL_dostring(L, to_luastring(sanitizedCode)) !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1))
        console.error('[Extractor] Lua Load Error:', err)
        console.error('[Extractor] Failing Code Snippet:', sanitizedCode.substring(0, 500) + '...')
        throw new Error(`Failed to load role code: ${err}`)
      }

      // 3. Execute ROLE:PreInitialize and extract settings
      const execScript = `
        local spy = CreateSpyParent()
        
        -- Override roles.SetBaseRole to capture baserole
        local oldSetBaseRole = roles.SetBaseRole
        roles.SetBaseRole = function(role, base)
          if role == ROLE then
            if type(base) == "number" then
              role.baserole = base
            elseif type(base) == "table" and base.index then
              role.baserole = base.index
            end
          end
          if oldSetBaseRole then oldSetBaseRole(role, base) end
        end

        -- Call PreInitialize if it exists
        if ROLE and ROLE.PreInitialize then
          pcall(function() ROLE:PreInitialize() end)
        end
        
        -- Call Initialize if it exists (often sets baserole)
        if ROLE and ROLE.Initialize then
          pcall(function() ROLE:Initialize() end)
        end

        -- Method 1: direct ROLE call
        if ROLE and ROLE.AddToSettingsMenu then
          local status, err = pcall(function() ROLE:AddToSettingsMenu(spy) end)
          if not status then
            table.insert(__TRAITORDASH_SCHEMA, { type = "Error", args = { label = "ROLE:AddToSettingsMenu Failed: " .. tostring(err) } })
          end
        end
        
        -- Method 2: TTT2 Hooks
        if __TD_HOOKS["TTT2RenderRoleConfig"] then
           for id, cb in pairs(__TD_HOOKS["TTT2RenderRoleConfig"]) do
              local status, err = pcall(function() cb(ROLE, spy) end)
              if not status then
                 table.insert(__TRAITORDASH_SCHEMA, { type = "Error", args = { label = "Hook " .. id .. " Failed: " .. tostring(err) } })
              end
           end
        end

        -- Method 3: conVarData (TTT2 Autogen)
        if ROLE and ROLE.conVarData then
           for key, value in pairs(ROLE.conVarData) do
              table.insert(__TRAITORDASH_SCHEMA, { 
                type = "conVarData", 
                args = { 
                  key = key, 
                  value = value,
                  convar = "ttt_" .. (ROLE.abbr or "unknown") .. "_" .. key
                } 
              })
           end
        end
      `
      if (lauxlib.luaL_dostring(L, to_luastring(execScript)) !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1))
        console.error('[Extractor] Schema Extraction Error:', err)
        throw new Error(`Failed to extract schema: ${err}`)
      }

      // 4. Extract __TRAITORDASH_SCHEMA and Metadata
      lua.lua_getglobal(L, to_luastring('__TRAITORDASH_SCHEMA'))
      const rawSchema = this.luaTableToJS(L, -1)

      lua.lua_getglobal(L, to_luastring('ROLE'))
      let team = 'unknown'
      let isPolicingRole = false
      let baserole = -1

      if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
        // Extract defaultTeam
        lua.lua_getfield(L, -1, to_luastring('defaultTeam'))
        if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
          team = to_jsstring(lua.lua_tostring(L, -1))
        }
        lua.lua_pop(L, 1)

        // Extract isPolicingRole
        lua.lua_getfield(L, -1, to_luastring('isPolicingRole'))
        if (lua.lua_type(L, -1) === lua.LUA_TBOOLEAN) {
          isPolicingRole = lua.lua_toboolean(L, -1)
        }
        lua.lua_pop(L, 1)

        // Extract baserole
        lua.lua_getfield(L, -1, to_luastring('baserole'))
        if (lua.lua_type(L, -1) === lua.LUA_TNUMBER) {
          baserole = lua.lua_tonumber(L, -1)
        }
        lua.lua_pop(L, 1)
      }
      
      // Ensure we ALWAYS return an array, even if Lua returns a sparse table/object
      let schema = Array.isArray(rawSchema) ? rawSchema : []
      if (rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
        schema = Object.values(rawSchema)
      }

      return { team, isPolicingRole, baserole, schema }
    } catch (e) {
      console.error('[Extractor] Caught Exception:', e)
      throw e
    } finally {
      lua.lua_close(L)
    }
  }

  private static luaTableToJS(L: any, index: number): any {
    const type = lua.lua_type(L, index)

    if (type === lua.LUA_TNIL) return null
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index)
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index)
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index))

    if (type === lua.LUA_TTABLE) {
      const result: any = {}
      let isArray = true
      let maxIdx = 0

      lua.lua_pushnil(L) // first key
      while (lua.lua_next(L, index < 0 ? index - 1 : index) !== 0) {
        const keyType = lua.lua_type(L, -2)
        let key: any

        if (keyType === lua.LUA_TNUMBER) {
          key = lua.lua_tonumber(L, -2)
          if (key <= 0 || !Number.isInteger(key)) isArray = false
          if (key > maxIdx) maxIdx = key
        } else {
          key = to_jsstring(lua.lua_tostring(L, -2))
          isArray = false
        }

        result[key] = this.luaTableToJS(L, -1)
        lua.lua_pop(L, 1) // remove value, keep key for next iteration
      }

      if (isArray && maxIdx > 0) {
        const arr = []
        for (let i = 1; i <= maxIdx; i++) {
          arr.push(result[i])
        }
        return arr
      }

      return result
    }

    return `[${lua.lua_typename(L, type)}]`
  }
}
