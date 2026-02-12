/**
 * @fileoverview AES-256-GCM encryption / decryption for cookie payloads.
 *
 * We encrypt the Google refresh token before storing it in an HttpOnly cookie
 * so that even if an attacker reads the raw cookie value (e.g. via a proxy
 * log or a compromised CDN), they cannot use the refresh token without the
 * server-side COOKIE_SECRET.
 *
 * Format of the encrypted blob (all base64url-encoded, dot-separated):
 *   <iv>.<authTag>.<ciphertext>
 *
 * - `iv`: 12-byte initialization vector (unique per encryption).
 * - `authTag`: 16-byte GCM authentication tag (integrity check).
 * - `ciphertext`: The encrypted payload.
 *
 * The key is derived once at module load from the base64-encoded COOKIE_SECRET
 * environment variable. It must be exactly 32 bytes (256 bits).
 *
 * @see https://nodejs.org/api/crypto.html#class-cipher
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The byte-length of the AES-256 key (32 bytes = 256 bits).
 */
const KEY_LENGTH = 32;

/**
 * GCM initialization vector length. NIST recommends 12 bytes for GCM.
 */
const IV_LENGTH = 12;

/**
 * GCM authentication tag length in bytes.
 */
const AUTH_TAG_LENGTH = 16;

/**
 * Decodes the COOKIE_SECRET env var into a 32-byte Buffer.
 *
 * @param base64Secret - The base64-encoded secret from the environment.
 * @returns A 32-byte Buffer suitable for AES-256.
 * @throws {Error} If the decoded key is not exactly 32 bytes.
 */
export function deriveKey(base64Secret: string): Buffer {
	const key = Buffer.from(base64Secret, 'base64');
	if (key.length !== KEY_LENGTH) {
		throw new Error(
			`COOKIE_SECRET must decode to exactly ${KEY_LENGTH} bytes. ` +
				`Got ${key.length} bytes. Generate with: ` +
				`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
		);
	}
	return key;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * A fresh 12-byte IV is generated for every call, ensuring that identical
 * plaintexts produce different ciphertexts.
 *
 * @param plaintext - The string to encrypt (e.g. a refresh token).
 * @param key - A 32-byte encryption key.
 * @returns A dot-separated string: `<iv>.<authTag>.<ciphertext>` (all base64url).
 */
export function encrypt(plaintext: string, key: Buffer): string {
	const iv = randomBytes(IV_LENGTH);

	const cipher = createCipheriv('aes-256-gcm', key, iv, {
		authTagLength: AUTH_TAG_LENGTH
	});

	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

	const authTag = cipher.getAuthTag();

	/*
	 * Dot-separated format keeps the cookie value URL-safe without
	 * additional encoding. Base64url avoids `+`, `/`, and `=`.
	 */
	return [
		iv.toString('base64url'),
		authTag.toString('base64url'),
		encrypted.toString('base64url')
	].join('.');
}

/**
 * Decrypts an AES-256-GCM encrypted payload produced by {@link encrypt}.
 *
 * @param payload - The dot-separated `<iv>.<authTag>.<ciphertext>` string.
 * @param key - The same 32-byte encryption key used for encryption.
 * @returns The original plaintext string.
 * @throws {Error} If the payload is malformed or the authentication tag
 *   does not match (indicating tampering or a wrong key).
 */
export function decrypt(payload: string, key: Buffer): string {
	const parts = payload.split('.');
	if (parts.length !== 3) {
		throw new Error('Malformed encrypted payload: expected 3 dot-separated parts.');
	}

	const [ivB64, authTagB64, ciphertextB64] = parts;
	const iv = Buffer.from(ivB64, 'base64url');
	const authTag = Buffer.from(authTagB64, 'base64url');
	const ciphertext = Buffer.from(ciphertextB64, 'base64url');

	if (iv.length !== IV_LENGTH) {
		throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}.`);
	}
	if (authTag.length !== AUTH_TAG_LENGTH) {
		throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${authTag.length}.`);
	}

	const decipher = createDecipheriv('aes-256-gcm', key, iv, {
		authTagLength: AUTH_TAG_LENGTH
	});
	decipher.setAuthTag(authTag);

	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

	return decrypted.toString('utf8');
}
