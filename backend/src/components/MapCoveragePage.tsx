import { PageHead, Shell } from './CaseFile'
import type { Ctx } from './kit'
import { COVERAGE, lookup, type CoverageRecord, type Status } from '../maps/coverage'
import { flagSetStatus, sizeText, worldFacesByStatus, type CoverageReport, type MapRow } from '../services/coveragereport'

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

export interface MapCoveragePageProps { ctx: Ctx, server: { id: string, name: string }, report: CoverageReport }

export const MapCoveragePage = ({ ctx, server, report }: MapCoveragePageProps) => {
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
