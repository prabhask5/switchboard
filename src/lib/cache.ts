/**
 * @fileoverview Client-Side IndexedDB Cache for Email Switchboard.
 *
 * Provides a lightweight key-value cache backed by IndexedDB for persisting
 * thread metadata and detail data across browser sessions. This enables:
 *
 *   - **Offline support**: When offline, the app shows cached thread lists
 *     and thread details from IndexedDB.
 *   - **Stale-while-revalidate**: Cached data is served immediately while
 *     fresh data is fetched in the background when online.
 *   - **Reduced API calls**: Already-fetched thread details don't need
 *     to be re-fetched on subsequent views.
 *
 * Storage Architecture:
 *   - **thread-metadata** store: Cached ThreadMetadata objects keyed by threadId.
 *     Updated whenever the inbox list is refreshed.
 *   - **thread-detail** store: Cached ThreadDetail objects keyed by threadId.
 *     Updated whenever the user opens a thread.
 *
 * All cached items include a `cachedAt` timestamp for staleness checks.
 * The cache does NOT auto-expire — the app decides when to revalidate
 * based on online/offline status and user actions.
 *
 * This module uses the raw IndexedDB API (no external dependencies) to
 * keep the bundle small. The API is Promise-wrapped for ergonomic usage.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
 */

import type { ThreadMetadata, ThreadDetail, CachedItem, AttachmentInfo } from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** IndexedDB database name for the Switchboard cache. */
const DB_NAME = 'switchboard-cache';

/** Current schema version. Increment when adding/modifying object stores. */
const DB_VERSION = 1;

/** Object store name for cached thread metadata (inbox list items). */
const METADATA_STORE = 'thread-metadata';

/** Object store name for cached thread details (full message bodies). */
const DETAIL_STORE = 'thread-detail';

// =============================================================================
// Database Initialization
// =============================================================================

/**
 * Singleton promise for the database connection.
 * Reused across all cache operations to avoid opening multiple connections.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Opens (or creates) the IndexedDB database.
 *
 * Creates object stores on first open or version upgrade. The database
 * is opened once and the connection is reused for all subsequent operations.
 *
 * @returns A promise resolving to the open IDBDatabase connection.
 */
function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;

	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		/**
		 * Called when the database is created or the version changes.
		 * Creates the object stores for thread metadata and detail.
		 */
		request.onupgradeneeded = () => {
			const db = request.result;

			/* Create stores if they don't already exist. */
			if (!db.objectStoreNames.contains(METADATA_STORE)) {
				db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains(DETAIL_STORE)) {
				db.createObjectStore(DETAIL_STORE, { keyPath: 'id' });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(request.error);
		};
	});

	return dbPromise;
}

// =============================================================================
// Generic Helpers
// =============================================================================

/**
 * Wraps an IDBRequest in a Promise for async/await usage.
 *
 * @param request - The IDBRequest to wrap.
 * @returns A promise that resolves with the request's result.
 */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * Puts a value into an object store (insert or update).
 *
 * @param storeName - The name of the object store.
 * @param value - The value to store (must include the keyPath property).
 */
async function putItem(storeName: string, value: unknown): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readwrite');
	const store = tx.objectStore(storeName);
	await promisify(store.put(value));
}

/**
 * Gets a value from an object store by key.
 *
 * @param storeName - The name of the object store.
 * @param key - The key to look up.
 * @returns The stored value, or undefined if not found.
 */
async function getItem<T>(storeName: string, key: string): Promise<T | undefined> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readonly');
	const store = tx.objectStore(storeName);
	return promisify(store.get(key)) as Promise<T | undefined>;
}

/**
 * Gets all values from an object store.
 *
 * @param storeName - The name of the object store.
 * @returns Array of all stored values.
 */
async function getAllItems<T>(storeName: string): Promise<T[]> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readonly');
	const store = tx.objectStore(storeName);
	return promisify(store.getAll()) as Promise<T[]>;
}

/**
 * Deletes a value from an object store by key.
 *
 * @param storeName - The name of the object store.
 * @param key - The key to delete.
 */
async function deleteItem(storeName: string, key: string): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readwrite');
	const store = tx.objectStore(storeName);
	await promisify(store.delete(key));
}

/**
 * Clears all values from an object store.
 *
 * @param storeName - The name of the object store.
 */
async function clearStore(storeName: string): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readwrite');
	const store = tx.objectStore(storeName);
	await promisify(store.clear());
}

/**
 * Counts the number of items in an object store.
 *
 * @param storeName - The name of the object store.
 * @returns The number of items in the store.
 */
async function countItems(storeName: string): Promise<number> {
	const db = await openDB();
	const tx = db.transaction(storeName, 'readonly');
	const store = tx.objectStore(storeName);
	return promisify(store.count());
}

// =============================================================================
// Thread Metadata Cache (Inbox List Items)
// =============================================================================

/** Shape of a cached metadata item in IndexedDB (includes keyPath `id`). */
interface CachedMetadataRow {
	/** Thread ID (used as keyPath in the object store). */
	id: string;
	/** The cached thread metadata. */
	data: ThreadMetadata;
	/** When this item was cached (epoch ms). */
	cachedAt: number;
}

/**
 * Caches thread metadata for a list of threads.
 *
 * Called after fetching metadata from the server. Each thread is stored
 * individually, keyed by its thread ID, so partial cache hits are possible.
 *
 * @param threads - Array of thread metadata objects to cache.
 */
export async function cacheThreadMetadata(threads: ThreadMetadata[]): Promise<void> {
	const now = Date.now();
	const db = await openDB();
	const tx = db.transaction(METADATA_STORE, 'readwrite');
	const store = tx.objectStore(METADATA_STORE);

	for (const thread of threads) {
		store.put({ id: thread.id, data: thread, cachedAt: now });
	}

	/* Wait for the transaction to complete. */
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * Retrieves all cached thread metadata.
 *
 * Used when offline to display the cached inbox list.
 *
 * @returns Array of all cached thread metadata with timestamps.
 */
export async function getAllCachedMetadata(): Promise<CachedItem<ThreadMetadata>[]> {
	const rows = await getAllItems<CachedMetadataRow>(METADATA_STORE);
	return rows.map((row) => ({ data: row.data, cachedAt: row.cachedAt }));
}

/**
 * Removes cached metadata for a specific thread.
 *
 * Called after a thread is trashed to keep the cache consistent.
 *
 * @param threadId - The thread ID to remove from cache.
 */
export async function removeCachedMetadata(threadId: string): Promise<void> {
	await deleteItem(METADATA_STORE, threadId);
}

// =============================================================================
// Thread Detail Cache (Full Message Bodies)
// =============================================================================

/** Shape of a cached detail item in IndexedDB (includes keyPath `id`). */
interface CachedDetailRow {
	/** Thread ID (used as keyPath in the object store). */
	id: string;
	/** The cached thread detail. */
	data: ThreadDetail;
	/** When this item was cached (epoch ms). */
	cachedAt: number;
}

/**
 * Caches a full thread detail (all messages with bodies).
 *
 * Called after fetching a thread for reading. The cached detail
 * persists across sessions and can be served offline.
 *
 * @param detail - The thread detail to cache.
 */
export async function cacheThreadDetail(detail: ThreadDetail): Promise<void> {
	await putItem(DETAIL_STORE, { id: detail.id, data: detail, cachedAt: Date.now() });
}

/**
 * Retrieves a cached thread detail by thread ID.
 *
 * @param threadId - The thread ID to look up.
 * @returns The cached detail with timestamp, or undefined if not cached.
 */
export async function getCachedThreadDetail(
	threadId: string
): Promise<CachedItem<ThreadDetail> | undefined> {
	const row = await getItem<CachedDetailRow>(DETAIL_STORE, threadId);
	if (!row) return undefined;
	return { data: row.data, cachedAt: row.cachedAt };
}

// =============================================================================
// Bulk Attachment Lookup
// =============================================================================

/**
 * Returns a map of threadId → flattened AttachmentInfo[] for all cached thread details.
 *
 * Iterates over every entry in the thread-detail IndexedDB store using a cursor,
 * flattens each thread's messages' attachments into a single array, and includes
 * the thread in the map only if it has at least one attachment.
 *
 * Used by the inbox page to show inline attachment previews on thread rows
 * without fetching thread details from the server.
 *
 * @returns Map from thread ID to its flattened attachment list.
 */
export async function getCachedAttachmentMap(): Promise<Map<string, AttachmentInfo[]>> {
	const db = await openDB();
	const tx = db.transaction(DETAIL_STORE, 'readonly');
	const store = tx.objectStore(DETAIL_STORE);
	const map = new Map<string, AttachmentInfo[]>();

	return new Promise((resolve, reject) => {
		const request = store.openCursor();

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				/* No more entries — resolve with the built map. */
				resolve(map);
				return;
			}

			const row = cursor.value as CachedDetailRow;
			if (row.data?.messages) {
				/* Flatten attachments from all messages in the thread. */
				const attachments: AttachmentInfo[] = [];
				for (const msg of row.data.messages) {
					if (msg.attachments && msg.attachments.length > 0) {
						attachments.push(...msg.attachments);
					}
				}
				if (attachments.length > 0) {
					map.set(row.id, attachments);
				}
			}

			cursor.continue();
		};

		request.onerror = () => reject(request.error);
	});
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Clears all cached data (both metadata and detail stores).
 *
 * Used when the user logs out or wants to clear their local cache.
 *
 */
export async function clearAllCaches(): Promise<void> {
	await clearStore(METADATA_STORE);
	await clearStore(DETAIL_STORE);
}

/**
 * Returns cache statistics for the diagnostics page.
 *
 * @returns Object with counts of cached metadata and detail items.
 */
export async function getCacheStats(): Promise<{
	metadataCount: number;
	detailCount: number;
}> {
	const [metadataCount, detailCount] = await Promise.all([
		countItems(METADATA_STORE),
		countItems(DETAIL_STORE)
	]);
	return { metadataCount, detailCount };
}
