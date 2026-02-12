/**
 * @fileoverview Unit tests for the reactive online/offline state detector.
 *
 * Tests cover:
 *   - createOnlineState():
 *       - Returns an object with `current` property and `destroy()` method
 *       - Initial state reflects navigator.onLine value
 *       - Defaults to true (online) when navigator is undefined (SSR)
 *   - Online/offline event tracking:
 *       - Updates `current` to false when 'offline' event fires
 *       - Updates `current` to true when 'online' event fires
 *       - Handles rapid online/offline toggling
 *       - Reflects correct state after multiple transitions
 *   - Cleanup via destroy():
 *       - Removes event listeners from window
 *       - No longer updates state after destroy() is called
 *       - Can be called multiple times without error (idempotent)
 *   - SSR / non-browser environment:
 *       - Does not throw when window is undefined
 *       - Does not throw when navigator is undefined
 *
 * Since this module uses Svelte 5 $state runes, the Svelte compiler
 * (via the Vite/Vitest plugin) handles the rune transformation at
 * import time. We mock the browser APIs (navigator.onLine, window
 * event listeners) to test the reactive behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Mock Setup
// =============================================================================

/**
 * Storage for event listeners registered via window.addEventListener.
 * Used to manually dispatch events in tests.
 */
let eventListeners: Map<string, Set<EventListener>>;

/** The mocked navigator.onLine value. */
let mockOnlineStatus: boolean;

/** Spy for window.addEventListener. */
let addEventListenerSpy: ReturnType<typeof vi.fn>;

/** Spy for window.removeEventListener. */
let removeEventListenerSpy: ReturnType<typeof vi.fn>;

/**
 * Sets up the browser API mocks for each test.
 *
 * Creates a mock window with addEventListener/removeEventListener that
 * track listeners in a Map, and a mock navigator with a configurable
 * onLine property.
 */
function setupBrowserMocks(initialOnline: boolean = true): void {
	mockOnlineStatus = initialOnline;
	eventListeners = new Map();

	addEventListenerSpy = vi.fn((type: string, listener: EventListener) => {
		if (!eventListeners.has(type)) {
			eventListeners.set(type, new Set());
		}
		eventListeners.get(type)!.add(listener);
	});

	removeEventListenerSpy = vi.fn((type: string, listener: EventListener) => {
		eventListeners.get(type)?.delete(listener);
	});

	/* Mock window with event listener tracking. */
	Object.defineProperty(globalThis, 'window', {
		value: {
			addEventListener: addEventListenerSpy,
			removeEventListener: removeEventListenerSpy
		},
		writable: true,
		configurable: true
	});

	/* Mock navigator.onLine. */
	Object.defineProperty(globalThis, 'navigator', {
		value: {
			get onLine() {
				return mockOnlineStatus;
			}
		},
		writable: true,
		configurable: true
	});
}

/**
 * Dispatches a mock event to all registered listeners for the given type.
 */
function dispatchMockEvent(type: string): void {
	const listeners = eventListeners.get(type);
	if (listeners) {
		for (const listener of listeners) {
			listener(new Event(type));
		}
	}
}

// =============================================================================
// Test Lifecycle
// =============================================================================

/** Store originals for cleanup. */
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

beforeEach(() => {
	setupBrowserMocks(true);
});

afterEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();

	/* Restore original globals. */
	if (originalWindow === undefined) {
		delete (globalThis as any).window;
	} else {
		(globalThis as any).window = originalWindow;
	}
	if (originalNavigator === undefined) {
		delete (globalThis as any).navigator;
	} else {
		(globalThis as any).navigator = originalNavigator;
	}
});

// =============================================================================
// Tests — Object Shape & Initial State
// =============================================================================

describe('createOnlineState — object shape', () => {
	it('returns an object with a `current` property', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state).toHaveProperty('current');
		expect(typeof state.current).toBe('boolean');

		state.destroy();
	});

	it('returns an object with a `destroy` method', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state).toHaveProperty('destroy');
		expect(typeof state.destroy).toBe('function');

		state.destroy();
	});
});

describe('createOnlineState — initial state', () => {
	it('reflects navigator.onLine = true as current = true', async () => {
		setupBrowserMocks(true);
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(true);

		state.destroy();
	});

	it('reflects navigator.onLine = false as current = false', async () => {
		setupBrowserMocks(false);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(false);

		state.destroy();
	});
});

// =============================================================================
// Tests — Event Tracking
// =============================================================================

describe('createOnlineState — event tracking', () => {
	it('registers online and offline event listeners on window', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(addEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
		expect(addEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function));

		state.destroy();
	});

	it('updates current to false when offline event fires', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(true);

		dispatchMockEvent('offline');

		expect(state.current).toBe(false);

		state.destroy();
	});

	it('updates current to true when online event fires', async () => {
		setupBrowserMocks(false);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(false);

		dispatchMockEvent('online');

		expect(state.current).toBe(true);

		state.destroy();
	});

	it('handles rapid online/offline toggling correctly', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(true);

		dispatchMockEvent('offline');
		expect(state.current).toBe(false);

		dispatchMockEvent('online');
		expect(state.current).toBe(true);

		dispatchMockEvent('offline');
		expect(state.current).toBe(false);

		dispatchMockEvent('offline'); /* Duplicate offline event. */
		expect(state.current).toBe(false);

		dispatchMockEvent('online');
		expect(state.current).toBe(true);

		state.destroy();
	});

	it('tracks state through multiple transitions', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		const expectedStates: boolean[] = [];
		const actualStates: boolean[] = [];

		/* Simulate a sequence of connectivity changes. */
		for (let i = 0; i < 10; i++) {
			const goOffline = i % 2 === 0;
			dispatchMockEvent(goOffline ? 'offline' : 'online');
			expectedStates.push(!goOffline);
			actualStates.push(state.current);
		}

		expect(actualStates).toEqual(expectedStates);

		state.destroy();
	});
});

// =============================================================================
// Tests — destroy() Cleanup
// =============================================================================

describe('createOnlineState — destroy()', () => {
	it('removes event listeners from window', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		state.destroy();

		expect(removeEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
		expect(removeEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function));
	});

	it('removes the exact same listener references that were added', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		/* Get the listener functions that were registered. */
		const onlineListener = addEventListenerSpy.mock.calls.find(
			(c: unknown[]) => c[0] === 'online'
		)?.[1];
		const offlineListener = addEventListenerSpy.mock.calls.find(
			(c: unknown[]) => c[0] === 'offline'
		)?.[1];

		state.destroy();

		/* The exact same function references should be passed to remove. */
		expect(removeEventListenerSpy).toHaveBeenCalledWith('online', onlineListener);
		expect(removeEventListenerSpy).toHaveBeenCalledWith('offline', offlineListener);
	});

	it('can be called multiple times without error (idempotent)', async () => {
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		/* Multiple destroy calls should not throw. */
		expect(() => state.destroy()).not.toThrow();
		expect(() => state.destroy()).not.toThrow();
		expect(() => state.destroy()).not.toThrow();
	});

	it('no longer updates state after destroy() is called', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(true);

		state.destroy();

		/*
		 * After destroy(), dispatching events should not update state
		 * because the listeners have been removed from eventListeners.
		 * The mock's removeEventListener actually removes from our Set,
		 * so dispatchMockEvent will no longer reach the handler.
		 */
		dispatchMockEvent('offline');
		expect(state.current).toBe(true);
	});
});

// =============================================================================
// Tests — Multiple Instances
// =============================================================================

describe('createOnlineState — multiple instances', () => {
	it('supports multiple independent instances', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');

		const state1 = createOnlineState();
		const state2 = createOnlineState();

		expect(state1.current).toBe(true);
		expect(state2.current).toBe(true);

		dispatchMockEvent('offline');

		/* Both instances should reflect the change. */
		expect(state1.current).toBe(false);
		expect(state2.current).toBe(false);

		state1.destroy();
		state2.destroy();
	});

	it('destroying one instance does not affect another', async () => {
		setupBrowserMocks(true);
		vi.resetModules();
		const { createOnlineState } = await import('./offline.svelte.js');

		const state1 = createOnlineState();
		const state2 = createOnlineState();

		/* Destroy only the first instance. */
		state1.destroy();

		/* Second instance should still respond to events. */
		dispatchMockEvent('offline');
		expect(state2.current).toBe(false);

		dispatchMockEvent('online');
		expect(state2.current).toBe(true);

		state2.destroy();
	});
});

// =============================================================================
// Tests — SSR / Non-browser Environment
// =============================================================================

describe('createOnlineState — SSR safety', () => {
	it('defaults to true when navigator is undefined', async () => {
		/* Remove navigator to simulate SSR. */
		delete (globalThis as any).navigator;
		vi.resetModules();

		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		expect(state.current).toBe(true);

		state.destroy();
	});

	it('does not throw when window is undefined', async () => {
		/* Remove window to simulate SSR. */
		delete (globalThis as any).window;
		vi.resetModules();

		const { createOnlineState } = await import('./offline.svelte.js');

		expect(() => {
			const state = createOnlineState();
			state.destroy();
		}).not.toThrow();
	});

	it('does not register event listeners when window is undefined', async () => {
		delete (globalThis as any).window;
		vi.resetModules();

		const { createOnlineState } = await import('./offline.svelte.js');
		const state = createOnlineState();

		/* No addEventListener should have been called since window is gone. */
		expect(addEventListenerSpy).not.toHaveBeenCalled();

		state.destroy();
	});
});
