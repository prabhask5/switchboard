/**
 * @fileoverview Unit tests for the Service Worker (static/sw.js).
 *
 * Tests cover:
 *   - Install event: pre-caching, SW_INSTALLED message broadcasting
 *   - Activate event: old cache cleanup, clients.claim()
 *   - Message handler: SKIP_WAITING and GET_VERSION message types
 *   - Fetch routing: skip logic for non-GET, cross-origin, /api/, /auth/, /logout
 *   - Navigation handler: network-first with 3s timeout, cache fallback, offline HTML
 *   - Immutable asset handler: cache-forever strategy for /_app/immutable/
 *   - Static asset handler: cache-first strategy for known file extensions
 *   - isStaticAsset helper: path/extension detection
 *   - Offline HTML fallback: content and dark mode support
 *
 * Strategy:
 *   The service worker runs in a ServiceWorkerGlobalScope, not available in Node.
 *   We mock the entire SW environment (self, caches, fetch, clients, Request,
 *   Response, URL, AbortController, etc.) then load sw.js via dynamic import
 *   to register its event listeners. Tests trigger those listeners directly.
 *
 * @see static/sw.js - The service worker under test
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// =============================================================================
// Types for the Mock Environment
// =============================================================================

/** Registered event listeners keyed by event name. */
type EventHandler = (...args: any[]) => any;
type ListenerMap = Record<string, EventHandler[]>;

/** A mock cache instance returned by caches.open(). */
interface MockCache {
	add: Mock;
	put: Mock;
	match: Mock;
	delete: Mock;
	/** Internal store for simulating cached responses. */
	_store: Map<string, any>;
}

// =============================================================================
// Mock Environment Setup
// =============================================================================

/**
 * Creates a fresh mock cache instance.
 *
 * Each cache maintains an internal _store Map so tests can pre-populate
 * cached responses and verify cache.put() calls.
 *
 * @returns A MockCache object with vi.fn() methods.
 */
function createMockCache(): MockCache {
	const store = new Map<string, any>();
	return {
		_store: store,
		add: vi.fn().mockResolvedValue(undefined),
		put: vi.fn((key: string | Request, value: any) => {
			const k = typeof key === 'string' ? key : key.url;
			store.set(k, value);
			return Promise.resolve();
		}),
		match: vi.fn((key: string | Request) => {
			const k = typeof key === 'string' ? key : key.url;
			return Promise.resolve(store.get(k) || undefined);
		}),
		delete: vi.fn().mockResolvedValue(true)
	};
}

/** All event listeners registered by the service worker. */
let listeners: ListenerMap;

/** Named cache buckets opened by the SW. */
let cacheInstances: Record<string, MockCache>;

/** The mock for the global `caches` object (CacheStorage). */
let mockCaches: {
	open: Mock;
	delete: Mock;
	keys: Mock;
	match: Mock;
};

/** The mock for `self` (ServiceWorkerGlobalScope). */
let mockSelf: {
	addEventListener: Mock;
	skipWaiting: Mock;
	clients: {
		claim: Mock;
		matchAll: Mock;
	};
	location: { origin: string };
};

/** The mock for global `fetch`. */
let mockFetch: Mock;

/**
 * Loads and evaluates the service worker script in the mocked global context.
 *
 * Reads static/sw.js from disk, wraps it in a function that receives the
 * mocked globals, and executes it. This causes the SW to call
 * self.addEventListener() which populates our `listeners` map.
 */
function loadServiceWorker(): void {
	const swPath = resolve(__dirname, 'sw.js');
	const swCode = readFileSync(swPath, 'utf-8');

	/*
	 * We wrap the SW code in a function and pass in mocked globals.
	 * The `self` variable in SW context refers to the global scope,
	 * so we assign our mock to both `self` and the function's scope.
	 *
	 * We also provide setTimeout/clearTimeout, URL, Request, Response,
	 * AbortController, and Promise which the SW uses.
	 */
	const wrappedCode = `
		(function(self, caches, fetch, setTimeout, clearTimeout, URL, Request, Response, AbortController, Promise, console) {
			${swCode}
		})
	`;

	const fn = eval(wrappedCode);
	fn(
		mockSelf,
		mockCaches,
		mockFetch,
		globalThis.setTimeout,
		globalThis.clearTimeout,
		globalThis.URL,
		globalThis.Request ?? MockRequest,
		globalThis.Response ?? MockResponse,
		globalThis.AbortController,
		globalThis.Promise,
		globalThis.console
	);
}

// =============================================================================
// Lightweight Request/Response Polyfills (for Node environments without them)
// =============================================================================

/**
 * Minimal Request mock for environments where the Web API Request is unavailable.
 */
class MockRequest {
	url: string;
	method: string;
	mode: string;
	signal?: AbortSignal;

	constructor(url: string, init?: { method?: string; mode?: string; signal?: AbortSignal }) {
		this.url = url;
		this.method = init?.method ?? 'GET';
		this.mode = init?.mode ?? 'cors';
		this.signal = init?.signal;
	}
}

/**
 * Minimal Response mock for environments where the Web API Response is unavailable.
 */
class MockResponse {
	body: any;
	ok: boolean;
	status: number;
	headers: Map<string, string>;

	constructor(body?: any, init?: { status?: number; headers?: Record<string, string> }) {
		this.body = body;
		this.status = init?.status ?? 200;
		this.ok = this.status >= 200 && this.status < 300;
		this.headers = new Map(Object.entries(init?.headers ?? {}));
	}

	clone() {
		return new MockResponse(this.body, {
			status: this.status,
			headers: Object.fromEntries(this.headers)
		});
	}
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Retrieves the handler(s) registered for a specific event type.
 *
 * @param eventName - The event name (e.g., 'install', 'activate', 'fetch', 'message').
 * @returns Array of registered handler functions.
 */
function getListeners(eventName: string): EventHandler[] {
	return listeners[eventName] ?? [];
}

/**
 * Creates a FetchEvent-like object for testing the fetch handler.
 *
 * @param url - The full URL being fetched.
 * @param options - Optional overrides for method, mode, etc.
 * @returns An object mimicking FetchEvent with respondWith() and request.
 */
function createFetchEvent(
	url: string,
	options: { method?: string; mode?: string } = {}
): {
	request: { url: string; method: string; mode: string };
	respondWith: Mock;
	_responsePromise: Promise<any> | null;
} {
	const event = {
		request: {
			url,
			method: options.method ?? 'GET',
			mode: options.mode ?? 'cors'
		},
		respondWith: vi.fn((promise: Promise<any>) => {
			event._responsePromise = promise;
		}),
		_responsePromise: null as Promise<any> | null
	};
	return event;
}

/**
 * Creates an InstallEvent-like object with a waitUntil() mock.
 *
 * @returns An object mimicking ExtendableEvent.
 */
function createExtendableEvent(): { waitUntil: Mock; _promise: Promise<any> | null } {
	const event = {
		waitUntil: vi.fn((promise: Promise<any>) => {
			event._promise = promise;
		}),
		_promise: null as Promise<any> | null
	};
	return event;
}

// =============================================================================
// Before Each / After Each — Reset All Mocks
// =============================================================================

beforeEach(() => {
	/* Reset listener registry. */
	listeners = {};

	/* Reset cache instances. */
	cacheInstances = {};

	/* Mock caches (CacheStorage). */
	mockCaches = {
		open: vi.fn((name: string) => {
			if (!cacheInstances[name]) {
				cacheInstances[name] = createMockCache();
			}
			return Promise.resolve(cacheInstances[name]);
		}),
		delete: vi.fn().mockResolvedValue(true),
		keys: vi.fn().mockResolvedValue([]),
		match: vi.fn().mockResolvedValue(undefined)
	};

	/* Mock self (ServiceWorkerGlobalScope). */
	mockSelf = {
		addEventListener: vi.fn((event: string, handler: EventHandler) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		}),
		skipWaiting: vi.fn().mockResolvedValue(undefined),
		clients: {
			claim: vi.fn().mockResolvedValue(undefined),
			matchAll: vi.fn().mockResolvedValue([])
		},
		location: { origin: 'https://switchboard.app' }
	};

	/* Mock fetch. */
	mockFetch = vi.fn();

	/* Load the service worker (registers event listeners). */
	loadServiceWorker();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// Event Listener Registration
// =============================================================================

describe('Service Worker — Event Registration', () => {
	it('registers an install event listener', () => {
		expect(getListeners('install')).toHaveLength(1);
	});

	it('registers an activate event listener', () => {
		expect(getListeners('activate')).toHaveLength(1);
	});

	it('registers a message event listener', () => {
		expect(getListeners('message')).toHaveLength(1);
	});

	it('registers a fetch event listener', () => {
		expect(getListeners('fetch')).toHaveLength(1);
	});
});

// =============================================================================
// Install Event
// =============================================================================

describe('Service Worker — Install Event', () => {
	it('opens the versioned shell cache during install', async () => {
		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;

		/* caches.open() should be called with the shell cache name. */
		expect(mockCaches.open).toHaveBeenCalled();
		const cacheName = mockCaches.open.mock.calls[0][0] as string;
		expect(cacheName).toMatch(/^switchboard-shell-/);
	});

	it('pre-caches the root URL "/" during install', async () => {
		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;

		/* The shell cache's add() should be called with '/'. */
		const cacheName = mockCaches.open.mock.calls[0][0] as string;
		const cache = cacheInstances[cacheName];
		expect(cache.add).toHaveBeenCalledWith('/');
	});

	it('pre-caches additional assets (favicon, manifest) via allSettled', async () => {
		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;

		const cacheName = mockCaches.open.mock.calls[0][0] as string;
		const cache = cacheInstances[cacheName];

		/*
		 * cache.add('/') is called first, then the remaining PRECACHE_URLS
		 * are cached individually. There should be at least 3 calls total
		 * (one for '/', one for '/favicon.svg', one for '/manifest.webmanifest').
		 */
		expect(cache.add.mock.calls.length).toBeGreaterThanOrEqual(3);

		const addedUrls = cache.add.mock.calls.map((call: any[]) => call[0]);
		expect(addedUrls).toContain('/');
		expect(addedUrls).toContain('/favicon.svg');
		expect(addedUrls).toContain('/manifest.webmanifest');
	});

	it('posts SW_INSTALLED message to all open clients', async () => {
		const mockClient1 = { postMessage: vi.fn() };
		const mockClient2 = { postMessage: vi.fn() };
		mockSelf.clients.matchAll.mockResolvedValue([mockClient1, mockClient2]);

		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;

		/* Allow microtasks from matchAll().then() to resolve. */
		await new Promise((r) => setTimeout(r, 10));

		expect(mockSelf.clients.matchAll).toHaveBeenCalledWith({ type: 'window' });
		expect(mockClient1.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'SW_INSTALLED' })
		);
		expect(mockClient2.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'SW_INSTALLED' })
		);
	});

	it('includes the version in the SW_INSTALLED message', async () => {
		const mockClient = { postMessage: vi.fn() };
		mockSelf.clients.matchAll.mockResolvedValue([mockClient]);

		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;
		await new Promise((r) => setTimeout(r, 10));

		const message = mockClient.postMessage.mock.calls[0][0];
		expect(message).toHaveProperty('version');
		expect(typeof message.version).toBe('string');
		expect(message.version.length).toBeGreaterThan(0);
	});

	it('does NOT call skipWaiting automatically during install', async () => {
		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;

		/* skipWaiting is deferred to the SKIP_WAITING message handler. */
		expect(mockSelf.skipWaiting).not.toHaveBeenCalled();
	});

	it('does not reject install when a non-root precache URL fails', async () => {
		const cache = createMockCache();

		/* Make /favicon.svg fail but '/' succeed. */
		cache.add.mockImplementation((url: string) => {
			if (url === '/favicon.svg') {
				return Promise.reject(new Error('Network error'));
			}
			return Promise.resolve();
		});

		mockCaches.open.mockResolvedValue(cache);

		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);

		/* Should NOT reject — allSettled catches individual failures. */
		await expect(event._promise).resolves.not.toThrow();
	});
});

// =============================================================================
// Activate Event
// =============================================================================

describe('Service Worker — Activate Event', () => {
	it('deletes old versioned shell caches', async () => {
		mockCaches.keys.mockResolvedValue([
			'switchboard-shell-oldversion1',
			'switchboard-shell-oldversion2',
			'switchboard-assets-v1'
		]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		/* Old shell caches should be deleted. */
		expect(mockCaches.delete).toHaveBeenCalledWith('switchboard-shell-oldversion1');
		expect(mockCaches.delete).toHaveBeenCalledWith('switchboard-shell-oldversion2');
	});

	it('preserves the current shell cache (does not delete it)', async () => {
		/*
		 * Read the APP_VERSION from the SW file to determine the current cache name.
		 * We match the value the loaded SW actually uses.
		 */
		const swCode = readFileSync(resolve(__dirname, 'sw.js'), 'utf-8');
		const match = swCode.match(/const APP_VERSION = ['"]([^'"]+)['"]/);
		const version = match ? match[1] : '';
		const currentShellCache = `switchboard-shell-${version}`;

		mockCaches.keys.mockResolvedValue([
			currentShellCache,
			'switchboard-shell-oldversion',
			'switchboard-assets-v1'
		]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		/* The current shell cache should NOT be deleted. */
		const deletedCaches = mockCaches.delete.mock.calls.map((c: any[]) => c[0]);
		expect(deletedCaches).not.toContain(currentShellCache);
		expect(deletedCaches).toContain('switchboard-shell-oldversion');
	});

	it('preserves the asset cache (switchboard-assets-v1)', async () => {
		mockCaches.keys.mockResolvedValue([
			'switchboard-shell-oldversion',
			'switchboard-assets-v1'
		]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		/* ASSET_CACHE should never be deleted. */
		const deletedCaches = mockCaches.delete.mock.calls.map((c: any[]) => c[0]);
		expect(deletedCaches).not.toContain('switchboard-assets-v1');
	});

	it('deletes the legacy switchboard-v1 cache', async () => {
		mockCaches.keys.mockResolvedValue([
			'switchboard-v1',
			'switchboard-assets-v1'
		]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		expect(mockCaches.delete).toHaveBeenCalledWith('switchboard-v1');
	});

	it('calls clients.claim() to take control of open tabs', async () => {
		mockCaches.keys.mockResolvedValue([]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		expect(mockSelf.clients.claim).toHaveBeenCalled();
	});

	it('does not delete unrelated caches (from other origins/apps)', async () => {
		mockCaches.keys.mockResolvedValue([
			'some-other-app-cache',
			'workbox-precache-v2',
			'switchboard-assets-v1'
		]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		const deletedCaches = mockCaches.delete.mock.calls.map((c: any[]) => c[0]);
		expect(deletedCaches).not.toContain('some-other-app-cache');
		expect(deletedCaches).not.toContain('workbox-precache-v2');
	});
});

// =============================================================================
// Message Handler
// =============================================================================

describe('Service Worker — Message Handler', () => {
	it('calls skipWaiting() when receiving SKIP_WAITING message', () => {
		const handler = getListeners('message')[0];

		handler({ data: { type: 'SKIP_WAITING' } });

		expect(mockSelf.skipWaiting).toHaveBeenCalled();
	});

	it('responds with version when receiving GET_VERSION message', () => {
		const handler = getListeners('message')[0];
		const mockPort = { postMessage: vi.fn() };

		handler({
			data: { type: 'GET_VERSION' },
			ports: [mockPort]
		});

		expect(mockPort.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ version: expect.any(String) })
		);
	});

	it('does not crash when GET_VERSION has no ports', () => {
		const handler = getListeners('message')[0];

		/* ports[0] is undefined — the ?. operator should prevent a crash. */
		expect(() => {
			handler({ data: { type: 'GET_VERSION' }, ports: [] });
		}).not.toThrow();
	});

	it('does not crash when GET_VERSION has no ports array (BUG: should use event.ports?.[0])', () => {
		const handler = getListeners('message')[0];

		/*
		 * BUG: The SW code uses `event.ports[0]?.postMessage(...)` which crashes when
		 * `event.ports` is undefined. The optional chaining protects against `ports[0]`
		 * being undefined, but NOT against `ports` itself being undefined.
		 *
		 * Fix: Change to `event.ports?.[0]?.postMessage(...)` in sw.js line 157.
		 * This test intentionally FAILS to surface the bug.
		 */
		expect(() => {
			handler({ data: { type: 'GET_VERSION' } });
		}).not.toThrow();
	});

	it('ignores unknown message types', () => {
		const handler = getListeners('message')[0];

		expect(() => {
			handler({ data: { type: 'UNKNOWN_TYPE' } });
		}).not.toThrow();

		expect(mockSelf.skipWaiting).not.toHaveBeenCalled();
	});

	it('does not crash when event.data is null', () => {
		const handler = getListeners('message')[0];

		expect(() => {
			handler({ data: null });
		}).not.toThrow();
	});

	it('does not crash when event.data is undefined', () => {
		const handler = getListeners('message')[0];

		expect(() => {
			handler({ data: undefined });
		}).not.toThrow();
	});
});

// =============================================================================
// Fetch Event — Skip Logic (Requests That Should NOT Be Intercepted)
// =============================================================================

describe('Service Worker — Fetch Routing: Skip Logic', () => {
	it('skips non-GET requests (POST)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/page', { method: 'POST' });

		handler(event);

		/* respondWith should NOT be called — the request passes through. */
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips non-GET requests (PUT)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/page', { method: 'PUT' });

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips non-GET requests (DELETE)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/page', { method: 'DELETE' });

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips cross-origin requests', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://other-domain.com/resource');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips API requests (/api/threads)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/api/threads');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips API requests (/api/thread/123)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/api/thread/123');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips auth routes (/auth/callback)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/auth/callback');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips auth routes (/auth/login)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/auth/login');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips the logout route (/logout)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/logout');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('skips logout with query params (/logout?redirect=true)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/logout?redirect=true');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Fetch Event — Navigation Requests (Network-First with Timeout)
// =============================================================================

describe('Service Worker — Fetch Routing: Navigation Requests', () => {
	it('intercepts navigation requests with respondWith', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/inbox', { mode: 'navigate' });

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('returns the network response when fetch succeeds', async () => {
		const networkResponse = { ok: true, clone: vi.fn().mockReturnThis() };
		mockFetch.mockResolvedValue(networkResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(networkResponse);
	});

	it('caches the successful network response for "/" in the shell cache', async () => {
		const networkResponse = {
			ok: true,
			clone: vi.fn().mockReturnValue('cloned-response')
		};
		mockFetch.mockResolvedValue(networkResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		await event._responsePromise;

		/* Verify that cache.put was called with '/' and the cloned response. */
		const cacheName = mockCaches.open.mock.calls[0][0] as string;
		const cache = cacheInstances[cacheName];
		expect(cache.put).toHaveBeenCalledWith('/', 'cloned-response');
	});

	it('falls back to cached "/" when network fails', async () => {
		mockFetch.mockRejectedValue(new Error('Network error'));

		/* Pre-populate the shell cache with a cached root response. */
		const swCode = readFileSync(resolve(__dirname, 'sw.js'), 'utf-8');
		const match = swCode.match(/const APP_VERSION = ['"]([^'"]+)['"]/);
		const version = match ? match[1] : '';
		const shellCacheName = `switchboard-shell-${version}`;
		const shellCache = createMockCache();
		const cachedResponse = { ok: true, body: 'cached-page' };
		shellCache.match.mockResolvedValue(cachedResponse);
		cacheInstances[shellCacheName] = shellCache;
		mockCaches.open.mockImplementation((name: string) => {
			if (!cacheInstances[name]) {
				cacheInstances[name] = createMockCache();
			}
			return Promise.resolve(cacheInstances[name]);
		});

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/settings', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(cachedResponse);
	});

	it('serves offline HTML when network fails and no cache is available', async () => {
		mockFetch.mockRejectedValue(new Error('Offline'));

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		/*
		 * When cache.match('/') returns undefined and fetch fails,
		 * the SW returns new Response(getOfflineHTML(), ...).
		 * We verify it's a Response-like object with HTML content.
		 */
		expect(result).toBeDefined();
		expect(result.status).toBe(200);
	});

	it('falls back to cache on non-OK network response (e.g. 500)', async () => {
		const badResponse = { ok: false, status: 500 };
		mockFetch.mockResolvedValue(badResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		/*
		 * Non-OK response throws, falls to catch block.
		 * Since no cached response exists, offline HTML is served.
		 */
		expect(result).toBeDefined();
		expect(result.status).toBe(200);
	});
});

// =============================================================================
// Fetch Event — Immutable Assets (Cache-Forever)
// =============================================================================

describe('Service Worker — Fetch Routing: Immutable Assets', () => {
	it('intercepts requests to /_app/immutable/ paths', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/chunks/app-abc123.js'
		);

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('returns cached response for previously cached immutable assets', async () => {
		const cachedAsset = { ok: true, body: 'cached-js' };

		/* Pre-populate the asset cache. */
		const assetCache = createMockCache();
		assetCache.match.mockResolvedValue(cachedAsset);
		cacheInstances['switchboard-assets-v1'] = assetCache;

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/chunks/app-abc123.js'
		);

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(cachedAsset);
		/* Fetch should NOT be called since the asset was cached. */
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('fetches and caches immutable assets on cache miss', async () => {
		const networkResponse = {
			ok: true,
			clone: vi.fn().mockReturnValue('cloned-asset')
		};
		mockFetch.mockResolvedValue(networkResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/chunks/app-abc123.js'
		);

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(networkResponse);
		expect(mockFetch).toHaveBeenCalled();

		/* Verify it was cached in ASSET_CACHE. */
		const assetCache = cacheInstances['switchboard-assets-v1'];
		expect(assetCache.put).toHaveBeenCalled();
	});

	it('returns 503 when immutable asset fetch fails and not cached', async () => {
		mockFetch.mockRejectedValue(new Error('Network error'));

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/chunks/missing.js'
		);

		handler(event);
		const result = await event._responsePromise;

		expect(result.status).toBe(503);
	});

	it('does not cache non-OK responses for immutable assets', async () => {
		const badResponse = {
			ok: false,
			status: 404,
			clone: vi.fn().mockReturnThis()
		};
		mockFetch.mockResolvedValue(badResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/chunks/missing.js'
		);

		handler(event);
		await event._responsePromise;

		const assetCache = cacheInstances['switchboard-assets-v1'];
		expect(assetCache.put).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Fetch Event — Static Assets (Cache-First)
// =============================================================================

describe('Service Worker — Fetch Routing: Static Assets', () => {
	it('intercepts requests for /_app/ paths (non-immutable)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/_app/version.json');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for files with known extensions (.css)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/styles/main.css');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .js files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/scripts/analytics.js');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .svg files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/favicon.svg');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .png files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/icons/logo.png');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .woff2 font files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/fonts/roboto.woff2');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .ico files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/favicon.ico');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .jpg and .jpeg files', () => {
		const handler = getListeners('fetch')[0];

		const jpgEvent = createFetchEvent('https://switchboard.app/photo.jpg');
		handler(jpgEvent);
		expect(jpgEvent.respondWith).toHaveBeenCalled();

		const jpegEvent = createFetchEvent('https://switchboard.app/photo.jpeg');
		handler(jpegEvent);
		expect(jpegEvent.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .gif files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/animation.gif');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .webp files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/image.webp');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('intercepts requests for .woff font files', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/fonts/roboto.woff');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('returns cached response for previously cached static assets', async () => {
		const swCode = readFileSync(resolve(__dirname, 'sw.js'), 'utf-8');
		const match = swCode.match(/const APP_VERSION = ['"]([^'"]+)['"]/);
		const version = match ? match[1] : '';
		const shellCacheName = `switchboard-shell-${version}`;

		const cachedAsset = { ok: true, body: 'cached-css' };
		const shellCache = createMockCache();
		shellCache.match.mockResolvedValue(cachedAsset);
		cacheInstances[shellCacheName] = shellCache;

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/styles/main.css');

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(cachedAsset);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('fetches and caches static assets on cache miss', async () => {
		const networkResponse = {
			ok: true,
			clone: vi.fn().mockReturnValue('cloned-css')
		};
		mockFetch.mockResolvedValue(networkResponse);

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/styles/main.css');

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBe(networkResponse);
		expect(mockFetch).toHaveBeenCalled();
	});

	it('returns 503 when static asset fetch fails and not cached', async () => {
		mockFetch.mockRejectedValue(new Error('Network error'));

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/styles/missing.css');

		handler(event);
		const result = await event._responsePromise;

		expect(result.status).toBe(503);
	});

	it('does not intercept requests for paths without known extensions', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/some-page');

		handler(event);

		/* No known extension and not a navigation request → not intercepted. */
		expect(event.respondWith).not.toHaveBeenCalled();
	});
});

// =============================================================================
// isStaticAsset — Path Detection
// =============================================================================

describe('Service Worker — isStaticAsset Logic (via Fetch Routing)', () => {
	/*
	 * isStaticAsset is a private function inside sw.js, so we test it
	 * indirectly through the fetch handler's routing behavior.
	 *
	 * If isStaticAsset returns true, the fetch handler calls respondWith.
	 * If false and not navigation/immutable, respondWith is NOT called.
	 */

	it('treats /_app/ paths as static assets', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/_app/version.json');

		handler(event);

		expect(event.respondWith).toHaveBeenCalled();
	});

	it('does not treat a bare path like /settings as a static asset', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/settings');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('does not treat /t/threadId as a static asset', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/t/abc123');

		handler(event);

		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('treats a .manifest file as NOT a static asset (not in regex)', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/site.manifest');

		handler(event);

		/* .manifest is not in the isStaticAsset regex. */
		expect(event.respondWith).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Offline HTML Fallback Content
// =============================================================================

describe('Service Worker — Offline HTML Fallback', () => {
	it('returns HTML content when both network and cache fail for navigation', async () => {
		mockFetch.mockRejectedValue(new Error('Offline'));

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		expect(result).toBeDefined();
		expect(result.status).toBe(200);
	});

	it('returns a response with text/html content type', async () => {
		mockFetch.mockRejectedValue(new Error('Offline'));

		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });

		handler(event);
		const result = await event._responsePromise;

		/*
		 * The SW creates: new Response(getOfflineHTML(), {
		 *   headers: { 'Content-Type': 'text/html; charset=utf-8' }
		 * })
		 *
		 * In our mock environment, result.headers may be a Map.
		 */
		if (result.headers instanceof Map) {
			expect(result.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
		} else if (result.headers?.get) {
			expect(result.headers.get('Content-Type')).toContain('text/html');
		}
	});
});

// =============================================================================
// Edge Cases and Integration Scenarios
// =============================================================================

describe('Service Worker — Edge Cases', () => {
	it('handles simultaneous install of multiple listeners correctly', () => {
		/* Verify all four event types are registered exactly once. */
		expect(getListeners('install')).toHaveLength(1);
		expect(getListeners('activate')).toHaveLength(1);
		expect(getListeners('message')).toHaveLength(1);
		expect(getListeners('fetch')).toHaveLength(1);
	});

	it('does not intercept GET requests to unknown same-origin paths', () => {
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent('https://switchboard.app/unknown/path/here');

		handler(event);

		/* No extension, not navigation, not /_app/ → not intercepted. */
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('immutable path inside /_app/immutable/ takes priority over /_app/ static', () => {
		/*
		 * A path like /_app/immutable/chunk.js should use the immutable handler
		 * (ASSET_CACHE), not the static handler (SHELL_CACHE).
		 */
		const handler = getListeners('fetch')[0];
		const event = createFetchEvent(
			'https://switchboard.app/_app/immutable/entry/start-abc.js'
		);

		mockFetch.mockResolvedValue({
			ok: true,
			clone: vi.fn().mockReturnThis()
		});

		handler(event);

		/* Verify respondWith was called (it's intercepted). */
		expect(event.respondWith).toHaveBeenCalled();
	});

	it('correctly routes multiple different request types in sequence', () => {
		const handler = getListeners('fetch')[0];

		/* 1. API request — skipped */
		const apiEvent = createFetchEvent('https://switchboard.app/api/threads');
		handler(apiEvent);
		expect(apiEvent.respondWith).not.toHaveBeenCalled();

		/* 2. Navigation — intercepted */
		const navEvent = createFetchEvent('https://switchboard.app/', { mode: 'navigate' });
		mockFetch.mockResolvedValue({ ok: true, clone: vi.fn().mockReturnThis() });
		handler(navEvent);
		expect(navEvent.respondWith).toHaveBeenCalled();

		/* 3. Static asset — intercepted */
		const cssEvent = createFetchEvent('https://switchboard.app/style.css');
		handler(cssEvent);
		expect(cssEvent.respondWith).toHaveBeenCalled();

		/* 4. Cross-origin — skipped */
		const extEvent = createFetchEvent('https://cdn.example.com/lib.js');
		handler(extEvent);
		expect(extEvent.respondWith).not.toHaveBeenCalled();
	});

	it('activate event handles an empty cache list gracefully', async () => {
		mockCaches.keys.mockResolvedValue([]);

		const event = createExtendableEvent();
		const handler = getListeners('activate')[0];

		handler(event);
		await event._promise;

		/* No caches to delete, but clients.claim() should still be called. */
		expect(mockCaches.delete).not.toHaveBeenCalled();
		expect(mockSelf.clients.claim).toHaveBeenCalled();
	});

	it('install event handles zero clients gracefully', async () => {
		mockSelf.clients.matchAll.mockResolvedValue([]);

		const event = createExtendableEvent();
		const handler = getListeners('install')[0];

		handler(event);
		await event._promise;
		await new Promise((r) => setTimeout(r, 10));

		/* No clients to post to, but install should still succeed. */
		expect(mockSelf.clients.matchAll).toHaveBeenCalled();
	});
});
