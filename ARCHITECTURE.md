# Architecture

This document explains the entire Switchboard system — from how a user signs in with Google, to how emails are fetched, cached, and displayed. It is written so that someone with zero experience can understand the whole codebase.

---

## Table of Contents

1. [What is Switchboard?](#what-is-switchboard)
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

## What is Switchboard?

Switchboard is a lightweight web application that shows your Gmail inbox in a clean, organized way. Instead of one big list, you can set up **4 panels** (like tabs) that filter emails based on rules you define (e.g., "emails from @github.com go to Panel 2").

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
       │
       │ Stores:
       ├── Panel rules (IndexedDB)
       ├── Cached emails (IndexedDB)
       └── UI state (memory)
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
├── auth.ts      # The Big Module — handles everything auth-related
├── crypto.ts    # Low-level AES-256-GCM encrypt/decrypt
├── env.ts       # Environment variable access with lazy loading
└── pkce.ts      # PKCE code verifier/challenge generation
```

### auth.ts — The Unified Auth Module

This is the most important file. It contains:

1. **`initiateOAuthFlow()`** — Generates PKCE + state, sets cookies, returns Google auth URL
2. **`handleOAuthCallback()`** — Validates state, exchanges code for tokens, encrypts and stores refresh token
3. **`getAccessToken()`** — Reads encrypted refresh token from cookie, exchanges it for a fresh access token
4. **`getGmailProfile()`** — Calls Gmail's profile endpoint to get the user's email
5. **`hasRefreshToken()`** — Quick check: is the user logged in?
6. **`getCsrfToken()`** — Reads the CSRF token from the cookie
7. **`logout()`** — Deletes all auth cookies

All external HTTP calls use `fetchWithTimeout()` with a 10-second AbortController to prevent hanging.

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

### PR 1 Endpoints

| Method | Path             | Auth Required | Description                       |
| ------ | ---------------- | ------------- | --------------------------------- |
| GET    | `/auth/google`   | No            | Redirect to Google consent screen |
| GET    | `/auth/callback` | No            | Handle OAuth callback from Google |
| GET    | `/logout`        | No            | Clear cookies, redirect to /login |
| GET    | `/api/me`        | Yes           | Returns `{ email: string }`       |

### Future Endpoints (PR 2+)

| Method | Path                    | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| GET    | `/api/threads`          | List thread IDs from inbox          |
| POST   | `/api/threads/metadata` | Batch fetch metadata for thread IDs |
| GET    | `/api/thread/[id]`      | Get full thread detail              |
| POST   | `/api/threads/trash`    | Batch move threads to trash         |

---

## Client Architecture

### Pages

| Route     | Purpose                                  |
| --------- | ---------------------------------------- |
| `/`       | Home — shows inbox or redirects to login |
| `/login`  | Sign-in page with Google button          |
| `/t/[id]` | Thread detail view (PR 2+)               |

### State Management

- **Auth state**: Determined by calling `/api/me` on page load
- **Panel rules**: Stored in IndexedDB (configured in-app, PR 2+)
- **Email cache**: IndexedDB for offline access (PR 3+)
- **UI state**: Svelte reactive state ($state)

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

| File                                  | Lines | Purpose                               |
| ------------------------------------- | ----- | ------------------------------------- |
| `src/lib/server/auth.ts`              | ~470  | OAuth flow, token management, cookies |
| `src/lib/server/crypto.ts`            | ~130  | AES-256-GCM encrypt/decrypt           |
| `src/lib/server/pkce.ts`              | ~55   | PKCE verifier/challenge generation    |
| `src/lib/server/env.ts`               | ~75   | Lazy env var access with validation   |
| `src/routes/+page.svelte`             | ~260  | Home page (auth check, connected UI)  |
| `src/routes/login/+page.svelte`       | ~155  | Gmail-style login page                |
| `src/routes/+layout.svelte`           | ~45   | Root layout (fonts, global styles)    |
| `src/routes/auth/google/+server.ts`   | ~20   | OAuth initiation redirect             |
| `src/routes/auth/callback/+server.ts` | ~25   | OAuth callback handler                |
| `src/routes/logout/+server.ts`        | ~20   | Logout handler                        |
| `src/routes/api/me/+server.ts`        | ~45   | Profile endpoint                      |

### Test Files

| File                            | Tests | Covers                                  |
| ------------------------------- | ----- | --------------------------------------- |
| `src/lib/server/crypto.test.ts` | 10    | Encrypt/decrypt, key derivation, tamper |
| `src/lib/server/pkce.test.ts`   | 4     | Verifier length, challenge correctness  |
| `src/lib/server/auth.test.ts`   | 27    | OAuth flow, callbacks, cookies, logout  |

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

### Unit Tests

- **crypto.ts**: Round-trip encryption, wrong key detection, tamper detection, malformed payloads, key length validation
- **pkce.ts**: Verifier/challenge format, length, SHA-256 correctness, randomness
- **auth.ts**: OAuth URL construction, state validation, error handling, cookie management, PKCE cookie lifecycle, encrypted token verification

### Future Tests (PR 2+)

- **Rule engine**: Accept/reject regex logic, edge cases (empty rules, overlapping rules)
- **Header parsing**: From/To with names + emails, multiple recipients, malformed headers
- **Date parsing**: Various date formats, timezone handling
- **Batch response parsing**: Multipart/mixed parsing, partial failures
- **Offline behavior**: Cache reads, stale-while-revalidate, network error handling
- **Frontend components**: Login flow, panel switching, list rendering, thread detail

---

## Glossary

| Term              | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **OAuth 2.0**     | An industry standard protocol for authorization                                                            |
| **PKCE**          | Proof Key for Code Exchange — prevents code interception                                                   |
| **Access Token**  | Short-lived credential (~1hr) for making API calls                                                         |
| **Refresh Token** | Long-lived credential for getting new access tokens                                                        |
| **AES-256-GCM**   | Symmetric encryption algorithm (256-bit key, authenticated)                                                |
| **HttpOnly**      | Cookie flag that prevents JavaScript from reading the cookie                                               |
| **SameSite=Lax**  | Cookie is sent on same-site requests + top-level navigations                                               |
| **CSRF**          | Cross-Site Request Forgery — an attack where a malicious site makes requests on behalf of a logged-in user |
| **SvelteKit**     | A full-stack web framework built on Svelte                                                                 |
| **adapter-node**  | SvelteKit adapter that outputs a standalone Node.js server                                                 |
| **Vitest**        | A test runner built for Vite projects                                                                      |
| **Knip**          | A tool that finds unused files, exports, and dependencies                                                  |
