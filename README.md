# TraitorDash 🕵️‍♂️💻

**Dynamic Web Configuration Manager for TTT2 (Garry's Mod)**

TraitorDash is an external, web-based admin panel designed specifically for TTT2 (Trouble in Terrorist Town 2) servers. It allows server owners to manage role configurations, ConVars, and internal TTT2 data through a clean, modern web interface—without ever needing to join the server or touch a `.cfg` file.

---

### ⚠️ Project Status: Hobbyist & First Steps
**This is a hobby project.** It marks my first journey into the world of Garry's Mod Lua and Source Engine development. While the architecture is designed to be robust, please expect "newbie" mistakes in the Lua implementation! Feedback and contributions from seasoned GMod devs are highly welcome.

---

### ✨ Key Features

-   **"Automagic" Schema Extraction:** No manual form building. The system parses your installed roles' Lua files in a headless VM to automatically generate a mirroring web UI.
-   **RCON-less Security:** Uses a pull-based **Command Queue** via HTTP polling. You never have to expose your RCON password or open ports on your home router.
-   **TTT2 Native Support:** Deep integration with TTT2's internal registration system, including support for `TTT2.DATA` (SQLite) and standard ConVars.
-   **Steam Identity:** Zero-config administration. Log in with Steam, and TraitorDash automatically syncs your permissions from the GMod server using **CAMI**.
-   **B.A.H. Stack:** Built with modern, high-performance tools: **Bun**, **Alpine.js**, and **HTMX** for a snappy, server-rendered experience.

---

### 🏗️ Architecture

TraitorDash is split into two parts:

1.  **The TraitorLink Bridge (GMod Side):** A lightweight Lua plugin that discovers installed roles, scrapes localization files, and polls the web backend for pending changes.
2.  **The TraitorDash Backend (Web Side):** A Bun-powered server that executes role code in a mocked Fengari VM, extracts the UI schema, and hosts the admin dashboard.

---

### 🛠️ Tech Stack

-   **Backend:** [Bun](https://bun.sh/) + [Hono](https://hono.dev/) (TypeScript)
-   **Lua VM:** [Fengari](https://fengari.io/) (Headless extraction)
-   **Database:** `bun:sqlite`
-   **Frontend:** [HTMX](https://htmx.org/) + [Alpine.js](https://alpinejs.dev/) + [Tailwind CSS](https://tailwindcss.com/)
-   **Auth:** Steam OpenID

---

### 📜 Documentation & RFCs

The project is built following a series of Request for Comments (RFCs) that outline the core logic:

-   [RFC 1: Project Vision](./docs/rfcs/RFC-001.md)
-   [RFC 2: The TraitorLink Bridge](./docs/rfcs/RFC-002.md)
-   [RFC 3: Headless Extraction](./docs/rfcs/RFC-003.md)
-   [RFC 4: Web Dashboard Design](./docs/rfcs/RFC-004.md)
-   [RFC 5: Identity & Multi-Server](./docs/rfcs/RFC-005.md)
-   [RFC 6: Secure Command Queue](./docs/rfcs/RFC-006.md)

---

### 🤝 Contributing

As this is my first GMod project, I'm especially interested in:
-   Lua best practices for performance and stability.
-   Improved mocking of the GMod environment for schema extraction.
-   Security audits of the Command Queue logic.

Feel free to open an issue or submit a PR!

---

### ⚖️ License

Distributed under the MIT License. See `LICENSE` for more information.
