import { duration } from '../format'
import { BTN } from '../ui'

// The round replay's page (RFC 12, 3.5): the markup the viewer (replay.ts) fills in. Without
// JavaScript or WebGL the lists the viewer builds are not there, and the page says so.


export interface ReplayPageProps {
  server: { id: string, name: string }
  round: { id: string, map: string | null, result: string, duration: number | null }
  /** Whether the round has a stored track. */
  hasTrack: boolean
  /** The data URL, with the same `bots` choice as the page. */
  src: string
  /** The signed-in visitor, so the viewer can open on their own player. */
  viewer: string
  admin: boolean
  pinned: boolean
  /** Where to come back to after pinning. */
  here: string
  pinnedCount?: { used: number, max: number }
}

export const ReplayPage = ({ server, round, hasTrack, src, viewer, admin, pinned, here, pinnedCount }: ReplayPageProps) => (
  <div class="p-4 sm:p-8 space-y-6">
    <header>
      <nav class="text-xs font-black text-gray-500 uppercase tracking-widest mb-4 flex flex-wrap gap-x-2">
        <a href="/" class="hover:text-white transition">Dashboard</a>
        <span>/</span>
        <a href={`/servers/${server.id}/stats`} class="hover:text-white transition">{server.name}</a>
        <span>/</span>
        <span class="text-red-500">Replay</span>
      </nav>
      <h1 class="text-3xl sm:text-5xl font-black mb-2 break-words">Round replay</h1>
      <p class="text-gray-400">
        {round.map ?? 'unknown map'} · {round.result} · {duration(round.duration)}
        {pinned && <span data-pinned class="ml-2 inline-block text-[10px] font-black uppercase tracking-widest border border-yellow-500/50 text-yellow-400 rounded px-2 py-0.5">Pinned</span>}
      </p>
    </header>

    {!hasTrack ? (
      <div data-no-track class="bg-gray-800 border border-gray-700 rounded-xl p-6 text-gray-300">
        There is no recorded track for this round. Tracks are recorded only when the game server has position tracking on, and older ones are removed to keep room.
        <p class="mt-3"><a class="underline hover:text-white" href={`/servers/${server.id}/stats`}>Back to the round stats</a></p>
      </div>
    ) : (
      <div data-replay data-src={src} data-viewer={viewer} class="grid lg:grid-cols-[minmax(0,1fr)_20rem] gap-4">
        <div class="space-y-3 min-w-0">
          <div class="relative">
            <canvas data-canvas class="block w-full h-[55vh] rounded-xl bg-gray-900 touch-none" aria-label="3D replay of the round"></canvas>
            <p data-status class="absolute inset-0 grid place-items-center text-center px-4 text-sm text-gray-400 pointer-events-none">This view needs JavaScript.</p>
          </div>
          <div data-controls class="space-y-3 text-sm">
            <div class="relative">
              <input data-scrub type="range" min="0" max="0" step="1" value="0" class="w-full" aria-label="Time in the round" />
              <div data-ticks class="absolute inset-x-0 top-0 h-5 pointer-events-none" aria-hidden="true"></div>
            </div>
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <button data-play type="button" class={BTN + ' min-w-20'}>Play</button>
              <span data-time class="font-mono text-gray-300">0:00 / 0:00</span>
              <div class="flex items-center gap-1" role="group" aria-label="Speed">
                {[1, 2, 4, 8].map(s => <button type="button" data-speed={s} aria-pressed="false" class={BTN}>{s}x</button>)}
              </div>
              <div class="flex items-center gap-1" role="group" aria-label="Camera">
                <button type="button" data-cam="orbit" aria-pressed="true" class={BTN}>3D</button>
                <button type="button" data-cam="top" aria-pressed="false" class={BTN}>From above</button>
                <button type="button" data-cam="follow" aria-pressed="false" class={BTN}>Follow</button>
              </div>
            </div>
            <div data-levels-wrap class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Levels shown">
                <span class="text-xs font-black uppercase tracking-widest text-gray-500 mr-2">Up to level</span>
                <span data-levels class="contents"></span>
              </div>
              <label class="flex items-center gap-2 text-gray-300"><input type="checkbox" data-follow-level checked /> Follow the selected player's level</label>
              <label class="flex items-center gap-2 text-gray-300"><input type="checkbox" data-walls checked /> Walls</label>
            </div>
          </div>
          <p data-background class="text-xs text-gray-400"></p>
          <div data-notes class="space-y-1"></div>
          <p data-disclaimer class="text-xs text-gray-500">
            Simplified map: this shows where players were and when, not what they could see. Doors, glass, props and ceilings are not in it, so it cannot tell who could see whom.
          </p>
        </div>
        <aside class="space-y-5 min-w-0">
          <section>
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-2">Players</h2>
            <div data-players class="bg-gray-800 border border-gray-700 rounded-xl p-1 text-sm max-h-80 overflow-y-auto"></div>
          </section>
          <section>
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-2">Selected player</h2>
            <div class="bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-gray-300 space-y-2">
              <p data-selected-role class="font-bold"></p>
              <ol data-player-events class="space-y-1 max-h-40 overflow-y-auto"></ol>
            </div>
          </section>
          <section data-revives-wrap hidden>
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-2">Revivals</h2>
            <ol data-revives class="bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-gray-300 space-y-1 max-h-64 overflow-y-auto"></ol>
          </section>
          <section>
            <h2 class="text-sm font-black uppercase tracking-widest text-gray-400 mb-2">Deaths</h2>
            <ol data-deaths class="bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-gray-300 space-y-1 max-h-64 overflow-y-auto"></ol>
          </section>
          {admin && (
            <section>
              <form method="post" action={`/servers/${server.id}/rounds/${encodeURIComponent(round.id)}/pin`} class="space-y-1">
                <input type="hidden" name="pin" value={pinned ? '0' : '1'} />
                <input type="hidden" name="next" value={here} />
                <button type="submit" data-pin class={BTN}>{pinned ? 'Unpin this round' : 'Pin this round'}</button>
                <p class="text-xs text-gray-500">A pinned track is never removed to make room.{pinnedCount ? ` ${pinnedCount.used} of ${pinnedCount.max} pins used.` : ''}</p>
              </form>
            </section>
          )}
        </aside>
      </div>
    )}
    <script defer src="/public/replay.js"></script>
  </div>
)
