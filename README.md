# Email Switchboard

A lightweight Gmail inbox PWA with 4 configurable panels and offline-friendly caching. Built with SvelteKit + TypeScript, deployed with the Node adapter.

> **Architecture Deep Dive**: See [ARCHITECTURE.md](./ARCHITECTURE.md) for a complete explanation of the backend, security model, and system design.

---

## Features

- **4 Configurable Panels** — Route emails to panels using regex rules on From/To fields
- **Gmail-like UI** — Clean list view with checkboxes, sender, subject, snippet, date, unread styling
- **Thread Detail** — View full thread messages (text/plain preferred, sanitized HTML fallback)
- **Offline Support** — Service worker caches app shell; IndexedDB caches thread data; global offline banner on all pages; inline offline fallback HTML when no cache exists
- **Auto-Fill Panels** — Automatically loads more threads until each panel has enough to fill the visible area
- **Minimal API Calls** — Uses Gmail batch endpoints for metadata fetch and trash operations
- **Secure by Default** — Encrypted refresh token cookies, CSRF protection, no client-side token storage

## Prerequisites

- **Node.js** 18+ (tested on 20.x and 22.x)
- **npm** 9+
- A Google Cloud project with the Gmail API enabled
- OAuth 2.0 credentials (Web application type)

## Google Cloud Setup

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (type: Web application)
3. Add authorized redirect URI: `http://localhost:5173/auth/callback`
4. For production, add your domain: `https://your-domain.com/auth/callback`
5. Enable the **Gmail API** in [API Library](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
6. Configure the **OAuth consent screen** (External or Internal, depending on your needs)

## Local Development Setup

### 1. Clone and install

```bash
git clone <repo-url> switchboard
cd switchboard
npm install
```

### 2. Configure environment variables

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

### 3. Run the dev server

```bash
npm run dev
```

Open http://localhost:5173 — you'll see the login page.

### 4. Run tests

```bash
npm test          # Run all tests once
npm run test:watch # Watch mode
```

### 5. Run the full validation pipeline

```bash
npm run validate  # format:check → lint → check → test → knip → build
```

### 6. Auto-format and fix lint issues

```bash
npm run cleanup   # format → lint:fix
```

## Available Scripts

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

## Production Deployment (Node)

### Build

```bash
npm run build
```

This produces a `build/` directory with a standalone Node.js server.

### Run

```bash
GOOGLE_CLIENT_ID=... \
GOOGLE_CLIENT_SECRET=... \
APP_BASE_URL=https://your-domain.com \
COOKIE_SECRET=... \
node build/index.js
```

The server listens on port 3000 by default. Set `PORT` env var to change it.

### Vercel Deployment

The project auto-detects Vercel via the `VERCEL` env var and switches to `@sveltejs/adapter-vercel`:

1. Import the repo in the [Vercel Dashboard](https://vercel.com/new)
2. Set all 4 environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_BASE_URL`, `COOKIE_SECRET`)
3. Set `APP_BASE_URL` to your Vercel domain (e.g., `https://switchboard-xxx.vercel.app`)
4. Add the OAuth redirect URI in Google Cloud Console: `https://your-vercel-domain/auth/callback`
5. Deploy — the build command and output are auto-detected by Vercel

## User Guide (Production UI)

### Signing In

1. Visit the app URL — you'll see a "Sign in with Google" page
2. Click the button and authorize Gmail access in Google's consent screen
3. You'll be redirected to the inbox view showing your Gmail threads

### Inbox & Panels

The inbox shows your Gmail threads organized into **panels** (tabs). By default there are 4 panels: Primary, Social, Updates, and Other. Since no rules are configured initially, all threads appear in the last panel (Other) as a catch-all.

- **Switching panels**: Click a tab to view threads sorted into that panel
- **Unread indicators**: Unread threads appear in bold with a blue background; the tab badge shows the unread count
- **Thread navigation**: Click any thread row to view the thread detail page
- **Pagination**: Click "Load more threads" at the bottom to fetch the next page
- **Auto-fill**: When a panel has fewer threads than needed to fill the screen, more are loaded automatically
- **All loaded**: When all server threads have been fetched, an "All emails loaded" indicator appears
- **Selection**: Use checkboxes for future bulk actions (coming in a later update)

### Thread Detail

Click any thread row to view the full conversation:

- **All messages**: Every message in the thread is displayed with sender, date, and body
- **Text/HTML bodies**: Prefers text/plain; falls back to sanitized HTML (scripts, event handlers, and dangerous URLs are stripped)
- **Collapsed threads**: In multi-message threads, older messages are collapsed by default
- **Offline access**: Previously viewed threads are cached in IndexedDB and available offline
- **Stale-while-revalidate**: Cached data renders immediately; fresh data is fetched in the background when online

### Offline Support

The app works offline with progressively degraded functionality:

- **Service worker**: Caches the app shell (HTML, CSS, JS) so pages load without network
- **IndexedDB cache**: Thread lists and detail are cached locally for offline viewing
- **Global banner**: A fixed pill-shaped "You're offline" banner appears on all pages
- **Login page**: Shows a warning that internet is required to sign in
- **Fallback page**: If no cached content exists, a self-contained offline HTML page is served

### Configuring Panels

Click the gear icon on the right side of the panel tabs to open the **Configure Panels** modal.

- **Rename panels**: Change the name of each panel in the text input
- **Add/remove panels**: Use the "+" button to add panels (up to 4) or the "x" on each tab to remove
- **Add rules**: Each panel can have regex rules that match against the **From** or **To** email header:
  - **Field**: Choose "From" or "To"
  - **Pattern**: A regex pattern (case-insensitive). Example: `@company\.com` matches all emails from that domain
  - **Action**: "Accept" (sort matching threads into this panel) or "Reject" (skip this panel for matching threads)
- First matching rule wins. Threads that don't match any panel's rules fall into the last panel
- Click **Save** to persist your configuration (stored in your browser's localStorage)

### Example Panel Setup

| Panel       | Rule                                                        |
| ----------- | ----------------------------------------------------------- |
| Work        | From matches `@company\.com` → Accept                       |
| Social      | From matches `@(facebook\|twitter\|linkedin)\.com` → Accept |
| Newsletters | From matches `newsletter\|digest\|weekly` → Accept          |
| Other       | (no rules — catch-all for everything else)                  |

## Security Notes

- Refresh tokens are **AES-256-GCM encrypted** before being stored in cookies
- All auth cookies are **HttpOnly, Secure (in production), SameSite=Lax**
- CSRF protection uses a **double-submit cookie** pattern
- The `GOOGLE_CLIENT_SECRET` is **never exposed** to the browser
- PKCE (RFC 7636) prevents authorization-code interception attacks

## Pre-commit Hook

A Husky pre-commit hook runs `npm run cleanup && npm run validate` before every commit to ensure code quality. To skip it in an emergency:

```bash
git commit --no-verify -m "emergency fix"
```

## Project Structure

```
src/
├── lib/
│   ├── server/              # Server-only modules (never bundled for browser)
│   │   ├── auth.ts          # OAuth + cookie + token caching + Gmail profile
│   │   ├── gmail.ts         # Gmail API client (fetch, batch, thread detail)
│   │   ├── headers.ts       # Email header parsing (From, Subject, Date)
│   │   ├── sanitize.ts      # HTML sanitizer for email bodies (allowlist-based)
│   │   ├── crypto.ts        # AES-256-GCM encrypt/decrypt utilities
│   │   ├── env.ts           # Lazy environment variable access
│   │   └── pkce.ts          # PKCE code verifier/challenge generation
│   ├── components/
│   │   └── OfflineBanner.svelte  # Global offline connectivity banner
│   ├── cache.ts             # IndexedDB wrapper for offline thread caching
│   ├── offline.svelte.ts    # Svelte 5 reactive online/offline state
│   ├── types.ts             # Shared TypeScript types (Gmail, panels, API)
│   ├── rules.ts             # Panel rule engine (pure functions, shared)
│   └── index.ts             # Lib barrel export
├── routes/
│   ├── +layout.svelte       # Root layout (fonts, global styles, offline banner)
│   ├── +page.svelte         # Inbox view (panels, thread list, config modal)
│   ├── login/               # Login page (offline-aware)
│   ├── t/[threadId]/        # Thread detail page (cached + offline support)
│   ├── auth/
│   │   ├── google/          # OAuth initiation (redirect to Google)
│   │   └── callback/        # OAuth callback (exchange code, set cookies)
│   ├── logout/              # Clear cookies and redirect
│   └── api/
│       ├── me/              # GET /api/me — user profile
│       ├── thread/[id]/     # GET /api/thread/[id] — full thread detail
│       └── threads/         # GET /api/threads — list threads
│           └── metadata/    # POST /api/threads/metadata — batch metadata
├── app.html                 # HTML shell (manifest + SW registration)
└── app.d.ts                 # SvelteKit type declarations

static/
├── sw.js                    # Service worker (offline caching + fallback)
├── manifest.json            # PWA manifest
└── favicon.svg              # App icon
```

## License

MIT
