# Architecture

This document explains the entire Email Switchboard system — from how a user signs in with Google, to how emails are fetched, cached, and displayed. It is written so that someone with zero experience can understand the whole codebase.

---

## Table of Contents

1. [What is Email Switchboard?](#what-is-switchboard)
2. [High-Level Overview](#high-level-overview)
3. [Technology Stack](#technology-stack)
4. [How Authentication Works](#how-authentication-works)
5. [Security Model](#security-model)
6. [Server Architecture](#server-architecture)
7. [API Endpoints](#api-endpoints)
8. [Client Architecture](#client-architecture)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [File-by-File Guide](#file-by-file-guide)
11. [Environment Variables](#environment-variables)
12. [Testing Strategy](#testing-strategy)
13. [Glossary](#glossary)

---

## What is Email Switchboard?

Email Switchboard is a lightweight web application that shows your Gmail inbox in a clean, organized way. Instead of one big list, you can set up **4 panels** (like tabs) that filter emails based on rules you define (e.g., "emails from @github.com go to Panel 2").

Key constraints:

- **No database** — all user data lives in browser storage and encrypted cookies
- **Minimal Gmail API calls** — uses batch endpoints to fetch multiple emails at once
- **Works offline** — cached emails are viewable without an internet connection
- **Secure** — your Google credentials are encrypted, never stored in plain text

---

## High-Level Overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────▶│  SvelteKit Server │────▶│   Gmail API     │
│  (Your PC)  │◀────│  (Node.js)       │◀────│   (Google)      │
└─────────────┘     └──────────────────┘     └─────────────────┘
       │                     │
       │ Stores:             │ Caches:
       ├── Panel rules       ├── Access tokens (in-memory,
       │   (localStorage)    │   keyed by session, ~55min TTL)
       ├── Cached emails     │
       │   (IndexedDB)       │
       ├── Service worker    │
       │   (Cache API)       │
       └── UI state (memory) │
```

**The browser** renders the UI and stores panel configuration + cached emails locally.

**The SvelteKit server** acts as a secure proxy between your browser and Google's Gmail API. It holds your encrypted credentials in cookies and makes Gmail API calls on your behalf.

**Gmail API** is Google's official interface for reading/managing Gmail. We never talk to it directly from the browser — always through our server.

---

## Technology Stack

| Layer      | Technology        | Why                                           |
| ---------- | ----------------- | --------------------------------------------- |
| Framework  | SvelteKit         | Fast, SSR-capable, great DX                   |
| Language   | TypeScript        | Type safety catches bugs early                |
| Runtime    | Node.js           | Universal JS runtime, adapter-node for deploy |
| Validation | Zod               | Runtime type checking for API inputs          |
| Testing    | Vitest            | Fast, Vite-native test runner                 |
| Linting    | ESLint + Prettier | Consistent code style                         |
| Dead Code  | Knip              | Finds unused files/exports/dependencies       |

---

## How Authentication Works

Authentication uses **OAuth 2.0 Authorization Code flow with PKCE**. Here's what happens step by step:

### Step 1: User clicks "Sign in with Google"

The browser navigates to `/auth/google` (a server endpoint).

### Step 2: Server generates security tokens

The server creates two things:

- **PKCE verifier/challenge**: A random secret + its hash. The hash goes to Google; the secret stays with us. Later, we prove we're the same party by presenting the secret.
- **State parameter**: A random value for CSRF protection. We store it in a cookie and include it in the Google URL. When Google sends the user back, we verify the state matches.

Both are stored in short-lived (10-minute) HttpOnly cookies.

### Step 3: User is redirected to Google

The server sends the user to Google's consent screen with the PKCE challenge and state parameter in the URL.

### Step 4: User grants permission

Google shows a consent screen asking "Allow Switchboard to read and manage your Gmail?" The user clicks "Allow."

### Step 5: Google redirects back to our server

Google sends the user back to `/auth/callback` with:

- An **authorization code** (a one-time use token)
- The **state** parameter (so we can verify it matches our cookie)

### Step 6: Server exchanges code for tokens

Our server sends the authorization code + PKCE verifier to Google's token endpoint. Google verifies the code is valid and the PKCE verifier matches the challenge, then returns:

- **Access token**: Short-lived (~1 hour), used for API calls
- **Refresh token**: Long-lived, used to get new access tokens

### Step 7: Server stores the refresh token securely

The refresh token is **encrypted with AES-256-GCM** using a server secret, then stored in an HttpOnly cookie. This means:

- JavaScript cannot read it (HttpOnly)
- It's only sent over HTTPS in production (Secure flag)
- Even if someone intercepts the cookie, they can't decrypt it without the server secret

### Step 8: User sees "Connected as user@gmail.com"

The home page calls `/api/me`, which uses the refresh token to mint an access token, calls Gmail's profile endpoint, and returns the email address.

### Token Refresh Flow

When the access token expires (after ~1 hour), the server automatically uses the refresh token to get a new one. The user never sees this — it happens transparently on each API call.

---

## Security Model

### Cookie Security

| Cookie             | Purpose                  | HttpOnly | Secure | SameSite |
| ------------------ | ------------------------ | -------- | ------ | -------- |
| `sb_refresh`       | Encrypted refresh token  | Yes      | Yes\*  | Lax      |
| `sb_csrf`          | CSRF double-submit token | Yes      | Yes\*  | Lax      |
| `sb_pkce_verifier` | Ephemeral PKCE verifier  | Yes      | Yes\*  | Lax      |
| `sb_oauth_state`   | Ephemeral state param    | Yes      | Yes\*  | Lax      |

\*Secure flag is only set when `APP_BASE_URL` starts with `https`. In local dev (HTTP), it's disabled so cookies work.

### Encryption

The refresh token is encrypted with **AES-256-GCM** before being stored in the cookie:

- **AES-256**: Military-grade symmetric encryption
- **GCM mode**: Provides both confidentiality (encryption) and integrity (tamper detection)
- **Random IV**: Every encryption produces different output, even for the same input
- **Authentication tag**: Detects if anyone modified the ciphertext

The encrypted cookie format is: `<iv>.<authTag>.<ciphertext>` (all base64url-encoded).

### CSRF Protection

For state-changing operations (like trashing emails), we use a **double-submit cookie** pattern:

1. On login, the server sets a random CSRF token in an HttpOnly cookie
2. The client reads this token (via a dedicated endpoint) and includes it in a custom header
3. The server verifies the header matches the cookie
4. Cross-origin requests can't read our cookies, so they can't forge the header

### What We DON'T Store

- ❌ Refresh tokens in localStorage (vulnerable to XSS)
- ❌ Any tokens in a database (we have no database)
- ❌ Client secrets in browser code (only on the server)
- ❌ Unencrypted tokens in cookies (always AES-256-GCM encrypted)

---

## Server Architecture

The server has a clean separation of concerns:

```
src/lib/server/
├── auth.ts       # OAuth flow + cookie management + access token caching
├── gmail.ts      # Gmail API client (fetch, batch, thread detail)
├── headers.ts    # Email header parsing (From, Subject, Date)
├── sanitize.ts   # HTML sanitizer for email bodies (allowlist-based)
├── crypto.ts     # Low-level AES-256-GCM encrypt/decrypt
├── env.ts        # Environment variable access with lazy loading
└── pkce.ts       # PKCE code verifier/challenge generation

src/lib/
├── components/
│   └── OfflineBanner.svelte  # Global offline connectivity banner
├── cache.ts      # IndexedDB wrapper for offline thread caching
├── offline.svelte.ts  # Svelte 5 reactive online/offline state
├── types.ts      # Shared TypeScript types (used by both server and client)
└── rules.ts      # Panel rule engine (pure functions, no side effects)
```

### auth.ts — The Unified Auth Module

This is the most important file. It contains:

1. **`initiateOAuthFlow()`** — Generates PKCE + state, sets cookies, returns Google auth URL
2. **`handleOAuthCallback()`** — Validates state, exchanges code for tokens, encrypts and stores refresh token
3. **`getAccessToken()`** — Reads encrypted refresh token from cookie, exchanges it for a fresh access token. **Includes an in-memory cache** keyed by the encrypted cookie value, so multiple API calls within the same request don't trigger redundant token refreshes. Tokens are cached for `expires_in - 5 minutes` as a safety buffer.
4. **`getGmailProfile()`** — Calls Gmail's profile endpoint to get the user's email
5. **`hasRefreshToken()`** — Quick check: is the user logged in?
6. **`getCsrfToken()`** — Reads the CSRF token from the cookie
7. **`logout()`** — Deletes all auth cookies

All external HTTP calls use `fetchWithTimeout()` with a 10-second AbortController to prevent hanging.

### gmail.ts — Gmail API Client

Wraps the Gmail REST API v1 with authenticated fetch and batch support:

1. **`gmailFetch(accessToken, path)`** — Makes authenticated GET/POST requests to the Gmail API with Bearer auth + timeout + error parsing
2. **`gmailBatch(accessToken, threadIds)`** — Uses Google's batch endpoint (`multipart/mixed`) to fetch multiple threads in a single HTTP call. Automatically splits into chunks of 100 (Google's limit per batch)
3. **`listThreads(accessToken, pageToken?)`** — Calls `threads.list(userId="me", labelIds=INBOX, maxResults=50)`. Returns lightweight thread summaries (IDs + snippets only)
4. **`batchGetThreadMetadata(accessToken, threadIds)`** — Batch-fetches full headers (Subject, From, To, Date) for multiple threads. Returns structured `ThreadMetadata[]`
5. **`parseBatchResponse(responseText, boundary?)`** — Parses the `multipart/mixed` batch response format, extracting JSON bodies from successful parts. Supports boundary extraction from the Content-Type header (preferred) or fallback to first-line parsing
6. **`getThreadDetail(accessToken, threadId)`** — Fetches a single thread with `format=full` (includes message bodies). Parses the MIME tree to extract text/plain or sanitized text/html body for each message. Returns a `ThreadDetail` with all messages

**Two-Phase Fetch Pattern**: The client first calls `listThreads()` (lightweight, just IDs) then `batchGetThreadMetadata()` (heavy, full headers). This minimizes API quota usage because `threads.list` is much cheaper than `threads.get`.

**Body Extraction**: `extractMessageBody()` traverses the MIME part tree:

1. If the payload has no parts (simple message), decode the body directly
2. Search for `text/plain` part (preferred — clean, no XSS risk)
3. Fall back to `text/html` part (sanitized with allowlist-based HTML sanitizer)
4. If no body found, return empty string

### sanitize.ts — HTML Sanitizer

Server-side HTML sanitizer for email bodies. Uses a strict **allowlist approach** — only known-safe tags and attributes pass through, everything else is stripped:

1. **Tag allowlist**: `p`, `br`, `div`, `span`, `a`, `strong`, `em`, `b`, `i`, `u`, `ul`, `ol`, `li`, `h1`-`h6`, `blockquote`, `pre`, `code`, `table`, `tr`, `td`, `th`, `thead`, `tbody`, `img`
2. **Dangerous tag removal**: `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg`, `math`, `base`, `link`, `meta` — entire tag and content removed
3. **Attribute filtering**: Strips all `on*` event handlers and `javascript:`/`vbscript:`/`data:` URLs
4. **Link hardening**: All `<a>` tags get `target="_blank" rel="noopener noreferrer"`
5. No external dependencies — pure regex-based processing

### headers.ts — Email Header Parsing

Utility functions for extracting and parsing Gmail message headers:

1. **`extractHeader(headers, name)`** — Case-insensitive header lookup from the Gmail header array
2. **`parseFrom(fromHeader)`** — Parses "Display Name <email@example.com>" format into `{ name, email }`
3. **`parseDate(dateHeader)`** — Converts RFC 2822 dates to ISO 8601
4. **`extractThreadMetadata(thread)`** — Extracts structured metadata from a full Gmail thread: uses the first message for Subject/From/To, the last message for Date/snippet, and merges label IDs from all messages

### types.ts — Shared Types

Contains all TypeScript interfaces used across server and client:

- **Gmail API types**: `GmailHeader`, `GmailMessagePartBody`, `GmailMessagePart`, `GmailMessage`, `GmailThread`, `GmailThreadsListResponse` — raw shapes from the REST API
- **Domain types**: `ThreadListItem`, `ThreadMetadata`, `ParsedFrom`, `ThreadDetailMessage`, `ThreadDetail` — transformed types for the UI
- **Panel types**: `PanelConfig`, `PanelRule` — panel configuration stored in localStorage
- **Cache types**: `CachedItem<T>` — generic wrapper with `cachedAt` timestamp for staleness checks
- **API envelopes**: `ThreadsListApiResponse`, `ThreadsMetadataRequest`, `ThreadsMetadataApiResponse`, `ThreadDetailApiResponse` — request/response shapes

### rules.ts — Panel Rule Engine

A pure function module (no side effects, no I/O) that determines which panel a thread belongs to:

1. **`matchesRule(rule, from, to)`** — Tests a single rule's regex pattern (case-insensitive) against the From or To header. Invalid regex patterns are treated as non-matching with a console warning
2. **`assignPanel(panels, from, to)`** — Evaluates all panels' rules in order. First panel whose rules "accept" the thread claims it. If a panel's first matching rule is "reject", skip to next panel. If no panel claims the thread, it falls into the last panel (catch-all)
3. **`getDefaultPanels()`** — Returns 4 default panels with no rules

### crypto.ts — Encryption Utilities

Pure utility module with three functions:

- `deriveKey(base64Secret)` → Decodes and validates the 32-byte encryption key
- `encrypt(plaintext, key)` → AES-256-GCM encrypt → `iv.authTag.ciphertext`
- `decrypt(payload, key)` → Reverse of encrypt, with integrity verification

### env.ts — Environment Variables

Uses **lazy getters** instead of eager evaluation. This is important because SvelteKit's build step imports all server modules for analysis — if we eagerly read env vars, the build would fail when they're not set.

### pkce.ts — PKCE Utilities

Generates a cryptographic code verifier (32 random bytes, base64url) and its SHA-256 challenge.

---

## API Endpoints

### Authentication Endpoints

| Method | Path             | Auth Required | Description                       |
| ------ | ---------------- | ------------- | --------------------------------- |
| GET    | `/auth/google`   | No            | Redirect to Google consent screen |
| GET    | `/auth/callback` | No            | Handle OAuth callback from Google |
| GET    | `/logout`        | No            | Clear cookies, redirect to /login |
| GET    | `/api/me`        | Yes           | Returns `{ email: string }`       |

### Thread Endpoints

| Method | Path                    | Auth Required | Description                                            |
| ------ | ----------------------- | ------------- | ------------------------------------------------------ |
| GET    | `/api/threads`          | Yes           | List inbox thread IDs + snippets (supports pagination) |
| POST   | `/api/threads/metadata` | Yes           | Batch fetch full metadata for up to 100 thread IDs     |
| GET    | `/api/thread/[id]`      | Yes           | Get full thread detail with message bodies             |

#### GET /api/threads

Query params: `pageToken` (optional, for pagination)

Returns: `{ threads: ThreadListItem[], nextPageToken?: string }`

This is the lightweight first phase of the two-phase fetch. It only returns thread IDs and snippet previews — no headers or message content.

#### POST /api/threads/metadata

Request body: `{ ids: string[] }` (1-100 thread IDs, validated with Zod)

Returns: `{ threads: ThreadMetadata[] }`

Batch-fetches full metadata (Subject, From, To, Date, labels, message count) using Gmail's batch endpoint. All thread IDs are fetched in a single HTTP call to Google (or split into chunks of 100 if more).

#### GET /api/thread/[id]

Returns: `{ thread: ThreadDetail }`

Fetches a single thread with `format=full`, including all message bodies. The server extracts text/plain or sanitized text/html from each message's MIME tree and returns structured `ThreadDetailMessage[]`.

### Future Endpoints

| Method | Path                 | Description                 |
| ------ | -------------------- | --------------------------- |
| POST   | `/api/threads/trash` | Batch move threads to trash |

---

## Client Architecture

### Pages

| Route           | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `/`             | Inbox — panel tabs, thread list, config modal, auto-fill  |
| `/login`        | Sign-in page with Google button (offline-aware)           |
| `/t/[threadId]` | Thread detail — full messages with stale-while-revalidate |

### Inbox Page Data Flow

The inbox page (`+page.svelte`) follows this sequence on mount:

1. **Auth check**: `GET /api/me` — if 401, redirect to `/login`
2. **Load panels**: Read panel config from `localStorage` (or use defaults)
3. **Phase 1 fetch**: `GET /api/threads` — get thread IDs + snippets
4. **Phase 2 fetch**: `POST /api/threads/metadata` — batch fetch headers
5. **Panel assignment**: For each thread, run the rule engine to determine which panel it belongs to
6. **Render**: Show threads in the active panel's tab, sorted by date (newest first)

### Panel Rule Engine

The rule engine (`src/lib/rules.ts`) is a pure function with no side effects:

```
For each panel (in order):
  For each rule (in order):
    If rule.pattern matches thread's from/to:
      If rule.action === "accept" → thread belongs to this panel ✓
      If rule.action === "reject" → skip this panel, try next ✗
      (first matching rule wins)
  If no rules matched → skip to next panel

If no panel claimed the thread → falls into last panel (catch-all)
```

Rules use JavaScript `RegExp` with the `i` (case-insensitive) flag. Invalid regex patterns are treated as non-matching (with a console warning) so a single bad rule doesn't break the entire inbox.

### State Management

- **Auth state**: Determined by calling `/api/me` on page load
- **Thread data**: Fetched from API, stored in Svelte `$state` reactivity
- **Panel config**: Stored in `localStorage` (key: `switchboard_panels`). JSON array of `PanelConfig` objects
- **Panel stats**: Derived values computed from thread metadata (total + unread count per panel)
- **Selected threads**: `SvelteSet<string>` for reactive checkbox state
- **Email cache**: IndexedDB stores thread metadata (inbox list) and thread details (full messages) for offline access
- **Online/offline**: Reactive `$state` powered by `navigator.onLine` + `online`/`offline` events

### Date Formatting

Thread dates are displayed Gmail-style:

- **Today**: Time only (e.g., "3:42 PM")
- **This year**: Month + day (e.g., "Jan 15")
- **Older**: Short date (e.g., "1/15/24")

---

## Data Flow Diagrams

### Sign-in Flow

```
Browser                    Server                     Google
  │                          │                           │
  │  GET /auth/google        │                           │
  │─────────────────────────▶│                           │
  │                          │ Generate PKCE + state     │
  │                          │ Set cookies               │
  │  302 → Google auth URL   │                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  User grants consent ──────────────────────────────▶│
  │                          │                           │
  │  GET /auth/callback?code=...&state=...               │
  │─────────────────────────▶│                           │
  │                          │ Validate state            │
  │                          │ POST token exchange ─────▶│
  │                          │◀──── tokens ─────────────│
  │                          │ Encrypt refresh token     │
  │                          │ Set cookies               │
  │  302 → /                 │                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  GET /api/me             │                           │
  │─────────────────────────▶│                           │
  │                          │ Decrypt refresh token     │
  │                          │ POST refresh ────────────▶│
  │                          │◀──── access token ───────│
  │                          │ GET profile ─────────────▶│
  │                          │◀──── { email } ──────────│
  │  { email: "..." }        │                           │
  │◀─────────────────────────│                           │
```

### Inbox Fetch Flow (Two-Phase)

```
Browser                    Server                     Google
  │                          │                           │
  │  GET /api/threads        │                           │
  │─────────────────────────▶│                           │
  │                          │ getAccessToken() (cached) │
  │                          │ GET threads.list ────────▶│
  │                          │◀──── { threads, token } ──│
  │  { threads, nextPage }   │                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  POST /api/threads/meta  │                           │
  │  { ids: [...] }          │                           │
  │─────────────────────────▶│                           │
  │                          │ getAccessToken() (cached) │
  │                          │ POST batch ──────────────▶│
  │                          │  (multipart/mixed,        │
  │                          │   up to 100 GET requests  │
  │                          │   in one HTTP call)       │
  │                          │◀──── multipart response ──│
  │                          │ Parse response            │
  │                          │ Extract headers           │
  │  { threads: metadata[] } │                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  Client-side:            │                           │
  │  Run rule engine to      │                           │
  │  sort threads into       │                           │
  │  panels                  │                           │
```

### Thread Detail Flow

```
Browser                    Server                     Google
  │                          │                           │
  │  GET /api/thread/abc123  │                           │
  │─────────────────────────▶│                           │
  │                          │ getAccessToken() (cached) │
  │                          │ GET threads.get ─────────▶│
  │                          │  (format=full,            │
  │                          │   includes bodies)        │
  │                          │◀──── full thread ─────────│
  │                          │ Extract bodies:           │
  │                          │  1. Find text/plain       │
  │                          │  2. Fall back: sanitize   │
  │                          │     text/html             │
  │  { thread: ThreadDetail }│                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  Client-side:            │                           │
  │  Cache in IndexedDB      │                           │
  │  for offline access      │                           │
```

---

## Offline & PWA Architecture

### Service Worker (`static/sw.js`)

The service worker provides offline capability using a layered caching strategy:

| Request Type       | Strategy                  | Fallback Chain                                  |
| ------------------ | ------------------------- | ----------------------------------------------- |
| Navigation (HTML)  | Network-first             | Cached page → Cached root → Inline offline HTML |
| Static assets      | Cache-first               | Network fetch → cache for next time             |
| API requests       | Pass-through (not cached) | App handles via IndexedDB                       |
| Auth/logout routes | Pass-through (not cached) | Must always hit server                          |

**Offline fallback**: When both network and cache fail for a navigation request, the SW serves a self-contained HTML page (no external dependencies) with a "Try again" button and Gmail-like styling.

### IndexedDB Cache (`src/lib/cache.ts`)

Client-side cache backed by IndexedDB with two object stores:

| Store             | Key       | Contents                      | When Populated         |
| ----------------- | --------- | ----------------------------- | ---------------------- |
| `thread-metadata` | Thread ID | `ThreadMetadata` + `cachedAt` | After each inbox fetch |
| `thread-detail`   | Thread ID | `ThreadDetail` + `cachedAt`   | After viewing a thread |

**Stale-while-revalidate**: The thread detail page shows cached data immediately, then fetches fresh data in the background when online. The inbox page falls back to all cached metadata when offline.

### Online/Offline State (`src/lib/offline.svelte.ts`)

A Svelte 5 reactive state tracker using `$state`:

- Initial state from `navigator.onLine`
- Real-time updates via `online`/`offline` window events
- Used by the inbox page (disable load-more, show offline badge, fallback to cache)
- Used by the thread detail page (show offline badge, skip network fetch)

### Global Offline Banner (`src/lib/components/OfflineBanner.svelte`)

A fixed pill-shaped banner at the bottom of the viewport:

- Appears on **all pages** (included in root layout)
- Auto-shows when `navigator.onLine` becomes false
- Auto-hides when connectivity is restored
- Uses the same `online`/`offline` event pattern

### Auto-Fill Logic

The inbox page automatically loads more threads until each panel has enough to fill the visible area:

1. After initial fetch, check if active panel has < 15 threads
2. If yes and more pages exist, fetch the next page
3. Repeat up to 5 times (prevents infinite loops when panel rules don't match)
4. Triggers on panel tab switch (resets counter, checks new panel)
5. When all server pages are exhausted, shows "All emails loaded" indicator

---

## File-by-File Guide

### Configuration Files

| File                | Purpose                               |
| ------------------- | ------------------------------------- |
| `svelte.config.js`  | SvelteKit config with adapter-node    |
| `vite.config.ts`    | Vite config with SvelteKit + Vitest   |
| `tsconfig.json`     | TypeScript compiler options           |
| `eslint.config.js`  | ESLint rules (TS + Svelte + Prettier) |
| `.prettierrc`       | Code formatting (tabs, single quotes) |
| `knip.config.ts`    | Dead code detection config            |
| `.env.example`      | Template for environment variables    |
| `.husky/pre-commit` | Git hook: runs cleanup + validate     |

### Source Files

| File                                         | Lines | Purpose                                                  |
| -------------------------------------------- | ----- | -------------------------------------------------------- |
| `src/lib/server/auth.ts`                     | ~500  | OAuth flow, token caching, cookie management             |
| `src/lib/server/gmail.ts`                    | ~570  | Gmail API client (fetch, batch, thread detail, bodies)   |
| `src/lib/server/headers.ts`                  | ~130  | Email header parsing and metadata extraction             |
| `src/lib/server/sanitize.ts`                 | ~340  | HTML sanitizer for email bodies (allowlist-based)        |
| `src/lib/server/crypto.ts`                   | ~130  | AES-256-GCM encrypt/decrypt                              |
| `src/lib/server/pkce.ts`                     | ~55   | PKCE verifier/challenge generation                       |
| `src/lib/server/env.ts`                      | ~75   | Lazy env var access with validation                      |
| `src/lib/cache.ts`                           | ~350  | IndexedDB wrapper for offline thread caching             |
| `src/lib/offline.svelte.ts`                  | ~80   | Svelte 5 reactive online/offline state                   |
| `src/lib/components/OfflineBanner.svelte`    | ~90   | Global offline connectivity banner                       |
| `src/lib/types.ts`                           | ~350  | Shared TypeScript types                                  |
| `src/lib/rules.ts`                           | ~120  | Panel rule engine (pure functions)                       |
| `src/routes/+page.svelte`                    | ~2020 | Inbox view (panels, threads, config, offline, auto-fill) |
| `src/routes/login/+page.svelte`              | ~240  | Gmail-style login page (offline-aware)                   |
| `src/routes/t/[threadId]/+page.svelte`       | ~545  | Thread detail (cached, offline, stale-while-revalidate)  |
| `src/routes/+layout.svelte`                  | ~55   | Root layout (fonts, global styles, offline banner)       |
| `src/routes/auth/google/+server.ts`          | ~20   | OAuth initiation redirect                                |
| `src/routes/auth/callback/+server.ts`        | ~25   | OAuth callback handler                                   |
| `src/routes/logout/+server.ts`               | ~20   | Logout handler                                           |
| `src/routes/api/me/+server.ts`               | ~65   | Profile endpoint                                         |
| `src/routes/api/thread/[id]/+server.ts`      | ~75   | Thread detail endpoint (format=full + body extraction)   |
| `src/routes/api/threads/+server.ts`          | ~55   | Thread listing endpoint                                  |
| `src/routes/api/threads/metadata/+server.ts` | ~75   | Batch metadata endpoint (Zod validated)                  |
| `static/sw.js`                               | ~250  | Service worker (offline caching + fallback HTML)         |

### Test Files

| File                              | Tests | Covers                                                        |
| --------------------------------- | ----- | ------------------------------------------------------------- |
| `src/lib/server/crypto.test.ts`   | 10    | Encrypt/decrypt, key derivation, tamper detection             |
| `src/lib/server/pkce.test.ts`     | 4     | Verifier length, challenge correctness, randomness            |
| `src/lib/server/auth.test.ts`     | 27    | OAuth flow, callbacks, cookies, logout, caching               |
| `src/lib/server/gmail.test.ts`    | 33    | Batch parsing, body extraction, MIME traversal, thread detail |
| `src/lib/server/headers.test.ts`  | 31    | Header extraction, From/Date parsing, metadata                |
| `src/lib/server/sanitize.test.ts` | 47    | Tag allowlist, attribute filtering, URL sanitization          |
| `src/lib/rules.test.ts`           | 26    | Rule matching, panel assignment, edge cases                   |

---

## Environment Variables

| Variable               | Required | Description                                   |
| ---------------------- | -------- | --------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes      | OAuth client ID from Google Cloud Console     |
| `GOOGLE_CLIENT_SECRET` | Yes      | OAuth client secret (server-side only)        |
| `APP_BASE_URL`         | Yes      | Public URL (e.g., `http://localhost:5173`)    |
| `COOKIE_SECRET`        | Yes      | 32-byte base64-encoded AES-256 encryption key |

---

## Testing Strategy

### Current Test Coverage (178 tests, 7 test files)

- **crypto.ts** (10 tests): Round-trip encryption, wrong key detection, tamper detection (ciphertext + auth tag), malformed payloads, key length validation, empty string handling, special characters
- **pkce.ts** (4 tests): Verifier/challenge format, length, SHA-256 correctness, randomness
- **auth.ts** (27 tests): OAuth URL construction, state validation, error handling, cookie management, PKCE cookie lifecycle, encrypted token verification, token refresh, access token caching
- **gmail.ts** (33 tests): Batch response parsing (single/multiple/failed parts, malformed JSON, missing boundary, LF-only line endings, header-supplied boundary, leading whitespace, debug logging), authenticated fetch with mocked global `fetch`, error handling, additional headers, base64url decoding, MIME part tree traversal, body extraction (text/plain, text/html, multipart/alternative, nested multipart, empty messages)
- **headers.ts** (31 tests): Case-insensitive header extraction, From parsing (display name + email, bare email, angle brackets, quoted names, special characters, empty), date parsing (RFC 2822 → ISO 8601, timezones, unparseable), full thread metadata extraction (first/last message logic, label merging, no subject, empty messages)
- **sanitize.ts** (47 tests): Dangerous tag removal (script, style, iframe, object, embed, form, svg), allowed tag preservation, attribute filtering (event handlers, style, class), URL sanitization (javascript:, vbscript:, data:), link security (target, rel), edge cases (empty input, deeply nested, comments, malformed HTML)
- **rules.ts** (26 tests): Individual rule matching (from/to fields, case insensitivity, complex regex, invalid regex), panel assignment (multi-panel, first-match-wins, reject rules, catch-all, single panel, empty panels, overlapping rules), default panel config (immutability, structure)

### Future Tests

- **Frontend components**: Panel switching, list rendering, config modal interactions
- **Trash operations**: Batch trash with CSRF validation

---

## Glossary

| Term               | Meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **OAuth 2.0**      | An industry standard protocol for authorization                                                            |
| **PKCE**           | Proof Key for Code Exchange — prevents code interception                                                   |
| **Access Token**   | Short-lived credential (~1hr) for making API calls                                                         |
| **Refresh Token**  | Long-lived credential for getting new access tokens                                                        |
| **AES-256-GCM**    | Symmetric encryption algorithm (256-bit key, authenticated)                                                |
| **HttpOnly**       | Cookie flag that prevents JavaScript from reading the cookie                                               |
| **SameSite=Lax**   | Cookie is sent on same-site requests + top-level navigations                                               |
| **CSRF**           | Cross-Site Request Forgery — an attack where a malicious site makes requests on behalf of a logged-in user |
| **SvelteKit**      | A full-stack web framework built on Svelte                                                                 |
| **adapter-node**   | SvelteKit adapter that outputs a standalone Node.js server                                                 |
| **Service Worker** | A script that runs in the background, intercepting network requests for offline caching                    |
| **IndexedDB**      | A browser-based NoSQL database for storing structured data client-side                                     |
| **PWA**            | Progressive Web App — a web app that can be installed and works offline                                    |
| **MIME**           | Multipurpose Internet Mail Extensions — the format for email body structure (multipart/alternative, etc.)  |
| **Vitest**         | A test runner built for Vite projects                                                                      |
| **Knip**           | A tool that finds unused files, exports, and dependencies                                                  |
