# Switchboard

A lightweight Gmail inbox PWA with 4 configurable panels and offline-friendly caching. Built with SvelteKit + TypeScript, deployed with the Node adapter.

> **Architecture Deep Dive**: See [ARCHITECTURE.md](./ARCHITECTURE.md) for a complete explanation of the backend, security model, and system design.

---

## Features

- **4 Configurable Panels** — Route emails to panels using regex rules on From/To fields
- **Gmail-like UI** — Clean list view with checkboxes, sender, subject, snippet, date, unread styling
- **Thread Detail** — View the latest message body (text/plain preferred, sanitized HTML fallback)
- **Multi-select Trash** — Select multiple threads and move to Trash in a single batch
- **Offline Support** — Cached lists and thread details available offline with clear status indicators
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

While this project uses `adapter-node`, you can deploy to Vercel by:

1. Switch to `@sveltejs/adapter-vercel` (or keep adapter-node with a custom build)
2. Set all environment variables in the Vercel dashboard
3. Set the **build command** to `npm run build`
4. Set the **output directory** to `build`

Make sure your `APP_BASE_URL` matches your Vercel domain and that the Google OAuth redirect URI is configured in Google Cloud Console.

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
│   ├── server/          # Server-only modules (never bundled for browser)
│   │   ├── auth.ts      # Unified OAuth + cookie + Gmail profile module
│   │   ├── crypto.ts    # AES-256-GCM encrypt/decrypt utilities
│   │   ├── env.ts       # Lazy environment variable access
│   │   └── pkce.ts      # PKCE code verifier/challenge generation
│   └── index.ts         # Lib barrel export
├── routes/
│   ├── +layout.svelte   # Root layout (fonts, global styles)
│   ├── +page.svelte     # Home page (auth check, connected state)
│   ├── login/           # Login page with Google sign-in button
│   ├── auth/
│   │   ├── google/      # OAuth initiation (redirect to Google)
│   │   └── callback/    # OAuth callback (exchange code, set cookies)
│   ├── logout/          # Clear cookies and redirect
│   └── api/
│       └── me/          # GET /api/me — returns authenticated user's email
├── app.html             # HTML shell
└── app.d.ts             # SvelteKit type declarations
```

## License

MIT
