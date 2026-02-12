/**
 * @fileoverview Unit tests for PKCE code verifier/challenge generation.
 *
 * Tests cover:
 *   - Verifier length and character set (base64url, no padding).
 *   - Challenge length and character set.
 *   - Challenge is deterministic for a given verifier (SHA-256 is deterministic).
 *   - Different calls produce different verifiers (random).
 */

import { describe, it, expect } from 'vitest';
import { generatePkce } from './pkce.js';
import { createHash } from 'node:crypto';

/** Base64url characters: A-Z, a-z, 0-9, -, _ (no padding '='). */
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

describe('generatePkce', () => {
	it('returns a verifier of 43 characters (32 bytes base64url)', () => {
		const { codeVerifier } = generatePkce();
		expect(codeVerifier.length).toBe(43);
		expect(codeVerifier).toMatch(BASE64URL_REGEX);
	});

	it('returns a challenge of 43 characters (SHA-256 digest base64url)', () => {
		const { codeChallenge } = generatePkce();
		expect(codeChallenge.length).toBe(43);
		expect(codeChallenge).toMatch(BASE64URL_REGEX);
	});

	it('challenge matches SHA-256 of verifier', () => {
		const { codeVerifier, codeChallenge } = generatePkce();

		/* Manually compute what the challenge should be. */
		const expected = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');

		expect(codeChallenge).toBe(expected);
	});

	it('produces different verifiers on each call', () => {
		const a = generatePkce();
		const b = generatePkce();
		expect(a.codeVerifier).not.toBe(b.codeVerifier);
		expect(a.codeChallenge).not.toBe(b.codeChallenge);
	});
});
