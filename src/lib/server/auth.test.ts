/**
 * @fileoverview Unit tests for the unified auth module.
 *
 * Tests cover:
 *   - initiateOAuthFlow: generates correct auth URL, sets correct cookies
 *   - handleOAuthCallback: validates state, handles error/missing params
 *   - Cookie helpers: logout
 *   - getAccessToken: token refresh, caching, error handling
 *   - getGmailProfile: profile fetch, error handling
 *
 * We mock the SvelteKit Cookies interface and the env module to isolate
 * the logic under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, deriveKey } from './crypto.js';

/*
 * Mock the env module before importing auth, so auth.ts doesn't try
 * to read real environment variables.
 */
vi.mock('./env.js', () => ({
	getGoogleClientId: () => 'mock-client-id',
	getGoogleClientSecret: () => 'mock-client-secret',
	getAppBaseUrl: () => 'http://localhost:5173',
	getCookieSecret: () =>
		/* 32 bytes of zeros as base64. */
		Buffer.from(new Uint8Array(32)).toString('base64')
}));

import {
	initiateOAuthFlow,
	handleOAuthCallback,
	logout,
	getAccessToken,
	getGmailProfile,
	validateCsrf
} from './auth.js';

/**
 * Encryption key derived from the mocked COOKIE_SECRET.
 * Used to create valid encrypted cookie values for getAccessToken tests.
 */
const TEST_KEY = deriveKey(Buffer.from(new Uint8Array(32)).toString('base64'));

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock SvelteKit Cookies object that stores cookies in a plain Map.
 * This lets us inspect what was set/deleted without needing a real HTTP context.
 */
function createMockCookies() {
	const store = new Map<string, string>();
	const deleted = new Set<string>();

	return {
		store,
		deleted,
		get: vi.fn((name: string) => store.get(name)),
		set: vi.fn((name: string, value: string, _opts?: unknown) => {
			store.set(name, value);
			deleted.delete(name);
		}),
		delete: vi.fn((name: string, _opts?: unknown) => {
			store.delete(name);
			deleted.add(name);
		}),
		serialize: vi.fn(),
		getAll: vi.fn()
	};
}

// =============================================================================
// Tests: initiateOAuthFlow
// =============================================================================

describe('initiateOAuthFlow', () => {
	it('returns an auth URL pointing to Google', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
	});

	it('includes the client_id in the auth URL', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		expect(url.searchParams.get('client_id')).toBe('mock-client-id');
	});

	it('includes the correct redirect_uri', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
	});

	it('uses S256 PKCE challenge method', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	});

	it('includes access_type=offline and prompt=consent', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('prompt')).toBe('consent');
	});

	it('requests gmail.modify, openid, and email scopes', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		const scope = url.searchParams.get('scope') ?? '';
		expect(scope).toContain('gmail.modify');
		expect(scope).toContain('openid');
		expect(scope).toContain('email');
	});

	it('sets a PKCE verifier cookie', () => {
		const cookies = createMockCookies();
		initiateOAuthFlow(cookies as any);

		expect(cookies.set).toHaveBeenCalledWith(
			'sb_pkce_verifier',
			expect.any(String),
			expect.objectContaining({
				httpOnly: true,
				path: '/',
				maxAge: 600
			})
		);
	});

	it('sets an OAuth state cookie', () => {
		const cookies = createMockCookies();
		initiateOAuthFlow(cookies as any);

		expect(cookies.set).toHaveBeenCalledWith(
			'sb_oauth_state',
			expect.any(String),
			expect.objectContaining({
				httpOnly: true,
				path: '/',
				maxAge: 600
			})
		);
	});

	it('state cookie value matches the state param in the URL', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);

		const url = new URL(authUrl);
		const stateInUrl = url.searchParams.get('state');

		/* Find the state value set in cookies. */
		const stateCookieCall = cookies.set.mock.calls.find(
			(call: any[]) => call[0] === 'sb_oauth_state'
		);
		const stateInCookie = stateCookieCall?.[1];

		expect(stateInUrl).toBe(stateInCookie);
	});

	it('produces different state values on each call (randomness)', () => {
		const cookies1 = createMockCookies();
		const cookies2 = createMockCookies();

		initiateOAuthFlow(cookies1 as any);
		initiateOAuthFlow(cookies2 as any);

		const state1 = cookies1.store.get('sb_oauth_state');
		const state2 = cookies2.store.get('sb_oauth_state');

		expect(state1).not.toBe(state2);
	});

	it('sets secure=false when base URL is http', () => {
		const cookies = createMockCookies();
		initiateOAuthFlow(cookies as any);

		expect(cookies.set).toHaveBeenCalledWith(
			'sb_pkce_verifier',
			expect.any(String),
			expect.objectContaining({ secure: false })
		);
	});

	it('includes response_type=code in the auth URL', () => {
		const cookies = createMockCookies();
		const { authUrl } = initiateOAuthFlow(cookies as any);
		const url = new URL(authUrl);
		expect(url.searchParams.get('response_type')).toBe('code');
	});

	it('sets sameSite=lax on ephemeral cookies', () => {
		const cookies = createMockCookies();
		initiateOAuthFlow(cookies as any);
		expect(cookies.set).toHaveBeenCalledWith(
			'sb_pkce_verifier',
			expect.any(String),
			expect.objectContaining({ sameSite: 'lax' })
		);
		expect(cookies.set).toHaveBeenCalledWith(
			'sb_oauth_state',
			expect.any(String),
			expect.objectContaining({ sameSite: 'lax' })
		);
	});
});

// =============================================================================
// Tests: handleOAuthCallback
// =============================================================================

describe('handleOAuthCallback', () => {
	it('returns error when state param is missing', async () => {
		const cookies = createMockCookies();
		const url = new URL('http://localhost:5173/auth/callback?code=abc');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error.status).toBe(403);
			expect(result.error.message).toContain('state mismatch');
		}
	});

	it('returns error when state cookie is missing', async () => {
		const cookies = createMockCookies();
		const url = new URL('http://localhost:5173/auth/callback?code=abc&state=xyz');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error.status).toBe(403);
		}
	});

	it('returns error when state does not match cookie', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'correct-state');
		const url = new URL('http://localhost:5173/auth/callback?code=abc&state=wrong-state');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error.status).toBe(403);
			expect(result.error.message).toContain('state mismatch');
		}
	});

	it('redirects to login with error when user denies consent', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		const url = new URL('http://localhost:5173/auth/callback?error=access_denied&state=some-state');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('redirect');
		if ('redirect' in result) {
			expect(result.redirect).toContain('/login');
			expect(result.redirect).toContain('access_denied');
		}
	});

	it('returns error when authorization code is missing', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		const url = new URL('http://localhost:5173/auth/callback?state=some-state');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error.status).toBe(400);
			expect(result.error.message).toContain('Missing authorization code');
		}
	});

	it('returns error when PKCE verifier cookie is missing', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		const url = new URL('http://localhost:5173/auth/callback?code=abc&state=some-state');

		const result = await handleOAuthCallback(url, cookies as any);

		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error.status).toBe(400);
			expect(result.error.message).toContain('PKCE verifier');
		}
	});

	it('returns error when token exchange fails (HTTP 400)', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=invalid-code&state=some-state');

		/*
		 * Mock fetch to return a 400 error (simulating invalid code).
		 * We need to mock global fetch for this test.
		 */
		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => '{"error": "invalid_grant"}'
		});

		try {
			const result = await handleOAuthCallback(url, cookies as any);

			expect(result).toHaveProperty('error');
			if ('error' in result) {
				expect(result.error.status).toBe(500);
				expect(result.error.message).toContain('Token exchange failed');
			}
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('returns error when token exchange fails (network error)', async () => {
		/* Set up cookies with valid state and PKCE. */
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=abc&state=some-state');

		const originalFetch = global.fetch;
		/* Mock fetch to REJECT (simulating a real network error like DNS failure). */
		global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

		try {
			const result = await handleOAuthCallback(url, cookies as any);
			expect(result).toHaveProperty('error');
			if ('error' in result) {
				expect(result.error.status).toBe(500);
				expect(result.error.message).toContain('Token exchange failed');
			}
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('returns error when no refresh token in response', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=valid-code&state=some-state');

		/* Mock fetch to return tokens WITHOUT a refresh_token. */
		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
				/* No refresh_token! */
			})
		});

		try {
			const result = await handleOAuthCallback(url, cookies as any);

			expect(result).toHaveProperty('error');
			if ('error' in result) {
				expect(result.error.status).toBe(500);
				expect(result.error.message).toContain('No refresh token received');
			}
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('succeeds and sets cookies when token exchange returns refresh token', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=valid-code&state=some-state');

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				refresh_token: 'rt-456',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email https://www.googleapis.com/auth/gmail.modify'
			})
		});

		try {
			const result = await handleOAuthCallback(url, cookies as any);

			/* Should redirect to home. */
			expect(result).toEqual({ redirect: '/' });

			/* Should set the encrypted refresh token cookie. */
			expect(cookies.set).toHaveBeenCalledWith(
				'sb_refresh',
				expect.any(String),
				expect.objectContaining({
					httpOnly: true,
					path: '/',
					maxAge: expect.any(Number)
				})
			);

			/* Should set a CSRF token cookie (httpOnly: false for double-submit pattern). */
			expect(cookies.set).toHaveBeenCalledWith(
				'sb_csrf',
				expect.any(String),
				expect.objectContaining({
					httpOnly: false,
					path: '/'
				})
			);

			/* Should delete ephemeral cookies. */
			expect(cookies.delete).toHaveBeenCalledWith('sb_pkce_verifier', { path: '/' });
			expect(cookies.delete).toHaveBeenCalledWith('sb_oauth_state', { path: '/' });
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('handles non-Error thrown in catch block (Unknown error fallback)', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=abc&state=some-state');

		const originalFetch = global.fetch;
		// Throw a non-Error value (e.g., a string)
		global.fetch = vi.fn().mockRejectedValue('string error');

		try {
			const result = await handleOAuthCallback(url, cookies as any);
			expect(result).toHaveProperty('error');
			if ('error' in result) {
				expect(result.error.status).toBe(500);
				expect(result.error.message).toContain('Unknown error');
			}
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('sets refresh cookie with exact maxAge of 15,552,000 seconds (180 days)', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=valid-code&state=some-state');

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				refresh_token: 'rt-456',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		try {
			await handleOAuthCallback(url, cookies as any);
			const refreshCall = cookies.set.mock.calls.find((call: any[]) => call[0] === 'sb_refresh');
			expect(refreshCall).toBeDefined();
			expect((refreshCall as any[])[2].maxAge).toBe(180 * 24 * 60 * 60); // 15,552,000
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('sends correct body params in token exchange request', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'test-verifier-value');
		const url = new URL('http://localhost:5173/auth/callback?code=test-auth-code&state=some-state');

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				refresh_token: 'rt-456',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		try {
			await handleOAuthCallback(url, cookies as any);

			const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
			const body = fetchCall[1].body;
			const params = new URLSearchParams(body);

			expect(params.get('code')).toBe('test-auth-code');
			expect(params.get('client_id')).toBe('mock-client-id');
			expect(params.get('client_secret')).toBe('mock-client-secret');
			expect(params.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
			expect(params.get('grant_type')).toBe('authorization_code');
			expect(params.get('code_verifier')).toBe('test-verifier-value');
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('encrypted refresh token is not plaintext', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=valid-code&state=some-state');

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				refresh_token: 'rt-456-secret-token',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		try {
			await handleOAuthCallback(url, cookies as any);

			/* The cookie value should NOT contain the raw refresh token. */
			const refreshCookieValue = cookies.store.get('sb_refresh');
			expect(refreshCookieValue).toBeDefined();
			expect(refreshCookieValue).not.toContain('rt-456-secret-token');

			/* It should be in dot-separated format (iv.authTag.ciphertext). */
			expect(refreshCookieValue!.split('.').length).toBe(3);
		} finally {
			global.fetch = originalFetch;
		}
	});
});

// =============================================================================
// Tests: Cookie Helpers
// =============================================================================

describe('logout', () => {
	it('deletes both refresh and CSRF cookies', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_refresh', 'encrypted-value');
		cookies.store.set('sb_csrf', 'csrf-value');

		logout(cookies as any);

		expect(cookies.delete).toHaveBeenCalledWith('sb_refresh', { path: '/' });
		expect(cookies.delete).toHaveBeenCalledWith('sb_csrf', { path: '/' });
	});

	it('does not throw when cookies are already absent', () => {
		const cookies = createMockCookies();
		expect(() => logout(cookies as any)).not.toThrow();
	});

	it('clears the in-memory token cache entry', async () => {
		/* First, populate the token cache by doing a getAccessToken call. */
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('logout-test-refresh', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'cached-token-for-logout',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		try {
			/* Populate the cache. */
			const token1 = await getAccessToken(cookies as any);
			expect(token1).toBe('cached-token-for-logout');

			/* Logout should clear the cache. */
			logout(cookies as any);

			/* Re-add the cookie (simulating a new login). */
			cookies.store.set('sb_refresh', encryptedRefresh);

			/* Mock a different response. */
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'new-token-after-logout',
					expires_in: 3600,
					token_type: 'Bearer',
					scope: 'openid email'
				})
			});

			/* Should fetch a new token since cache was cleared. */
			const token2 = await getAccessToken(cookies as any);
			expect(token2).toBe('new-token-after-logout');
		} finally {
			global.fetch = originalFetch;
		}
	});
});

// =============================================================================
// Tests: getAccessToken
// =============================================================================

describe('getAccessToken', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = vi.fn();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('throws when no refresh token cookie exists', async () => {
		const cookies = createMockCookies();
		await expect(getAccessToken(cookies as any)).rejects.toThrow('Not authenticated');
	});

	it('refreshes and returns a new access token on cache miss', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('real-refresh-token', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'new-access-token',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		const token = await getAccessToken(cookies as any);
		expect(token).toBe('new-access-token');

		/* Verify fetch was called with the token endpoint. */
		expect(global.fetch).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/token',
			expect.objectContaining({
				method: 'POST'
			})
		);
	});

	it('returns cached token on second call (no extra fetch)', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('cached-refresh-token', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'cached-access-token',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		/* First call: fetches from Google. */
		const token1 = await getAccessToken(cookies as any);
		expect(token1).toBe('cached-access-token');
		expect(global.fetch).toHaveBeenCalledTimes(1);

		/* Second call: should return cached token without another fetch. */
		const token2 = await getAccessToken(cookies as any);
		expect(token2).toBe('cached-access-token');
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('throws when token refresh returns non-OK response', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('expired-refresh-token', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => '{"error":"invalid_grant"}'
		});

		await expect(getAccessToken(cookies as any)).rejects.toThrow('Token refresh failed (400)');
	});

	it('throws when cookie value is corrupted (decrypt fails)', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_refresh', 'not-a-valid-encrypted-value');

		await expect(getAccessToken(cookies as any)).rejects.toThrow(
			'Not authenticated: refresh token cookie is corrupted'
		);
	});

	it('refreshes token when cached entry has expired', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('expiry-test-refresh', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		// First call: returns token that expires very soon (1 second)
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: 'first-token',
				expires_in: 1, // 1 second - will be immediately expired due to 5-min buffer
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		// Second call: returns a new token
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: 'second-token',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		const token1 = await getAccessToken(cookies as any);
		expect(token1).toBe('first-token');

		// Second call should NOT use cache since expires_in of 1s minus 5-min buffer = already expired
		const token2 = await getAccessToken(cookies as any);
		expect(token2).toBe('second-token');
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('throws on network error during token refresh (not just HTTP error)', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('network-error-refresh', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		// Mock fetch to reject with a network error (DNS failure, timeout, etc.)
		(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
			new TypeError('fetch failed: network error')
		);

		await expect(getAccessToken(cookies as any)).rejects.toThrow('fetch failed');
	});

	it('aborts fetch when fetchWithTimeout exceeds the timeout (via getAccessToken)', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('abort-test-refresh', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		/*
		 * Mock fetch to hang indefinitely, but respect the abort signal.
		 * When the AbortController fires, fetch rejects with an AbortError.
		 */
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			(_url: string, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					if (init?.signal) {
						init.signal.addEventListener('abort', () => {
							reject(new DOMException('The operation was aborted.', 'AbortError'));
						});
					}
				});
			}
		);

		/*
		 * getAccessToken uses fetchWithTimeout with a 10s default timeout.
		 * To avoid waiting 10s, we use fake timers and advance past the timeout.
		 */
		vi.useFakeTimers();

		const promise = getAccessToken(cookies as any);

		/*
		 * Register the rejection expectation BEFORE advancing timers.
		 * This attaches a .catch handler so the rejection is not "unhandled"
		 * when advanceTimersByTimeAsync triggers the AbortController.
		 */
		const expectation = expect(promise).rejects.toThrow('aborted');

		/* Advance past the 10-second timeout. */
		await vi.advanceTimersByTimeAsync(11_000);

		await expectation;

		vi.useRealTimers();
	});

	it('sends correct parameters in the token refresh request', async () => {
		const cookies = createMockCookies();
		const encryptedRefresh = encrypt('my-refresh-token', TEST_KEY);
		cookies.store.set('sb_refresh', encryptedRefresh);

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email'
			})
		});

		await getAccessToken(cookies as any);

		/* Extract the body from the fetch call. */
		const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = fetchCall[1].body;
		const params = new URLSearchParams(body);

		expect(params.get('client_id')).toBe('mock-client-id');
		expect(params.get('client_secret')).toBe('mock-client-secret');
		expect(params.get('refresh_token')).toBe('my-refresh-token');
		expect(params.get('grant_type')).toBe('refresh_token');
	});
});

// =============================================================================
// Tests: getGmailProfile
// =============================================================================

describe('getGmailProfile', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = vi.fn();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('fetches Gmail profile with Bearer authorization', async () => {
		const mockProfile = {
			emailAddress: 'user@gmail.com',
			messagesTotal: 1234,
			threadsTotal: 567,
			historyId: '12345'
		};

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: async () => mockProfile
		});

		const profile = await getGmailProfile('test-access-token');

		expect(profile).toEqual(mockProfile);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://gmail.googleapis.com/gmail/v1/users/me/profile',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer test-access-token'
				})
			})
		);
	});

	it('throws on non-OK response', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => 'Unauthorized'
		});

		await expect(getGmailProfile('bad-token')).rejects.toThrow('Gmail profile fetch failed (401)');
	});

	it('throws on network error', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network timeout'));

		await expect(getGmailProfile('token')).rejects.toThrow('Network timeout');
	});

	it('throws on malformed JSON response (200 OK with invalid body)', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.reject(new SyntaxError('Unexpected token'))
		});

		await expect(getGmailProfile('token')).rejects.toThrow('Unexpected token');
	});
});

// =============================================================================
// Tests: validateCsrf
// =============================================================================

describe('validateCsrf', () => {
	it('returns true when cookie and header tokens match', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'matching-token-value');

		const headers = new Headers({ 'x-csrf-token': 'matching-token-value' });
		expect(validateCsrf(cookies as any, headers)).toBe(true);
	});

	it('returns false when tokens do not match', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'cookie-value');

		const headers = new Headers({ 'x-csrf-token': 'different-value' });
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('returns false when CSRF cookie is missing', () => {
		const cookies = createMockCookies();
		/* No sb_csrf cookie set. */

		const headers = new Headers({ 'x-csrf-token': 'some-value' });
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('returns false when x-csrf-token header is missing', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'some-value');

		const headers = new Headers();
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('returns false when both cookie and header are missing', () => {
		const cookies = createMockCookies();
		const headers = new Headers();
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('returns false when tokens have different lengths', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'short');

		const headers = new Headers({ 'x-csrf-token': 'much-longer-token-value' });
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('correctly validates base64url tokens (real token format)', () => {
		const token = 'dGhpcyBpcyBhIGJhc2U2NHVybCB0b2tlbg';
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', token);

		const headers = new Headers({ 'x-csrf-token': token });
		expect(validateCsrf(cookies as any, headers)).toBe(true);
	});

	it('returns false when cookie token is empty string', () => {
		/*
		 * Empty strings are falsy in JS, so the !cookieToken guard
		 * should catch this before reaching timingSafeEqual.
		 */
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', '');

		const headers = new Headers({ 'x-csrf-token': 'some-value' });
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('returns false when header token is empty string', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'some-value');

		/*
		 * Headers constructor ignores empty-string values for some header
		 * names but x-csrf-token should be set. However, Headers.get()
		 * returns "" which is falsy, so the guard should catch it.
		 */
		const headers = new Headers({ 'x-csrf-token': '' });
		expect(validateCsrf(cookies as any, headers)).toBe(false);
	});

	it('CSRF cookie is set with httpOnly: false in OAuth callback', async () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_oauth_state', 'some-state');
		cookies.store.set('sb_pkce_verifier', 'some-verifier');
		const url = new URL('http://localhost:5173/auth/callback?code=valid-code&state=some-state');

		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'at-123',
				refresh_token: 'rt-456',
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'openid email https://www.googleapis.com/auth/gmail.modify'
			})
		});

		try {
			await handleOAuthCallback(url, cookies as any);

			/* Verify CSRF cookie was set with httpOnly: false. */
			const csrfCall = cookies.set.mock.calls.find((call: any[]) => call[0] === 'sb_csrf');
			expect(csrfCall).toBeDefined();
			expect(csrfCall![2]).toMatchObject({ httpOnly: false });
		} finally {
			global.fetch = originalFetch;
		}
	});
});

// =============================================================================
// Tests: isSecure — via cookie options
// =============================================================================

describe('isSecure — via cookie options', () => {
	it('sets secure=false when APP_BASE_URL uses http scheme', () => {
		// The mock returns 'http://localhost:5173'
		const cookies = createMockCookies();
		initiateOAuthFlow(cookies as any);
		expect(cookies.set).toHaveBeenCalledWith(
			'sb_pkce_verifier',
			expect.any(String),
			expect.objectContaining({ secure: false })
		);
	});
});
