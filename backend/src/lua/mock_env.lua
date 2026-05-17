-- TraitorDash Mock GMod Environment for Schema Extraction

-- 1. Essential Globals
CLIENT = true
SERVER = true
GAME_DETAILS = {}
GAMEMODE = { name = "TTT2" }
_G = _G or {}

-- Create a protective proxy table that never returns nil and handles nil indexing
local function CreateProxy(name)
    local proxy = { __td_proxy = true, __name = name or "proxy" }
    local mt = {
        __index = function(t, k)
            if k == nil then return nil end
            -- Return a specialized proxy for common string fields to satisfy concatenation
            if k == "defaultTeam" or k == "name" or k == "abbr" then
                return "unknown"
            end
            return CreateProxy(k)
        end,
        __newindex = function(t, k, v)
            -- Ignore assignments to nil keys to prevent "table index is nil"
            if k == nil then return end
            rawset(t, k, v)
        end,
        __call = function() return CreateProxy() end,
        __tostring = function() return "proxy" end,
        __concat = function(a, b)
            return tostring(a) .. tostring(b)
        end
    }
    setmetatable(proxy, mt)
    return proxy
end

setmetatable(_G, {
    __index = function(t, k)
        -- If it's an uppercase string, it's likely a TTT2 Role/Team constant
        if type(k) == "string" and k:match("^[A-Z_%d]+$") then
            local role = {
                index = 100, -- Dummy index
                name = k:lower(),
                abbr = k:lower():sub(1, 4),
                color = Color(255, 255, 255),
                defaultTeam = "innocents"
            }
            -- Make the dummy role behave like a proxy too
            setmetatable(role, {
                __index = function(_, key)
                    if key == nil then return nil end
                    if key == "defaultTeam" or key == "name" or key == "abbr" then
                        return "unknown"
                    end
                    return CreateProxy(key)
                end
            })
            return role
        end
        return nil
    end
})

-- TTT2 Specific Constants (Engine values verified via API)
ROLE_INNOCENT = 0
ROLE_TRAITOR = 1
ROLE_DETECTIVE = 2
ROLE_CUPID = 9
ROLE_DEFECTOR = 10
ROLE_DEPUTY = 11
ROLE_HAUNTED = 12
ROLE_HITMAN = 13
ROLE_INFECTED = 14
ROLE_JACKAL = 15
ROLE_MEDIC = 16
ROLE_MESMERIST = 17
ROLE_NECROMANCER = 18
ROLE_RAT = 19
ROLE_REVOLUTIONARY = 20
ROLE_SHERIFF = 21
ROLE_SIDEKICK = 22
ROLE_SPECTRE = 23
ROLE_SPY = 24
ROLE_SURVIVALIST = 25
ROLE_SWAPPER = 26
ROLE_THRALL = 27
ROLE_VAMPIRE = 28
ROLE_ZOMBIE = 29
ROLE_NONE = 3

TEAM_INNOCENT = "innocents"
TEAM_TRAITOR = "traitors"
TEAM_NONE = "nones"
TEAM_NECROMANCER = "necromancers"
TEAM_JACKAL = "jackals"
TEAM_INFECTED = "infecteds"
TEAM_JESTER = "nones"

SHOP_FALLBACK_TRAITOR = "traitor"
SHOP_FALLBACK_INNOCENT = "innocent"
SHOP_FALLBACK_DETECTIVE = "detective"
SHOP_DISABLED = "DISABLED"

-- Common GMod Constants
FCVAR_NOTIFY = 256
FCVAR_ARCHIVE = 128
FCVAR_REPLICATED = 8192
FCVAR_SERVER_CAN_EXECUTE = 268435456
FCVAR_PROTECTED = 32
FCVAR_USERINFO = 512

SPECIAL_EQUIPMENT = 1
TRAITOR_EQUIPMENT = 2
ROLEINSPECT_REASON_LOW_PROPORTION = "roleinspect_reason_low_proportion"

-- 2. Mock GMod Primitives
function Color(r, g, b, a) return { r = r, g = g, b = b, a = a } end
function Vector(x, y, z) return { x = x, y = y, z = z } end
function Angle(p, y, r) return { p = p, y = y, r = r } end
function include(f) end
function AddCSLuaFile(f) end
function FindMetaTable(n) return {} end
function Material(n) return {} end
function CreateConVar(n, v, f, d) return GetConVar(n) end
function Msg(...) end
function MsgN(...) end
function MsgC(...) end
function print(...) end
function ErrorNoHalt(...) end
function __td_continue() end

-- 3. Mock ConVar Handling
__TD_CONVAR_STATE = __TD_CONVAR_STATE or {}

local convar_mt = {
    __index = function(t, k)
        local name = rawget(t, "name")
        local val = __TD_CONVAR_STATE[name]

        if k == "GetString" then
            return function() return tostring(val or "") end
        elseif k == "GetInt" or k == "GetFloat" then
            return function() return tonumber(val) or 0 end
        elseif k == "GetBool" then
            return function() 
                if not val then return false end
                return val == "1" or val == "true" or val:lower() == "yes"
            end
        elseif k == "GetName" then
            return function() return name end
        elseif k == "GetDefault" then
            return function() return "" end
        end

        -- Fallback for other methods
        return function() return 0 end
    end
}

function GetConVar(name)
    local cv = { name = name }
    setmetatable(cv, convar_mt)
    return cv
end

cvars = {
    AddChangeCallback = function() end,
    Number = function() return 0 end,
    Bool = function() return false end,
    String = function() return "" end,
    OnConVarChanged = function() end
}

concommand = {
    Add = function() end,
    Remove = function() end,
    GetTable = function() return {} end,
    Run = function() end
}

-- 4. Localization Mock
__TD_LANGS = { en = {} }
LANG = {
    GetUnsafe = function(key) 
        if key == nil then return "" end
        return __TD_LANGS["en"][key] or key 
    end,
    TryTranslation = function(key) 
        if key == nil then return "" end
        return __TD_LANGS["en"][key] or key 
    end,
    GetTranslation = function(key) 
        if key == nil then return "" end
        return __TD_LANGS["en"][key] or key 
    end,
    AddToLanguage = function(l, k, v) 
        if l == nil or k == nil then return end
        __TD_LANGS[l] = __TD_LANGS[l] or {}
        __TD_LANGS[l][k] = v
    end,
    GetLanguageTableReference = function(l)
        if l == nil then return CreateProxy() end
        __TD_LANGS[l] = __TD_LANGS[l] or {}
        return __TD_LANGS[l]
    end,
}

-- 5. Library Stubs
__TD_HOOKS = {}
hook = { 
    Add = function(ev, id, cb) 
        __TD_HOOKS[ev] = __TD_HOOKS[ev] or {}
        __TD_HOOKS[ev][id] = cb
    end, 
    Run = function() end, 
    Remove = function() end 
}

net = { 
    Receive = function() end, 
    Start = function() end, 
    SendToServer = function() end, 
    WriteString = function() end, 
    ReadString = function() end, 
    WriteInt = function() end, 
    ReadInt = function() end, 
    WriteBool = function() end, 
    ReadBool = function() end, 
    WriteTable = function() end, 
    ReadTable = function() end, 
    WriteEntity = function() end, 
    ReadEntity = function() end, 
    Send = function() end, 
    Broadcast = function() end 
}

util = { 
    TableToJSON = function() return "{}" end, 
    JSONToTable = function() return {} end, 
    CRC = function() return "0" end, 
    IsBinary = function() return false end,
    AddNetworkString = function() end
}

file = { 
    Read = function() return "" end, 
    Exists = function() return false end, 
    Find = function() return {}, {} end, 
    Write = function() end, 
    Append = function() end, 
    Delete = function() end, 
    Time = function() return 0 end, 
    Size = function() return 0 end 
}

resource = { 
    AddFile = function() end, 
    AddWorkshop = function() end, 
    AddSingleFile = function() end 
}

timer = { 
    Simple = function() end, 
    Create = function() end, 
    Remove = function() end, 
    Exists = function() return false end, 
    Pause = function() end, 
    UnPause = function() end, 
    Start = function() end, 
    Stop = function() end, 
    Check = function() end, 
    Toggle = function() end 
}

table.count = function(t)
    local c = 0
    for _ in pairs(t) do c = c + 1 end
    return c
end

-- UI & Rendering Mocks
vgui = { 
    Create = function() return CreateSpyParent() end, 
    Register = function() end,
    CreateTTT2Form = function(parent, label)
        -- Return the parent (which is a spy) so we can chain Make* calls
        return parent or CreateSpyParent()
    end
}
surface = { SetFont = function() end, GetTextSize = function() return 0, 0 end, SetDrawColor = function() end, DrawRect = function() end, SetMaterial = function() end, DrawTexturedRect = function() end, PlaySound = function() end }
draw = { SimpleText = function() end, RoundedBox = function() end, Text = function() end, TextShadow = function() end }
language = { Add = function() end, GetPhrase = function(k) return k end }
derma = { DefineControl = function() end, GetControlList = function() return {} end }
markup = { Parse = function() return { Draw = function() end, GetWidth = function() return 0 end, GetHeight = function() return 0 end } end }

-- TTT2 Specific
TTT2 = {
    DATA = { Set = function() end, Get = function() end },
    Loaded = true,
    isocline = { AddRole = function() end }
}

PIGEON = { Enable = function() end, Disable = function() end }

-- 6. The ROLE Object
ROLE = {
    AddToSettingsMenu = function(self, parent) end,
    name = "unknown",
    index = 0,
    abbr = "unk",
    color = Color(255, 255, 255),
    defaultTeam = "innocents",
    score = CreateProxy("score")
}
setmetatable(ROLE, {
    __index = function(t, k)
        if k == nil then return nil end
        return CreateProxy(k)
    end
})
_G.ROLE = ROLE

roles = { 
    GetByName = function() return ROLE end, 
    GetList = function() return { ROLE } end, 
    GetByIndex = function() return ROLE end,
    GetByAbbreviation = function() return ROLE end,
    SetBaseRole = function(role, base)
      if role == ROLE then
        if type(base) == "number" then
          role.baserole = base
        elseif type(base) == "table" and base.index then
          role.baserole = base.index
        end
      end
    end,
    InitCustomTeam = function() end
}
setmetatable(roles, {
    __index = function(t, k)
        if k == nil then return nil end
        return CreateProxy(k)
    end
})

-- 7. The Extraction Logic
__TRAITORDASH_SCHEMA = {}

local function resolveTranslation(label)
    if type(label) ~= "string" or label == nil then return label end
    if __TD_LANGS["en"][label] then
        return __TD_LANGS["en"][label]
    end
    -- If it starts with label_, header_, or ttt2_, mark it as missing
    if label:match("^label_") or label:match("^header_") or label:match("^ttt2_") then
        return "[" .. label .. "]"
    end
    return label
end

local spy_mt = {
    __index = function(t, k)
        if type(k) == "string" and (k:sub(1, 4) == "Make" or k == "AddControl") then
            return function(self, args)
                if args and args.label then
                    args.label = resolveTranslation(args.label)
                end
                table.insert(__TRAITORDASH_SCHEMA, {
                    type = k,
                    args = args or {}
                })
            end
        end
        return function() end
    end
}

function CreateSpyParent()
    local spy = {}
    setmetatable(spy, spy_mt)
    return spy
end
