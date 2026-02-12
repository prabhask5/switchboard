/**
 * @fileoverview Unit tests for AES-256-GCM encryption/decryption.
 *
 * Tests cover:
 *   - Round-trip encrypt→decrypt returns original plaintext.
 *   - Different encryptions of the same plaintext produce different ciphertexts
 *     (proving the IV is random per call).
 *   - Decrypting with the wrong key throws.
 *   - Tampering with any part of the payload throws.
 *   - Malformed payloads throw.
 *   - Key derivation validates length.
 */

import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveKey } from './crypto.js';
import { randomBytes } from 'node:crypto';

/** A valid 32-byte key for testing. */
const testKey = randomBytes(32);

describe('deriveKey', () => {
	it('accepts a valid 32-byte base64 secret', () => {
		const secret = randomBytes(32).toString('base64');
		const key = deriveKey(secret);
		expect(key.length).toBe(32);
	});

	it('throws if the decoded key is not 32 bytes', () => {
		const tooShort = randomBytes(16).toString('base64');
		expect(() => deriveKey(tooShort)).toThrow('must decode to exactly 32 bytes');
	});
});

describe('encrypt / decrypt', () => {
	it('round-trips a simple string', () => {
		const plaintext = 'hello-refresh-token-1234';
		const encrypted = encrypt(plaintext, testKey);
		const decrypted = decrypt(encrypted, testKey);
		expect(decrypted).toBe(plaintext);
	});

	it('round-trips an empty string', () => {
		const encrypted = encrypt('', testKey);
		const decrypted = decrypt(encrypted, testKey);
		expect(decrypted).toBe('');
	});

	it('round-trips a long string with special characters', () => {
		const plaintext = '1//0abc-DEFG_token+value/with=special&chars!@#$%^&*()';
		const encrypted = encrypt(plaintext, testKey);
		const decrypted = decrypt(encrypted, testKey);
		expect(decrypted).toBe(plaintext);
	});

	it('produces different ciphertexts for the same plaintext (random IV)', () => {
		const plaintext = 'same-input-every-time';
		const a = encrypt(plaintext, testKey);
		const b = encrypt(plaintext, testKey);
		expect(a).not.toBe(b);

		/* Both should decrypt to the same thing though. */
		expect(decrypt(a, testKey)).toBe(plaintext);
		expect(decrypt(b, testKey)).toBe(plaintext);
	});

	it('throws when decrypting with the wrong key', () => {
		const encrypted = encrypt('secret', testKey);
		const wrongKey = randomBytes(32);
		expect(() => decrypt(encrypted, wrongKey)).toThrow();
	});

	it('throws when the ciphertext is tampered with', () => {
		const encrypted = encrypt('secret', testKey);
		const parts = encrypted.split('.');
		/* Flip a character in the ciphertext portion. */
		parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A');
		const tampered = parts.join('.');
		expect(() => decrypt(tampered, testKey)).toThrow();
	});

	it('throws when the auth tag is tampered with', () => {
		const encrypted = encrypt('secret', testKey);
		const parts = encrypted.split('.');
		/* Replace the entire auth tag with a completely different random value. */
		parts[1] = randomBytes(16).toString('base64url');
		const tampered = parts.join('.');
		expect(() => decrypt(tampered, testKey)).toThrow();
	});

	it('throws on malformed payload (wrong number of parts)', () => {
		expect(() => decrypt('onlyonepart', testKey)).toThrow('3 dot-separated parts');
		expect(() => decrypt('two.parts', testKey)).toThrow('3 dot-separated parts');
		expect(() => decrypt('a.b.c.d', testKey)).toThrow('3 dot-separated parts');
	});
});
