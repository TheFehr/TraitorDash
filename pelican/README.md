# Pelican egg

`egg-traitordash.json` is the egg the TraitorDash backend runs under. It replaces the generic Bun egg
with one that:

- marks the server as **running**: the app prints `[TraitorDash] Listening on port <n>` and the egg waits
  for exactly that line (Bun's own "Started development server" line is only printed in development mode,
  so with `NODE_ENV=production` a generic egg stays on "starting" forever);
- takes the configuration as **egg variables** instead of values typed into the startup command:
  `BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET` (at least 32 characters, admin-only), `NODE_ENV`, `MAIN_FILE`, `MAP_GEOMETRY`, `GAME_CONTENT`, `OPEN_SIGNIN`, `BLOCKED_STEAM_IDS`, `VIEW_LOG_DAYS`, `PUBLIC_ROLES`, `PUBLIC_ROLE_SETTINGS`;
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
2. For a **new** server pick this egg, fill in the variables, allocate one port.

## Moving the existing server to it

1. Admin > Servers > *the TraitorDash server* > Startup: change the egg to **TraitorDash**.
2. Fill in the variables (`BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET`, ...). The old values typed inline in the
   startup command (`BASE_URL=...`, `SESSION_SECRET=...`, `SUPER_ADMINS=...`) are no longer used: the startup
   command is now the egg's own.
3. Restart. The files and the SQLite database in the volume are untouched.
