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
import { encrypt, decrypt, deriveKey } from '../crypto.js';
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

	it('round-trips multibyte UTF-8 characters (emoji, CJK)', () => {
		const plaintext = '你好世界 🎉🔑 مرحبا';
		const encrypted = encrypt(plaintext, testKey);
		const decrypted = decrypt(encrypted, testKey);
		expect(decrypted).toBe(plaintext);
	});

	it('throws when IV portion is tampered with', () => {
		const encrypted = encrypt('secret', testKey);
		const parts = encrypted.split('.');
		/* Flip a character in the IV portion (first part). */
		parts[0] = parts[0].slice(0, -1) + (parts[0].endsWith('A') ? 'B' : 'A');
		const tampered = parts.join('.');
		expect(() => decrypt(tampered, testKey)).toThrow();
	});

	it('throws on invalid IV length (not 12 bytes)', () => {
		/* Craft a payload with a 6-byte IV (too short). */
		const shortIv = Buffer.from('123456').toString('base64url');
		const validAuthTag = Buffer.alloc(16).toString('base64url');
		const validCiphertext = Buffer.from('test').toString('base64url');
		const payload = `${shortIv}.${validAuthTag}.${validCiphertext}`;
		expect(() => decrypt(payload, testKey)).toThrow('Invalid IV length');
	});

	it('throws on invalid auth tag length (not 16 bytes)', () => {
		const validIv = Buffer.alloc(12).toString('base64url');
		const shortAuthTag = Buffer.from('12345678').toString('base64url'); // 8 bytes
		const validCiphertext = Buffer.from('test').toString('base64url');
		const payload = `${validIv}.${shortAuthTag}.${validCiphertext}`;
		expect(() => decrypt(payload, testKey)).toThrow('Invalid auth tag length');
	});

	it('throws on empty string input', () => {
		expect(() => decrypt('', testKey)).toThrow('3 dot-separated parts');
	});
});

describe('deriveKey — additional edge cases', () => {
	it('throws for key that is too long (48 bytes)', () => {
		const tooLong = randomBytes(48).toString('base64');
		expect(() => deriveKey(tooLong)).toThrow('must decode to exactly 32 bytes');
	});

	it('throws for empty string input', () => {
		expect(() => deriveKey('')).toThrow('must decode to exactly 32 bytes');
	});
});
