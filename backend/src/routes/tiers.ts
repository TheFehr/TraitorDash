/**
 * Who may call each route (RFC 13, 4.4). Every route of the application is named here, and a test
 * (`test/signin.test.ts`) fails when one is missing or does not behave as declared, so a new route
 * cannot be anonymous by accident.
 *
 *   public      anyone, signed in or not
 *   user        a signed-in user (any Steam account while OPEN_SIGNIN is on, otherwise only admins)
 *   admin       an account on the ADMIN_STEAM_IDS list, checked on every request
 *   bridge      the game server, with its bearer token; a session cookie is not accepted
 *   credential  carries its own credential (the pairing code)
 *   login       the sign-in flow itself
 */
export type Tier = 'public' | 'user' | 'admin' | 'bridge' | 'credential' | 'login'

export const TIERS: Record<string, Tier> = {
  'GET /health': 'public',
  'GET /': 'public',
  // The short address of the voice page (RFC 31, 10): a code typed here leads to the server that issued it; it names no server.
  'GET /voice': 'public',
  'GET /servers/:serverId/stats': 'public',
  'GET /servers/:serverId/maps': 'public',
  'GET /servers/:serverId/players/:playerId': 'public',
  'GET /servers/:serverId/maps/:map/rounds': 'public',
  'GET /servers/:serverId/rounds/:roundId': 'public',
  'GET /servers/:serverId/roles': 'public',
  'GET /servers/:serverId/roles/:roleName': 'public',

  'GET /servers/:serverId/maps/:map': 'user',
  'GET /servers/:serverId/maps/:map/mesh.glb': 'user',
  'GET /servers/:serverId/playermodel.glb': 'user',
  'GET /servers/:serverId/rounds/:roundId/replay': 'user',
  'GET /servers/:serverId/rounds/:roundId/track.json': 'user',
  'GET /servers/:serverId/rounds/:roundId/weapon-model.glb': 'user',
  // The four voice routes (the page, the token, who is on, and who speaks) also take the voice cookie (RFC 31, `getVoiceSession`); the page answers a visitor without a session with the code form.
  'GET /servers/:serverId/voice': 'user',
  'POST /servers/:serverId/voice/token': 'user',
  // Who spoke (RFC 26, 4c.5): the signed-in or paired player's own spans, only when the server records them.
  'POST /servers/:serverId/voice/talk': 'user',
  'GET /servers/:serverId/voice/people': 'user',

  'GET /sidebar/:serverId': 'admin',
  'GET /servers': 'admin',
  'GET /servers/:serverId': 'admin',
  'GET /servers/:serverId/roles/:roleName/config': 'admin',
  'GET /servers/:serverId/views': 'admin',
  // What the 3D pipeline draws, ignores and misses, summed over the maps (RFC 32): a maintenance page.
  'GET /servers/:serverId/map-coverage': 'admin',
  'GET /servers/:serverId/maps/:map/plan.svg': 'admin',
  'GET /servers/:serverId/maps/:map/plan.json': 'admin',
  'POST /servers/:serverId/maps/:map/geometry': 'admin',
  // The Workshop content card of the coverage page (RFC 40, 5).
  'POST /servers/:serverId/workshop-content/run': 'admin',
  'POST /servers/:serverId/workshop-content/retry': 'admin',
  'POST /servers/:serverId/workshop-content/model': 'admin',
  'GET /servers/:serverId/workshop-content/model.glb': 'admin',
  'POST /servers/:serverId/tracks/limits': 'admin',
  'POST /servers/:serverId/rounds/:roundId/pin': 'admin',
  'POST /servers/:serverId/rounds/:roundId/delete': 'admin',
  'POST /servers/:serverId/rounds/delete-bots': 'admin',
  'POST /servers/:serverId/rounds/delete-selected': 'admin',
  'GET /api/servers': 'admin',
  'POST /api/servers': 'admin',
  'POST /api/servers/:id/regenerate-token': 'admin',
  'POST /api/servers/:id/pairing-code': 'admin',
  'DELETE /api/servers/:id': 'admin',
  'POST /api/save/:serverId/:role': 'admin',
  'POST /api/bridge-settings/:serverId': 'admin',
  'GET /api/bridge-settings/:serverId': 'admin',
  'GET /servers/:serverId/bridge': 'admin',
  'GET /servers/:serverId/settings': 'admin',
  'POST /api/track-limits/:serverId': 'admin',

  'POST /api/ingest': 'bridge',
  'POST /api/v1/lang': 'bridge',
  'POST /api/v1/values': 'bridge',
  'POST /api/v1/settings': 'bridge',
  'POST /api/v1/round': 'bridge',
  'POST /api/v1/track': 'bridge',
  'POST /api/v1/track/extend': 'bridge',
  'POST /api/v1/voice': 'bridge',
  'POST /api/v1/maps': 'bridge',
  'POST /api/v1/mapplan': 'bridge',
  'POST /api/v1/roleaddons': 'bridge',
  'POST /api/v1/roledescriptions': 'bridge',
  'POST /api/v1/ingame-keys': 'bridge',
  'POST /api/v1/voice-codes': 'bridge',
  'GET /api/v1/whoami': 'bridge',
  'POST /api/v1/poll': 'bridge',
  'POST /api/v1/pair': 'credential',

  'GET /auth/steam': 'login',
  'GET /auth/game': 'login',
  'GET /auth/steam/callback': 'login',
  'POST /auth/voice-code': 'login',
  'POST /auth/voice-logout': 'login',
  'POST /auth/logout': 'login',
}
