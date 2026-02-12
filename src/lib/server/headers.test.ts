/**
 * @fileoverview Unit tests for Gmail header parsing utilities.
 *
 * Tests cover:
 *   - extractHeader: case-insensitive header lookup
 *   - parseFrom: various "From" header formats
 *   - parseDate: RFC 2822 → ISO 8601 conversion
 *   - extractThreadMetadata: full thread metadata extraction
 */

import { describe, it, expect } from 'vitest';
import { extractHeader, parseFrom, parseDate, extractThreadMetadata } from './headers.js';
import type { GmailHeader, GmailThread } from '../types.js';

// =============================================================================
// extractHeader
// =============================================================================

describe('extractHeader', () => {
	const headers: GmailHeader[] = [
		{ name: 'Subject', value: 'Hello World' },
		{ name: 'From', value: 'John Doe <john@example.com>' },
		{ name: 'To', value: 'me@gmail.com' },
		{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
	];

	it('extracts a header by exact name', () => {
		expect(extractHeader(headers, 'Subject')).toBe('Hello World');
	});

	it('is case-insensitive', () => {
		expect(extractHeader(headers, 'subject')).toBe('Hello World');
		expect(extractHeader(headers, 'SUBJECT')).toBe('Hello World');
		expect(extractHeader(headers, 'from')).toBe('John Doe <john@example.com>');
	});

	it('returns empty string for missing headers', () => {
		expect(extractHeader(headers, 'Cc')).toBe('');
		expect(extractHeader(headers, 'Reply-To')).toBe('');
	});

	it('returns empty string for an empty headers array', () => {
		expect(extractHeader([], 'Subject')).toBe('');
	});

	it('returns the first matching header if duplicates exist', () => {
		const dupes: GmailHeader[] = [
			{ name: 'Received', value: 'first' },
			{ name: 'Received', value: 'second' }
		];
		expect(extractHeader(dupes, 'Received')).toBe('first');
	});
});

// =============================================================================
// parseFrom
// =============================================================================

describe('parseFrom', () => {
	it('parses "Display Name <email>" format', () => {
		expect(parseFrom('John Doe <john@example.com>')).toEqual({
			name: 'John Doe',
			email: 'john@example.com'
		});
	});

	it('parses quoted "Display Name" <email> format', () => {
		expect(parseFrom('"John Doe" <john@example.com>')).toEqual({
			name: 'John Doe',
			email: 'john@example.com'
		});
	});

	it('parses bare email address', () => {
		expect(parseFrom('john@example.com')).toEqual({
			name: '',
			email: 'john@example.com'
		});
	});

	it('parses <email> format (angle brackets only)', () => {
		expect(parseFrom('<john@example.com>')).toEqual({
			name: '',
			email: 'john@example.com'
		});
	});

	it('handles empty string', () => {
		expect(parseFrom('')).toEqual({ name: '', email: '' });
	});

	it('handles whitespace around name and email', () => {
		expect(parseFrom('  John Doe  <  john@example.com  >')).toEqual({
			name: 'John Doe',
			email: 'john@example.com'
		});
	});

	it('handles name with special characters', () => {
		const result = parseFrom("O'Brien, James <james@example.com>");
		expect(result.email).toBe('james@example.com');
		expect(result.name).toContain("O'Brien");
	});

	it('handles email-only with no angle brackets', () => {
		expect(parseFrom('noreply@github.com')).toEqual({
			name: '',
			email: 'noreply@github.com'
		});
	});

	it('handles name with numbers', () => {
		expect(parseFrom('User123 <user123@test.com>')).toEqual({
			name: 'User123',
			email: 'user123@test.com'
		});
	});
});

// =============================================================================
// parseDate
// =============================================================================

describe('parseDate', () => {
	it('converts RFC 2822 date to ISO 8601', () => {
		const result = parseDate('Mon, 1 Jan 2024 12:00:00 +0000');
		expect(result).toBe('2024-01-01T12:00:00.000Z');
	});

	it('handles dates with timezone offsets', () => {
		const result = parseDate('Fri, 15 Mar 2024 08:30:00 -0700');
		/* -0700 offset → 15:30 UTC. */
		expect(result).toContain('2024-03-15');
	});

	it('returns empty string for empty input', () => {
		expect(parseDate('')).toBe('');
	});

	it('returns original string for unparseable dates', () => {
		expect(parseDate('not-a-date')).toBe('not-a-date');
	});

	it('handles ISO 8601 input (passes through)', () => {
		const iso = '2024-06-15T10:30:00.000Z';
		expect(parseDate(iso)).toBe(iso);
	});

	it('handles simple date strings', () => {
		const result = parseDate('January 15, 2024');
		expect(result).toContain('2024-01-15');
	});
});

// =============================================================================
// extractThreadMetadata
// =============================================================================

describe('extractThreadMetadata', () => {
	/**
	 * Creates a minimal Gmail thread fixture for testing.
	 */
	function makeThread(overrides: Partial<GmailThread> = {}): GmailThread {
		return {
			id: 'thread123',
			historyId: '999',
			messages: [
				{
					id: 'msg1',
					threadId: 'thread123',
					labelIds: ['INBOX', 'UNREAD'],
					snippet: 'Hey, how are you?',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Hello World' },
							{ name: 'From', value: 'Alice <alice@example.com>' },
							{ name: 'To', value: 'bob@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						]
					}
				},
				{
					id: 'msg2',
					threadId: 'thread123',
					labelIds: ['INBOX'],
					snippet: "I'm good, thanks!",
					internalDate: '1704153600000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Re: Hello World' },
							{ name: 'From', value: 'Bob <bob@example.com>' },
							{ name: 'To', value: 'alice@example.com' },
							{ name: 'Date', value: 'Tue, 2 Jan 2024 12:00:00 +0000' }
						]
					}
				}
			],
			...overrides
		};
	}

	it('extracts the thread ID', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.id).toBe('thread123');
	});

	it('extracts subject from the first message', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.subject).toBe('Hello World');
	});

	it('extracts from from the first message', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.from).toEqual({ name: 'Alice', email: 'alice@example.com' });
	});

	it('extracts to from the first message', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.to).toBe('bob@example.com');
	});

	it('extracts date from the last message (most recent)', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.date).toBe('2024-01-02T12:00:00.000Z');
	});

	it('extracts snippet from the last message', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.snippet).toBe("I'm good, thanks!");
	});

	it('counts messages correctly', () => {
		const meta = extractThreadMetadata(makeThread());
		expect(meta.messageCount).toBe(2);
	});

	it('merges labels from all messages (union)', () => {
		const meta = extractThreadMetadata(makeThread());
		/* msg1 has INBOX + UNREAD, msg2 has INBOX. Union = INBOX + UNREAD. */
		expect(meta.labelIds).toContain('INBOX');
		expect(meta.labelIds).toContain('UNREAD');
		expect(meta.labelIds.length).toBe(2);
	});

	it('handles a single message thread', () => {
		const singleMsg = makeThread({
			messages: [
				{
					id: 'msg1',
					threadId: 'thread123',
					labelIds: ['INBOX'],
					snippet: 'Solo message',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Just One' },
							{ name: 'From', value: 'solo@example.com' },
							{ name: 'To', value: 'me@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						]
					}
				}
			]
		});
		const meta = extractThreadMetadata(singleMsg);
		expect(meta.subject).toBe('Just One');
		expect(meta.from.email).toBe('solo@example.com');
		expect(meta.snippet).toBe('Solo message');
		expect(meta.messageCount).toBe(1);
	});

	it('uses "(no subject)" when Subject header is missing', () => {
		const noSubject = makeThread({
			messages: [
				{
					id: 'msg1',
					threadId: 'thread123',
					labelIds: ['INBOX'],
					snippet: 'No subject',
					internalDate: '1704067200000',
					payload: {
						headers: [
							{ name: 'From', value: 'test@test.com' },
							{ name: 'To', value: 'me@example.com' },
							{ name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }
						]
					}
				}
			]
		});
		const meta = extractThreadMetadata(noSubject);
		expect(meta.subject).toBe('(no subject)');
	});

	it('handles thread with empty messages array', () => {
		const empty = makeThread({ messages: [] });
		const meta = extractThreadMetadata(empty);
		expect(meta.id).toBe('thread123');
		expect(meta.subject).toBe('(no subject)');
		expect(meta.from).toEqual({ name: '', email: '' });
		expect(meta.messageCount).toBe(0);
	});
});
