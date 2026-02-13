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
12. [Glossary](#glossary)

---

## What is Email Switchboard?

Email Switchboard is a lightweight web application that shows your Gmail inbox in a clean, organized way. Instead of one big list, you can set up **panels** (like tabs) that filter emails based on rules you define (e.g., "emails from @github.com go to Panel 2"). Panels with no rules show all emails, and emails can appear in multiple panels.

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
| `sb_csrf`          | CSRF double-submit token | **No**   | Yes\*  | Lax      |
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

1. On login, the server sets a random CSRF token in a cookie (`httpOnly: false` so client JS can read it)
2. The client reads this token from `document.cookie` via `getCsrfToken()` (`src/lib/csrf.ts`) and includes it in an `x-csrf-token` request header
3. The server's `validateCsrf()` verifies the header matches the cookie using `timingSafeEqual` (prevents timing attacks)
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
├── sanitize.ts   # HTML sanitizer for email bodies (primary security boundary)
├── crypto.ts     # Low-level AES-256-GCM encrypt/decrypt
├── env.ts        # Environment variable access with lazy loading
└── pkce.ts       # PKCE code verifier/challenge generation

src/lib/
├── components/
│   └── OfflineBanner.svelte  # Global offline connectivity banner
├── cache.ts      # IndexedDB wrapper for offline thread caching
├── csrf.ts       # Client-side CSRF token reader (reads sb_csrf cookie)
├── format.ts     # Display formatting (HTML entities, dates, relative time)
├── inbox.ts      # Inbox data management (surgical thread merge for cache-first UI)
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
5. **`validateCsrf(cookies, requestHeaders)`** — Timing-safe comparison of the `sb_csrf` cookie value against the `x-csrf-token` header (double-submit pattern)
6. **`logout()`** — Deletes all auth cookies

All external HTTP calls use `fetchWithTimeout()` with a 10-second AbortController to prevent hanging.

### gmail.ts — Gmail API Client

Wraps the Gmail REST API v1 with authenticated fetch and batch support:

1. **`gmailFetch(accessToken, path)`** — Makes authenticated GET/POST requests to the Gmail API with Bearer auth + timeout + error parsing
2. **`gmailBatch(accessToken, threadIds)`** — Uses Google's batch endpoint (`multipart/mixed`) to fetch multiple threads in a single HTTP call. Automatically splits into chunks of 100 (Google's limit per batch)
3. **`listThreads(accessToken, pageToken?, maxResults?, q?)`** — Calls `threads.list(userId="me", labelIds=INBOX)`. Returns lightweight thread summaries (IDs + snippets + `resultSizeEstimate`). Supports optional `q` parameter for Gmail search queries
4. **`batchGetThreadMetadata(accessToken, threadIds)`** — Batch-fetches full headers (Subject, From, To, Date) for multiple threads. Returns structured `ThreadMetadata[]`
5. **`parseBatchResponse(responseText, boundary?)`** — Parses the `multipart/mixed` batch response format, extracting JSON bodies from successful parts. Supports boundary extraction from the Content-Type header (preferred) or fallback to first-line parsing
6. **`getThreadDetail(accessToken, threadId)`** — Fetches a single thread with `format=full` (includes message bodies). Parses the MIME tree to extract text/plain or sanitized text/html body for each message. Calls `extractAttachments()` to include attachment info per message. Returns a `ThreadDetail` with all messages
7. **`extractAttachments(payload, messageId)`** — Walks the MIME tree to find parts with a `filename` and `body.attachmentId`, returning `AttachmentInfo[]`
8. **`getAttachment(accessToken, messageId, attachmentId)`** — Fetches raw attachment data via Gmail's dedicated `/messages/{id}/attachments/{attId}` endpoint
9. **`markThreadAsRead(accessToken, threadId)`** — `POST /users/me/threads/{id}/modify` removing the UNREAD label
10. **`batchMarkAsRead(accessToken, threadIds)`** — Parallel `Promise.allSettled` mark-as-read for multiple threads
11. **`batchTrashThreads(accessToken, threadIds)`** — Batch POST to `/threads/{id}/trash` using Gmail's `multipart/mixed` batch endpoint, with automatic chunking for > 100 IDs
12. **`parseTrashBatchResponse(responseText, threadIds, boundary?)`** — Parses the batch trash response into `TrashResultItem[]`
13. **`getEstimatedCounts(accessToken, queries)`** — Fetches estimated total and unread thread counts for each query string using `resultSizeEstimate` (calls `threads.list` with `maxResults=1` per query). Empty queries return `{total: 0, unread: 0}` without making API calls
14. **`getInboxLabelCounts(accessToken)`** — Returns exact INBOX thread counts (total and unread) via `users.labels.get(INBOX)`. Used for panels with no rules where exact counts are available without query estimation

**Two-Phase Fetch Pattern**: The client first calls `listThreads()` (lightweight, just IDs) then `batchGetThreadMetadata()` (heavy, full headers). This minimizes API quota usage because `threads.list` is much cheaper than `threads.get`.

**Body Extraction**: `extractMessageBody()` traverses the MIME part tree (HTML-preferred, like Gmail):

1. If the payload has no parts (simple message), decode the body directly
2. Search for `text/html` part (preferred — rich rendering with sanitization)
3. Fall back to `text/plain` part (displayed in a `<pre>` block)
4. If no body found, return empty string

### sanitize.ts — HTML Sanitizer

Server-side HTML sanitizer for email bodies. This is the **primary security boundary** for inline rendering — the client renders sanitized HTML inside a Shadow DOM (which provides CSS isolation only, not script sandboxing).

Sanitization passes (in order):

1. **Script stripping**: `<script>` tags and content (multi-pass loop for nested/malformed cases)
2. **Dangerous embed tag removal**: `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<noscript>` — tag and content removed
3. **Structural/meta tag removal**: `<link>`, `<meta>`, `<base>` — tag and content removed
4. **Form element stripping**: `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`, `<option>`, `<optgroup>` — tag removed, child content preserved
5. **SVG foreignObject stripping**: `<foreignObject>` and content removed (prevents arbitrary HTML inside SVGs)
6. **Event handler removal**: Strips all `on*` attributes (`onclick`, `onerror`, `onload`, etc.)
7. **Dangerous URI sanitization**: Strips `href`/`src`/`srcset`/`xlink:href`/`formaction`/`action`/`poster` when value starts with `javascript:`, `vbscript:`, or `data:` (except `data:image/` in `src`). Handles whitespace/encoding obfuscation tricks
8. **Link safety**: All `<a>` tags get `target="_blank" rel="noopener noreferrer"`

**Attribute matching**: All tag-matching regexes use a robust attribute pattern (`(?:[^>"']|"[^"]*"|'[^']*')*`) instead of the naive `[^>]*`, correctly handling `>` characters inside quoted attribute values (e.g., `<script title="a > b">`).

**Preserved**: `<style>` (Shadow DOM scopes it), `<img>`, `<svg>` (minus foreignObject), inline `style` attributes, tables, all standard formatting tags. No external dependencies — pure regex-based processing

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
- **Attachment types**: `AttachmentInfo` — filename, mimeType, size, attachmentId, messageId
- **Trash types**: `TrashResultItem` — per-thread result for batch trash operations
- **Panel types**: `PanelConfig`, `PanelRule` — panel configuration stored in localStorage
- **Cache types**: `CachedItem<T>` — generic wrapper with `cachedAt` timestamp for staleness checks
- **API envelopes**: `ThreadsListApiResponse`, `ThreadsMetadataApiResponse` — response shapes for list and batch metadata endpoints

### rules.ts — Panel Rule Engine

A pure function module (no side effects, no I/O) that determines which panel a thread belongs to:

1. **`matchesRule(rule, from, to)`** — Tests a single rule's regex pattern (case-insensitive) against the From or To header. Invalid regex patterns are treated as non-matching with a console warning
2. **`threadMatchesPanel(panel, from, to)`** — Tests whether a thread matches a single panel. Panels with no rules match ALL threads. Returns `true` if the panel accepts the thread (or has no rules), `false` if rejected or unmatched. Used for frontend filtering where emails can appear in multiple panels
3. **`getDefaultPanels()`** — Returns 4 default panels with no rules
4. **`regexToGmailTerms(pattern)`** — Converts a regex pattern to an array of Gmail search terms. Handles `(a|b)` groups, top-level `|` alternatives, and regex metacharacter cleanup
5. **`panelRulesToGmailQuery(panel)`** — Converts a panel's rules to a Gmail search query string. Accept rules are OR'd with `{}` syntax, reject rules are negated. Returns an empty string for panels with no rules (these use exact INBOX counts instead)

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

| Method | Path                          | Auth Required | Description                                                       |
| ------ | ----------------------------- | ------------- | ----------------------------------------------------------------- |
| GET    | `/api/threads`                | Yes           | List inbox thread IDs + snippets (supports pagination and search) |
| POST   | `/api/threads/metadata`       | Yes           | Batch fetch full metadata for up to 100 thread IDs                |
| GET    | `/api/thread/[id]`            | Yes           | Get full thread detail with message bodies                        |
| POST   | `/api/threads/read`           | Yes           | Batch mark threads as read (1-100 IDs)                            |
| POST   | `/api/threads/trash`          | Yes + CSRF    | Batch move threads to trash (1-100 IDs, CSRF validated)           |
| POST   | `/api/threads/counts`         | Yes           | Per-panel total and unread counts (exact or estimated)            |
| GET    | `/api/thread/[id]/attachment` | Yes           | Download an email attachment (binary)                             |

#### GET /api/threads

Query params: `pageToken` (optional, for pagination), `q` (optional, Gmail search query)

Returns: `{ threads: ThreadListItem[], nextPageToken?: string, resultSizeEstimate?: number }`

This is the lightweight first phase of the two-phase fetch. It only returns thread IDs and snippet previews — no headers or message content. The `q` parameter supports Gmail's full search syntax (`from:`, `to:`, `subject:`, `has:attachment`, `before:`, `after:`, `is:unread`, `label:`, `OR`, `-` negation, etc.). Search results are always scoped to the inbox (`labelIds=INBOX`).

#### POST /api/threads/metadata

Request body: `{ ids: string[] }` (1-100 thread IDs, validated with Zod)

Returns: `{ threads: ThreadMetadata[] }`

Batch-fetches full metadata (Subject, From, To, Date, labels, message count) using Gmail's batch endpoint. All thread IDs are fetched in a single HTTP call to Google (or split into chunks of 100 if more).

#### POST /api/threads/counts

Request body: `{ panels: PanelConfig[], searchQuery?: string }`

Returns: `{ counts: Array<{ total: number; unread: number; isEstimate: boolean }> }`

For each panel, determines counts differently based on whether the panel has rules:

- **No-rules panels**: Uses `getInboxLabelCounts()` for exact INBOX thread counts (`isEstimate: false`). If a `searchQuery` is provided, falls back to estimated counts.
- **Rules panels**: Converts regex rules to Gmail search queries using `panelRulesToGmailQuery()`, then calls `threads.list` with `maxResults=1` to get `resultSizeEstimate` (`isEstimate: true`).

The `isEstimate` flag controls whether the UI displays a `~` prefix on the count. This endpoint is non-critical — failures are silently ignored by the UI, which falls back to loaded-thread counts.

#### GET /api/thread/[id]

Returns: `{ thread: ThreadDetail }`

Fetches a single thread with `format=full`, including all message bodies. The server extracts text/plain or sanitized text/html from each message's MIME tree and returns structured `ThreadDetailMessage[]`.

---

## Client Architecture

### Pages

| Route           | Purpose                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`             | Inbox — panel tabs, toolbar, pagination, trash, mark-as-read, stale-while-revalidate                        |
| `/login`        | Sign-in page with Google button (offline-aware)                                                             |
| `/t/[threadId]` | Thread detail — messages, attachments, dark mode email body, Shadow DOM, search bar, stale-while-revalidate |

### Inbox Page Data Flow (Cache-First Architecture)

The inbox page (`+page.svelte`) uses a **cache-first** strategy that prioritizes showing cached data instantly, then merging fresh server data surgically in the background. This prevents the "blank flash" that occurs when the thread list is emptied and progressively refilled on each page load.

**On mount:**

1. **Auth check**: `GET /api/me` — if 401, redirect to `/login`
2. **Load panels**: Read panel config from `localStorage` (or use defaults)
3. **Load cache**: Read all cached thread metadata from IndexedDB → display immediately
4. **Fetch counts early**: `fetchPanelCounts()` fires immediately (parallel with data loading). This ensures pagination shows stable server counts from the start, not increasing loaded-thread counts. Unread badges also appear as soon as counts arrive (without waiting for auto-fill to finish)
5. **Background refresh** (if online + has cache): `fetchThreadPage()` → `mergeThreads(existing, server, 'refresh')` — surgically updates/adds threads without clearing the list
6. **Blocking fetch** (if online + no cache): `initialBlockingFetch()` with a loading spinner (first-ever visit)
7. **Auto-fill**: `maybeAutoFill()` silently loads more pages until the active panel has enough threads for the current page
8. **Panel filtering**: For each thread, `threadMatchesPanel()` determines which panels it appears in. Panels with no rules show all threads; emails can appear in multiple panels
9. **Render**: Show threads in the active panel's tab, sorted by date (newest first)

**Surgical merge (`mergeThreads` in `src/lib/inbox.ts`):**

The merge function takes the existing thread list + server threads and returns a new list:

- **'refresh' mode** (background refresh of page 1): Updates existing threads in-place with fresh data (e.g., label changes, new snippets), prepends new threads. Does NOT remove threads missing from this page (they may be on later pages, not deleted).
- **'append' mode** (pagination): Adds only threads not already present in the list, deduplicating by thread ID.

This approach ensures the user never sees the list go blank — they see their cached emails immediately, and updates appear seamlessly.

**Error handling:** Background fetch failures show a dismissible error toast (not a page-level error), so the user can still interact with cached data. Critical errors (auth failure, no data at all) still show the error page.

**Search flow:**

1. User types a query and presses Enter
2. `executeSearch()` clears search state, calls `fetchThreadPage(undefined, query)`
3. Results are stored in separate `searchThreadMetaList` (preserves inbox data)
4. Panel assignment runs on search results — each panel shows its matching subset
5. `fetchPanelCounts(searchQuery)` fetches search-scoped counts for every panel (all show `~` estimates during search)
6. Auto-fill loads additional pages if the active panel has fewer threads than `currentPage * pageSize`
7. All operations (trash, mark read, select) work on search results and sync back to inbox list
8. Clearing search returns to the normal inbox view instantly — badges and counts revert to inbox estimates (no re-fetch)

### Panel Rule Engine

The rule engine (`src/lib/rules.ts`) uses `threadMatchesPanel` for per-panel filtering:

**`threadMatchesPanel` (frontend filtering):**

```
For a single panel:
  If panel has no rules → matches ALL threads (returns true)
  For each rule (in order):
    If rule.pattern matches thread's from/to:
      If rule.action === "accept" → matches ✓
      If rule.action === "reject" → does not match ✗
  If no rules matched → does not match ✗
```

Emails can appear in multiple panels because `threadMatchesPanel` evaluates each panel independently. Panels with no rules act as "show all" panels.

Rules use JavaScript `RegExp` with the `i` (case-insensitive) flag. Invalid regex patterns are treated as non-matching (with a console warning) so a single bad rule doesn't break the entire inbox.

### State Management

- **Auth state**: Determined by calling `/api/me` on page load
- **Thread data**: Fetched from API, stored in Svelte `$state` reactivity
- **Search state**: Separate `searchThreadMetaList`, pagination tokens, and per-panel pages for search results — preserves inbox state so toggling between search and inbox is instant
- **Panel config**: Stored in `localStorage` (key: `switchboard_panels`). JSON array of `PanelConfig` objects
- **Panel stats**: Derived values computed from thread metadata, with server-side count estimates preferred when available
- **Inbox count estimates**: Fetched from `/api/threads/counts` (no search query), stored as `inboxCountEstimates`, refreshed after operations (trash, mark-all-read, refresh, config save). Each entry includes `{ total, unread, isEstimate }`
- **Search count estimates**: Fetched from `/api/threads/counts` (with search query), stored as `searchCountEstimates`, refreshed on search execution
- **Unread badges**: Suppressed until server estimates arrive. Server counts are the source of truth; optimistically decremented on mark-as-read
- **Page size**: Configurable via Settings modal, persisted to localStorage under `switchboard_page_size` (default: 20, options: 10/15/20/25/50/100)
- **Selected threads**: `SvelteSet<string>` for reactive checkbox state
- **Email cache**: IndexedDB stores thread metadata (inbox list) and thread details (full messages) for offline access
- **Online/offline**: Reactive `$state` powered by `navigator.onLine` + `online`/`offline` events

### Display Formatting (`src/lib/format.ts`)

Pure utility functions for formatting Gmail API data for display. All date functions accept an optional `now` parameter for deterministic testing.

**HTML Entity Decoding**: Gmail's API returns snippets with HTML-encoded entities (`&#39;`, `&amp;`, etc.). `decodeHtmlEntities()` resolves these to readable characters for clean display in both the inbox list and thread detail views.

**Inbox List Dates** (`formatListDate`): Gmail-style compact formatting:

- **Today**: Time only (e.g., "3:42 PM")
- **This year**: Month + day (e.g., "Jan 15")
- **Older**: Short date (e.g., "1/15/24")

**Thread Detail Dates** (`formatDetailDate`): Full absolute date with relative time:

- Format: `"Feb 11, 2026, 11:29 PM (2 hours ago)"`
- Relative time uses `formatRelativeTime()` which cascades from years → months → weeks → days → hours → minutes → "just now"

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
  │                          │  1. Find text/html →      │
  │                          │     sanitize for inline   │
  │                          │  2. Fall back: text/plain │
  │  { thread: ThreadDetail }│                           │
  │◀─────────────────────────│                           │
  │                          │                           │
  │  Client-side:            │                           │
  │  Render HTML in Shadow   │                           │
  │  DOM (CSS isolation)     │                           │
  │  Cache in IndexedDB      │                           │
  │  for offline access      │                           │
```

---

## Theme System

### Theme Store (`src/lib/stores/theme.ts`)

Manages the application's light/dark colour scheme using a Svelte writable store:

- **Resolution order**: localStorage → OS `prefers-color-scheme` → `'light'` default
- **Persistence**: `toggleTheme()` saves to localStorage + sets `data-theme` attribute on `<html>`
- **Initialization**: `initTheme()` is called in the root layout's `onMount` to sync the DOM attribute with the resolved theme before first paint
- **Exports**: `theme` (writable store), `toggleTheme()`, `initTheme()`, `getInitialTheme()`

### CSS Variables (`src/app.css`)

All colours are defined as CSS custom properties (prefixed `--color-`) on `:root` (light) and `[data-theme="dark"]` (dark). The variables cover:

| Category   | Variables                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Background | `bg-primary`, `bg-surface`, `bg-surface-dim`, `bg-hover`, `bg-hover-alt`, `bg-overlay`, `bg-unread` |
| Text       | `text-primary`, `text-secondary`, `text-tertiary`                                                   |
| Borders    | `border`, `border-light`, `border-subtle`                                                           |
| Primary    | `primary`, `primary-hover`                                                                          |
| Status     | `error`, `error-surface`, `warning`, `warning-surface`, `warning-border`                            |
| UI         | `code-bg`, `badge-bg`, `badge-text`, `tab-badge-bg`, `tab-badge-text`                               |
| Input      | `input-bg`                                                                                          |
| Offline    | `offline-banner-bg`, `offline-banner-text`                                                          |
| Shadows    | `shadow-sm`, `shadow-md`, `shadow-lg`, `modal-shadow`, `google-btn-shadow`                          |

The dark theme uses Gmail dark mode-inspired values: `#1f1f1f` page bg, `#292929` surfaces, `#e8eaed`/`#9aa0a6` text, `#8ab4f8` primary blue, with `color-scheme: dark` for native form theming.

### Theme Toggle

A sun/moon icon button in the inbox header (`.header-right`) toggles between light and dark mode. The toggle is only shown on the authenticated inbox page; other pages inherit the theme automatically.

---

## Offline & PWA Architecture

### Service Worker (`static/sw.js`)

The service worker provides offline capability using a dual-cache architecture:

| Cache Bucket | Naming                            | Contents                          | Lifecycle               |
| ------------ | --------------------------------- | --------------------------------- | ----------------------- |
| SHELL_CACHE  | `switchboard-shell-{APP_VERSION}` | App shell, favicon, manifest      | Versioned per deploy    |
| ASSET_CACHE  | `switchboard-assets-v1`           | Immutable JS/CSS (content-hashed) | Persists across deploys |

Caching strategies by request type:

| Request Type                          | Strategy                     | Fallback Chain                      |
| ------------------------------------- | ---------------------------- | ----------------------------------- |
| Navigation (HTML)                     | Network-first (3s timeout)   | Cached '/' → Inline offline HTML    |
| Immutable assets (`/_app/immutable/`) | Cache-forever in ASSET_CACHE | Network fetch on miss               |
| Other static assets                   | Cache-first in SHELL_CACHE   | Network fetch → cache for next time |
| API requests                          | Pass-through (not cached)    | App handles via IndexedDB           |
| Auth/logout routes                    | Pass-through (not cached)    | Must always hit server              |

**Version management**: `APP_VERSION` is patched by the Vite build plugin (`serviceWorkerVersion()` in `vite.config.ts`). On each build, a base-36 timestamp replaces the constant, making the SW file byte-different so the browser triggers the install → waiting → activate lifecycle.

**Update flow**: The SW does NOT call `skipWaiting()` automatically. Instead, it posts `SW_INSTALLED` to all clients after install. The `UpdateToast` component detects this and prompts the user to reload. When the user clicks "Update", the client sends `SKIP_WAITING` to the waiting worker.

**Offline fallback**: Includes `@media (prefers-color-scheme: dark)` inline styles for automatic dark mode support in the offline HTML page.

### UpdateToast (`src/lib/components/UpdateToast.svelte`)

A fixed-position toast at the bottom of the screen that notifies users when a new app version is available. Uses 6 detection strategies for reliable cross-platform coverage:

1. **Immediate + delayed polling** (0s, 1s, 3s) — handles iOS PWA timing quirks
2. **`SW_INSTALLED` message listener** — the SW posts this after install
3. **Native `updatefound` event** + `statechange` tracking — standard browser API
4. **`visibilitychange` triggered update** — catches updates when app returns from background
5. **Periodic polling** (every 2 minutes) — ensures long-lived tabs discover updates
6. **Immediate `registration.update()`** — forces check on page load

User actions: "Update" (sends `SKIP_WAITING`, reloads on `controllerchange`) or "Dismiss" (hides toast, may reappear later).

### Vite Build Plugin (`vite.config.ts`)

The `serviceWorkerVersion()` plugin hooks into Vite's `buildStart` lifecycle:

1. Generates a unique version: `Date.now().toString(36)`
2. Reads `static/sw.js` and replaces the `APP_VERSION` constant via regex
3. Writes the patched file back, ensuring each build produces a byte-different SW

### IndexedDB Cache (`src/lib/cache.ts`)

Client-side cache backed by IndexedDB with two object stores:

| Store             | Key       | Contents                      | When Populated         |
| ----------------- | --------- | ----------------------------- | ---------------------- |
| `thread-metadata` | Thread ID | `ThreadMetadata` + `cachedAt` | After each inbox fetch |
| `thread-detail`   | Thread ID | `ThreadDetail` + `cachedAt`   | After viewing a thread |

**Stale-while-revalidate**: Both the inbox and thread detail pages show cached data immediately, then fetch fresh data in the background when online. The inbox uses surgical merge (`mergeThreads`) to update/add threads without clearing the list. When offline, the inbox displays all cached metadata.

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

The inbox page silently loads more threads in the background until the active panel has enough to fill the current page view.

1. After initial fetch or background refresh, check if active panel has < `currentPage * pageSize` threads
2. If yes and more pages exist, fetch the next page using `fetchThreadPage()` → `mergeThreads(append)`
3. Repeat until the panel has enough threads or all server pages are exhausted (no retry limit)
4. A small pulsing dot appears on the active panel tab during loading — hovering shows detailed debug info (loaded count, target, search query, etc.)
5. Count estimates (`fetchPanelCounts`) run in parallel with data loading so pagination displays stable server counts from the start, not increasing loaded-thread counts

### Diagnostics Overlay

Press **Ctrl+Shift+D** (or Settings > Diagnostics) to toggle a floating diagnostics overlay with two tabs:

**Counts tab** — Live per-panel count data:

- Context (inbox vs search), active panel, server counts availability
- Per-panel table: loaded count, server total, server unread, exact vs estimate flag, badge value
- Pagination display, total pages, current page, thread counts

**System tab** — Developer/support information:

- IndexedDB cache stats (metadata and detail entry counts)
- Real-time online/offline connectivity status
- Service worker registration status and force-update button
- Clear caches button (clears IndexedDB only)
- Factory reset button (clears all caches, localStorage panels, and page size)

### Error Handling & Offline States

The UI uses a **three-tier error strategy** so users can always debug what went wrong:

| Tier                 | When Used                                    | UI Treatment                                                       |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| **Page-level error** | Auth failure, initial fetch failure (online) | Red error card with server message, "Try again" + "Sign in again"  |
| **Error toast**      | Background refresh/revalidation failure      | Dismissible toast overlay (cached data still visible underneath)   |
| **Graceful offline** | Offline with no cached data                  | Informational card (not red) with cloud-offline icon + "Try again" |

Key design decisions:

- **Offline ≠ Error**: Being offline with no cache is shown as an informational state (neutral styling, cloud icon, "You're offline" heading) — not an error. The user isn't at fault.
- **Background failures are non-blocking**: When cached data is available, network errors during refresh/revalidation appear as a dismissible toast, never replacing the page content.
- **Every error is debuggable**: Server error messages (from API endpoints) are propagated to the UI. HTTP status codes and Gmail API error details are included.
- **Every error has a retry**: All error and offline states include a "Try again" button (`location.reload()`).
- **Thread detail revalidation**: When a cached thread is displayed and background revalidation fails, the user sees a toast instead of losing the cached content. If the server returns 404 (thread deleted), this is also shown as a toast when cached data exists.

---

## File-by-File Guide

### Configuration Files

| File                | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `svelte.config.js`  | SvelteKit config with adapter-node             |
| `vite.config.ts`    | Vite config with SvelteKit + SW version plugin |
| `tsconfig.json`     | TypeScript compiler options                    |
| `eslint.config.js`  | ESLint rules (TS + Svelte + Prettier)          |
| `.prettierrc`       | Code formatting (tabs, single quotes)          |
| `knip.config.ts`    | Dead code detection config                     |
| `.env.example`      | Template for environment variables             |
| `.husky/pre-commit` | Git hook: runs cleanup + validate              |

### Source Files

| File                                               | Lines | Purpose                                                                                       |
| -------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `src/lib/server/auth.ts`                           | ~500  | OAuth flow, token caching, cookie management                                                  |
| `src/lib/server/gmail.ts`                          | ~570  | Gmail API client (fetch, batch, thread detail, bodies)                                        |
| `src/lib/server/headers.ts`                        | ~130  | Email header parsing and metadata extraction                                                  |
| `src/lib/server/sanitize.ts`                       | ~270  | HTML sanitizer for email bodies (primary security boundary)                                   |
| `src/lib/server/crypto.ts`                         | ~130  | AES-256-GCM encrypt/decrypt                                                                   |
| `src/lib/server/pkce.ts`                           | ~55   | PKCE verifier/challenge generation                                                            |
| `src/lib/server/env.ts`                            | ~75   | Lazy env var access with validation                                                           |
| `src/lib/csrf.ts`                                  | ~35   | Client-side CSRF token reader (parses document.cookie)                                        |
| `src/lib/format.ts`                                | ~210  | Display formatting (HTML entities, dates, relative time)                                      |
| `src/lib/inbox.ts`                                 | ~80   | Inbox data management (surgical merge for cache-first UI)                                     |
| `src/lib/cache.ts`                                 | ~350  | IndexedDB wrapper for offline thread caching                                                  |
| `src/lib/offline.svelte.ts`                        | ~80   | Svelte 5 reactive online/offline state                                                        |
| `src/lib/components/OfflineBanner.svelte`          | ~90   | Global offline connectivity banner                                                            |
| `src/lib/components/UpdateToast.svelte`            | ~190  | Deployment update notification (6 SW detection strategies)                                    |
| `src/lib/stores/theme.ts`                          | ~85   | Light/dark theme store (localStorage + OS preference)                                         |
| `src/lib/types.ts`                                 | ~350  | Shared TypeScript types                                                                       |
| `src/lib/rules.ts`                                 | ~245  | Panel rule engine + Gmail query conversion (pure functions)                                   |
| `src/app.css`                                      | ~160  | Global CSS variables (light/dark themes) + base reset                                         |
| `src/routes/+page.svelte`                          | ~3600 | Inbox view (panels, toolbar, pagination, trash, mark-as-read, search, settings, panel counts) |
| `src/routes/login/+page.svelte`                    | ~240  | Gmail-style login page (offline-aware)                                                        |
| `src/routes/t/[threadId]/+page.svelte`             | ~1035 | Thread detail (Shadow DOM, dark mode, attachments, app header)                                |
| `src/routes/+layout.svelte`                        | ~40   | Root layout (skip link, theme init, global CSS, offline banner)                               |
| `src/routes/auth/google/+server.ts`                | ~20   | OAuth initiation redirect                                                                     |
| `src/routes/auth/callback/+server.ts`              | ~25   | OAuth callback handler                                                                        |
| `src/routes/logout/+server.ts`                     | ~20   | Logout handler                                                                                |
| `src/routes/api/me/+server.ts`                     | ~65   | Profile endpoint                                                                              |
| `src/routes/api/thread/[id]/+server.ts`            | ~75   | Thread detail endpoint (format=full + body extraction)                                        |
| `src/routes/api/threads/+server.ts`                | ~55   | Thread listing endpoint (supports search via q param)                                         |
| `src/routes/api/threads/counts/+server.ts`         | ~100  | Per-panel count estimates endpoint                                                            |
| `src/routes/api/threads/metadata/+server.ts`       | ~75   | Batch metadata endpoint (Zod validated)                                                       |
| `src/routes/api/threads/read/+server.ts`           | ~105  | Mark-as-read endpoint (single + batch)                                                        |
| `src/routes/api/threads/trash/+server.ts`          | ~100  | Batch trash endpoint (CSRF validated)                                                         |
| `src/routes/api/thread/[id]/attachment/+server.ts` | ~110  | Attachment download (base64url → binary)                                                      |
| `static/sw.js`                                     | ~410  | Service worker (dual cache, version, update toast protocol)                                   |

---

## Environment Variables

| Variable               | Required | Description                                   |
| ---------------------- | -------- | --------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes      | OAuth client ID from Google Cloud Console     |
| `GOOGLE_CLIENT_SECRET` | Yes      | OAuth client secret (server-side only)        |
| `APP_BASE_URL`         | Yes      | Public URL (e.g., `http://localhost:5173`)    |
| `COOKIE_SECRET`        | Yes      | 32-byte base64-encoded AES-256 encryption key |

---

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
| **Knip**           | A tool that finds unused files, exports, and dependencies                                                  |
