# TraitorDash UI Design Document

## 1. Introduction
This document serves as the technical and aesthetic blueprint for the TraitorDash Web UI. It tracks the implementation status of features, distinguishing between fully integrated logic and purely visual elements.

**Goal:** Provide a seamless, multi-server TTT2 management experience using a "B.A.H." stack.

---

## 2. Technical Stack & Design Language

-   **Backend & Logic:** [Bun](https://bun.sh/) + [Hono](https://hono.dev/)
-   **Frontend Interactivity:** [Alpine.js](https://alpinejs.dev/) (Client-side state) + [HTMX](https://htmx.org/) (Server-side partials)
-   **Styling:** one inline stylesheet written by hand (the case-file look of [RFC 17](./rfcs/RFC-017.md)); Tailwind was dropped because the game's built-in browser (Chrome 86) cannot read its output
-   **Typography:** Inter / System Sans
-   **Theme:** Dark mode first (Slate/Gray 900 background) with high-contrast Red/Orange accents.

---

## 2b. The stylesheet and its class vocabulary

All CSS is in `backend/src/components/styles.ts`: `PUBLIC_CSS` (every page) and `ADMIN_CSS` (added on the admin pages, which only adds or overrides). Nothing a 2020 browser lacks: no `@layer`, no `inset`, no `oklch`/`color-mix` without a plain fallback.

-   **Palette.** Colours are variables on `:root`, named by use: `--ink` / `--ink2` (text on paper), `--paper`, `--desk` / `--night` (dark grounds), `--muted`, `--soft`, `--mist` (text on dark), `--dim` (quiet text on paper), `--rule` / `--edge` / `--line` (borders and rules), `--good` / `--warn` / `--bad` / `--blush` / `--amber` / `--deep` (signals). Use a variable; add a new one only when a colour is used in three places. The two font stacks are `--mono` and `--cond`.
-   **Panels.** `.f` is a card on paper (public pages), `.pn` the same card dark (admin pages). They share one set of rules; the tab colour is `--c`, set with a helper class (`c-gray`, `c-red`, `c-green`, `c-violet`, `c-mint`, `c-blue`, `c-edge`) or inline for a colour that comes from data (a role's own colour).
-   **Pills.** `.pill.ok|wait|mute` has one definition; the surface decides the colours through `--st-ok`, `--st-wait`, `--st-mute` (paper sets darker ones). Do not write a pill colour per page.
-   **Helpers.** `mt1`, `mt12`, `mt6` (margin-top), `m0`, `ml6`, `mb6`, `ul`. They win over the card rules. A margin used once stays an inline `style`; a margin used three times becomes a helper.
-   **Scripts.** `replay.ts`, `mapview.ts` and the canvas views build their lists in the browser with these same class names (`tog`, `lnk`, `prow`, `pdot`, `tick`); they cannot share JSX, only the names.

---

## 3. Feature Audit Matrix

| View / Feature | implementation Status | Type | Technical Integration |
| :--- | :--- | :--- | :--- |
| **Global Navigation** | Complete | Functional | Steam OpenID 2.0 Auth |
| **Active Route States** | Complete | Functional | Layout `path` awareness |
| **Guest Tile View** | Complete | Functional | SQLite Server Registry |
| **Server Heartbeat** | Complete | Functional | `last_seen < 30s` check |
| **Admin Landing** | Complete | Functional | Multi-node Dashboard |
| **Server Management** | Complete | Functional | CRUD API (`/api/servers`) |
| **Copy API Token** | Complete | Functional | `navigator.clipboard` (Alpine) |
| **Copy Feedback** | Complete | Aesthetic | Bounce animation & Tooltip |
| **Server Dashboard** | Complete | Functional | Per-server Role Filtering |
| **Role Config Page** | Complete | Functional | Standalone RESTful Route |
| **Dynamic Forms** | Complete | Functional | Lua -> JSON Schema Parser |
| **Slider Indicators** | Complete | Aesthetic | Alpine `x-text="value"` |
| **Command Staging** | Complete | Functional | SQLite `commands` table |

---

## 4. Routing Architecture (RESTful)

TraitorDash uses a clear hierarchy to support multi-server communities:

-   **`/`**: Landing page. (Guest: Tile View \| Admin: Node List).
-   **`/servers`**: Admin server lifecycle management (Add/Delete/Tokens).
-   **`/servers/:serverId`**: Role registry for a specific GMod node.
-   **`/servers/:serverId/roles/:roleName`**: Dedicated configuration terminal for a specific role.

---

## 5. Security Model

-   **Session Security:** Admin routes are gated via a `steam_id` cookie check.
-   **Data Isolation:** Role schemas and command queues are strictly scoped to their `server_id`.
-   **Frontend Isolation:** Guests see server names and heartbeat status only; tokens and role configurations are NEVER rendered for unauthenticated users.

---

## 6. Future Aesthetic Goals (Nice-to-Look-At)
- [ ] **Animated Background:** Subtly moving gradient or grid on the landing page.
- [ ] **Role Icons:** Scrape role icons from the GMod bridge.
- [ ] **Chart.js Integration:** Show player count history tiles for each server.
- [ ] **Toast Notifications:** Replace basic HTMX swaps with global toast alerts for "Save" actions.
