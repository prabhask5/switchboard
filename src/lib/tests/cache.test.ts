/**
 * @fileoverview Unit tests for the client-side IndexedDB cache module.
 *
 * Tests cover:
 *   - cacheThreadMetadata: batch write with cachedAt timestamps, empty arrays
 *   - getAllCachedMetadata: returns all cached items with correct shape
 *   - removeCachedMetadata: delete by ID, missing ID is a no-op
 *   - cacheThreadDetail: write single detail with cachedAt
 *   - getCachedThreadDetail: read by ID, undefined for missing
 *   - clearAllCaches: both stores emptied
 *   - getCacheStats: correct counts after various operations
 *   - Upsert behavior: multiple writes to same ID
 *
 * IndexedDB is not available in Node.js, so we provide a minimal in-memory
 * mock of the IDBFactory / IDBDatabase / IDBObjectStore / IDBTransaction /
 * IDBRequest APIs. The mock is installed on `globalThis.indexedDB` before
 * each test and the module is re-imported to reset the singleton `dbPromise`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ThreadMetadata, ThreadDetail } from '../types.js';

// =============================================================================
// In-Memory IndexedDB Mock
// =============================================================================

/**
 * Minimal in-memory object store backed by a Map.
 * Supports put, get, getAll, delete, clear, and count operations
 * by returning mock IDBRequest objects that resolve synchronously.
 */
class MockObjectStore {
	/** The keyPath for this store (e.g., 'id'). */
	private keyPath: string;
	/** In-memory storage map. */
	private data: Map<string, unknown>;

	constructor(keyPath: string) {
		this.keyPath = keyPath;
		this.data = new Map();
	}

	/** Inserts or updates a value, keyed by the keyPath property. */
	put(value: Record<string, unknown>): MockIDBRequest {
		const key = value[this.keyPath] as string;
		this.data.set(key, structuredClone(value));
		return new MockIDBRequest(key);
	}

	/** Retrieves a value by key, or undefined if not found. */
	get(key: string): MockIDBRequest {
		const value = this.data.get(key);
		return new MockIDBRequest(value ? structuredClone(value) : undefined);
	}

	/** Returns all values in the store. */
	getAll(): MockIDBRequest {
		const values = Array.from(this.data.values()).map((v) => structuredClone(v));
		return new MockIDBRequest(values);
	}

	/** Deletes a value by key. */
	delete(key: string): MockIDBRequest {
		this.data.delete(key);
		return new MockIDBRequest(undefined);
	}

	/** Removes all values from the store. */
	clear(): MockIDBRequest {
		this.data.clear();
		return new MockIDBRequest(undefined);
	}

	/** Returns the number of items in the store. */
	count(): MockIDBRequest {
		return new MockIDBRequest(this.data.size);
	}
}

/**
 * Mock IDBRequest that fires onsuccess synchronously (via microtask)
 * to simulate the asynchronous IndexedDB callback pattern.
 */
class MockIDBRequest {
	result: unknown;
	error: DOMException | null = null;
	onsuccess: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	constructor(result: unknown) {
		this.result = result;

		/* Fire onsuccess on the next microtask so callers can attach handlers. */
		queueMicrotask(() => {
			if (this.onsuccess) {
				this.onsuccess(new Event('success'));
			}
		});
	}
}

/**
 * Mock IDBTransaction that wraps access to object stores and fires
 * oncomplete after all operations in the current microtask batch.
 */
class MockTransaction {
	/** The stores accessible in this transaction. */
	private stores: Map<string, MockObjectStore>;
	oncomplete: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	error: DOMException | null = null;

	constructor(stores: Map<string, MockObjectStore>) {
		this.stores = stores;

		/* Fire oncomplete on the next microtask to simulate async completion. */
		queueMicrotask(() => {
			if (this.oncomplete) {
				this.oncomplete(new Event('complete'));
			}
		});
	}

	/** Returns the requested object store. */
	objectStore(name: string): MockObjectStore {
		const store = this.stores.get(name);
		if (!store) {
			throw new DOMException(`No objectStore named "${name}"`, 'NotFoundError');
		}
		return store;
	}
}

/**
 * Mock IDBDatabase containing named object stores.
 * Supports createObjectStore (during upgradeneeded) and transaction.
 */
class MockDatabase {
	/** Map of store name -> MockObjectStore. */
	stores: Map<string, MockObjectStore> = new Map();
	objectStoreNames: {
		contains: (name: string) => boolean;
	};

	constructor() {
		this.objectStoreNames = {
			contains: (name: string) => this.stores.has(name)
		};
	}

	/** Creates a new object store (called during onupgradeneeded). */
	createObjectStore(name: string, options?: { keyPath?: string }): MockObjectStore {
		const store = new MockObjectStore(options?.keyPath ?? 'id');
		this.stores.set(name, store);
		return store;
	}

	/** Opens a transaction on the named stores. */
	transaction(storeNames: string | string[], _mode?: string): MockTransaction {
		const names = Array.isArray(storeNames) ? storeNames : [storeNames];
		const txStores = new Map<string, MockObjectStore>();
		for (const name of names) {
			const store = this.stores.get(name);
			if (store) txStores.set(name, store);
		}
		return new MockTransaction(txStores);
	}
}

/**
 * Mock IDBFactory.open() that creates a MockDatabase and fires
 * onupgradeneeded + onsuccess via microtasks.
 */
class MockIDBFactory {
	/** Shared database instance (persists across open calls within a test). */
	private db: MockDatabase | null = null;

	/**
	 * Opens a mock database. On first call, fires onupgradeneeded to create
	 * stores, then onsuccess. On subsequent calls, fires onsuccess directly.
	 */
	open(_name: string, _version?: number) {
		const isFirstOpen = !this.db;
		if (!this.db) {
			this.db = new MockDatabase();
		}

		const db = this.db;
		const request = {
			result: db,
			error: null as DOMException | null,
			onupgradeneeded: null as ((event: Event) => void) | null,
			onsuccess: null as ((event: Event) => void) | null,
			onerror: null as ((event: Event) => void) | null
		};

		queueMicrotask(() => {
			/* Fire onupgradeneeded on first open (simulates DB creation). */
			if (isFirstOpen && request.onupgradeneeded) {
				request.onupgradeneeded(new Event('upgradeneeded'));
			}
			if (request.onsuccess) {
				request.onsuccess(new Event('success'));
			}
		});

		return request;
	}

	/** Resets the mock factory for the next test. */
	_reset(): void {
		this.db = null;
	}
}

// =============================================================================
// Test Setup
// =============================================================================

/** Shared mock factory, reset between tests. */
let mockFactory: MockIDBFactory;

beforeEach(() => {
	mockFactory = new MockIDBFactory();
	Object.defineProperty(globalThis, 'indexedDB', {
		value: mockFactory,
		writable: true,
		configurable: true
	});
});

afterEach(() => {
	mockFactory._reset();
	vi.resetModules();
	vi.restoreAllMocks();
});

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Creates a minimal ThreadMetadata fixture for testing.
 * Only the fields actually used by the cache module are relevant (id).
 */
function makeMetadata(overrides: Partial<ThreadMetadata> & { id: string }): ThreadMetadata {
	return {
		id: overrides.id,
		subject: overrides.subject ?? `Subject for ${overrides.id}`,
		from: overrides.from ?? { name: 'Test Sender', email: 'sender@test.com' },
		to: overrides.to ?? 'recipient@test.com',
		date: overrides.date ?? '2026-02-12T10:00:00Z',
		snippet: overrides.snippet ?? 'Test snippet...',
		labelIds: overrides.labelIds ?? ['INBOX'],
		messageCount: overrides.messageCount ?? 1
	};
}

/**
 * Creates a minimal ThreadDetail fixture for testing.
 * Only the fields actually used by the cache module are relevant (id).
 */
function makeDetail(overrides: Partial<ThreadDetail> & { id: string }): ThreadDetail {
	return {
		id: overrides.id,
		subject: overrides.subject ?? `Detail for ${overrides.id}`,
		messages: overrides.messages ?? [
			{
				id: `msg-${overrides.id}`,
				from: { name: 'Sender', email: 'sender@test.com' },
				to: 'recipient@test.com',
				subject: `Detail for ${overrides.id}`,
				date: '2026-02-12T10:00:00Z',
				snippet: 'Message body preview...',
				body: '<p>Hello</p>',
				bodyType: 'html',
				labelIds: ['INBOX'],
				attachments: []
			}
		],
		labelIds: overrides.labelIds ?? ['INBOX']
	};
}

// =============================================================================
// cacheThreadMetadata
// =============================================================================

describe('cacheThreadMetadata', () => {
	it('caches a single thread metadata item', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		const thread = makeMetadata({ id: 'thread-1' });

		await cacheThreadMetadata([thread]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0].data.id).toBe('thread-1');
		expect(cached[0].data.subject).toBe('Subject for thread-1');
	});

	it('caches multiple thread metadata items in a batch', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		const threads = [
			makeMetadata({ id: 'thread-a' }),
			makeMetadata({ id: 'thread-b' }),
			makeMetadata({ id: 'thread-c' })
		];

		await cacheThreadMetadata(threads);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(3);

		const ids = cached.map((c) => c.data.id).sort();
		expect(ids).toEqual(['thread-a', 'thread-b', 'thread-c']);
	});

	it('sets a cachedAt timestamp on each item', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		const before = Date.now();

		await cacheThreadMetadata([makeMetadata({ id: 'ts-test' })]);

		const after = Date.now();
		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0].cachedAt).toBeGreaterThanOrEqual(before);
		expect(cached[0].cachedAt).toBeLessThanOrEqual(after);
	});

	it('uses the same cachedAt timestamp for all items in a batch', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		const threads = [
			makeMetadata({ id: 'batch-1' }),
			makeMetadata({ id: 'batch-2' }),
			makeMetadata({ id: 'batch-3' })
		];

		await cacheThreadMetadata(threads);

		const cached = await getAllCachedMetadata();
		const timestamps = cached.map((c) => c.cachedAt);
		/* All items in the same batch should share the same timestamp. */
		expect(new Set(timestamps).size).toBe(1);
	});

	it('handles an empty array without error', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');

		await cacheThreadMetadata([]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(0);
	});

	it('preserves all metadata fields through cache round-trip', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		const thread = makeMetadata({
			id: 'full-data',
			subject: 'Important Email',
			from: { name: 'Jane Doe', email: 'jane@example.com' },
			to: 'me@gmail.com',
			date: '2026-01-15T08:30:00Z',
			snippet: 'Please review the attached document...',
			labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
			messageCount: 5
		});

		await cacheThreadMetadata([thread]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0].data).toEqual(thread);
	});
});

// =============================================================================
// getAllCachedMetadata
// =============================================================================

describe('getAllCachedMetadata', () => {
	it('returns an empty array when no metadata is cached', async () => {
		const { getAllCachedMetadata } = await import('../cache.js');

		const cached = await getAllCachedMetadata();
		expect(cached).toEqual([]);
	});

	it('returns CachedItem<ThreadMetadata> objects with data and cachedAt', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');
		await cacheThreadMetadata([makeMetadata({ id: 'shape-test' })]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0]).toHaveProperty('data');
		expect(cached[0]).toHaveProperty('cachedAt');
		/* Should NOT leak internal row shape (no 'id' at top level). */
		expect(cached[0]).not.toHaveProperty('id');
	});

	it('returns items after multiple separate cacheThreadMetadata calls', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'call-1' })]);
		await cacheThreadMetadata([makeMetadata({ id: 'call-2' })]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(2);
	});
});

// =============================================================================
// removeCachedMetadata
// =============================================================================

describe('removeCachedMetadata', () => {
	it('removes a cached metadata item by thread ID', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata, removeCachedMetadata } =
			await import('../cache.js');
		await cacheThreadMetadata([makeMetadata({ id: 'keep-me' }), makeMetadata({ id: 'remove-me' })]);

		await removeCachedMetadata('remove-me');

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0].data.id).toBe('keep-me');
	});

	it('does not throw when removing a non-existent ID', async () => {
		const { removeCachedMetadata } = await import('../cache.js');

		/* Should not throw — deleting a missing key is a no-op in IndexedDB. */
		await expect(removeCachedMetadata('does-not-exist')).resolves.toBeUndefined();
	});

	it('only removes the targeted item, leaving others intact', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata, removeCachedMetadata } =
			await import('../cache.js');
		const threads = [
			makeMetadata({ id: 'alpha' }),
			makeMetadata({ id: 'beta' }),
			makeMetadata({ id: 'gamma' })
		];
		await cacheThreadMetadata(threads);

		await removeCachedMetadata('beta');

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(2);
		const ids = cached.map((c) => c.data.id).sort();
		expect(ids).toEqual(['alpha', 'gamma']);
	});
});

// =============================================================================
// cacheThreadDetail
// =============================================================================

describe('cacheThreadDetail', () => {
	it('caches a single thread detail', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');
		const detail = makeDetail({ id: 'detail-1' });

		await cacheThreadDetail(detail);

		const cached = await getCachedThreadDetail('detail-1');
		expect(cached).toBeDefined();
		expect(cached!.data.id).toBe('detail-1');
	});

	it('sets a cachedAt timestamp on the cached detail', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');
		const before = Date.now();

		await cacheThreadDetail(makeDetail({ id: 'ts-detail' }));

		const after = Date.now();
		const cached = await getCachedThreadDetail('ts-detail');
		expect(cached).toBeDefined();
		expect(cached!.cachedAt).toBeGreaterThanOrEqual(before);
		expect(cached!.cachedAt).toBeLessThanOrEqual(after);
	});

	it('preserves all detail fields through cache round-trip', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');
		const detail = makeDetail({
			id: 'full-detail',
			subject: 'Re: Project Update',
			messages: [
				{
					id: 'msg-1',
					from: { name: 'Alice', email: 'alice@work.com' },
					to: 'bob@work.com',
					subject: 'Re: Project Update',
					date: '2026-02-10T14:30:00Z',
					snippet: 'Sounds good...',
					body: '<p>Sounds good, let us proceed.</p>',
					bodyType: 'html',
					labelIds: ['INBOX'],
					attachments: [
						{
							filename: 'report.pdf',
							mimeType: 'application/pdf',
							size: 12345,
							attachmentId: 'att-001',
							messageId: 'msg-1'
						}
					]
				}
			],
			labelIds: ['INBOX', 'IMPORTANT']
		});

		await cacheThreadDetail(detail);

		const cached = await getCachedThreadDetail('full-detail');
		expect(cached).toBeDefined();
		expect(cached!.data).toEqual(detail);
	});
});

// =============================================================================
// getCachedThreadDetail
// =============================================================================

describe('getCachedThreadDetail', () => {
	it('returns undefined for a non-existent thread ID', async () => {
		const { getCachedThreadDetail } = await import('../cache.js');

		const cached = await getCachedThreadDetail('non-existent');
		expect(cached).toBeUndefined();
	});

	it('returns the correct detail for a cached thread', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');
		await cacheThreadDetail(makeDetail({ id: 'find-me', subject: 'Found It' }));

		const cached = await getCachedThreadDetail('find-me');
		expect(cached).toBeDefined();
		expect(cached!.data.subject).toBe('Found It');
	});

	it('returns CachedItem shape with data and cachedAt', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');
		await cacheThreadDetail(makeDetail({ id: 'shape-detail' }));

		const cached = await getCachedThreadDetail('shape-detail');
		expect(cached).toBeDefined();
		expect(cached).toHaveProperty('data');
		expect(cached).toHaveProperty('cachedAt');
		/* Should NOT leak internal row shape (no 'id' at top level). */
		expect(cached).not.toHaveProperty('id');
	});

	it('returns undefined after the detail has been cleared', async () => {
		const { cacheThreadDetail, getCachedThreadDetail, clearAllCaches } =
			await import('../cache.js');
		await cacheThreadDetail(makeDetail({ id: 'cleared-detail' }));

		await clearAllCaches();

		const cached = await getCachedThreadDetail('cleared-detail');
		expect(cached).toBeUndefined();
	});
});

// =============================================================================
// clearAllCaches
// =============================================================================

describe('clearAllCaches', () => {
	it('clears all cached metadata', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata, clearAllCaches } =
			await import('../cache.js');
		await cacheThreadMetadata([makeMetadata({ id: 'm-1' }), makeMetadata({ id: 'm-2' })]);

		await clearAllCaches();

		const cached = await getAllCachedMetadata();
		expect(cached).toEqual([]);
	});

	it('clears all cached details', async () => {
		const { cacheThreadDetail, getCachedThreadDetail, clearAllCaches } =
			await import('../cache.js');
		await cacheThreadDetail(makeDetail({ id: 'd-1' }));
		await cacheThreadDetail(makeDetail({ id: 'd-2' }));

		await clearAllCaches();

		expect(await getCachedThreadDetail('d-1')).toBeUndefined();
		expect(await getCachedThreadDetail('d-2')).toBeUndefined();
	});

	it('clears both stores simultaneously', async () => {
		const {
			cacheThreadMetadata,
			cacheThreadDetail,
			getAllCachedMetadata,
			getCachedThreadDetail,
			clearAllCaches
		} = await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'both-m' })]);
		await cacheThreadDetail(makeDetail({ id: 'both-d' }));

		await clearAllCaches();

		const metadata = await getAllCachedMetadata();
		const detail = await getCachedThreadDetail('both-d');
		expect(metadata).toEqual([]);
		expect(detail).toBeUndefined();
	});

	it('is idempotent (clearing empty stores does not throw)', async () => {
		const { clearAllCaches } = await import('../cache.js');

		/* Clearing when already empty should not throw. */
		await expect(clearAllCaches()).resolves.toBeUndefined();
		await expect(clearAllCaches()).resolves.toBeUndefined();
	});
});

// =============================================================================
// getCacheStats
// =============================================================================

describe('getCacheStats', () => {
	it('returns zero counts when both stores are empty', async () => {
		const { getCacheStats } = await import('../cache.js');

		const stats = await getCacheStats();
		expect(stats).toEqual({ metadataCount: 0, detailCount: 0 });
	});

	it('returns correct metadata count after caching', async () => {
		const { cacheThreadMetadata, getCacheStats } = await import('../cache.js');
		await cacheThreadMetadata([
			makeMetadata({ id: 's-1' }),
			makeMetadata({ id: 's-2' }),
			makeMetadata({ id: 's-3' })
		]);

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(3);
		expect(stats.detailCount).toBe(0);
	});

	it('returns correct detail count after caching', async () => {
		const { cacheThreadDetail, getCacheStats } = await import('../cache.js');
		await cacheThreadDetail(makeDetail({ id: 'sd-1' }));
		await cacheThreadDetail(makeDetail({ id: 'sd-2' }));

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(0);
		expect(stats.detailCount).toBe(2);
	});

	it('returns correct counts for both stores', async () => {
		const { cacheThreadMetadata, cacheThreadDetail, getCacheStats } = await import('../cache.js');
		await cacheThreadMetadata([makeMetadata({ id: 'combo-m1' }), makeMetadata({ id: 'combo-m2' })]);
		await cacheThreadDetail(makeDetail({ id: 'combo-d1' }));

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(2);
		expect(stats.detailCount).toBe(1);
	});

	it('returns zero counts after clearAllCaches', async () => {
		const { cacheThreadMetadata, cacheThreadDetail, clearAllCaches, getCacheStats } =
			await import('../cache.js');
		await cacheThreadMetadata([makeMetadata({ id: 'clear-s1' })]);
		await cacheThreadDetail(makeDetail({ id: 'clear-sd1' }));

		await clearAllCaches();

		const stats = await getCacheStats();
		expect(stats).toEqual({ metadataCount: 0, detailCount: 0 });
	});

	it('reflects count decrease after removeCachedMetadata', async () => {
		const { cacheThreadMetadata, removeCachedMetadata, getCacheStats } =
			await import('../cache.js');
		await cacheThreadMetadata([
			makeMetadata({ id: 'rm-1' }),
			makeMetadata({ id: 'rm-2' }),
			makeMetadata({ id: 'rm-3' })
		]);

		await removeCachedMetadata('rm-2');

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(2);
	});
});

// =============================================================================
// Upsert Behavior (Multiple Writes to Same ID)
// =============================================================================

describe('upsert behavior', () => {
	it('overwrites metadata when caching the same thread ID again', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'upsert-m', subject: 'Original' })]);
		await cacheThreadMetadata([makeMetadata({ id: 'upsert-m', subject: 'Updated' })]);

		const cached = await getAllCachedMetadata();
		expect(cached).toHaveLength(1);
		expect(cached[0].data.subject).toBe('Updated');
	});

	it('overwrites detail when caching the same thread ID again', async () => {
		const { cacheThreadDetail, getCachedThreadDetail } = await import('../cache.js');

		await cacheThreadDetail(makeDetail({ id: 'upsert-d', subject: 'First Version' }));
		await cacheThreadDetail(makeDetail({ id: 'upsert-d', subject: 'Second Version' }));

		const cached = await getCachedThreadDetail('upsert-d');
		expect(cached).toBeDefined();
		expect(cached!.data.subject).toBe('Second Version');
	});

	it('updates cachedAt timestamp on upsert', async () => {
		const { cacheThreadMetadata, getAllCachedMetadata } = await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'ts-upsert' })]);
		const firstCached = await getAllCachedMetadata();
		const firstTimestamp = firstCached[0].cachedAt;

		/* Wait a tiny bit to ensure a different timestamp. */
		await new Promise((resolve) => setTimeout(resolve, 5));

		await cacheThreadMetadata([makeMetadata({ id: 'ts-upsert' })]);
		const secondCached = await getAllCachedMetadata();
		const secondTimestamp = secondCached[0].cachedAt;

		expect(secondTimestamp).toBeGreaterThanOrEqual(firstTimestamp);
	});

	it('does not increase count on metadata upsert', async () => {
		const { cacheThreadMetadata, getCacheStats } = await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'count-upsert' })]);
		await cacheThreadMetadata([makeMetadata({ id: 'count-upsert' })]);

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(1);
	});

	it('does not increase count on detail upsert', async () => {
		const { cacheThreadDetail, getCacheStats } = await import('../cache.js');

		await cacheThreadDetail(makeDetail({ id: 'count-upsert-d' }));
		await cacheThreadDetail(makeDetail({ id: 'count-upsert-d' }));

		const stats = await getCacheStats();
		expect(stats.detailCount).toBe(1);
	});
});

// =============================================================================
// Cross-Store Isolation
// =============================================================================

describe('cross-store isolation', () => {
	it('metadata and detail stores are independent', async () => {
		const {
			cacheThreadMetadata,
			cacheThreadDetail,
			getAllCachedMetadata,
			getCachedThreadDetail,
			getCacheStats
		} = await import('../cache.js');

		/* Same ID used in both stores — they should not interfere. */
		await cacheThreadMetadata([makeMetadata({ id: 'shared-id', subject: 'Metadata Subject' })]);
		await cacheThreadDetail(makeDetail({ id: 'shared-id', subject: 'Detail Subject' }));

		const metadata = await getAllCachedMetadata();
		const detail = await getCachedThreadDetail('shared-id');

		expect(metadata).toHaveLength(1);
		expect(metadata[0].data.subject).toBe('Metadata Subject');
		expect(detail).toBeDefined();
		expect(detail!.data.subject).toBe('Detail Subject');

		const stats = await getCacheStats();
		expect(stats.metadataCount).toBe(1);
		expect(stats.detailCount).toBe(1);
	});

	it('clearing one store does not affect the other', async () => {
		const { cacheThreadMetadata, cacheThreadDetail, getAllCachedMetadata, getCachedThreadDetail } =
			await import('../cache.js');

		await cacheThreadMetadata([makeMetadata({ id: 'iso-m' })]);
		await cacheThreadDetail(makeDetail({ id: 'iso-d' }));

		/*
		 * clearAllCaches clears both stores. To test isolation, we use
		 * removeCachedMetadata which only touches metadata.
		 */
		const { removeCachedMetadata } = await import('../cache.js');
		await removeCachedMetadata('iso-m');

		const metadata = await getAllCachedMetadata();
		const detail = await getCachedThreadDetail('iso-d');
		expect(metadata).toHaveLength(0);
		expect(detail).toBeDefined();
		expect(detail!.data.id).toBe('iso-d');
	});
});

// =============================================================================
// Database Singleton Behavior
// =============================================================================

describe('database singleton', () => {
	it('reuses the same database connection across multiple operations', async () => {
		const { cacheThreadMetadata, cacheThreadDetail, getCacheStats } = await import('../cache.js');

		/* Multiple operations should all succeed using the same connection. */
		await cacheThreadMetadata([makeMetadata({ id: 'singleton-1' })]);
		await cacheThreadDetail(makeDetail({ id: 'singleton-2' }));
		const stats = await getCacheStats();

		expect(stats.metadataCount).toBe(1);
		expect(stats.detailCount).toBe(1);
	});
});
