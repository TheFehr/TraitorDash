# Pelican egg

`egg-traitordash.json` is the egg the TraitorDash backend runs under. It replaces the generic Bun egg
with one that:

- marks the server as **running**: the app prints `[TraitorDash] Listening on port <n>` and the egg waits
  for exactly that line (Bun's own "Started development server" line is only printed in development mode,
  so with `NODE_ENV=production` a generic egg stays on "starting" forever);
- takes the configuration as **egg variables** instead of values typed into the startup command:
  `BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET` (at least 32 characters, admin-only), `NODE_ENV`, `MAIN_FILE`;
- has no git/clone logic: the files are put in the volume by whatever deploys the app (for example
  the `backend.tar.gz` from the `main-latest` release, unpacked into the server's files), and the
  startup command only runs `bun install --production` and the app.

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
