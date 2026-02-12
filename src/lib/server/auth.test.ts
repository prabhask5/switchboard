/**
 * @fileoverview Unit tests for the unified auth module.
 *
 * These tests cover the pure logic within auth.ts that can be tested without
 * live Google OAuth credentials. We test:
 *
 *   - initiateOAuthFlow: generates correct auth URL, sets correct cookies
 *   - handleOAuthCallback: validates state, handles error/missing params
 *   - Cookie helpers: hasRefreshToken, getCsrfToken, logout
 *
 * The actual token exchange and Gmail profile calls require network access
 * and valid credentials, so those are integration-tested separately.
 *
 * We mock the SvelteKit Cookies interface and the env module to isolate
 * the logic under test.
 */

import { describe, it, expect, vi } from 'vitest';

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
	hasRefreshToken,
	getCsrfToken,
	logout
} from './auth.js';

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

	it('returns error when token exchange fails (network)', async () => {
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

			/* Should set a CSRF token cookie. */
			expect(cookies.set).toHaveBeenCalledWith(
				'sb_csrf',
				expect.any(String),
				expect.objectContaining({
					httpOnly: true,
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

describe('hasRefreshToken', () => {
	it('returns true when refresh cookie exists', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_refresh', 'encrypted-value');
		expect(hasRefreshToken(cookies as any)).toBe(true);
	});

	it('returns false when refresh cookie is absent', () => {
		const cookies = createMockCookies();
		expect(hasRefreshToken(cookies as any)).toBe(false);
	});
});

describe('getCsrfToken', () => {
	it('returns the CSRF token when cookie exists', () => {
		const cookies = createMockCookies();
		cookies.store.set('sb_csrf', 'my-csrf-token');
		expect(getCsrfToken(cookies as any)).toBe('my-csrf-token');
	});

	it('returns null when CSRF cookie is absent', () => {
		const cookies = createMockCookies();
		expect(getCsrfToken(cookies as any)).toBeNull();
	});
});

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
});
