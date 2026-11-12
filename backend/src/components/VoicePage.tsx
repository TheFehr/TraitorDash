import { Sections, Shell } from './CaseFile'
import { Crumbs, adminOf, type Ctx } from './kit'

// The voice page (RFC 27): the markup voice.ts finds its parts in, in two cards: who is on the voice chat (join, the list, the volumes) and the
// player's own microphone (how it opens, the filter, the level and the sensitivity). Everything that happens is done by that code; without
// JavaScript, or when the dashboard has no media server, the page says so. Anything the code writes into the page while it runs (the
// status, the level, the notes) has a line of its own that is there when it is empty, so nothing below it moves when the text comes.

export interface VoicePageProps {
  ctx: Ctx
  server: { id: string, name: string }
  /** Whether the dashboard has a media server to join (LIVEKIT_URL and the keys are set). */
  enabled: boolean
}

export const VoicePage = ({ ctx, server, enabled }: VoicePageProps) => {
  const id = server.id
  return (
    <Shell title={`Voice | ${server.name}`} embed={ctx.embed} viewer={ctx.viewer} scripts={enabled ? ['/public/voice.js'] : []}>
      <Crumbs><a href={`/servers/${id}/stats`}>{server.name}</a> / Voice</Crumbs>
      {!ctx.embed && <Sections serverId={id} admin={adminOf(ctx)} />}
      <h1>Voice chat</h1>
      <p class="muted" style="margin:0 0 var(--space-3)">Talk to the other players of the server while you play.</p>
      {!enabled ? (
        <div data-voice-off class="f c-gray">Voice chat is not set up on this dashboard.</div>
      ) : (
        <div data-voice data-token={`/servers/${id}/voice/token`} data-people-url={`/servers/${id}/voice/people`} class="stack">
          <div class="f c-gray vc">
            <div class="ft">On the voice chat</div>
            <p>
              Keep this tab open while you play, turn the game's own voice off or down, and use a headset.
              While a round runs, the living hear the living, and the dead hear everyone.
            </p>

            <div class="row">
              <button data-join type="button" class="tog jn">Join voice</button>
              <span data-status role="status">Not connected.</span>
              <span class="muted">Connected: <span data-count>0</span></span>
            </div>
            <p class="muted note" data-who></p>

            <div>
              <div class="cap">People</div>
              <div data-people></div>
              <p class="muted mt1">Everyone on the voice chat is listed, whether or not you can hear them right now (during a round the game decides that). Your volumes and mutes are remembered on this device.</p>
            </div>
          </div>

          <div class="f c-gray vc">
            <div class="ft">Your microphone</div>

            <div>
              <div class="cap">Microphone opens</div>
              <div class="row" role="group" aria-label="How the microphone opens">
                <button type="button" data-mode="vad" aria-pressed="true" class="tog">By your voice</button>
                <button type="button" data-mode="ptt" aria-pressed="false" class="tog" disabled title="Needs the desktop app, which comes later">Hold a key</button>
              </div>
              <p class="muted mt1">Holding a key to talk needs a small desktop app (a browser tab cannot hear a key while the game has the focus); it comes later.</p>
            </div>

            <div>
              <div class="cap">Noise filter</div>
              <div class="row" role="group" aria-label="Noise filter">
                <button type="button" data-filter="on" aria-pressed="true" class="tog">On</button>
                <button type="button" data-filter="off" aria-pressed="false" class="tog">Off</button>
                <button type="button" data-monitor aria-pressed="false" class="tog">Hear myself</button>
              </div>
              <p class="muted">The filter (RNNoise) takes fans, keys and other noise out of your voice before it is sent. "Hear myself" plays your microphone back to you as the others hear it: use headphones, or it will howl.</p>
            </div>

            <div data-vad-box>
              <div class="cap">Level and sensitivity</div>
              <div class="lvl" aria-hidden="true"><i data-level></i><b data-marker></b><b data-marker-close class="c"></b></div>
              <div class="lvl-read"><span data-db class="muted db"></span><span data-speaking class="muted talk"></span></div>
              <p class="muted lvl-legend">The bar is what the microphone hears, in dBFS (0 is the loudest it can go). The left zone is quiet, the green zone is where speech should sit, the red zone is too loud.</p>
              <div class="row">
                <label for="td-sens">Sensitivity</label>
                <input id="td-sens" data-threshold type="range" min={-70} max={-20} step={1} value={-50} aria-label="Sensitivity: the level the microphone opens at, in dBFS" />
                <span data-threshold-out class="muted db">-50 dBFS</span>
              </div>
              <p class="muted">The solid line is where the microphone opens, the dashed line where it closes again (a little lower, so it does not flutter). Move the slider until the solid line sits just above your room's noise and well below your voice.</p>
              <div class="row">
                <button type="button" data-measure class="tog">Measure my room</button>
                <button type="button" data-auto aria-pressed="false" class="tog">Adjust by itself</button>
              </div>
              <p class="muted note mnote" data-measure-note role="status"></p>
              <p class="muted">"Measure my room" listens for 3 seconds while you stay quiet and sets the line for you. "Adjust by itself" keeps following the room's noise while you are not talking (it is off until you switch it on).</p>
              <details>
                <summary>Advanced</summary>
                <div class="row mt2">
                  <label for="td-close">Closes below</label>
                  <input id="td-close" data-close-threshold type="range" min={-70} max={-20} step={1} value={-56} aria-label="The level the microphone closes at, in dBFS" />
                  <span data-close-out class="muted db">-56 dBFS</span>
                </div>
                <p class="muted mt1">The microphone stays open until the sound has been below this level for a quarter of a second. It cannot be higher than the opening level.</p>
              </details>
            </div>

            <div data-ptt-box style="display:none">
              <div class="cap">Key to hold</div>
              <div class="row">
                <input data-ptt-key type="text" value="v" maxlength={1} size={2} aria-label="Key to hold to talk" />
                <span class="muted">Works only while this tab has the focus; a helper app for use during the game comes later.</span>
              </div>
            </div>

            <p class="muted" data-filter-note role="status"></p>
            <p class="muted" data-gate-note role="status"></p>
          </div>

          <div data-audio style="display:none"></div>
        </div>
      )}
    </Shell>
  )
}
