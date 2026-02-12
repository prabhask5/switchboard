/**
 * @fileoverview Inbox data management utilities.
 *
 * Pure functions for managing the in-memory thread list. The primary export
 * is {@link mergeThreads}, which implements the surgical merge strategy
 * that prevents the "blank flash" when refreshing inbox data.
 *
 * These functions are pure (no side effects, no DOM, no fetch) so they can
 * be thoroughly unit tested in isolation.
 */

import type { ThreadMetadata } from './types.js';

// =============================================================================
// Thread Merge
// =============================================================================

/**
 * Surgically merges server threads into an existing local thread list.
 *
 * This is the core of the cache-first architecture: instead of replacing the
 * entire list (which causes a blank flash in the UI), we update/add individual
 * threads and return a new array. The caller assigns this back to the reactive
 * state variable, triggering a minimal Svelte re-render.
 *
 * Merge modes:
 *
 *   - **'refresh'**: For background refresh of page 1. Updates existing threads
 *     with fresh server data (e.g., label changes like UNREAD→READ, new snippet
 *     text) and prepends new threads. Does NOT remove threads missing from this
 *     page — they may simply be on a later page, not deleted.
 *
 *   - **'append'**: For pagination. Adds only threads that don't already exist
 *     in the local list (deduplication by thread ID). Existing threads are left
 *     untouched.
 *
 * @param existing - The current local thread list (from cache or prior fetches).
 * @param serverThreads - Fresh thread metadata from the server.
 * @param mode - How to merge: 'refresh' updates + adds, 'append' adds only.
 * @returns A new array with the merged result. Returns `existing` by reference
 *          if no changes are needed (optimization for Svelte reactivity).
 */
export function mergeThreads(
	existing: ThreadMetadata[],
	serverThreads: ThreadMetadata[],
	mode: 'refresh' | 'append'
): ThreadMetadata[] {
	if (serverThreads.length === 0) return existing;

	/* Build a lookup map of existing threads by ID for O(1) checks. */
	const existingMap = new Map(existing.map((t) => [t.id, t]));

	if (mode === 'refresh') {
		/*
		 * Build a map of server threads for efficient lookup, then walk the
		 * local list replacing any thread that has a newer version from the
		 * server (e.g., UNREAD label removed, snippet changed).
		 */
		const serverMap = new Map(serverThreads.map((t) => [t.id, t]));
		const updated = existing.map((t) => serverMap.get(t.id) ?? t);

		/* New threads = in server response but not in local list. */
		const newThreads = serverThreads.filter((t) => !existingMap.has(t.id));

		/*
		 * Prepend new threads (they're the newest) and keep updated existing
		 * ones. Always return a new array reference for Svelte reactivity.
		 */
		return [...newThreads, ...updated];
	}

	/* Append mode: only add threads not already present (dedup by ID). */
	const newThreads = serverThreads.filter((t) => !existingMap.has(t.id));
	if (newThreads.length === 0) return existing;
	return [...existing, ...newThreads];
}
