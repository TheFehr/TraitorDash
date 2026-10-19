-- TraitorDash: measure a map's floors with traces (prototype, for the round replay idea).
--
--   traitordash_mapscan [cell]     superadmin or console; cell = grid size in units (default 64)
--
-- Walks a grid over the world's bounds and, for every cell, fires traces straight down to find
-- the surfaces a player could stand on (72 units of headroom), or crouch on (36), which are marked. Nothing needs a client, a bot
-- or an admin. The result goes to data/traitordash/mapscan_<map>.json; `tools/render-mapscan.ts`
-- turns it into a picture so the quality can be judged. The work is spread over server ticks.
--
-- ScanColumn and the scanner only talk to a "tracer" (start, end -> trace result), so they are
-- tested against a fake world; the command wires in the real util.TraceLine.

TraitorDash = TraitorDash or {}

local HEADROOM = 72       -- a standing player
local CROUCH_HEADROOM = 36 -- a crouching player: less than this is not passable at all
local MAX_FLOORS = 8      -- per column; more than this is not a floor plan any more
local MAX_TRACES = 40     -- per column: a guard against a tracer that never makes progress
local DEFAULT_CELL = 64
local MAX_CELLS = 250000
local BUDGET = 0.003      -- seconds of work per tick
local STEP = 48           -- the biggest height change between neighbouring cells that is still walkable
local WALL_HEIGHT = 20    -- a wall between two cells is looked for this far above the higher floor
local SEED_TOLERANCE = 128 -- a spawn point must be this close (in height) to a floor to start from it
local SPAWN_CLASSES = { "info_player_start", "info_player_deathmatch", "info_player_terrorist",
    "info_player_counterterrorist", "info_player_combine", "info_player_rebel", "info_player_teamspawn" }

--- The heights (ascending) a player could stand at in the column (x, y), scanning down from
--- ztop to zbottom, how many traces that took, and which of those heights have room only for a
--- crouching player (a set: crouch[z] = true).
function TraitorDash.ScanColumn(x, y, ztop, zbottom, tracer)
    local floors, traces, crouch = {}, 0, {}
    local z = ztop

    while z > zbottom and #floors < MAX_FLOORS and traces < MAX_TRACES do
        local tr = tracer(Vector(x, y, z), Vector(x, y, zbottom))
        traces = traces + 1

        if tr.StartSolid then
            -- Inside something solid: carry on below the point where the trace left it.
            local left = z - (z - zbottom) * (tr.FractionLeftSolid or 0)
            z = math.min(left, z - 1)
        elseif not tr.Hit then
            break
        else
            local top = tr.HitPos.z
            if not tr.HitSky then
                local up = tracer(Vector(x, y, top + 1), Vector(x, y, top + HEADROOM))
                traces = traces + 1
                -- One probe tells the three cases apart: nothing within 72 units (stand), a
                -- ceiling at 36 or more (crouch), or lower / already inside solid (no floor).
                if not up.StartSolid then
                    local clearance = up.Hit and (up.HitPos.z - top) or HEADROOM
                    if clearance >= CROUCH_HEADROOM then
                        local height = math.floor(top + 0.5)
                        floors[#floors + 1] = height
                        if clearance < HEADROOM then crouch[height] = true end
                    end
                end
            end
            z = top - 1 -- into the slab we stood on; the next pass leaves it
        end
    end

    table.sort(floors)
    return floors, traces, crouch
end

local Scan = {}
Scan.__index = Scan

--- cfg: map, cell, mins/maxs ({x,y,z}), tracer, clock (default SysTime)
function TraitorDash.NewMapScan(cfg)
    local cell = cfg.cell
    local self = setmetatable({}, Scan)
    self.cfg = cfg
    self.tracer = cfg.tracer
    self.clock = cfg.clock or SysTime
    self.nx = math.ceil((cfg.maxs.x - cfg.mins.x) / cell)
    self.ny = math.ceil((cfg.maxs.y - cfg.mins.y) / cell)
    self.i, self.j = 0, 0 -- next cell
    self.rows, self.row = {}, {}
    self.traces = 0
    self.histogram = { [0] = 0, 0, 0, 0 } -- cells with 0, 1, 2, 3 or more floors
    self.crouchFloors = 0
    return self
end

function Scan:Progress()
    return (self.j * self.nx + self.i) / (self.nx * self.ny)
end

--- Scans cells until `budget` seconds have passed; true once the whole grid is done.
function Scan:Step(budget)
    local cfg, started = self.cfg, self.clock()
    while self.j < self.ny do
        local x = cfg.mins.x + (self.i + 0.5) * cfg.cell
        local y = cfg.mins.y + (self.j + 0.5) * cfg.cell
        local floors, used, crouch = TraitorDash.ScanColumn(x, y, cfg.maxs.z, cfg.mins.z, function(a, b) return self.tracer(a, b) end)
        self.traces = self.traces + used
        local parts = {}
        for n, z in ipairs(floors) do
            -- "c" after a height: room only for a crouching player
            parts[n] = crouch[z] and (z .. "c") or tostring(z)
            if crouch[z] then self.crouchFloors = self.crouchFloors + 1 end
        end
        self.row[#self.row + 1] = table.concat(parts, ",")
        local h = math.min(#floors, 3)
        self.histogram[h] = self.histogram[h] + 1

        self.i = self.i + 1
        if self.i >= self.nx then
            self.rows[#self.rows + 1] = table.concat(self.row, "|")
            self.row, self.i, self.j = {}, 0, self.j + 1
        end
        if self.clock() - started >= budget then break end
    end
    return self.j >= self.ny
end

function Scan:Status() return math.floor(self:Progress() * 100) .. "%" end

function Scan:Result()
    local cfg = self.cfg
    return {
        map = cfg.map, cell = cfg.cell, minx = cfg.mins.x, miny = cfg.mins.y,
        nx = self.nx, ny = self.ny, zmin = cfg.mins.z, zmax = cfg.maxs.z,
        mode = "full", traces = self.traces, crouchFloors = self.crouchFloors, rows = self.rows,
    }
end

-- ---- the reachable scan: a flood fill from the spawn points -------------------------------------
--
-- Only cells a player can walk to are scanned: from every spawn, step to a neighbouring cell
-- (4 directions) whose floor is within STEP of the current one and with no wall in between. That
-- leaves out the skybox, the tops of ceilings, voids under floors and decoration, and costs a
-- fraction of the full grid. A "floor" is a (cell, height) pair, so a cell with two storeys is
-- visited once per storey.

local Reach = {}
Reach.__index = Reach

--- cfg: like NewMapScan, plus spawns = { { x, y, z }, ... }
function TraitorDash.NewReachScan(cfg)
    local self = setmetatable({}, Reach)
    self.cfg = cfg
    self.tracer = cfg.tracer
    self.clock = cfg.clock or SysTime
    self.nx = math.ceil((cfg.maxs.x - cfg.mins.x) / cfg.cell)
    self.ny = math.ceil((cfg.maxs.y - cfg.mins.y) / cfg.cell)
    self.columns, self.columnCount = {}, 0 -- cell -> { floors, crouch, x, y }
    self.visited, self.nodes, self.head = {}, {}, 1
    self.traces, self.seeds = 0, 0
    for _, spawn in ipairs(cfg.spawns or {}) do self:Seed(spawn) end
    return self
end

function Reach:Column(i, j, x, y)
    local key = j * self.nx + i
    local column = self.columns[key]
    if column then return column end

    local cfg = self.cfg
    x = x or cfg.mins.x + (i + 0.5) * cfg.cell
    y = y or cfg.mins.y + (j + 0.5) * cfg.cell
    local floors, used, crouch = TraitorDash.ScanColumn(x, y, cfg.maxs.z, cfg.mins.z, function(a, b) return self.tracer(a, b) end)
    self.traces = self.traces + used
    column = { floors = floors, crouch = crouch, x = x, y = y }
    self.columns[key] = column
    self.columnCount = self.columnCount + 1
    return column
end

function Reach:Visit(i, j, z)
    local key = (j * self.nx + i) .. ":" .. z
    if self.visited[key] then return false end
    self.visited[key] = true
    self.nodes[#self.nodes + 1] = { i = i, j = j, z = z }
    return true
end

--- Starts from the floor nearest to the spawn point, if there is one close enough.
function Reach:Seed(spawn)
    local cfg = self.cfg
    local i = math.floor((spawn.x - cfg.mins.x) / cfg.cell)
    local j = math.floor((spawn.y - cfg.mins.y) / cfg.cell)
    if i < 0 or j < 0 or i >= self.nx or j >= self.ny then return end

    local column = self:Column(i, j, spawn.x, spawn.y)
    local best
    for _, z in ipairs(column.floors) do
        if not best or math.abs(z - spawn.z) < math.abs(best - spawn.z) then best = z end
    end
    if best and math.abs(best - spawn.z) <= SEED_TOLERANCE and self:Visit(i, j, best) then
        self.seeds = self.seeds + 1
    end
end

local NEIGHBOURS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

function Reach:Expand(node)
    local from = self.columns[node.j * self.nx + node.i]
    for _, d in ipairs(NEIGHBOURS) do
        local ni, nj = node.i + d[1], node.j + d[2]
        if ni >= 0 and nj >= 0 and ni < self.nx and nj < self.ny then
            local to = self:Column(ni, nj)
            for _, z in ipairs(to.floors) do
                if math.abs(z - node.z) <= STEP and not self.visited[(nj * self.nx + ni) .. ":" .. z] then
                    local height = math.max(z, node.z) + WALL_HEIGHT
                    local tr = self.tracer(Vector(from.x, from.y, height), Vector(to.x, to.y, height))
                    self.traces = self.traces + 1
                    if not tr.Hit and not tr.StartSolid then self:Visit(ni, nj, z) end
                end
            end
        end
    end
end

--- Works through the queue until `budget` seconds have passed; true once nothing is left.
function Reach:Step(budget)
    local started = self.clock()
    while self.head <= #self.nodes do
        self:Expand(self.nodes[self.head])
        self.head = self.head + 1
        if self.clock() - started >= budget then break end
    end
    return self.head > #self.nodes
end

function Reach:Status() return #self.nodes .. " floor cells so far" end

function Reach:Result()
    local cfg, cells, crouchFloors = self.cfg, {}, 0
    for _, n in ipairs(self.nodes) do
        local key = n.j * self.nx + n.i
        cells[key] = cells[key] or {}
        table.insert(cells[key], n.z)
    end

    local rows = {}
    for j = 0, self.ny - 1 do
        local row = {}
        for i = 0, self.nx - 1 do
            local key = j * self.nx + i
            local list, parts = cells[key], {}
            if list then
                table.sort(list)
                for n, z in ipairs(list) do
                    local crouch = self.columns[key].crouch[z]
                    parts[n] = crouch and (z .. "c") or tostring(z)
                    if crouch then crouchFloors = crouchFloors + 1 end
                end
            end
            row[#row + 1] = table.concat(parts, ",")
        end
        rows[#rows + 1] = table.concat(row, "|")
    end

    return {
        mode = "reach", map = cfg.map, cell = cfg.cell, minx = cfg.mins.x, miny = cfg.mins.y,
        nx = self.nx, ny = self.ny, zmin = cfg.mins.z, zmax = cfg.maxs.z,
        traces = self.traces, columns = self.columnCount, seeds = self.seeds,
        floorCells = #self.nodes, crouchFloors = crouchFloors, rows = rows,
    }
end

-- ---- the console command --------------------------------------------------------------------

local function Say(msg) print("[TraitorDash] " .. msg) end

local active -- the scan in progress

local function WorldBounds()
    local ok, mins, maxs = pcall(function() return game.GetWorld():GetModelBounds() end)
    if ok and mins and maxs and maxs.x > mins.x and maxs.y > mins.y then return mins, maxs end
    return Vector(-16384, -16384, -16384), Vector(16384, 16384, 16384)
end

local function WorldTracer(a, b)
    return util.TraceLine({ start = a, endpos = b, mask = MASK_PLAYERSOLID_BRUSHONLY })
end

local function Spawns()
    local list = {}
    for _, class in ipairs(SPAWN_CLASSES) do
        for _, ent in ipairs(ents.FindByClass(class)) do
            local p = ent:GetPos()
            list[#list + 1] = { x = p.x, y = p.y, z = p.z }
        end
    end
    return list
end

local function Finish(scan, timing)
    hook.Remove("Think", "TraitorDash_MapScan")
    active = nil
    local result = scan:Result()
    result.seconds, result.ticks, result.maxSliceMs = timing.total, timing.ticks, timing.slowest * 1000
    local path = "traitordash/mapscan_" .. tostring(result.map):gsub("[^%w_%-]", "_") .. ".json"
    file.CreateDir("traitordash")
    file.Write(path, util.TableToJSON(result))
    local saved = file.Exists(path, "DATA") and "written" or "NOT written"

    local what
    if result.mode == "reach" then
        what = string.format("%d floor cells from %d spawn points, %d columns", result.floorCells, result.seeds, result.columns)
    else
        local h = scan.histogram
        what = string.format("cells with 0/1/2/3+ floors: %d/%d/%d/%d", h[0], h[1], h[2], h[3])
    end
    Say(string.format("Map scan done in %.1f s over %d ticks (slowest tick %.1f ms): %s, %d traces, %d crouch-only floors. data/%s %s.",
        result.seconds, result.ticks, result.maxSliceMs, what, result.traces, result.crouchFloors, path, saved))
end

concommand.Add("traitordash_mapscan", function(ply, _, args)
    if IsValid(ply) and not ply:IsSuperAdmin() then return end
    if active then Say("A map scan is already running (" .. active:Status() .. ").") return end

    local cell, full = DEFAULT_CELL, false
    for _, arg in ipairs(args or {}) do
        if arg == "full" then full = true else cell = tonumber(arg) or cell end
    end
    cell = math.Clamp(cell, 16, 512)

    local mins, maxs = WorldBounds()
    local cells = math.ceil((maxs.x - mins.x) / cell) * math.ceil((maxs.y - mins.y) / cell)
    if cells > MAX_CELLS then
        Say(string.format("That is too many cells (%d, the limit is %d). Use a larger cell size, e.g. traitordash_mapscan %d.",
            cells, MAX_CELLS, cell * 2))
        return
    end

    local cfg = { map = game.GetMap(), cell = cell, mins = mins, maxs = maxs, tracer = WorldTracer }
    local scan
    if full then
        scan = TraitorDash.NewMapScan(cfg)
        Say(string.format("Scanning %s, the whole grid: %d cells of %d units.", game.GetMap(), cells, cell))
    else
        cfg.spawns = Spawns()
        if #cfg.spawns == 0 then
            Say("No spawn points found on this map. Use traitordash_mapscan " .. cell .. " full to scan the whole grid instead.")
            return
        end
        scan = TraitorDash.NewReachScan(cfg)
        if scan.seeds == 0 then
            Say("None of the " .. #cfg.spawns .. " spawn points is over a floor the scan can start from. Try traitordash_mapscan " .. cell .. " full.")
            return
        end
        Say(string.format("Scanning %s from %d spawn points: cells of %d units.", game.GetMap(), scan.seeds, cell))
    end
    active = scan

    local timing = { total = 0, ticks = 0, slowest = 0 }
    local nextReport = SysTime() + 5
    hook.Add("Think", "TraitorDash_MapScan", function()
        if active ~= scan then return end
        local t0 = SysTime()
        local done = scan:Step(BUDGET)
        local took = SysTime() - t0
        timing.total, timing.ticks, timing.slowest = timing.total + took, timing.ticks + 1, math.max(timing.slowest, took)
        if done then Finish(scan, timing) return end
        if SysTime() >= nextReport then
            Say("Scan: " .. scan:Status())
            nextReport = SysTime() + 5
        end
    end)
end)
