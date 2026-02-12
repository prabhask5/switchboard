/**
 * @fileoverview Server-side environment variable access.
 *
 * Environment variables are accessed lazily (on first call) rather than
 * eagerly at import time. This is necessary because SvelteKit's build
 * step runs a post-build analysis that imports server modules — if we
 * eagerly read env vars, the build would fail when they're not set.
 *
 * Each getter caches the value after first access so the validation
 * (and the `env` import) only runs once per process lifetime.
 *
 * This module is only importable on the server side ($lib/server).
 */

import { env } from '$env/dynamic/private';

/**
 * Reads a required environment variable or throws.
 *
 * @param name - The environment variable name (e.g. "GOOGLE_CLIENT_ID").
 * @returns The non-empty string value.
 * @throws {Error} If the variable is missing or empty.
 */
function required(name: string): string {
	const value = env[name];
	if (!value || !value.trim()) {
		throw new Error(
			`Missing required environment variable: ${name}. ` + `See .env.example for documentation.`
		);
	}
	return value;
}

/*
 * We use a cache object + getter functions so that:
 *   1. The first access validates and caches the value.
 *   2. Subsequent accesses return the cached value instantly.
 *   3. No validation runs during the build's analysis phase.
 */
const cache: Record<string, string> = {};

/**
 * Returns the Google OAuth 2.0 client identifier.
 * Public value, but only accessed server-side.
 */
export function getGoogleClientId(): string {
	return (cache['GOOGLE_CLIENT_ID'] ??= required('GOOGLE_CLIENT_ID'));
}

/**
 * Returns the Google OAuth 2.0 client secret.
 * NEVER expose to the browser.
 */
export function getGoogleClientSecret(): string {
	return (cache['GOOGLE_CLIENT_SECRET'] ??= required('GOOGLE_CLIENT_SECRET'));
}

/**
 * Returns the public-facing base URL of the application (no trailing slash).
 */
export function getAppBaseUrl(): string {
	return (cache['APP_BASE_URL'] ??= required('APP_BASE_URL').replace(/\/+$/, ''));
}

/**
 * Returns the base64-encoded 32-byte secret for AES-256-GCM encryption
 * of the refresh-token cookie.
 */
export function getCookieSecret(): string {
	return (cache['COOKIE_SECRET'] ??= required('COOKIE_SECRET'));
}
