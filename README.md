# Email Switchboard

A lightweight Gmail inbox PWA with 4 configurable panels and offline-friendly caching. Built with SvelteKit + TypeScript, deployed with the Node adapter.

> **Architecture Deep Dive**: See [ARCHITECTURE.md](./ARCHITECTURE.md) for a complete explanation of the backend, security model, and system design.

---

## Features

- **4 Configurable Panels** — Route emails to panels using regex rules on From/To fields
- **Global Search** — Gmail-compatible search bar supporting all operators (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `is:unread`, `label:`, etc.); results filtered through panel rules with full pagination and auto-fill
- **Settings Modal** — Centralized settings with panel configuration, configurable page size (10–100), and quick diagnostics access
- **Panel Count Estimates** — Gmail-style total and unread counts per panel tab. No-rules panels use exact INBOX counts via `users.labels.get`; rules panels use estimated counts via `resultSizeEstimate`. Estimated counts display with a `~` prefix
- **Gmail-like UI** — Clean list view with checkboxes, sender, subject, snippet, date, unread styling
- **Gmail-style Toolbar** — Multiselect dropdown (All/None/Read/Unread), trash, mark-as-read, refresh, more options, pagination controls
- **Pagination** — Configurable threads per page (10/15/20/25/50/100) with per-panel page tracking, Gmail-style "1–20 of ~N" display with estimated totals
- **Mark as Read** — Single-thread on click, batch mark selected, "Mark all as read" in panel via More menu
- **Trash** — Multi-select threads and trash with confirmation modal, optimistic UI with rollback on failure
- **Thread Detail** — View full thread messages (sanitized HTML preferred, text/plain fallback) rendered in Shadow DOM for CSS isolation; includes same search bar as main page (search navigates to inbox with `?q=` param)
- **Attachments** — Download attachments from thread detail via clickable chips showing filename and size
- **Dark Mode Email Body** — CSS filter inversion in Shadow DOM with double-inversion for images; live-syncs with theme toggle via MutationObserver
- **Light/Dark Mode** — Full theme system with CSS variables, toggle button, localStorage persistence, OS preference detection
- **Offline Support** — Service worker with dual caches (shell + immutable assets); IndexedDB for thread data; global offline banner; dark mode-aware offline fallback HTML
- **Update Notifications** — UpdateToast component with 6 detection strategies prompts users to reload when a new version is deployed
- **Responsive Design** — Adapts to tablet (768px) and mobile (480px) with flexible header, full-width search, and compact tabs
- **Auto-Fill Panels** — Silently loads more threads in the background until each panel has enough threads to fill the visible page (or all pages are exhausted). Pulsing dot on the active tab indicates loading; hover for debug details
- **Minimal API Calls** — Uses Gmail batch endpoints for metadata fetch and trash operations
- **Diagnostics Overlay** — Floating diagnostics panel accessible via Ctrl+Shift+D or Settings > Diagnostics showing cache stats, SW status, connectivity, and cache-clear actions
- **Accessibility** — Skip-to-content link, ARIA tablist/tab/tabpanel roles on panels, keyboard arrow-key navigation between tabs
- **Secure by Default** — Encrypted refresh token cookies, CSRF double-submit cookie with timing-safe validation, no client-side token storage

## User Guide (Production UI)

### Signing In

1. Visit the app URL — you'll see a "Sign in with Google" page
2. Click the button and authorize Gmail access in Google's consent screen
3. You'll be redirected to the inbox view showing your Gmail threads

### Inbox & Panels

The inbox shows your Gmail threads organized into **panels** (tabs). By default there are 4 panels: Primary, Social, Updates, and Other. Any panel with no rules shows ALL emails. Emails can appear in multiple panels if they match multiple panels' rules.

- **Switching panels**: Click a tab to view threads sorted into that panel; use arrow keys for keyboard navigation
- **Unread indicators**: Unread threads appear in bold with a blue background; unread badges are suppressed until server estimates arrive, then use server counts as source of truth with optimistic decrements on mark-as-read
- **Thread navigation**: Click any thread row to view the thread detail page (also marks it as read)
- **Pagination**: Configurable threads per page (default 20); use the Previous/Next arrows in the toolbar. Each panel remembers its page independently
- **Auto-fill**: When a panel has fewer threads than the page size, more are loaded silently in the background (up to 5 retries)

### Searching

The search bar in the navigation header supports Gmail's full search syntax:

- **Basic search**: Type any keyword and press Enter to find matching threads
- **Gmail operators**: `from:user@example.com`, `to:team@`, `subject:meeting`, `has:attachment`, `filename:report.pdf`, `before:2025/06/01`, `after:2025/01/01`, `is:unread`, `is:read`, `label:important`, `larger:5M`, `older_than:1y`
- **Compound queries**: Combine operators: `from:alice subject:project has:attachment`
- **Boolean logic**: `meeting OR standup`, `-newsletter` (exclude), `"exact phrase"`
- **Panel integration**: Search results are filtered through your panel rules — switch panels to see results sorted by category
- **Clear search**: Click the X button or press Escape to return to the normal inbox view (no re-fetch needed)
- **Offline**: Search is disabled when offline (requires Gmail API)

### Toolbar Actions

The Gmail-style toolbar appears above the thread list in each panel:

- **Select dropdown** (☐ ▼): Click the arrow for options — All, None, Read, Unread — to bulk-select threads on the current page
- **Trash** (🗑️): Enabled when ≥1 thread is selected; opens a confirmation modal then moves threads to Gmail trash
- **Mark Read** (✉): Enabled when ≥1 thread is selected; marks selected threads as read
- **Refresh** (🔄): Triggers a background refresh that surgically merges new/updated threads without losing your place
- **More options** (⋯): "Mark all as read in this panel" — marks every unread thread in the current panel as read
- **Pagination** (right side): Shows "1–20 of ~N" (with estimated totals) and Previous/Next arrow buttons

### Thread Detail

Click any thread row to view the full conversation:

- **App header**: Full navigation bar with Switchboard link, search bar, theme toggle, user email, and sign out — consistent across all pages. Search navigates back to inbox with `?q=` param
- **All messages**: Every message in the thread is displayed with sender, date, and body
- **Text/HTML bodies**: Prefers sanitized HTML for rich rendering (like Gmail); falls back to text/plain. Scripts, event handlers, dangerous tags, and malicious URIs are stripped
- **Dark mode email body**: In dark mode, email HTML is rendered with CSS filter inversion to create a dark appearance while preserving image colors via double-inversion
- **Attachments**: Each message shows attachment chips with filename and size; click to download directly from Gmail
- **Collapsed threads**: In multi-message threads, older messages are collapsed by default
- **Offline access**: Previously viewed threads are cached in IndexedDB and available offline
- **Stale-while-revalidate**: Cached data renders immediately; fresh data is fetched in the background when online

### Diagnostics

Press **Ctrl+Shift+D** on the inbox page (or click Settings > Diagnostics) to toggle a floating diagnostics overlay with two tabs:

- **Counts tab**: Live per-panel count data (server totals, unread counts, exact vs estimate flags, loaded thread counts, auto-fill status, pagination state) for diagnosing count or badge issues
- **System tab**: IndexedDB cache stats (metadata and detail entry counts), connectivity status, service worker registration and force-update, clear caches button, factory reset button

No authentication required for the diagnostics overlay.

### Offline Support

The app works offline with progressively degraded functionality:

- **Service worker**: Caches the app shell (HTML, CSS, JS) so pages load without network
- **IndexedDB cache**: Thread lists and detail are cached locally for offline viewing
- **Global banner**: A fixed pill-shaped "You're offline" banner appears on all pages
- **Login page**: Shows a warning that internet is required to sign in
- **Fallback page**: If no cached content exists, a self-contained offline HTML page is served

### Settings

Click the gear icon on the right side of the panel tabs to open the **Settings** modal.

#### Configure Panels

- **Rename panels**: Change the name of each panel in the text input
- **Add/remove panels**: Use the "+" button to add panels (up to 4) or the "x" on each tab to remove
- **Add rules**: Each panel can have regex rules that match against the **From** or **To** email header:
  - **Field**: Choose "From" or "To"
  - **Pattern**: A regex pattern (case-insensitive). Example: `@company\.com` matches all emails from that domain
  - **Action**: "Accept" (sort matching threads into this panel) or "Reject" (skip this panel for matching threads)
- First matching rule wins within each panel. Panels with no rules show all emails. Emails can appear in multiple panels

#### Page Size

Choose how many threads to display per page: 10, 15, 20 (default), 25, 50, or 100. The setting is persisted in localStorage.

#### Diagnostics

Opens the floating diagnostics overlay (same as Ctrl+Shift+D) for viewing cache stats, service worker status, and connectivity info.

Click **Save** to persist all settings.

### Example Panel Setup

| Panel       | Rule                                                        |
| ----------- | ----------------------------------------------------------- |
| Work        | From matches `@company\.com` → Accept                       |
| Social      | From matches `@(facebook\|twitter\|linkedin)\.com` → Accept |
| Newsletters | From matches `newsletter\|digest\|weekly` → Accept          |
| Other       | (no rules — shows all emails)                               |

## Developer Guide

### Prerequisites

- **Node.js** 18+ (tested on 20.x and 22.x)
- **npm** 9+
- A Google Cloud project with the Gmail API enabled
- OAuth 2.0 credentials (Web application type)

### Google Cloud Setup

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (type: Web application)
3. Add authorized redirect URI: `http://localhost:5173/auth/callback`
4. For production, add your domain: `https://your-domain.com/auth/callback`
5. Enable the **Gmail API** in [API Library](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
6. Configure the **OAuth consent screen** (External or Internal, depending on your needs)

### Local Development Setup

#### 1. Clone and install

```bash
git clone <repo-url> switchboard
cd switchboard
npm install
```

#### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
APP_BASE_URL=http://localhost:5173
COOKIE_SECRET=<generate-below>
```

Generate `COOKIE_SECRET` (32 random bytes, base64-encoded):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

#### 3. Run the dev server

```bash
npm run dev
```

Open http://localhost:5173 — you'll see the login page.

#### 4. Run tests

```bash
npm test          # Run all tests once
npm run test:watch # Watch mode
```

#### 5. Run the full validation pipeline

```bash
npm run validate  # format:check → lint → check → test → knip → build
```

#### 6. Auto-format and fix lint issues

```bash
npm run cleanup   # format → lint:fix
```

### Available Scripts

| Script             | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `npm run dev`      | Start Vite dev server with HMR                                         |
| `npm run build`    | Production build (requires env vars)                                   |
| `npm run preview`  | Preview the production build locally                                   |
| `npm run check`    | TypeScript type checking via svelte-check                              |
| `npm test`         | Run all unit tests via Vitest                                          |
| `npm run lint`     | Lint source files with ESLint                                          |
| `npm run format`   | Format all files with Prettier                                         |
| `npm run knip`     | Find unused code and dependencies                                      |
| `npm run validate` | Full CI-style validation (format + lint + check + test + knip + build) |
| `npm run cleanup`  | Auto-fix formatting and lint issues                                    |

### Production Deployment (Node)

#### Build

```bash
npm run build
```

This produces a `build/` directory with a standalone Node.js server.

#### Run

```bash
GOOGLE_CLIENT_ID=... \
GOOGLE_CLIENT_SECRET=... \
APP_BASE_URL=https://your-domain.com \
COOKIE_SECRET=... \
node build/index.js
```

The server listens on port 3000 by default. Set `PORT` env var to change it.

#### Vercel Deployment

The project auto-detects Vercel via the `VERCEL` env var and switches to `@sveltejs/adapter-vercel`:

1. Import the repo in the [Vercel Dashboard](https://vercel.com/new)
2. Set all 4 environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_BASE_URL`, `COOKIE_SECRET`)
3. Set `APP_BASE_URL` to your Vercel domain (e.g., `https://switchboard-xxx.vercel.app`)
4. Add the OAuth redirect URI in Google Cloud Console: `https://your-vercel-domain/auth/callback`
5. Deploy — the build command and output are auto-detected by Vercel

### Security Notes

- Refresh tokens are **AES-256-GCM encrypted** before being stored in cookies
- Auth cookies (`sb_session`, `sb_refresh`) are **HttpOnly, Secure (in production), SameSite=Lax**
- CSRF protection uses a **double-submit cookie** pattern — the `sb_csrf` cookie is intentionally **not HttpOnly** so the client can read it for the `x-csrf-token` header; server validates with timing-safe comparison
- The `GOOGLE_CLIENT_SECRET` is **never exposed** to the browser
- PKCE (RFC 7636) prevents authorization-code interception attacks
- Email HTML is sanitized server-side and rendered in Shadow DOM to prevent CSS/script leakage

### Pre-commit Hook

A Husky pre-commit hook runs `npm run cleanup && npm run validate` before every commit to ensure code quality. To skip it in an emergency:

```bash
git commit --no-verify -m "emergency fix"
```

### Project Structure

```
src/
├── lib/
│   ├── server/              # Server-only modules (never bundled for browser)
│   │   ├── auth.ts          # OAuth + cookie + token caching + CSRF validation
│   │   ├── gmail.ts         # Gmail API client (fetch, batch, thread detail, attachments, trash)
│   │   ├── headers.ts       # Email header parsing (From, Subject, Date)
│   │   ├── sanitize.ts      # HTML sanitizer for email bodies (primary security boundary)
│   │   ├── crypto.ts        # AES-256-GCM encrypt/decrypt utilities
│   │   ├── env.ts           # Lazy environment variable access
│   │   └── pkce.ts          # PKCE code verifier/challenge generation
│   ├── components/
│   │   ├── OfflineBanner.svelte  # Global offline connectivity banner
│   │   └── UpdateToast.svelte    # Deployment update notification toast
│   ├── stores/
│   │   └── theme.ts         # Light/dark theme store (writable + localStorage)
│   ├── cache.ts             # IndexedDB wrapper for offline thread caching
│   ├── csrf.ts              # Client-side CSRF token reader (double-submit cookie)
│   ├── format.ts            # Display formatting (HTML entities, dates, relative time)
│   ├── inbox.ts             # Inbox data management (surgical thread merge)
│   ├── offline.svelte.ts    # Svelte 5 reactive online/offline state
│   ├── types.ts             # Shared TypeScript types (Gmail, panels, API, attachments, trash)
│   ├── rules.ts             # Panel rule engine (pure functions, shared)
│   └── index.ts             # Lib barrel export
├── routes/
│   ├── +layout.svelte       # Root layout (skip link, theme init, offline banner, update toast)
│   ├── +page.svelte         # Inbox view (toolbar, pagination, panels, trash, mark-as-read)
│   ├── login/               # Login page (offline-aware)
│   ├── t/[threadId]/        # Thread detail (app header, attachments, dark mode email body)
│   ├── diagnostics/         # Diagnostics page (cache stats, SW status, connectivity)
│   ├── auth/
│   │   ├── google/          # OAuth initiation (redirect to Google)
│   │   └── callback/        # OAuth callback (exchange code, set cookies)
│   ├── logout/              # Clear cookies and redirect
│   └── api/
│       ├── me/              # GET /api/me — user profile
│       ├── thread/[id]/     # GET /api/thread/[id] — full thread detail
│       │   └── attachment/  # GET /api/thread/[id]/attachment — download attachment
│       └── threads/
│           ├── +server.ts   # GET /api/threads — list threads (supports search via q param)
│           ├── counts/      # POST /api/threads/counts — per-panel estimated counts
│           ├── metadata/    # POST /api/threads/metadata — batch metadata
│           ├── read/        # POST /api/threads/read — mark threads as read
│           └── trash/       # POST /api/threads/trash — batch trash threads
├── app.css                  # Global CSS variables (light/dark themes) + skip link + base reset
├── app.html                 # HTML shell (manifest + SW registration)
└── app.d.ts                 # SvelteKit type declarations

static/
├── sw.js                    # Service worker (offline caching + fallback)
├── manifest.webmanifest            # PWA manifest
└── favicon.svg              # App icon
```

## License

MIT
