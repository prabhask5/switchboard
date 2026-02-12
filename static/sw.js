/**
 * @fileoverview Service Worker for Email Switchboard PWA.
 *
 * This service worker provides offline capability by caching the app shell
 * (HTML, CSS, JS) so the SvelteKit app can load even without network.
 *
 * Caching Strategy:
 *   - **App shell (static assets)**: Cache-first with network fallback.
 *     Cached on install and updated on new SW version.
 *   - **Navigation requests (HTML pages)**: Network-first with cache fallback.
 *     Ensures fresh content when online, cached pages when offline.
 *   - **API requests (/api/*)**: Network-only. API response caching is
 *     handled by IndexedDB in the app code (see cache.ts), not the SW.
 *     This gives the app full control over cache invalidation.
 *
 * Offline Fallback:
 *   When a navigation request fails and no cached page is available,
 *   the SW serves a self-contained offline HTML page (no external deps)
 *   with a "Try Again" button. This ensures every route is accessible
 *   offline — either the cached SvelteKit page or the offline fallback.
 *
 * Lifecycle:
 *   1. `install`: Pre-caches the app shell (root page).
 *   2. `activate`: Cleans up old cache versions.
 *   3. `fetch`: Routes requests through the appropriate caching strategy.
 *
 * Why not cache API responses in the SW?
 *   The app needs fine-grained control over which threads are cached,
 *   staleness checks, and cache invalidation on delete. IndexedDB in
 *   the main thread is more appropriate for this than the Cache API.
 */

/** Cache version — increment to force cache refresh on deploy. */
const CACHE_VERSION = 'switchboard-v1';

/**
 * URLs to pre-cache during installation.
 * The root page is cached so the app shell loads offline.
 * SvelteKit's generated assets are cached on first fetch.
 */
const PRECACHE_URLS = ['/'];

// =============================================================================
// Install Event
// =============================================================================

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_VERSION)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => {
				/* Skip waiting to activate the new SW immediately. */
				return self.skipWaiting();
			})
	);
});

// =============================================================================
// Activate Event
// =============================================================================

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) => {
				return Promise.all(
					cacheNames
						.filter((name) => name !== CACHE_VERSION)
						.map((name) => caches.delete(name))
				);
			})
			.then(() => {
				/* Take control of all open clients immediately. */
				return self.clients.claim();
			})
	);
});

// =============================================================================
// Fetch Event
// =============================================================================

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	/*
	 * Skip non-GET requests (POST, DELETE, etc.).
	 * State-changing requests should always go to the network.
	 */
	if (event.request.method !== 'GET') return;

	/*
	 * Skip API requests — these are cached by IndexedDB in the app.
	 * Letting them through to the network (or failing) allows the app
	 * code to handle offline fallback with cached IndexedDB data.
	 */
	if (url.pathname.startsWith('/api/')) return;

	/*
	 * Skip auth routes — OAuth redirects must always hit the server.
	 */
	if (url.pathname.startsWith('/auth/')) return;

	/*
	 * Skip the logout route.
	 */
	if (url.pathname.startsWith('/logout')) return;

	/*
	 * For navigation requests (HTML pages): network-first with cache fallback.
	 * This ensures the user gets fresh content when online, and the cached
	 * app shell when offline. If no cached page exists, serves the inline
	 * offline fallback HTML.
	 */
	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					/* Cache the fresh response for future offline use. */
					const clone = response.clone();
					caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
					return response;
				})
				.catch(() => {
					/*
					 * Network failed — try serving the cached version of this page,
					 * then fall back to the cached root page (app shell),
					 * then serve the inline offline HTML as a last resort.
					 */
					return caches.match(event.request).then((cached) => {
						if (cached) return cached;
						return caches.match('/').then((root) => {
							if (root) return root;
							return new Response(getOfflineHTML(), {
								status: 200,
								headers: { 'Content-Type': 'text/html; charset=utf-8' }
							});
						});
					});
				})
		);
		return;
	}

	/*
	 * For static assets (JS, CSS, images): cache-first with network fallback.
	 * SvelteKit's immutable assets have hashed filenames, so cached versions
	 * are always valid. Non-immutable assets get refreshed on navigation.
	 */
	event.respondWith(
		caches.match(event.request).then((cached) => {
			if (cached) return cached;

			return fetch(event.request).then((response) => {
				/*
				 * Only cache successful responses from our own origin.
				 * Avoid caching opaque responses or errors.
				 */
				if (response.ok && url.origin === self.location.origin) {
					const clone = response.clone();
					caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
				}
				return response;
			});
		})
	);
});

// =============================================================================
// Offline Fallback HTML
// =============================================================================

/**
 * Returns a self-contained offline HTML page.
 *
 * This is the last-resort fallback when a navigation request fails and
 * no cached page is available. The page is fully inline (no external CSS
 * or JS dependencies) so it renders even with no cache at all.
 *
 * Styled to match the Email Switchboard Gmail-like theme.
 *
 * @returns {string} Complete HTML document as a string.
 */
function getOfflineHTML() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline - Email Switchboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #f6f8fc;
      color: #202124;
      font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont,
        'Segoe UI', Helvetica, Arial, sans-serif;
      padding: 2rem;
      text-align: center;
    }
    .icon {
      width: 64px;
      height: 64px;
      margin-bottom: 24px;
      color: #5f6368;
    }
    h1 {
      font-size: 22px;
      font-weight: 400;
      margin-bottom: 8px;
      color: #202124;
    }
    p {
      color: #5f6368;
      max-width: 360px;
      line-height: 1.6;
      font-size: 14px;
      margin-bottom: 24px;
    }
    button {
      padding: 8px 24px;
      background: #1a73e8;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { background: #1765cc; }
  </style>
</head>
<body>
  <svg class="icon" viewBox="0 0 24 24" fill="currentColor">
    <path d="M24 8.98A16.88 16.88 0 0012 4C7.31 4 3.07 5.9 0 8.98l2 2.27A13.91 13.91 0 0112 7c3.48 0 6.63 1.26 9.08 3.33L24 8.98zM2.92 13.07l2 2.27A9.8 9.8 0 0112 12c2.7 0 5.13 1.04 6.93 2.74l2-2.27A12.83 12.83 0 0012 9c-3.6 0-6.86 1.41-9.08 3.07zM12 15c-1.63 0-3.06.6-4.17 1.57l2 2.27a3.43 3.43 0 012.17-.84c.8 0 1.56.31 2.17.84l2-2.27A6.45 6.45 0 0012 15z"/>
  </svg>
  <h1>You're offline</h1>
  <p>Check your internet connection and try again. Previously viewed emails may still be available from your cache.</p>
  <button onclick="location.reload()">Try again</button>
</body>
</html>`;
}
