import { PageHead, Shell } from './CaseFile'
import type { Ctx } from './kit'
import { COVERAGE, lookup, type CoverageRecord, type Status } from '../maps/coverage'
import { flagSetStatus, sizeText, worldFacesByStatus, type CoverageReport, type MapRow } from '../services/coveragereport'
import type { WorkshopStatus, AddonRow } from '../services/workshopStore'

// RFC 32, 5: what the 3D pipeline draws of the maps of a server, ignores on purpose and misses, counted from the coverage record each map's mesh carries.
// An admin's page: a maintenance tool, not a statistic for visitors. The look is the case-file card of every page, with the tables of the stats pages.

const STATUS_ORDER: Status[] = ['drawn', 'invisible', 'gap', 'not read', 'unknown']
const STATUS_HELP: Record<Status, string> = {
  drawn: 'the 3D view draws it',
  invisible: 'not drawn, and nothing is lost: a player never sees it',
  gap: 'a player sees it and the 3D view does not draw it',
  'not read': 'a part of the file the pipeline does not read',
  unknown: 'in a map and not in the registry: a task',
}
const n = (v: number) => v.toLocaleString('en-US')

const Status_ = ({ status }: { status: Status }) => <i class={`pill ${status === 'gap' || status === 'unknown' ? 'wait' : status === 'drawn' ? 'ok' : 'mute'}`} data-status={status}>{status}</i>

/** The record of one map as small tables: what the page's totals are made of. */
const RecordTables = ({ r }: { r: CoverageRecord }) => {
  const world = worldFacesByStatus(r)
  return (
    <>
      <p class="sp2"><b>World faces by flags</b> ({n(r.worldFaces)} in all; drawn {n(world.drawn)}, invisible {n(world.invisible)}, gap {n(world.gap)}, unknown {n(world.unknown)})</p>
      <div class="scrollx"><table class="set" data-record-flags>
        <tr><th>Flags</th><th>Faces</th><th>Status</th></tr>
        {Object.entries(r.flags).sort((a, b) => b[1] - a[1]).map(([set, count]) => <tr><td>{set}</td><td class="v">{n(count)}</td><td><Status_ status={flagSetStatus(set)} /></td></tr>)}
      </table></div>
      <p class="sp2"><b>World faces by what became of them</b></p>
      <div class="scrollx"><table class="set" data-record-outcome>
        {Object.entries(r.outcome).map(([k, count]) => <tr><td>{k}</td><td class="v">{n(count)}</td></tr>)}
      </table></div>
      <p class="sp2"><b>Brush entities by class</b>{r.brushOther ? ` (${r.brushOther.classes} more classes: ${n(r.brushOther.entities)} entities, ${n(r.brushOther.faces)} faces, not listed)` : ''}</p>
      <div class="scrollx"><table class="set" data-record-brush>
        <tr><th>Class</th><th>Entities</th><th>Faces</th><th>Status</th></tr>
        {r.brush.map(b => (
          <tr>
            <td>{b.class}</td><td class="v">{n(b.entities)}</td>
            <td class="v">{n(b.faces)}{b.parentedFaces ? <span class="d"> ({n(b.parentedFaces)} of a parented entity, not drawn)</span> : null}</td>
            <td><Status_ status={lookup('class', b.class).status} /></td>
          </tr>
        ))}
      </table></div>
      <p class="sp2"><b>Point entities</b>, the {r.points.length} most numerous classes{r.pointsOther ? ` (${r.pointsOther.classes} more classes, ${n(r.pointsOther.entities)} entities)` : ''}</p>
      <div class="scrollx"><table class="set" data-record-points>
        {r.points.map(p => <tr><td>{p.class}</td><td class="v">{n(p.count)}</td></tr>)}
      </table></div>
      <p class="sp2"><b>Parts of the file that are not read</b></p>
      <div class="scrollx"><table class="set" data-record-lumps>
        <tr><td>lighting</td><td class="v">{sizeText(r.lumps.lighting)}</td></tr>
        <tr><td>overlays</td><td class="v">{sizeText(r.lumps.overlays)}</td></tr>
        <tr><td>cubemaps</td><td class="v">{sizeText(r.lumps.cubemaps)}</td></tr>
        <tr><td>visibility</td><td class="v">{sizeText(r.lumps.visibility)}</td></tr>
        <tr><td>game lump (static props, detail props)</td><td class="v">{sizeText(r.lumps.gameLump)}</td></tr>
        <tr><td>pak file (embedded content)</td><td class="v">{sizeText(r.lumps.pakfile)}</td></tr>
      </table></div>
    </>
  )
}

const MapState = ({ row }: { row: MapRow }) => row.record ? <span class="d">record</span> : <i class="pill mute" data-no-record>{row.state === 'parsed' ? 'no record yet' : `3D ${row.state}`}</i>

/** What the "Workshop content" card shows (RFC 40, 5). */
export interface WorkshopPanel {
  collection: string
  status: WorkshopStatus
  state: { running: boolean, current: { kind: 'index' | 'model' | 'list', id: string } | null }
  failed: AddonRow[]
  /** What the last look at the collection left out or could not read. */
  notes: string[]
  collectionSize: number
  checkedAt: number | null
  /** The addons this server mounts and those of them that are not in the collection; null when no bridge has reported the list yet. */
  mounted: { count: number, notInCollection: string[] } | null
}

const when = (s: number) => new Date(s * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Zurich', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const dur = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`)

/** The Workshop collection as a content source (RFC 40): the list, the index, the models. Admin side of the coverage page; every row is always there, so the card does not change height when numbers do. */
export const WorkshopCard = ({ w, serverId, modelNote }: { w: WorkshopPanel, serverId: string, modelNote?: string }) => {
  const s = w.status
  const run = w.state.running ? (w.state.current ? `running: ${w.state.current.kind === 'list' ? 'reading the collection' : `${w.state.current.kind === 'index' ? 'indexing addon' : 'building'} ${w.state.current.id}`}` : 'running') : 'idle'
  const base = `/servers/${serverId}/workshop-content`
  return (
    <div class="f c-violet" id="workshop-content" data-workshop-card>
      <h2 class="ft">Workshop content</h2>
      <div class="scrollx">
        <table class="set" data-workshop-numbers>
          <tr><td>Collection</td><td class="v" data-w="collection">{w.collection}</td></tr>
          <tr><td>Addons in the collection</td><td class="v" data-w="listed">{n(w.collectionSize)}{w.checkedAt ? <span class="d"> (read {when(w.checkedAt)})</span> : <span class="d"> (not read yet)</span>}</td></tr>
          <tr><td>Indexed</td><td class="v" data-w="indexed">{n(s.indexed)}</td></tr>
          <tr><td>Pending</td><td class="v" data-w="pending">{n(s.pending)}</td></tr>
          <tr><td>Failed</td><td class="v" data-w="failed">{n(s.failed)}</td></tr>
          <tr><td>Downloaded for the index</td><td class="v" data-w="bytes">{sizeText(s.bytes)}</td></tr>
          <tr><td>Rows in the database</td><td class="v" data-w="rows">{n(s.files)} paths, {n(s.dirs)} directory counts (about {sizeText(s.rowBytes)})</td></tr>
          <tr><td>Models built</td><td class="v" data-w="built">{n(s.models.built)}</td></tr>
          <tr><td>Models queued</td><td class="v" data-w="queued">{n(s.models.queued + s.models.building)}<span class="d"> ({n(s.models.failed)} failed, {n(s.models.unknown)} not in the index yet)</span></td></tr>
          <tr><td>Last run</td><td class="v" data-w="lastrun">{s.lastRun ? `${when(s.lastRun.at)}, ${dur(s.lastRun.seconds)}: ${n(s.lastRun.indexed)} indexed, ${n(s.lastRun.failed)} failed, ${sizeText(s.lastRun.bytes)} downloaded${s.lastRun.note ? ` (${s.lastRun.note})` : ''}` : 'none yet'}</td></tr>
          <tr><td>Queue</td><td class="v" data-w="state">{run}</td></tr>
          <tr><td>Mounted, not in the collection</td><td class="v" data-w="mounted">{w.mounted ? `${n(w.mounted.notInCollection.length)} of ${n(w.mounted.count)} mounted${w.mounted.notInCollection.length ? `: ${w.mounted.notInCollection.slice(0, 12).join(', ')}${w.mounted.notInCollection.length > 12 ? ', ...' : ''}` : ''}` : 'the bridge has not reported its addons yet'}</td></tr>
        </table>
      </div>
      <div class="actions" data-workshop-actions>
        <form method="post" action={`${base}/run`} class="inline"><button type="submit" class="btn">Run now</button></form>
        {' '}
        <form method="post" action={`${base}/retry`} class="inline"><button type="submit" class="btn">Retry failed</button></form>
      </div>
      <form method="post" action={`${base}/model`} class="inline" data-workshop-model>
        <label>Build a model <input type="text" name="path" placeholder="models/weapons/w_example.mdl" maxlength={300} size={40} autocomplete="off" /></label>
        {' '}<button type="submit" class="btn">Queue</button>
        {modelNote ? <span class="d" data-workshop-model-note> {modelNote === 'queued' ? 'queued' : 'not queued (not a model path, or already queued or built)'}</span> : null}
      </form>
      {w.notes.length ? <ul class="foot dark" data-workshop-notes>{w.notes.map(t => <li>{t}</li>)}</ul> : null}
      {w.failed.length ? (
        <div class="scrollx">
          <table class="log" data-workshop-failed>
            <tr><th>Failed addon</th><th>Title</th><th>Why</th></tr>
            {w.failed.map(f => <tr data-failed-addon={f.id}><td>{f.id}</td><td>{f.title ?? '–'}</td><td class="d">{f.error ?? '–'}</td></tr>)}
          </table>
        </div>
      ) : null}
      <p class="foot dark">RFC 40. The addons of the server's Workshop collection are indexed (which models and materials each holds) in the background, one at a time, at start and every night; a model that a map needs is built from its addon when asked for. The numbers above are the first measurement of the index: nothing is decided from them yet.</p>
    </div>
  )
}

export interface MapCoveragePageProps { ctx: Ctx, server: { id: string, name: string }, report: CoverageReport, workshop?: WorkshopPanel, modelNote?: string }

export const MapCoveragePage = ({ ctx, server, report, workshop, modelNote }: MapCoveragePageProps) => {
  const id = server.id
  const mapHref = (m: string) => `/servers/${id}/maps/${encodeURIComponent(m)}`
  const anyRecord = report.withRecord > 0
  const features: [string, string, string][] = COVERAGE.filter(e => e.kind === 'feature' && e.status === 'not read').map(e => {
    const f = report.pointFeatures[e.key] ?? 0
    const size = e.key === 'lighting' ? sizeText(report.lumps.lighting) : e.key === 'overlays' ? sizeText(report.lumps.overlays) : e.key === 'cubemaps' ? sizeText(report.lumps.cubemaps) : e.key === 'visibility' ? sizeText(report.lumps.visibility) : e.key === 'detail props' ? `inside the game lump, ${sizeText(report.lumps.gameLump)} with the static props` : ''
    const count = f > 0 ? `${n(f)} ${e.key === 'overlays' ? 'overlay entities' : e.key === 'cubemaps' ? 'cubemap entities' : 'entities'}` : ''
    return [e.key, [size, count].filter(Boolean).join(', ') || '–', e.note]
  })
  return (
    <Shell title={`Map coverage | ${server.name}`} embed={false} viewer={ctx.viewer}>
      <PageHead serverId={id} embed={false} admin current="maps" crumbs={<><a href={`/servers/${id}/maps`}>All maps</a> / Map coverage</>}>
        <h1>Map coverage</h1>
      </PageHead>
      <p class="foot dark" data-coverage-intro>
        What the 3D view draws of the maps of this server, ignores on purpose, and misses (RFC 32). It is counted when a map's 3D mesh is built, so a map has a record once it has been built again after the update.
        {' '}{report.withRecord} of {report.maps} {report.maps === 1 ? 'map has' : 'maps have'} one{report.without.length ? `; without a record: ${report.without.length}` : ''}.
      </p>
      <div class="stack">
        {workshop ? <WorkshopCard w={workshop} serverId={id} modelNote={modelNote} /> : null}
        <div class="f c-blue" data-coverage-totals>
          <h2 class="ft">Totals by status</h2>
          {anyRecord ? (
            <>
              <div class="scrollx">
                <table class="log">
                  <tr><th>Status</th><th>What it means</th><th class="r">World faces</th><th class="r">Brush entities</th><th class="r">Brush faces</th></tr>
                  {STATUS_ORDER.map(s => (
                    <tr data-status-row={s}>
                      <td><Status_ status={s} /></td><td class="d">{STATUS_HELP[s]}</td>
                      <td class="r">{n(report.totals[s].worldFaces)}</td><td class="r">{n(report.totals[s].brushEntities)}</td><td class="r">{n(report.totals[s].brushFaces)}</td>
                    </tr>
                  ))}
                </table>
              </div>
              <p class="foot dark">Over the {report.withRecord} {report.withRecord === 1 ? 'map' : 'maps'} with a record. A world face is counted once, by its flags (ceilings, which the view leaves out on purpose, count with the drawn). Brush entities count by the status of their class.</p>
            </>
          ) : <p class="none" data-no-records>No map has a record yet: it is made when a map's 3D mesh is built.</p>}
        </div>

        <div class="f c-red" data-coverage-gaps>
          <h2 class="ft">Gaps and unknowns, ranked</h2>
          {report.gaps.length === 0
            ? <p class="none" data-no-gaps>{anyRecord ? 'Nothing is a gap or unknown in the maps with a record.' : 'Nothing to rank yet.'}</p>
            : (
              <div class="scrollx">
                <table class="log" data-gaps>
                  <tr><th>Entry</th><th>Kind</th><th>Status</th><th class="r">Maps</th><th class="r">Faces</th><th class="r">Entities</th><th>Largest in</th></tr>
                  {report.gaps.map(g => (
                    <tr data-gap={`${g.kind}:${g.key}`}>
                      <td>{g.key}</td><td>{g.kind}</td><td><Status_ status={g.status} /></td>
                      <td class="r">{g.maps}</td><td class="r">{n(g.faces)}</td><td class="r">{g.kind === 'class' ? n(g.entities) : '–'}</td>
                      <td><a href={mapHref(g.top.map)}>{g.top.map}</a> ({n(g.top.faces)})</td>
                    </tr>
                  ))}
                </table>
              </div>
            )}
        </div>

        <div class="f c-violet" data-coverage-starts>
          <h2 class="ft">Where moving parts start</h2>
          {report.starts.withData === 0
            ? <p class="none" data-no-starts>{anyRecord ? 'No record has the start states yet: they are counted when a map\'s 3D mesh is built again.' : 'Nothing to count yet.'}</p>
            : (
              <>
                <div class="scrollx">
                  <table class="log" data-start-totals>
                    <tr><th>Doors, rotating doors and linear movers</th><th class="r">Start closed</th><th class="r">Start open, drawn</th><th class="r">Start open, not drawn</th></tr>
                    {Object.entries(report.starts.byClass).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([cls, c]) => (
                      <tr data-start-class={cls}><td>{cls}</td><td class="r">{n(c.closed)}</td><td class="r">{n(c.openPlaced)}</td><td class="r">{n(c.openLeftOut)}</td></tr>
                    ))}
                    <tr data-start-all><td><b>All</b></td><td class="r">{n(report.starts.totals.closed)}</td><td class="r">{n(report.starts.totals.openPlaced)}</td><td class="r">{n(report.starts.totals.openLeftOut)}</td></tr>
                  </table>
                </div>
                <p class="foot dark">Over the {report.starts.withData} {report.starts.withData === 1 ? 'map' : 'maps'} whose record has them (RFC 35). A rotating door that starts open is drawn at its open angle and a linear mover at its start position; a sliding door that starts open, and a part that cannot be placed with confidence, are not drawn (left out). A linear mover counts as open when its start position is above 0 ({n(report.starts.totals.startPositioned)} so far). Hidden and parented parts are not counted.</p>
                <div class="scrollx">
                  <table class="log" data-start-rows>
                    <tr><th>Map</th><th class="r">Closed</th><th class="r">Open, drawn</th><th class="r">Open, not drawn</th></tr>
                    {report.starts.rows.map(r => (
                      <tr data-start-row={r.map}><td><a href={mapHref(r.map)}>{r.map}</a></td><td class="r">{n(r.closed)}</td><td class="r">{n(r.openPlaced)}</td><td class="r">{n(r.openLeftOut)}</td></tr>
                    ))}
                  </table>
                </div>
              </>
            )}
        </div>

        <div class="f c-mint" data-coverage-templated>
          <h2 class="ft">Entities not in the world at round start</h2>
          {report.templated.withData === 0
            ? <p class="none" data-no-templated>{anyRecord ? 'No record has the template counts yet: they are counted when a map\'s 3D mesh is built again.' : 'Nothing to count yet.'}</p>
            : (
              <>
                <div class="scrollx">
                  <table class="log" data-templated-totals>
                    <tr><th>Named by a point_template</th><th class="r">Entities</th></tr>
                    {report.templated.byClass.map(c => (
                      <tr data-templated-class={c.class}><td>{c.class}</td><td class="r">{n(c.count)}</td></tr>
                    ))}
                    {report.templated.totals.otherEntities > 0 && <tr data-templated-other><td>other classes</td><td class="r">{n(report.templated.totals.otherEntities)}</td></tr>}
                    <tr data-templated-all><td><b>All</b></td><td class="r">{n(report.templated.totals.entities)}</td></tr>
                  </table>
                </div>
                <p class="foot dark">Over the {report.templated.withData} {report.templated.withData === 1 ? 'map' : 'maps'} whose record has them (RFC 37): {report.templated.totals.maps} of them {report.templated.totals.maps === 1 ? 'has' : 'have'} entities that a point_template names, {n(report.templated.totals.templates)} templates in all. {report.templated.totals.spawnedAtStart > 0 ? `${n(report.templated.totals.spawnedAtStart)} of those the map spawns itself when the round starts: their entities are in the world and are drawn. ` : ''}The game removes such an entity when the map starts and keeps it only as a model for copies, so the 3D view leaves it out (it is not drawn, not a prop, not a spawn). {report.templated.totals.keptAsParts > 0 ? `${n(report.templated.totals.keptAsParts)} of the entities left out are doors, lifts or physics boxes that the bridge records the copies of: their geometry stays in the mesh as a hidden part, for the replay to draw the copies. ` : ''}The maps are ranked by the entities left out.</p>
                <div class="scrollx">
                  <table class="log" data-templated-rows>
                    <tr><th>Map</th><th class="r">Templates</th><th class="r">Entities left out</th><th>Largest classes</th></tr>
                    {report.templated.rows.map(r => (
                      <tr data-templated-row={r.map}><td><a href={mapHref(r.map)}>{r.map}</a></td><td class="r">{n(r.templates)}</td><td class="r">{n(r.entities)}</td><td>{r.top.length ? r.top.map(c => `${c.class} ${n(c.count)}`).join(', ') : '–'}</td></tr>
                    ))}
                  </table>
                </div>
              </>
            )}
        </div>

        <div class="f c-blue" data-coverage-textures>
          <h2 class="ft">Textures</h2>
          {report.textures.withData === 0
            ? <p class="none" data-no-textures>{anyRecord ? 'No record has the texture counts yet: they are counted when a map\'s 3D mesh is built again.' : 'Nothing to count yet.'}</p>
            : (
              <>
                <div class="scrollx">
                  <table class="log" data-texture-totals>
                    <tr><th>Over the maps with a record</th><th class="r">Materials</th><th class="r">Textured</th><th class="r">Fallback</th><th class="r">PNG</th><th class="r">GLB</th></tr>
                    <tr data-texture-all><td><b>All</b></td><td class="r">{n(report.textures.totals.materials)}</td><td class="r">{n(report.textures.totals.textured)}</td><td class="r">{n(report.textures.totals.fallback)}</td><td class="r">{sizeText(report.textures.totals.pngBytes)}</td><td class="r">{sizeText(report.textures.totals.glbBytes)}</td></tr>
                  </table>
                </div>
                <p class="foot dark">Over the {report.textures.withData} {report.textures.withData === 1 ? 'map' : 'maps'} whose record has them (RFC 36). Every material the map names gets its own texture; a fallback is a material whose texture could not be had: {n(report.textures.totals.notFound)} not found, {n(report.textures.totals.notDecodable)} not decodable, {n(report.textures.totals.ceiling)} left out because a safety ceiling was reached (a ceiling that bites is a reason to load textures gradually, not a quality setting). The maps are ranked by the size of their mesh.</p>
                <div class="scrollx">
                  <table class="log" data-texture-rows>
                    <tr><th>Map</th><th class="r">Materials</th><th class="r">Textured</th><th class="r">Fallback</th><th class="r">PNG</th><th class="r">GLB</th></tr>
                    {report.textures.rows.map(r => (
                      <tr data-texture-row={r.map}><td><a href={mapHref(r.map)}>{r.map}</a></td><td class="r">{n(r.materials)}</td><td class="r">{n(r.textured)}</td><td class="r" title={`${r.notFound} not found, ${r.notDecodable} not decodable, ${r.ceiling} ceiling`}>{n(r.fallback)}</td><td class="r">{sizeText(r.pngBytes)}</td><td class="r">{sizeText(r.glbBytes)}</td></tr>
                    ))}
                  </table>
                </div>
              </>
            )}
        </div>

        <div class="f c-green" data-coverage-maps>
          <h2 class="ft">Maps</h2>
          {report.rows.length === 0 ? <p class="none">No map has had its 3D view asked for.</p> : (
            <>
              <div class="scrollx">
                <table class="log" data-map-rows>
                  <tr><th>Map</th><th class="r">Gap faces</th><th class="r">Gap entities</th><th class="r">Unknown</th><th>Record</th></tr>
                  {report.rows.map(r => (
                    <tr data-map-row={r.map}>
                      <td><a href={mapHref(r.map)}>{r.map}</a></td>
                      <td class="r">{r.record ? n(r.gapFaces) : '–'}</td><td class="r">{r.record ? n(r.gapEntities) : '–'}</td><td class="r">{r.record ? r.unknown : '–'}</td>
                      <td><MapState row={r} /></td>
                    </tr>
                  ))}
                </table>
              </div>
              {report.rows.filter(r => r.record).map(r => (
                <details data-record-of={r.map}>
                  <summary>{r.map}: the record</summary>
                  <RecordTables r={r.record!} />
                </details>
              ))}
            </>
          )}
        </div>

        <div class="f c-gray" data-coverage-notread>
          <h2 class="ft">Not read</h2>
          <div class="scrollx">
            <table class="set" data-notread>
              <tr><th>Part of the file</th><th>In the maps with a record</th><th>What drawing it would take</th></tr>
              {features.map(([key, what, note]) => <tr data-notread-row={key}><td>{key}</td><td class="v">{anyRecord ? what : '–'}</td><td class="d">{note}</td></tr>)}
            </table>
          </div>
        </div>
      </div>
    </Shell>
  )
}
