import { expect, test, describe } from 'bun:test'
import { run } from './helpers/bridge_harness'

// The bridge sends the role-to-addon list to /api/v1/roleaddons after a sync.
const lua = (body: string) => run(`util.TableToJSON = function(t) LAST_PAYLOAD = t return "{json}" end\n${body}`).result

describe('TraitorDash.PushRoleAddons', () => {
  const found = `TraitorDash.FindRoleAddons = function() return { roles = {
    arsonist = { { wsid = "111", title = "Arsonist" } },
    pyro = { { wsid = "111", title = "Arsonist" }, { wsid = "222", title = "Other" } },
  } } end`

  test('posts the list to /api/v1/roleaddons with the token, a timeout and JSON', () => {
    const r = lua(`${found} TraitorDash.PushRoleAddons()
      local q = SENT[1]
      RESULT = q.method .. "|" .. q.url .. "|" .. q.headers.Authorization .. "|" .. q.headers["Content-Type"] .. "|" .. tostring(q.timeout) .. "|" .. q.body`)
    expect(r).toBe('POST|https://td.test/api/v1/roleaddons|Bearer tok|application/json|30|{json}')
  })
  test('carries each role with its addons, and nothing else', () => {
    const r = lua(`${found} TraitorDash.PushRoleAddons()
      local p = LAST_PAYLOAD
      RESULT = #p.roles.arsonist .. "|" .. p.roles.arsonist[1].wsid .. "|" .. #p.roles.pyro .. "|" .. p.roles.pyro[2].title .. "|" .. tostring(p.roles.arsonist[1].file)`)
    expect(r).toBe('1|111|2|Other|nil')
  })
  test('at most 500 roles and 10 addons per role', () => {
    const r = lua(`TraitorDash.FindRoleAddons = function()
        local roles = {}
        for i = 1, 520 do roles["r" .. i] = { { wsid = "1", title = "t" } } end
        local many = {} for i = 1, 14 do many[i] = { wsid = tostring(i), title = "t" } end
        roles.r1 = many
        return { roles = roles }
      end
      TraitorDash.PushRoleAddons()
      local n = 0 for _ in pairs(LAST_PAYLOAD.roles) do n = n + 1 end
      RESULT = n`)
    expect(r).toBe('500')
  })
  test('one role with more than 10 addons sends 10', () => {
    expect(lua(`TraitorDash.FindRoleAddons = function()
        local many = {} for i = 1, 14 do many[i] = { wsid = tostring(i), title = "t" } end
        return { roles = { r = many } }
      end
      TraitorDash.PushRoleAddons()
      RESULT = #LAST_PAYLOAD.roles.r`)).toBe('10')
  })
  test('nothing is sent when no role was found, when it cannot be read, or without roleaddons.lua', () => {
    expect(lua(`TraitorDash.FindRoleAddons = function() return { roles = {} } end TraitorDash.PushRoleAddons() RESULT = #SENT`)).toBe('0')
    expect(lua(`TraitorDash.FindRoleAddons = function() error("boom") end TraitorDash.PushRoleAddons() RESULT = #SENT`)).toBe('0')
    expect(lua(`TraitorDash.FindRoleAddons = nil TraitorDash.PushRoleAddons() RESULT = #SENT`)).toBe('0')
  })
})
