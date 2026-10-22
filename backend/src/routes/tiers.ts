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
  'GET /servers/:serverId/stats': 'public',
  'GET /servers/:serverId/maps': 'public',
  'GET /servers/:serverId/players/:playerId': 'public',
  'GET /servers/:serverId/maps/:map/rounds': 'public',
  'GET /servers/:serverId/rounds/:roundId': 'public',
  'GET /servers/:serverId/roles': 'public',
  'GET /servers/:serverId/roles/:roleName': 'public',

  'GET /servers/:serverId/maps/:map': 'user',
  'GET /servers/:serverId/maps/:map/mesh.glb': 'user',
  'GET /servers/:serverId/rounds/:roundId/replay': 'user',
  'GET /servers/:serverId/rounds/:roundId/track.json': 'user',

  'GET /sidebar/:serverId': 'admin',
  'GET /servers': 'admin',
  'GET /servers/:serverId': 'admin',
  'GET /servers/:serverId/roles/:roleName/config': 'admin',
  'GET /servers/:serverId/maps/:map/plan.svg': 'admin',
  'GET /servers/:serverId/maps/:map/plan.json': 'admin',
  'POST /servers/:serverId/maps/:map/geometry': 'admin',
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

  'POST /api/ingest': 'bridge',
  'POST /api/v1/lang': 'bridge',
  'POST /api/v1/values': 'bridge',
  'POST /api/v1/round': 'bridge',
  'POST /api/v1/track': 'bridge',
  'POST /api/v1/maps': 'bridge',
  'POST /api/v1/mapplan': 'bridge',
  'POST /api/v1/roleaddons': 'bridge',
  'POST /api/v1/roledescriptions': 'bridge',
  'GET /api/v1/whoami': 'bridge',
  'POST /api/v1/poll': 'bridge',
  'POST /api/v1/pair': 'credential',

  'GET /auth/steam': 'login',
  'GET /auth/steam/callback': 'login',
  'POST /auth/logout': 'login',
}
