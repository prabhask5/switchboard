/**
 * @fileoverview Shared test utilities for Svelte component tests.
 *
 * Provides fake data factories, mock helpers, and event dispatch utilities
 * used across all component test files. Centralizes common setup patterns
 * to keep individual test files focused on assertions.
 *
 * Categories:
 *   - Fake data factories: createThread, createThreadDetail, createPanelConfig, createPanelCount
 *   - Mock helpers: mockFetch, mockSvelteKitModules
 *   - Event dispatch helpers: fireOnline, fireOffline, flushPromises
 */

import { vi } from 'vitest';
import type {
	ThreadMetadata,
	ThreadDetail,
	ThreadDetailMessage,
	PanelConfig,
	PanelCount,
	AttachmentInfo
} from './types.js';

// =============================================================================
// Fake Data Factories
// =============================================================================

/**
 * Creates a fake ThreadMetadata object with sensible defaults.
 * All fields can be overridden via the `overrides` parameter.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete ThreadMetadata object.
 */
export function createThread(overrides: Partial<ThreadMetadata> = {}): ThreadMetadata {
	return {
		id: overrides.id ?? `thread-${Math.random().toString(36).slice(2, 8)}`,
		subject: 'Test Subject',
		from: { name: 'Test Sender', email: 'sender@example.com' },
		to: 'recipient@example.com',
		date: new Date().toISOString(),
		snippet: 'This is a test snippet...',
		labelIds: ['INBOX'],
		messageCount: 1,
		...overrides
	};
}

/**
 * Creates a fake ThreadDetailMessage with sensible defaults.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete ThreadDetailMessage object.
 */
export function createDetailMessage(
	overrides: Partial<ThreadDetailMessage> = {}
): ThreadDetailMessage {
	return {
		id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
		from: { name: 'Test Sender', email: 'sender@example.com' },
		to: 'recipient@example.com',
		subject: 'Test Subject',
		date: new Date().toISOString(),
		snippet: 'Test snippet...',
		body: 'Hello, this is the message body.',
		bodyType: 'text',
		labelIds: ['INBOX'],
		attachments: [],
		...overrides
	};
}

/**
 * Creates a fake ThreadDetail object with sensible defaults.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete ThreadDetail object.
 */
export function createThreadDetail(
	overrides: Partial<ThreadDetail> & { messages?: ThreadDetailMessage[] } = {}
): ThreadDetail {
	const id = overrides.id ?? `thread-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		subject: 'Test Thread Subject',
		messages: overrides.messages ?? [createDetailMessage({ id: `${id}-msg1` })],
		labelIds: ['INBOX'],
		...overrides
	};
}

/**
 * Creates a fake PanelConfig with sensible defaults.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete PanelConfig object.
 */
export function createPanelConfig(overrides: Partial<PanelConfig> = {}): PanelConfig {
	return {
		name: 'Primary',
		rules: [],
		...overrides
	};
}

/**
 * Creates a fake PanelCount with sensible defaults.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete PanelCount object.
 */
export function createPanelCount(overrides: Partial<PanelCount> = {}): PanelCount {
	return {
		total: 100,
		unread: 5,
		isEstimate: false,
		...overrides
	};
}

/**
 * Creates a fake AttachmentInfo with sensible defaults.
 *
 * @param overrides - Partial fields to override defaults.
 * @returns A complete AttachmentInfo object.
 */
export function createAttachment(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
	return {
		filename: 'document.pdf',
		mimeType: 'application/pdf',
		size: 1024,
		attachmentId: `att-${Math.random().toString(36).slice(2, 8)}`,
		messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
		...overrides
	};
}

// =============================================================================
// Mock Helpers
// =============================================================================

/**
 * Response configuration for mockFetch. Each entry describes how
 * a single sequential fetch call should respond.
 */
interface MockFetchResponse {
	/** HTTP status code (default: 200). */
	status?: number;
	/** Response body (will be JSON.stringify'd). */
	body?: unknown;
	/** Whether to reject the promise (simulate network error). */
	networkError?: boolean;
	/** Error message for network errors. */
	errorMessage?: string;
}

/**
 * Sets up `globalThis.fetch` as a vi.fn() with sequential response config.
 *
 * Each call to fetch() returns the next response in the array. Extra calls
 * beyond the configured responses return a default 200 with empty body.
 *
 * @param responses - Array of response configurations, consumed in order.
 * @returns The mock function for additional assertions.
 */
export function mockFetch(responses: MockFetchResponse[]): ReturnType<typeof vi.fn> {
	let callIndex = 0;

	const mockFn = vi.fn(() => {
		const config = responses[callIndex++];
		if (!config) {
			return Promise.resolve(
				new Response(JSON.stringify({}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}

		if (config.networkError) {
			return Promise.reject(new Error(config.errorMessage ?? 'Network error'));
		}

		return Promise.resolve(
			new Response(JSON.stringify(config.body ?? {}), {
				status: config.status ?? 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
	});

	globalThis.fetch = mockFn as unknown as typeof fetch;
	return mockFn;
}

// =============================================================================
// Event Dispatch Helpers
// =============================================================================

/**
 * Dispatches a 'online' event on the window, simulating connectivity restore.
 */
export function fireOnline(): void {
	window.dispatchEvent(new Event('online'));
}

/**
 * Dispatches an 'offline' event on the window, simulating connectivity loss.
 */
export function fireOffline(): void {
	window.dispatchEvent(new Event('offline'));
}

/**
 * Flushes pending microtasks and macrotasks.
 * Useful for waiting for async effects in Svelte components.
 */
export async function flushPromises(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}
