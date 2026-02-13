/**
 * @fileoverview Unit tests for the lazy environment variable getters.
 *
 * Tests cover:
 *   - Each getter returns the correct environment variable value
 *   - Missing/empty env vars throw descriptive errors
 *   - getAppBaseUrl strips trailing slashes
 *   - Values are cached after first access (lazy initialization)
 *
 * Because env.ts uses module-level caching, we use `vi.resetModules()`
 * and dynamic imports to get fresh module instances per test group.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mocked env store — individual tests set values here before calling getters.
 * This simulates the SvelteKit `$env/dynamic/private` module.
 */
const mockEnv: Record<string, string | undefined> = {};

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(mockEnv, {
		get: (_target, prop: string) => mockEnv[prop]
	})
}));

// =============================================================================
// Getter Tests
// =============================================================================

describe('env getters', () => {
	beforeEach(() => {
		/* Clear mock env and reset module cache for fresh getters each test. */
		for (const key of Object.keys(mockEnv)) {
			delete mockEnv[key];
		}
		vi.resetModules();
	});

	it('getGoogleClientId returns the env var value', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = 'test-client-id';
		const { getGoogleClientId } = await import('./env.js');
		expect(getGoogleClientId()).toBe('test-client-id');
	});

	it('getGoogleClientSecret returns the env var value', async () => {
		mockEnv['GOOGLE_CLIENT_SECRET'] = 'test-secret';
		const { getGoogleClientSecret } = await import('./env.js');
		expect(getGoogleClientSecret()).toBe('test-secret');
	});

	it('getAppBaseUrl returns the env var value', async () => {
		mockEnv['APP_BASE_URL'] = 'https://example.com';
		const { getAppBaseUrl } = await import('./env.js');
		expect(getAppBaseUrl()).toBe('https://example.com');
	});

	it('getAppBaseUrl strips trailing slashes', async () => {
		mockEnv['APP_BASE_URL'] = 'https://example.com///';
		const { getAppBaseUrl } = await import('./env.js');
		expect(getAppBaseUrl()).toBe('https://example.com');
	});

	it('getCookieSecret returns the env var value', async () => {
		mockEnv['COOKIE_SECRET'] = 'base64-encoded-secret';
		const { getCookieSecret } = await import('./env.js');
		expect(getCookieSecret()).toBe('base64-encoded-secret');
	});

	it('throws when GOOGLE_CLIENT_ID is missing', async () => {
		const { getGoogleClientId } = await import('./env.js');
		expect(() => getGoogleClientId()).toThrow(
			'Missing required environment variable: GOOGLE_CLIENT_ID'
		);
	});

	it('throws when GOOGLE_CLIENT_SECRET is missing', async () => {
		const { getGoogleClientSecret } = await import('./env.js');
		expect(() => getGoogleClientSecret()).toThrow(
			'Missing required environment variable: GOOGLE_CLIENT_SECRET'
		);
	});

	it('throws when APP_BASE_URL is missing', async () => {
		const { getAppBaseUrl } = await import('./env.js');
		expect(() => getAppBaseUrl()).toThrow('Missing required environment variable: APP_BASE_URL');
	});

	it('throws when COOKIE_SECRET is missing', async () => {
		const { getCookieSecret } = await import('./env.js');
		expect(() => getCookieSecret()).toThrow('Missing required environment variable: COOKIE_SECRET');
	});

	it('throws when env var is an empty string', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = '';
		const { getGoogleClientId } = await import('./env.js');
		expect(() => getGoogleClientId()).toThrow('Missing required environment variable');
	});

	it('throws when env var is whitespace-only', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = '   ';
		const { getGoogleClientId } = await import('./env.js');
		expect(() => getGoogleClientId()).toThrow('Missing required environment variable');
	});

	it('getAppBaseUrl strips single trailing slash', async () => {
		mockEnv['APP_BASE_URL'] = 'https://example.com/';
		const { getAppBaseUrl } = await import('./env.js');
		expect(getAppBaseUrl()).toBe('https://example.com');
	});

	it('error message suggests checking .env.example', async () => {
		const { getGoogleClientId } = await import('./env.js');
		expect(() => getGoogleClientId()).toThrow('.env.example');
	});

	it('returns raw untrimmed value when env var has whitespace padding', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = '  padded-client-id  ';
		const { getGoogleClientId } = await import('./env.js');
		/* required() returns the raw untrimmed value — whitespace is preserved. */
		expect(getGoogleClientId()).toBe('  padded-client-id  ');
	});
});

// =============================================================================
// Caching Behavior
// =============================================================================

describe('env caching', () => {
	beforeEach(() => {
		for (const key of Object.keys(mockEnv)) {
			delete mockEnv[key];
		}
		vi.resetModules();
	});

	it('caches the value after first access (subsequent calls return cached)', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = 'first-value';
		const { getGoogleClientId } = await import('./env.js');

		/* First call: reads from env and caches. */
		expect(getGoogleClientId()).toBe('first-value');

		/* Change the env var — cached value should still be returned. */
		mockEnv['GOOGLE_CLIENT_ID'] = 'changed-value';
		expect(getGoogleClientId()).toBe('first-value');
	});

	it('each getter caches independently', async () => {
		mockEnv['GOOGLE_CLIENT_ID'] = 'id-value';
		mockEnv['GOOGLE_CLIENT_SECRET'] = 'secret-value';
		const { getGoogleClientId, getGoogleClientSecret } = await import('./env.js');

		expect(getGoogleClientId()).toBe('id-value');
		expect(getGoogleClientSecret()).toBe('secret-value');

		/* Change both — cached values should persist. */
		mockEnv['GOOGLE_CLIENT_ID'] = 'new-id';
		mockEnv['GOOGLE_CLIENT_SECRET'] = 'new-secret';
		expect(getGoogleClientId()).toBe('id-value');
		expect(getGoogleClientSecret()).toBe('secret-value');
	});

	it('caches getCookieSecret after first access', async () => {
		mockEnv['COOKIE_SECRET'] = 'cached-secret-value';
		const { getCookieSecret } = await import('./env.js');
		expect(getCookieSecret()).toBe('cached-secret-value');
		mockEnv['COOKIE_SECRET'] = 'changed-value';
		expect(getCookieSecret()).toBe('cached-secret-value');
	});
});

// =============================================================================
// getAppBaseUrl — Trailing Slash Stripping
// =============================================================================

describe('getAppBaseUrl — trailing slash handling', () => {
	beforeEach(() => {
		for (const key of Object.keys(mockEnv)) {
			delete mockEnv[key];
		}
		vi.resetModules();
	});

	it('strips trailing slashes from the URL', async () => {
		mockEnv['APP_BASE_URL'] = 'https://app.example.com/';
		const { getAppBaseUrl } = await import('./env.js');

		expect(getAppBaseUrl()).toBe('https://app.example.com');
	});

	it('strips multiple trailing slashes', async () => {
		mockEnv['APP_BASE_URL'] = 'https://app.example.com///';
		const { getAppBaseUrl } = await import('./env.js');

		expect(getAppBaseUrl()).toBe('https://app.example.com');
	});

	it('preserves URLs without trailing slashes', async () => {
		mockEnv['APP_BASE_URL'] = 'https://app.example.com';
		const { getAppBaseUrl } = await import('./env.js');

		expect(getAppBaseUrl()).toBe('https://app.example.com');
	});

	it('preserves path components (only strips trailing slashes)', async () => {
		/*
		 * A base URL with a path like /app should keep the path
		 * but strip the trailing slash.
		 */
		mockEnv['APP_BASE_URL'] = 'https://example.com/app/';
		const { getAppBaseUrl } = await import('./env.js');

		expect(getAppBaseUrl()).toBe('https://example.com/app');
	});
});
