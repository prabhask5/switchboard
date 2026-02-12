/**
 * @fileoverview Unified OAuth 2.0 Authentication Module for Email Switchboard.
 *
 * This single module handles the full Google OAuth 2.0 lifecycle:
 *
 *   1. **Authorization URL**: Builds the Google consent URL with PKCE + state.
 *   2. **Token Exchange**: Swaps authorization code + PKCE verifier for tokens.
 *   3. **Token Refresh**: Mints new access tokens from the stored refresh token.
 *   4. **Profile Fetch**: Retrieves the user's Gmail email address.
 *   5. **Cookie Management**: Stores/reads the encrypted refresh token and
 *      CSRF token in HttpOnly cookies.
 *
 * OAuth Flow Overview:
 *   1. User clicks "Sign in" → GET /auth/google → generates PKCE + state,
 *      stores them in ephemeral cookies, redirects to Google consent screen.
 *   2. User grants consent → Google redirects to GET /auth/callback with
 *      `code` and `state` query parameters.
 *   3. Callback validates state, exchanges code for tokens, encrypts the
 *      refresh token into an HttpOnly cookie, generates a CSRF token.
 *   4. Subsequent API calls read the refresh token from the cookie, mint
 *      an access token, and call the Gmail API.
 *
 * Security Design:
 *   - **PKCE (RFC 7636)**: Prevents authorization-code interception attacks.
 *     The verifier is stored in an ephemeral HttpOnly cookie (not in-memory),
 *     so it survives server restarts and works across multiple instances.
 *   - **AES-256-GCM encryption**: The refresh token cookie value is encrypted
 *     so that even if the raw cookie is logged or intercepted, the token
 *     is unreadable without the COOKIE_SECRET.
 *   - **HttpOnly + Secure + SameSite=Lax cookies**: Prevents XSS token theft
 *     and provides basic CSRF protection.
 *   - **CSRF double-submit token**: For state-changing operations (trash),
 *     a token in an HttpOnly cookie must match a header sent by the client.
 *   - **AbortController timeouts**: All external HTTP calls have a 10-second
 *     timeout to prevent hanging requests from blocking the server.
 *
 * @see https://developers.google.com/identity/protocols/oauth2/web-server
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import type { Cookies } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { generatePkce } from './pkce.js';
import { encrypt, decrypt, deriveKey } from './crypto.js';
import { getGoogleClientId, getGoogleClientSecret, getAppBaseUrl, getCookieSecret } from './env.js';

// =============================================================================
// Constants
// =============================================================================

/** Google's OAuth 2.0 authorization endpoint. */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google's OAuth 2.0 token endpoint. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Gmail API v1 base URL. */
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** Default fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Minimum Gmail scopes:
 *   - gmail.modify: list/read threads + trash (modify includes readonly)
 *   - openid + email: get the user's email via profile endpoint
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'openid', 'email'].join(' ');

/** Cookie name for the AES-256-GCM encrypted refresh token. */
const REFRESH_COOKIE = 'sb_refresh';

/** Cookie name for the CSRF double-submit token. */
const CSRF_COOKIE = 'sb_csrf';

/** Cookie name for the ephemeral PKCE code verifier (10-minute TTL). */
const PKCE_COOKIE = 'sb_pkce_verifier';

/** Cookie name for the ephemeral OAuth state (10-minute TTL). */
const STATE_COOKIE = 'sb_oauth_state';

/** Maximum cookie age for the refresh token: 180 days. */
const REFRESH_MAX_AGE = 180 * 24 * 60 * 60;

/** Maximum cookie age for ephemeral OAuth cookies: 10 minutes. */
const EPHEMERAL_MAX_AGE = 600;

/**
 * Buffer subtracted from Google's `expires_in` when caching access tokens.
 * We refresh 5 minutes early to avoid using a token that's about to expire.
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * In-memory access token cache.
 *
 * Keyed by the encrypted refresh token cookie value (unique per user session).
 * Avoids redundant token refresh calls when multiple API endpoints are hit
 * in quick succession (e.g., listThreads + batchGetMetadata).
 *
 * Note: This is per-process, so each serverless invocation starts fresh.
 * That's fine — the cache prevents redundant refreshes within a single
 * request lifecycle or a long-running server process.
 */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/**
 * Lazily derived AES-256 encryption key. Computed on first use rather than
 * at module load so that the SvelteKit build analysis phase doesn't fail
 * when env vars aren't set.
 */
let _encryptionKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
	if (!_encryptionKey) {
		_encryptionKey = deriveKey(getCookieSecret());
	}
	return _encryptionKey;
}

/**
 * Returns whether the app is served over HTTPS (determines cookie Secure flag).
 * Lazily evaluated to avoid reading env vars at module load.
 */
function isSecure(): boolean {
	return getAppBaseUrl().startsWith('https');
}

// =============================================================================
// Types
// =============================================================================

/**
 * The raw token response from Google's token endpoint.
 */
export interface TokenResponse {
	/** Short-lived access token for API calls (~1 hour). */
	access_token: string;
	/** Long-lived refresh token (only on first consent with `prompt=consent`). */
	refresh_token?: string;
	/** Token lifetime in seconds (usually 3600). */
	expires_in: number;
	/** Always "Bearer". */
	token_type: string;
	/** Granted scopes, space-separated. */
	scope: string;
}

/**
 * Minimal Gmail profile returned by `users.getProfile`.
 */
export interface GmailProfile {
	emailAddress: string;
	messagesTotal: number;
	threadsTotal: number;
	historyId: string;
}

/**
 * The data returned by {@link initiateOAuthFlow} for the route to use.
 */
export interface OAuthFlowInit {
	/** The full Google authorization URL to redirect the user to. */
	authUrl: string;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Executes a fetch with an AbortController timeout.
 *
 * Prevents API calls from hanging if Google's endpoints are slow or
 * unreachable. The abort signal causes fetch to reject with an AbortError.
 *
 * @param url - The URL to fetch.
 * @param init - Standard fetch options.
 * @param timeoutMs - Timeout in ms (default 10s).
 * @returns The fetch Response.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Returns common cookie options.
 *
 * @param maxAge - Cookie lifetime in seconds.
 * @returns Cookie options object for SvelteKit's cookies.set().
 */
function cookieOpts(maxAge: number) {
	return {
		path: '/',
		httpOnly: true,
		secure: isSecure(),
		sameSite: 'lax' as const,
		maxAge
	};
}

// =============================================================================
// OAuth Flow: Step 1 – Initiate (builds auth URL, sets ephemeral cookies)
// =============================================================================

/**
 * Initiates the OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Generates a PKCE verifier/challenge pair and a random state value,
 * stores both in short-lived HttpOnly cookies, and returns the Google
 * authorization URL for the route to redirect to.
 *
 * The ephemeral cookies survive the redirect round-trip to Google and back.
 * They are consumed and deleted in {@link handleOAuthCallback}.
 *
 * @param cookies - SvelteKit's cookie jar for the current request.
 * @returns The authorization URL to redirect the user to.
 */
export function initiateOAuthFlow(cookies: Cookies): OAuthFlowInit {
	/* Generate PKCE pair: verifier (secret) + challenge (hash of verifier). */
	const { codeVerifier, codeChallenge } = generatePkce();

	/* Generate random state for CSRF protection. */
	const state = randomBytes(16).toString('base64url');

	/* Store verifier + state in ephemeral cookies (10 min TTL). */
	cookies.set(PKCE_COOKIE, codeVerifier, cookieOpts(EPHEMERAL_MAX_AGE));
	cookies.set(STATE_COOKIE, state, cookieOpts(EPHEMERAL_MAX_AGE));

	/* Build the Google authorization URL. */
	const url = new URL(AUTH_ENDPOINT);
	url.searchParams.set('client_id', getGoogleClientId());
	url.searchParams.set('redirect_uri', `${getAppBaseUrl()}/auth/callback`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', SCOPES);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);

	return { authUrl: url.toString() };
}

// =============================================================================
// OAuth Flow: Step 2 – Callback (exchange code, store refresh token)
// =============================================================================

/**
 * Handles the OAuth callback after Google redirects the user back.
 *
 * Validates state (CSRF), exchanges the authorization code for tokens
 * using the PKCE verifier, encrypts the refresh token into an HttpOnly
 * cookie, generates a CSRF token, and cleans up ephemeral cookies.
 *
 * @param url - The full callback URL with query parameters.
 * @param cookies - SvelteKit's cookie jar.
 * @returns An object with `redirect` (the URL to redirect to) or
 *   `error` (status code + message) if something went wrong.
 */
export async function handleOAuthCallback(
	url: URL,
	cookies: Cookies
): Promise<{ redirect: string } | { error: { status: number; message: string } }> {
	/* ── Validate state (CSRF protection) ────────────────────────── */
	const returnedState = url.searchParams.get('state');
	const savedState = cookies.get(STATE_COOKIE);

	if (!returnedState || !savedState || returnedState !== savedState) {
		return {
			error: {
				status: 403,
				message: 'OAuth state mismatch. Please try signing in again.'
			}
		};
	}

	/* ── Check if user denied consent ────────────────────────────── */
	const oauthError = url.searchParams.get('error');
	if (oauthError) {
		return { redirect: `/login?error=${encodeURIComponent(oauthError)}` };
	}

	/* ── Extract authorization code ──────────────────────────────── */
	const code = url.searchParams.get('code');
	if (!code) {
		return {
			error: { status: 400, message: 'Missing authorization code in callback.' }
		};
	}

	/* ── Retrieve PKCE verifier from ephemeral cookie ────────────── */
	const codeVerifier = cookies.get(PKCE_COOKIE);
	if (!codeVerifier) {
		return {
			error: { status: 400, message: 'Missing PKCE verifier. Please try signing in again.' }
		};
	}

	/* ── Exchange authorization code for tokens ──────────────────── */
	const body = new URLSearchParams({
		code,
		client_id: getGoogleClientId(),
		client_secret: getGoogleClientSecret(),
		redirect_uri: `${getAppBaseUrl()}/auth/callback`,
		grant_type: 'authorization_code',
		code_verifier: codeVerifier
	});

	let tokenResponse: TokenResponse;
	try {
		const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});

		if (!res.ok) {
			const errorBody = await res.text();
			throw new Error(`Token exchange failed (${res.status}): ${errorBody}`);
		}

		tokenResponse = (await res.json()) as TokenResponse;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		return { error: { status: 500, message: `Token exchange failed: ${msg}` } };
	}

	/* ── Verify we received a refresh token ──────────────────────── */
	if (!tokenResponse.refresh_token) {
		return {
			error: {
				status: 500,
				message:
					'No refresh token received. Please revoke app access in your ' +
					'Google Account settings and try again.'
			}
		};
	}

	/* ── Encrypt and store refresh token in HttpOnly cookie ──────── */
	const encryptedRefresh = encrypt(tokenResponse.refresh_token, getEncryptionKey());
	cookies.set(REFRESH_COOKIE, encryptedRefresh, cookieOpts(REFRESH_MAX_AGE));
	console.info('[auth] Refresh token cookie set successfully');

	/* ── Generate and store CSRF token ───────────────────────────── */
	const csrfToken = randomBytes(32).toString('base64url');
	cookies.set(CSRF_COOKIE, csrfToken, cookieOpts(REFRESH_MAX_AGE));

	/* ── Clean up ephemeral cookies ──────────────────────────────── */
	cookies.delete(PKCE_COOKIE, { path: '/' });
	cookies.delete(STATE_COOKIE, { path: '/' });

	return { redirect: '/' };
}

// =============================================================================
// Token Refresh
// =============================================================================

/**
 * Mints a fresh access token using the refresh token from the encrypted cookie.
 *
 * Google access tokens expire after ~1 hour. This function reads the encrypted
 * refresh token from the cookie and exchanges it for a new access token.
 *
 * @param cookies - SvelteKit's cookie jar.
 * @returns The new access token string.
 * @throws {Error} If no refresh token is stored (user not authenticated) or
 *   if Google rejects the refresh (token revoked, etc.).
 */
export async function getAccessToken(cookies: Cookies): Promise<string> {
	/* Read the encrypted refresh token cookie. */
	const encryptedRefresh = cookies.get(REFRESH_COOKIE);
	if (!encryptedRefresh) {
		throw new Error('Not authenticated: no refresh token cookie.');
	}

	/*
	 * Check the in-memory cache first. The cache key is the encrypted cookie
	 * value itself — it's unique per user session and avoids decryption.
	 */
	const cached = tokenCache.get(encryptedRefresh);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.accessToken;
	}

	/* Cache miss or expired — decrypt and refresh from Google. */
	let refreshToken: string;
	try {
		refreshToken = decrypt(encryptedRefresh, getEncryptionKey());
	} catch {
		throw new Error('Not authenticated: refresh token cookie is corrupted.');
	}

	/* Exchange refresh token for a new access token. */
	const body = new URLSearchParams({
		client_id: getGoogleClientId(),
		client_secret: getGoogleClientSecret(),
		refresh_token: refreshToken,
		grant_type: 'refresh_token'
	});

	const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Token refresh failed (${res.status}): ${errorBody}`);
	}

	const data = (await res.json()) as TokenResponse;

	/* Cache the new access token (with a 5-minute safety buffer). */
	tokenCache.set(encryptedRefresh, {
		accessToken: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS
	});

	return data.access_token;
}

// =============================================================================
// Gmail Profile
// =============================================================================

/**
 * Fetches the authenticated user's Gmail profile (email address).
 *
 * Uses the `users.getProfile` endpoint which is a lightweight call —
 * it only returns the email address and message/thread counts.
 *
 * @param accessToken - A valid Google access token with gmail scope.
 * @returns The user's Gmail profile.
 * @throws {Error} If the access token is invalid or the request fails.
 */
export async function getGmailProfile(accessToken: string): Promise<GmailProfile> {
	const res = await fetchWithTimeout(`${GMAIL_API_BASE}/users/me/profile`, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Gmail profile fetch failed (${res.status}): ${errorBody}`);
	}

	return (await res.json()) as GmailProfile;
}

// =============================================================================
// Cookie Read Helpers
// =============================================================================

/**
 * Checks whether the user has a refresh token cookie (i.e., is logged in).
 *
 * This does NOT validate the token — it only checks for the cookie's existence.
 * Used for quick auth-gating in layouts without making an API call.
 *
 * @public
 * @param cookies - SvelteKit's cookie jar.
 * @returns True if the refresh token cookie exists.
 */
export function hasRefreshToken(cookies: Cookies): boolean {
	return !!cookies.get(REFRESH_COOKIE);
}

/**
 * Reads the CSRF token from the cookie.
 *
 * Used by middleware to validate the CSRF double-submit pattern:
 * the client must send this value in a custom header for state-changing
 * requests (POST, DELETE, etc.).
 *
 * @public
 * @param cookies - SvelteKit's cookie jar.
 * @returns The CSRF token or null if not set.
 */
export function getCsrfToken(cookies: Cookies): string | null {
	return cookies.get(CSRF_COOKIE) ?? null;
}

// =============================================================================
// Logout
// =============================================================================

/**
 * Clears all authentication cookies, effectively logging the user out.
 *
 * We do NOT revoke the Google refresh token server-side because:
 *   - The user might want to re-authenticate quickly.
 *   - They can revoke access from Google Account settings.
 *   - Revoking adds latency and can fail silently.
 *
 * @param cookies - SvelteKit's cookie jar.
 */
export function logout(cookies: Cookies): void {
	/* Clear the in-memory access token cache entry before deleting the cookie. */
	const encryptedRefresh = cookies.get(REFRESH_COOKIE);
	if (encryptedRefresh) {
		tokenCache.delete(encryptedRefresh);
	}

	cookies.delete(REFRESH_COOKIE, { path: '/' });
	cookies.delete(CSRF_COOKIE, { path: '/' });
}
