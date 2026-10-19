# TraitorDash 🕵️‍♂️💻

**Dynamic Web Configuration Manager for TTT2 (Garry's Mod)**

TraitorDash is an external, web-based admin panel designed specifically for TTT2 (Trouble in Terrorist Town 2) servers. It allows server owners to manage role configurations, ConVars, and internal TTT2 data through a clean, modern web interface—without ever needing to join the server or touch a `.cfg` file.

---

## ⚠️ Project Status: Hobbyist & First Steps
**This is a hobby project.** It marks my first journey into the world of Garry's Mod Lua and Source Engine development. While the architecture is designed to be robust, please expect "newbie" mistakes in the Lua implementation! Feedback and contributions from seasoned GMod devs are highly welcome.

---

## ✨ Key Features

-   **"Automagic" Schema Extraction:** No manual form building. The system parses your installed roles' Lua files in a headless VM to automatically generate a mirroring web UI.
-   **RCON-less Security:** Uses a pull-based **Command Queue** via HTTP polling. You never have to expose your RCON password or open ports on your home router. Answers are **signed** and every command is checked against an allow-list before the server applies it (see [RFC 6](./docs/rfcs/RFC-006.md)).
-   **Round Statistics:** The server reports every finished round (who played which role, who survived, who killed whom). The dashboard turns that into per-server and per-player stats pages that are **public**; the rule settings stay behind the admin login.
-   **TTT2 Native Support:** Deep integration with TTT2's internal registration system, including support for `TTT2.DATA` (SQLite) and standard ConVars.
-   **Steam Identity:** Zero-config administration. Log in with Steam, and TraitorDash automatically syncs your permissions from the GMod server using **CAMI**.
-   **B.A.H. Stack:** Built with modern, high-performance tools: **Bun**, **Alpine.js**, and **HTMX** for a snappy, server-rendered experience.

---

## 🏗️ Architecture

TraitorDash is split into two parts:

1.  **The TraitorLink Bridge (GMod Side):** A lightweight Lua plugin that discovers installed roles, scrapes localization files, and polls the web backend for pending changes.
2.  **The TraitorDash Backend (Web Side):** A Bun-powered server that executes role code in a mocked Fengari VM, extracts the UI schema, and hosts the admin dashboard.

How they talk (always initiated by the game server, over HTTPS):

-   **At startup** the bridge sends the role files and language files, and the backend extracts a settings form for each role.
-   **Every 10 seconds** the bridge polls for changes. Each answer is signed with the server's token and a fresh nonce, the bridge verifies it, applies only `ttt_*`/`ttt2_*` ConVar changes, and acknowledges them on the next poll. A command stays queued until it is acknowledged, so a lost response never loses a change.
-   **After every round** the stats tracker (`stats.lua`) sends one small report. It never touches gameplay: it copies a few values in hooks, sends once, and a failure is logged and dropped.
-   **Optionally, position tracks** (`track.lua`, off by default): with `traitordash_track 1` the bridge samples where the living players are while a round runs, as often as the server can afford (`traitordash_track_interval_min` 0.2 s, `traitordash_track_interval_max` 1 s, `traitordash_track_budget_ms` 0.5), and sends the whole track once after the round's stats were accepted. A busy server gets a slower rate, then skipped ticks; one that cannot afford it at all records nothing more for that round. The console prints one line per round (ticks, interval, cost, size); `traitordash_track_status` shows the settings. To check that tracking does not cost the server anything, `traitordash_frametime round` measures the frame time of the next round (mean, 99th percentile, worst, and how many frames overran the tick); run it for a few rounds with `traitordash_track 0` and a few with `1` on the same map and compare (`traitordash_frametime history` lists the results; `traitordash_track_test [bots] [seconds] [off]` plays a whole round with walking bots and tracking on (or `off` for the control run), and puts every setting back; it refuses when a real player is online; read `Svms` in the server's `stats` command for headroom, which the tool cannot see). `traitordash_track 0` stops it at the next tick. Rounds with a track get a **replay** on the stats page: a free 3D camera, a top-down view and a follow view, drawn in the map's 3D geometry when the map has one (`MAP_GEOMETRY`). Replays are for signed-in users (`OPEN_SIGNIN`); the replay shows where players were and when, not what they could see.

---

## 🚀 Getting Started

### 1. Run the backend

```bash
cd backend
bun install
bun run build            # Tailwind CSS + the htmx/Alpine bundle
SESSION_SECRET=$(openssl rand -hex 32) \
ADMIN_STEAM_IDS=76561198000000000 \
BASE_URL=http://localhost:3000 \
bun run dev
```

| Variable | Meaning |
|---|---|
| `SESSION_SECRET` | **Required**, at least 32 random characters. The backend refuses to start without it. |
| `ADMIN_STEAM_IDS` | Comma-separated SteamID64s allowed to administer. Empty means nobody can log in. |
| `BASE_URL` | The public address of the dashboard (the Steam login returns here). An `https://` address makes the session cookie `Secure` with the `__Host-` prefix. |
| `OPEN_SIGNIN` | `1` lets **any Steam account** sign in (RFC 13), not only the admins. Signed-in users can open the 3D map views (and, with RFC 12, round replays); admin rights still come only from `ADMIN_STEAM_IDS`, checked on every request. Off by default. A Steam account costs nothing, so this is a login wall that makes limits per account possible, not a secret: do not describe it as one. |
| `BLOCKED_STEAM_IDS` | Comma-separated SteamID64s that may not sign in or keep a session while open sign-in is on. An admin on `ADMIN_STEAM_IDS` cannot be blocked, so a typo cannot lock the operator out. |
| `VIEW_LOG_DAYS` | How long views of gated content are kept (default 90). Opening a 3D map (and later a replay) writes one audit-log row with the viewer's **SteamID64**, at most once an hour per user and item; rows are deleted after this many days, at start-up and once a day. `0` switches the logging off. Tell your users, as the sign-in is open to everyone. |
| `TRAITORDASH_DB` | Path of the SQLite file (default `traitordash.sqlite`). |
| `MAP_GEOMETRY` | `1` lets admins switch on exact map geometry per map (RFC 11): the backend then downloads the map's Workshop addon once and keeps a simplified 3D mesh. Off by default. Needs the download helper below. |
| `DEPOTDOWNLOADER_PATH` | Where the [DepotDownloader](https://github.com/SteamRE/DepotDownloader) program is (default: `bin/DepotDownloader` in the working directory if there, else `DepotDownloader` on the PATH; the Pelican egg's installer puts it in `bin/`). It is run as a separate program, anonymously; it is not part of this project. Old Workshop items also need `xz` on the system. |
| `GEOMETRY_TMP` | Scratch directory for those downloads (default: `.geometry-tmp` in the working directory, so in the server's own volume). **Not the system temp directory**: in a container `/tmp` is often a small memory-backed disk (Pelican's is 100 MB) and a map addon is larger than that. One addon at a time, up to 1 GiB, deleted when the job ends; a folder left by a crash is removed at the next job. |
| `PORT` | Port to listen on (default 3000). `SERVER_PORT`, which Pelican sets, takes precedence. |

Log in with Steam and add a server on the **Servers** page. Pairing it with a game server needs no token copying: see the next step.
`TRUST_PROXY=1` (optional) makes the pairing endpoint rate limit per client address using the last `X-Forwarded-For` entry; set it only behind a reverse proxy you control. Without it only the global limit (30 attempts a minute) applies.

### 2. Install the bridge on the GMod server

Copy `addon/lua/` into the server's `garrysmod/lua/` (or install it as an addon) and restart the server.

**Pairing (recommended, [RFC 9](./docs/rfcs/RFC-009.md)).** On the **Servers** page press **Connect** for the server. The dashboard shows a command that works once and for 10 minutes; run it in the game server's console:

```
traitordash_connect "https://traitordash.example.com" ABCDE-FGHJK
```

The address is in quotes because the game console treats `//` as a comment; the dashboard shows the command ready to paste, quotes included.

The bridge trades the code for the server's token, stores it in `data/traitordash/config.json` and starts syncing. Pairing replaces the server's token (a server that is still using the old one stops working until it is paired), and the token is never shown or printed.

**By hand.** Create `garrysmod/data/traitordash/config.json` ([RFC 8](./docs/rfcs/RFC-008.md)), with a token from the dashboard's **Regen token**:

```json
{ "url": "https://traitordash.example.com", "token": "<the server's API token>" }
```

The two ConVars `traitordash_url` and `traitordash_token` in `server.cfg` still work as a fallback; for each setting the file wins. The file is read when the bridge starts and on `traitordash_reload`. The bridge only talks to an `https://` address or a private network address, and stays idle without a token, saying what is missing in the console. Restart the server; the console should show `Bridge Initialized`, `Language files OK` and `Sync complete!`. `traitordash_status` shows where each value came from and whether the token is set (never the token itself). `traitordash_stats 0` turns the round statistics off without a restart.

### 3. Deploy (optional)

-   `pelican/` has the [Pelican egg](./pelican/README.md) the backend runs under, configured through egg variables (`BASE_URL`, `ADMIN_STEAM_IDS`, `SESSION_SECRET`, ...).
-   Every push to `main` is tested by GitHub Actions, which also publishes the backend as a tarball (`backend.tar.gz` with a `.sha256`, commit recorded in `build.json`) on the rolling [`main-latest` release](https://github.com/TheFehr/TraitorDash/releases/tag/main-latest); `GET /health` shows the commit that is running.

---

## 🧪 Development

```bash
cd backend
bun test                 # the whole suite (backend, extractor, the Lua bridge in a Fengari VM)
bunx tsc --noEmit        # type check
```

CI runs exactly these two. A [husky](https://typicode.github.io/husky/) pre-commit hook (`backend/.husky/pre-commit`) runs them before every commit, so a failing build never reaches GitHub. The Lua bridge is tested by loading the real `addon/lua/traitordash/*.lua` into Fengari against a small fake of GMod; GMod's `continue` is not Lua 5.3, so the bridge avoids it.

---

## 🛠️ Tech Stack

-   **Backend:** [Bun](https://bun.sh/) + [Hono](https://hono.dev/) (TypeScript)
-   **Lua VM:** [Fengari](https://fengari.io/) (Headless extraction)
-   **Database:** `bun:sqlite`
-   **Frontend:** [HTMX](https://htmx.org/) + [Alpine.js](https://alpinejs.dev/) + [Tailwind CSS](https://tailwindcss.com/)
-   **Auth:** Steam OpenID

---

## 📜 Documentation & RFCs

The project is built following a series of Request for Comments (RFCs) that outline the core logic:

-   [RFC 1: Project Vision](./docs/rfcs/RFC-001.md)
-   [RFC 2: The TraitorLink Bridge](./docs/rfcs/RFC-002.md)
-   [RFC 3: Headless Extraction](./docs/rfcs/RFC-003.md)
-   [RFC 4: Web Dashboard Design](./docs/rfcs/RFC-004.md)
-   [RFC 5: Identity & Multi-Server](./docs/rfcs/RFC-005.md)
-   [RFC 6: Secure Command Queue](./docs/rfcs/RFC-006.md)
-   [RFC 7: Secure Session Management & CSRF Protection](./docs/rfcs/RFC-007.md)
-   [RFC 8: Bridge Configuration File](./docs/rfcs/RFC-008.md)
-   [RFC 9: Pairing a Game Server](./docs/rfcs/RFC-009.md)

RFCs 6 to 9 describe what is implemented today; [docs/UI_DESIGN.md](./docs/UI_DESIGN.md) has the dashboard design notes.

---

## 🤝 Contributing

As this is my first GMod project, I'm especially interested in:
-   Lua best practices for performance and stability.
-   Improved mocking of the GMod environment for schema extraction.
-   Security reviews. The command queue, the extractor sandbox and the login have had two audits (remote code execution through the extractor, console-command injection, the Steam callback, CSRF, signed answers, ...); the findings are fixed and covered by tests, but fresh eyes are welcome.

Feel free to open an issue or submit a PR!

---

## ⚖️ License

Distributed under the MIT License. See `LICENSE` for more information.
