import { Sections, Shell } from './CaseFile'
import { Crumbs, adminOf, type Ctx } from './kit'

// The voice page (RFC 27): the markup voice.ts finds its parts in. Everything that happens (joining, the meter, the mode) is
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
      {!enabled ? (
        <div data-voice-off class="f c-gray">Voice chat is not set up on this dashboard.</div>
      ) : (
        <div data-voice data-token={`/servers/${id}/voice/token`} class="f c-gray">
          <p style="margin:0 0 .6rem">
            Talk to the other players of the server from this page; leave the game's own voice off or turned down, and use a headset.
            While a round runs, the living hear the living, and the dead hear everyone. Keep this tab open while you play.
          </p>
          <p style="margin:0 0 .6rem"><button data-join type="button" class="tog">Join voice</button> <span data-status role="status">Not connected.</span></p>
          <fieldset style="border:0;padding:0;margin:0 0 .6rem">
            <legend class="muted">How your microphone opens</legend>
            <label><input type="radio" name="mode" value="vad" data-mode checked /> By your voice (default)</label>{' '}
            <label><input type="radio" name="mode" value="ptt" data-mode /> Hold a key (this tab must have the focus)</label>
          </fieldset>
          <p style="margin:0 0 .6rem" data-vad-box>
            <label>Sensitivity <input data-threshold type="range" min="1" max="60" step="1" value="12" aria-label="Sensitivity of the microphone" /></label>{' '}
            <meter data-level min={0} max={100} value={0} aria-label="Microphone level" style="width:10rem;vertical-align:middle"></meter>{' '}
            <span data-speaking class="muted"></span>
          </p>
          <p style="margin:0 0 .6rem;display:none" data-ptt-box>
            <label>Key <input data-ptt-key type="text" value="v" maxlength={1} size={2} aria-label="Key to hold to talk" /></label>
          </p>
          <p style="margin:0" class="muted">Connected: <span data-count>0</span></p>
          <div data-audio style="display:none"></div>
        </div>
      )}
    </Shell>
  )
}
