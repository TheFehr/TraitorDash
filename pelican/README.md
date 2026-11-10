# Pelican egg

`egg-traitordash.json` is the egg the TraitorDash backend runs under. It replaces the generic Bun egg
with one that:

- marks the server as **running**: the app prints `[TraitorDash] Listening on port <n>` and the egg waits
  for exactly that line (Bun's own "Started development server" line is only printed in development mode,
  so with `NODE_ENV=production` a generic egg stays on "starting" forever);
- takes the configuration as **egg variables** instead of values typed into the startup command:
  `BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET` (at least 32 characters, admin-only), `NODE_ENV`, `MAIN_FILE`, `MAP_GEOMETRY`, `GAME_CONTENT`, `OPEN_SIGNIN`, `BLOCKED_STEAM_IDS`, `VIEW_LOG_DAYS`, `PUBLIC_ROLES`, `PUBLIC_ROLE_SETTINGS`, `LIVEKIT_URL`, `LIVEKIT_API_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (voice chat, RFC 27; the server of the same name for the media server is `egg-livekit.json`, below);
- has no git/clone logic: the files are put in the volume by whatever deploys the app (for example
  the `backend.tar.gz` from the `main-latest` release, unpacked into the server's files), and the
  startup command only runs `bun install --production` and the app.

- can fetch the **download helper** for exact map geometry (RFC 11): with `MAP_GEOMETRY=1` the installer downloads
  DepotDownloader 3.4.0 (GPL-2.0, from its upstream release; the version and a SHA-256 per CPU architecture are
  pinned, and a file that does not match is discarded) into `bin/`, where the app finds it. It is never shipped
  with TraitorDash. The installer does not fail if the download does: the dashboard works, and the app logs that
  the helper is missing. Changing `MAP_GEOMETRY` later needs a **reinstall** of the server (Settings > Reinstall;
  the files and the database stay). Old Workshop items are unpacked with `xz`, which the runtime image has.

`backend/test/egg.test.ts` keeps the file honest (every variable the app reads is declared, the startup
line matches the one the app prints, and so on).

## Importing

1. Admin > Eggs > Import, choose `egg-traitordash.json`.
   The egg carries its own update address (the file on `main` of this repository), so after the first import
   the panel's **Update** button on the egg fetches new variables from there. A server that already exists keeps
   its own variables until you open its Startup tab and fill in the new ones.
2. For a **new** server pick this egg, fill in the variables, allocate one port.

## Moving the existing server to it

1. Admin > Servers > *the TraitorDash server* > Startup: change the egg to **TraitorDash**.
2. Fill in the variables (`BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET`, ...). The old values typed inline in the
   startup command (`BASE_URL=...`, `SESSION_SECRET=...`, `SUPER_ADMINS=...`) are no longer used: the startup
   command is now the egg's own.
3. Restart. The files and the SQLite database in the volume are untouched.

## The media server for voice chat (RFC 27)

`egg-livekit.json` runs the [LiveKit](https://livekit.io) media server that the dashboard's voice chat uses, as a Pelican server of its
own next to the dashboard's (two servers, one node; each egg runs one program). The installer downloads LiveKit's own release
(a pinned version, a SHA-256 per CPU architecture; a file that does not match fails the install), the startup command writes the
config from the variables and starts it with the keys in the environment, so the secret is not in a file.

1. Import the egg (Admin > Eggs > Import). Create a server from it with **three allocations**: the primary one is the signalling
   port (7880), the other two the media ports for TCP (7881) and UDP (7882); the numbers must be those of the allocations, and the
   UDP one must be open to the internet.
2. Fill in the variables: an API key, an API secret (at least 32 random characters), and the node's public address only if
   the server cannot find it itself (it asks a STUN server).
3. Put a TLS proxy in front of the signalling port: browsers will only open `wss://` from the dashboard's `https://` page. The media
   ports are reached directly, not through the proxy.
4. On the dashboard's server set `LIVEKIT_URL` (the proxy's `wss://` address), `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (the same
   key and secret), and `LIVEKIT_API_URL` if the dashboard reaches LiveKit by another address than the public one (for example
   `http://<node address>:7880` on the same node).

`backend/test/livekit_egg.test.ts` keeps the file honest (the command's variables are declared, no secret is shipped, the config it
writes is the one LiveKit reads, the installer refuses a failed or wrong download). **Not tried against a panel or the real
server yet:** the line that marks the server as running (`starting LiveKit server`) is LiveKit's log line as the maintainer of
this code remembers it; if the panel stays on "starting", change it in the egg's Configuration > Startup > Done.
