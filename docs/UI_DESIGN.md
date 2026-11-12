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
-   **Helpers.** `mt1` to `mt4` (margin-top, one per step of the scale below), `sp1` to `sp3` (the space above with the other margins 0), `ml2`, `mb2`, `m0`, `ul`. They win over the card rules. A margin used once stays an inline `style` written with a step (`style="margin-top:var(--space-2)"`); the same one used three times becomes a helper.
-   **Spacing** ([RFC 30](./rfcs/RFC-030.md)). Space between things is a step of one scale, named by use like the colours, on `:root`. A `gap`, a `margin*` or a layout `padding*` is `0`, `auto`, one of these or a `calc` of them; `backend/test/spacing.test.ts` fails otherwise.

    | Variable | Value | Use |
    |---|---|---|
    | `--space-1` | `.25rem` | the least: between a label and its field, inside a control's rows |
    | `--space-2` | `.5rem` | between items of a row, between a heading and its text |
    | `--space-3` | `.8rem` | between blocks of text and controls inside a card, between the columns of a grid of cards |
    | `--space-4` | `1.2rem` | between cards (the rows of a grid, the items of a column), between the parts of a page, the padding of the big card |
    | `--space-5` | `2rem` | between the big parts of a page, the room around an empty state |
    | `--tab` | `.7rem` | the height of a card's tab (`.f:before`, `.pn:before`) |
    | `--gutter` | `1rem` | the padding around the whole page (`.w`): the frame of the page, not a space between things, so it is **not a step** and a second use needs a reason (decided 2026-11-12, RFC 30, 7.3) |

    A new value goes to the nearest step; a tie is decided by the role (`1rem` between controls inside a card is `--space-3`, between cards `--space-4`). A new step is added only when a space is used in three places, as for colours. Details inside a control (the padding of a button, a pill, a table row, a one-pixel overlap) are not layout: they stay as they are and are on the allow-list of the test, by selector, with a reason; the list only gets shorter.

    **A column of cards is `.stack`** (flex, `--space-4` between the cards, `calc(var(--tab) + var(--space-2))` above the first one, which is the room for its tab); **a grid of cards is `.g`**, and `.pair`, `.nums` (and `.tiles` on the admin pages) have the same gaps (`--space-4` between rows, `--space-3` between columns) and the same room above; only their column minimums differ. A card's tab sticks out `--tab` into the space above it, so the clear space between two cards is the gap minus the tab: a page needs no `margin-top` before its first card, and a card put under something that is not a stack or grid takes `mt4`. Text blocks inside a card are `--space-3` apart, a heading and its text `--space-2`. `.parts` (admin) is a column of big parts with `--space-5` between them. The admin page's column of a server's role groups is `.parts` (`--space-5` between the groups; it was called `.stack` before the public `.stack` took the name).
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
