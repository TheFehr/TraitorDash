import { Sections, Shell } from './CaseFile'
import { Crumbs, Who, adminOf, link, type Ctx } from './kit'
import { duration } from '../format'
import { teamLabel } from '../teamColours'

// One round's replay (RFC 12, 3.5; RFC 17): the markup the browser code (replay.ts) finds its parts in,
// in the same look as the other pages. Everything it draws is in the canvas; the lists and the controls
// are filled in by that code, so a browser without WebGL still gets the lists.

export interface ReplayPageProps {
  ctx: Ctx
  server: { id: string, name: string }
  round: { id: string, map: string | null, result: string, duration: number | null }
  hasTrack: boolean
  /** The data URL, with the same `bots` choice as the page. */
  src: string
  pinned: boolean
  /** Where to come back to after pinning. */
  here: string
  pinnedCount?: { used: number, max: number }
  bots?: boolean
}

export const ReplayPage = ({ ctx, server, round, hasTrack, src, pinned, here, pinnedCount, bots }: ReplayPageProps) => {
  const id = server.id
  const admin = adminOf(ctx)
  const back = link(ctx, `/servers/${id}/rounds/${encodeURIComponent(round.id)}`, { bots })
  return (
    <Shell title={`Replay | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer} scripts={hasTrack ? ['/public/replay.js', ...(admin ? ['/public/confirm.js'] : [])] : []}>
      <Crumbs><a href={link(ctx, `/servers/${id}/stats`, { view: 'rounds', bots })}>Rounds</a> / <a href={back}>{round.map ?? 'Round'}</a> / Replay</Crumbs>
      {!ctx.embed && <Sections serverId={id} />}
      <h1>Round replay</h1>
      <p class="muted" style="margin:.1rem 0 .8rem">
        {round.map ?? 'unknown map'} · {teamLabel(round.result)} · {duration(round.duration)}
        {pinned && <span data-pinned class="pill ok" style="margin-left:.6rem">Pinned</span>}
      </p>

      {!hasTrack ? (
        <div data-no-track class="f" style="--c:#9ca3af">
          There is no recorded track for this round. Tracks are recorded only when the game server has position tracking on, and older ones are removed to keep room.
          <p style="margin:.6rem 0 0"><a href={link(ctx, `/servers/${id}/stats`, { view: 'rounds', bots })} style="text-decoration:underline">Back to the round stats</a></p>
        </div>
      ) : (
        <div data-replay data-src={src} data-viewer={ctx.viewer?.steamId ?? ''} class="replay">
          <div class="main">
            <div class="view">
              <canvas data-canvas aria-label="3D replay of the round"></canvas>
              <p data-status>This view needs JavaScript.</p>
            </div>
            <div data-controls>
              <div class="scrub">
                <input data-scrub type="range" min="0" max="0" step="1" value="0" aria-label="Time in the round" />
                <div data-ticks class="ticks" aria-hidden="true"></div>
              </div>
              <div class="tools">
                <button data-play type="button" class="tog play">Play</button>
                <span data-time class="time">0:00 / 0:00</span>
                <span role="group" aria-label="Speed">
                  {[1, 2, 4, 8].map(s => <button type="button" data-speed={s} aria-pressed="false" class="tog">{s}x</button>)}
                </span>
                <span role="group" aria-label="Camera">
                  <button type="button" data-cam="orbit" aria-pressed="true" class="tog">3D</button>
                  <button type="button" data-cam="top" aria-pressed="false" class="tog">From above</button>
                  <button type="button" data-cam="follow" aria-pressed="false" class="tog">Follow</button>
                </span>
              </div>
              <div data-levels-wrap class="tools">
                <span role="group" aria-label="Levels shown"><span class="cap">Up to level</span><span data-levels></span></span>
                <label><input type="checkbox" data-follow-level checked /> Follow the selected player's level</label>
                <label><input type="checkbox" data-walls checked /> Walls</label>
              </div>
            </div>
            <p data-background class="foot"></p>
            <div data-notes></div>
            <p data-disclaimer class="foot dark">
              Simplified map: this shows where players were and when, not what they could see. Doors, glass, props and ceilings are not in it, so it cannot tell who could see whom.
            </p>
          </div>
          <aside>
            <section class="f" style="--c:#22c55e"><b>Players</b><div data-players class="list"></div></section>
            <section class="f" style="--c:#a78bfa">
              <b>Selected player</b>
              <p data-selected-role style="margin:.2rem 0"></p>
              <ol data-player-events class="list"></ol>
            </section>
            <section data-revives-wrap hidden class="f" style="--c:#34d399"><b>Revivals</b><ol data-revives class="list"></ol></section>
            <section class="f" style="--c:#dc2626"><b>Deaths</b><ol data-deaths class="list"></ol></section>
            {admin && (
              <section class="f" style="--c:#9ca3af">
                <form method="post" action={`/servers/${id}/rounds/${encodeURIComponent(round.id)}/pin`}>
                  <input type="hidden" name="pin" value={pinned ? '0' : '1'} />
                  <input type="hidden" name="next" value={here} />
                  <button type="submit" data-pin class="btn">{pinned ? 'Unpin this round' : 'Pin this round'}</button>
                  <p class="foot dark">A pinned track is never removed to make room.{pinnedCount ? ` ${pinnedCount.used} of ${pinnedCount.max} pins used.` : ''}</p>
                </form>
                <div class="actions">
                  {[
                    { what: 'replay', label: 'Delete replay', ask: 'Delete this replay? The round stays in the statistics.' },
                    { what: 'round', label: 'Delete round and replay', ask: 'Delete this round with its replay? It leaves the statistics too. This cannot be undone.' },
                  ].map(d => (
                    <form method="post" action={`/servers/${id}/rounds/${encodeURIComponent(round.id)}/delete`} data-delete={d.what} data-confirm={d.ask}>
                      <input type="hidden" name="what" value={d.what} />
                      <button type="submit" class="btn danger">{d.label}</button>
                    </form>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      )}
      <Who ctx={ctx} />
    </Shell>
  )
}
