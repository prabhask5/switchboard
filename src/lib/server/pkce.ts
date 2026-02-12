/**
 * @fileoverview PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0.
 *
 * PKCE prevents authorization-code interception attacks by binding the
 * token-exchange request to the original authorization request via a
 * cryptographic challenge/verifier pair.
 *
 * Flow:
 *   1. Generate a random `code_verifier` (43-128 URL-safe characters).
 *   2. Derive a `code_challenge` = BASE64URL(SHA-256(code_verifier)).
 *   3. Send `code_challenge` + `code_challenge_method=S256` in the auth URL.
 *   4. Send `code_verifier` when exchanging the authorization code for tokens.
 *
 * Google's OAuth endpoint supports S256 PKCE challenges.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import { randomBytes, createHash } from 'node:crypto';

/**
 * The result of generating a PKCE pair.
 */
export interface PkcePair {
	/** The high-entropy random verifier (sent during token exchange). */
	codeVerifier: string;
	/** The SHA-256 hash of the verifier, base64url-encoded (sent in auth URL). */
	codeChallenge: string;
}

/**
 * Generates a cryptographically random PKCE code verifier and its
 * corresponding S256 challenge.
 *
 * The verifier is 32 random bytes encoded as base64url (43 characters),
 * which satisfies the RFC 7636 requirement of 43-128 characters.
 *
 * @returns A {@link PkcePair} containing the verifier and challenge.
 */
export function generatePkce(): PkcePair {
	/*
	 * 32 bytes of randomness -> 43 base64url characters.
	 * This exceeds the minimum entropy requirement of 256 bits.
	 */
	const codeVerifier = randomBytes(32).toString('base64url');

	/*
	 * S256 challenge: SHA-256 hash of the ASCII verifier, base64url-encoded.
	 * Google requires `code_challenge_method=S256` (not "plain").
	 */
	const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');

	return { codeVerifier, codeChallenge };
}
