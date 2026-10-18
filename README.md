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
| `TRAITORDASH_DB` | Path of the SQLite file (default `traitordash.sqlite`). |
| `PORT` | Port to listen on (default 3000). `SERVER_PORT`, which Pelican sets, takes precedence. |

Log in with Steam, add a server on the **Servers** page, and copy its **API token** (it is shown once; it can be regenerated).

### 2. Install the bridge on the GMod server

Copy `addon/lua/` into the server's `garrysmod/lua/` (or install it as an addon) and set two ConVars in `server.cfg`:

```
traitordash_url   "https://traitordash.example.com"
traitordash_token "<the server's API token>"
```

The bridge only talks to an `https://` address or a private network address, and stays idle (with one warning) without a token. Restart the server; the console should show `Bridge Initialized`, `Language files OK` and `Sync complete!`. `traitordash_stats 0` turns the round statistics off without a restart.

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

RFCs 6 and 7 describe what is implemented today; [docs/UI_DESIGN.md](./docs/UI_DESIGN.md) has the dashboard design notes.

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
