import { Sections, Shell } from './CaseFile'
import { Crumbs, adminOf, type Ctx } from './kit'

// The voice page (RFC 27): the markup voice.ts finds its parts in. Everything that happens (joining, the level, the mode) is
// done by that code; without JavaScript, or when the dashboard has no media server, the page says so.

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
      <p class="muted" style="margin:.1rem 0 .8rem">Talk to the other players of the server while you play.</p>
      {!enabled ? (
        <div data-voice-off class="f c-gray">Voice chat is not set up on this dashboard.</div>
      ) : (
        <div data-voice data-token={`/servers/${id}/voice/token`} class="f c-gray vc">
          <p>
            Keep this tab open while you play, turn the game's own voice off or down, and use a headset.
            While a round runs, the living hear the living, and the dead hear everyone.
          </p>

          <div class="row">
            <button data-join type="button" class="tog">Join voice</button>
            <span data-status role="status">Not connected.</span>
            <span class="muted">Connected: <span data-count>0</span></span>
          </div>

          <div>
            <div class="cap">Microphone opens</div>
            <div class="row" role="group" aria-label="How the microphone opens">
              <button type="button" data-mode="vad" aria-pressed="true" class="tog">By your voice</button>
              <button type="button" data-mode="ptt" aria-pressed="false" class="tog" disabled title="Needs the desktop app, which comes later">Hold a key</button>
            </div>
            <p class="muted" style="margin-top:.35rem">Holding a key to talk needs a small desktop app (a browser tab cannot hear a key while the game has the focus); it comes later.</p>
          </div>

          <div data-vad-box>
            <div class="cap">Level and sensitivity</div>
            <div class="row">
              <div class="lvl" aria-hidden="true"><i data-level></i><b data-marker></b></div>
              <input data-threshold type="range" min={1} max={60} step={1} value={12} aria-label="Sensitivity: the level the microphone opens at" />
              <span data-speaking class="muted"></span>
            </div>
            <p class="muted">The bar is what the microphone hears; the line is where it opens. Move the slider until the line sits just above your room's noise.</p>
          </div>

          <div data-ptt-box style="display:none">
            <div class="cap">Key to hold</div>
            <div class="row">
              <input data-ptt-key type="text" value="v" maxlength={1} size={2} aria-label="Key to hold to talk" />
              <span class="muted">Works only while this tab has the focus; a helper app for use during the game comes later.</span>
            </div>
          </div>

          <div data-audio style="display:none"></div>
        </div>
      )}
    </Shell>
  )
}
