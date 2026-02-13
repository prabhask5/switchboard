/**
 * @fileoverview Service Worker for Email Switchboard PWA.
 *
 * This service worker provides offline capability by caching the app shell
 * (HTML, CSS, JS) so the SvelteKit app can load even without network.
 *
 * Caching Architecture (2 separate Cache Storage buckets):
 *
 *   1. SHELL_CACHE  - The app shell (HTML, favicon, manifest) and other static assets.
 *                     Versioned per deploy via APP_VERSION so old shells are cleaned up
 *                     when a new service worker activates.
 *
 *   2. ASSET_CACHE  - Immutable, content-hashed JS/CSS bundles from SvelteKit.
 *                     These never change (the hash changes instead), so they are
 *                     cached indefinitely and persist across app deploys.
 *
 * Version Management:
 *   APP_VERSION is automatically patched by the Vite build plugin (see vite.config.ts).
 *   On each build, a new base-36 timestamp is injected, causing the browser to detect
 *   a byte-different service worker file and trigger the install -> waiting -> activate
 *   lifecycle. The app's UpdateToast component listens for the SW_INSTALLED message
 *   to prompt the user to reload.
 *
 * Caching Strategy:
 *   - **Navigation requests (HTML pages)**: Network-first with 3s timeout + cache fallback.
 *     Ensures fresh content when online, cached pages when offline.
 *   - **Immutable assets (/_app/immutable/)**: Cache-forever in ASSET_CACHE.
 *     Content-hashed filenames mean the URL changes when the content changes.
 *   - **Other static assets**: Cache-first in SHELL_CACHE.
 *     Refreshed on each deploy when old SHELL_CACHE is deleted.
 *   - **API requests (/api/*)**: Network-only. API response caching is
 *     handled by IndexedDB in the app code (see cache.ts), not the SW.
 *
 * Offline Fallback:
 *   When a navigation request fails and no cached page is available,
 *   the SW serves a self-contained offline HTML page (no external deps)
 *   with a "Try Again" button. Includes @media (prefers-color-scheme: dark)
 *   for automatic dark mode support.
 *
 * @see vite.config.ts - serviceWorkerVersion() plugin that patches APP_VERSION
 */

/** Unique version identifier, auto-updated on each build by the Vite plugin. */
const APP_VERSION = 'mlk8wy0y';

/* ============================================================
   Cache Bucket Names
   ============================================================ */

/** App shell and static assets — versioned per deploy so old versions get cleaned up. */
const SHELL_CACHE = 'switchboard-shell-' + APP_VERSION;

/** Immutable hashed assets (JS/CSS) — persist across deploys since filenames contain content hashes. */
const ASSET_CACHE = 'switchboard-assets-v1';

/**
 * URLs to pre-cache during installation.
 * The root page is cached so the app shell loads offline.
 */
const PRECACHE_URLS = ['/', '/favicon.svg', '/icons/icon-192.svg', '/manifest.webmanifest'];

/* ============================================================
   Install Event
   ============================================================ */

/**
 * INSTALL EVENT
 *
 * Triggered when the browser detects a new or updated service worker.
 * Precaches the app shell into the versioned SHELL_CACHE, then notifies
 * all open tabs/windows so the UI can show an "Update available" toast.
 *
 * Note: skipWaiting() is NOT called here. Instead, the client sends a
 * SKIP_WAITING message when the user clicks "Update" in the toast.
 * This prevents disrupting active sessions with a mid-use cache swap.
 */
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(SHELL_CACHE).then(async (cache) => {
			// Cache the root HTML shell first — critical for offline support.
			await cache.add('/');
			// Cache remaining assets with allSettled so one failure doesn't block installation.
			await Promise.allSettled(
				PRECACHE_URLS.slice(1).map((url) => cache.add(url).catch(() => {}))
			);

			// Notify all open client windows that a new SW version is available.
			// The app's UpdateToast component listens for this message type.
			self.clients.matchAll({ type: 'window' }).then((clients) => {
				clients.forEach((client) => {
					client.postMessage({ type: 'SW_INSTALLED', version: APP_VERSION });
				});
			});
		})
	);
	// Don't skipWaiting automatically — let the client control the transition
	// via the SKIP_WAITING message handler below.
});

/* ============================================================
   Activate Event
   ============================================================ */

/**
 * ACTIVATE EVENT
 *
 * Triggered after install when the new SW takes control. Cleans up old
 * versioned shell caches and the legacy `switchboard-v1` cache from the
 * previous single-cache implementation. The persistent ASSET_CACHE
 * survives across deploys since immutable assets are still valid.
 *
 * clients.claim() ensures this SW immediately controls all open tabs
 * without requiring a page reload (useful after the user clicks "Update").
 */
self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const cacheNames = await caches.keys();
			await Promise.all(
				cacheNames
					.filter((name) => {
						// Delete old versioned shell caches (e.g., switchboard-shell-abc123).
						if (name.startsWith('switchboard-shell-') && name !== SHELL_CACHE) return true;
						// Delete the legacy single-cache from the previous SW implementation.
						if (name === 'switchboard-v1') return true;
						return false;
					})
					.map((name) => caches.delete(name))
			);
			// Take control of all open clients immediately (no reload needed).
			await self.clients.claim();
		})()
	);
});

/* ============================================================
   Client Message Handler
   ============================================================ */

/**
 * MESSAGE EVENT
 *
 * Handles postMessage() calls from the app's client-side JavaScript.
 * Supported message types:
 *
 *   - SKIP_WAITING: Sent when the user clicks "Update" in the UpdateToast.
 *     Calls skipWaiting() to promote this SW from "waiting" to "active".
 *
 *   - GET_VERSION: Sent by the app to query the current SW version.
 *     Responds via the MessagePort with the APP_VERSION string.
 */
self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}
	if (event.data?.type === 'GET_VERSION') {
		event.ports?.[0]?.postMessage({ version: APP_VERSION });
	}
});

/* ============================================================
   Fetch Event Router
   ============================================================ */

/**
 * FETCH EVENT
 *
 * Routes each GET request to the appropriate caching strategy:
 *
 *   1. Navigation (HTML pages)          -> handleNavigation()   [network-first, 3s timeout]
 *   2. Immutable assets (/_app/immutable/) -> handleImmutableAsset() [cache-forever]
 *   3. Other static assets (.js, .css, etc.) -> handleStaticAsset() [cache-first]
 *
 * Non-GET requests and API/auth/logout requests are passed through to the
 * network without interception.
 */
self.addEventListener('fetch', (event) => {
	/* Only intercept GET requests — POST/PUT/DELETE should always go to the network. */
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	/* Skip cross-origin requests. */
	if (url.origin !== self.location.origin) return;

	/* Skip API requests — these are cached by IndexedDB in the app. */
	if (url.pathname.startsWith('/api/')) return;

	/* Skip auth routes — OAuth redirects must always hit the server. */
	if (url.pathname.startsWith('/auth/')) return;

	/* Skip the logout route. */
	if (url.pathname.startsWith('/logout')) return;

	/* Navigation requests (HTML pages): network-first with cache fallback. */
	if (event.request.mode === 'navigate') {
		event.respondWith(handleNavigation(event.request));
		return;
	}

	/* Immutable assets: cache-forever in ASSET_CACHE. */
	if (url.pathname.includes('/_app/immutable/')) {
		event.respondWith(handleImmutableAsset(event.request));
		return;
	}

	/* Other static assets: cache-first in SHELL_CACHE. */
	if (isStaticAsset(url.pathname)) {
		event.respondWith(handleStaticAsset(event.request));
		return;
	}
});

/* ============================================================
   Caching Strategy Handlers
   ============================================================ */

/**
 * Navigation Handler — Network-first with 3-second timeout.
 *
 * Tries the network first to get the freshest HTML shell, but aborts after
 * 3 seconds and falls back to the cached app shell. Since this is a SPA,
 * all navigation requests serve the same root '/' HTML shell.
 *
 * Fallback chain: Network (3s timeout) -> Cached '/' -> Inline offline HTML
 *
 * @param {Request} request - The navigation request.
 * @returns {Promise<Response>} The HTML response for the page.
 */
async function handleNavigation(request) {
	const cache = await caches.open(SHELL_CACHE);

	try {
		// Set up a 3-second abort timeout for slow/unresponsive networks.
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 3000);

		const response = await fetch(request, { signal: controller.signal });
		clearTimeout(timeoutId);

		if (response.ok) {
			// Update the cached shell with the latest version for next offline use.
			cache.put('/', response.clone());
			return response;
		}
		// Non-OK responses (4xx, 5xx) — fall through to cache.
		throw new Error('Not ok');
	} catch {
		// Network failed or timed out — serve the cached app shell.
		const cached = await cache.match('/');
		if (cached) return cached;

		// No cached shell available — serve a minimal inline offline page.
		return new Response(getOfflineHTML(), {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' }
		});
	}
}

/**
 * Immutable Asset Handler — Cache-forever strategy.
 *
 * SvelteKit places content-hashed files under /_app/immutable/.
 * Because the filename contains a hash of the file contents, the content
 * at any given URL will never change, so we can cache permanently.
 *
 * Stored in ASSET_CACHE (unversioned) to persist across deploys.
 *
 * @param {Request} request - The asset request.
 * @returns {Promise<Response>} The cached or fetched asset response.
 */
async function handleImmutableAsset(request) {
	const cache = await caches.open(ASSET_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;

	try {
		const response = await fetch(request);
		if (response.ok) {
			cache.put(request, response.clone());
		}
		return response;
	} catch {
		return new Response('Asset not available offline', { status: 503 });
	}
}

/**
 * Static Asset Handler — Cache-first, no background revalidation.
 *
 * Handles non-hashed static files (favicon, manifest, non-immutable JS/CSS).
 * Stored in the versioned SHELL_CACHE, cleaned up on each new deploy.
 *
 * @param {Request} request - The static asset request.
 * @returns {Promise<Response>} The cached or fetched asset response.
 */
async function handleStaticAsset(request) {
	const cache = await caches.open(SHELL_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;

	try {
		const response = await fetch(request);
		if (response.ok) {
			cache.put(request, response.clone());
		}
		return response;
	} catch {
		return new Response('', { status: 503 });
	}
}

/**
 * Determines whether a given pathname refers to a static asset.
 *
 * @param {string} pathname - The URL pathname to check.
 * @returns {boolean} True if the pathname looks like a static asset.
 */
function isStaticAsset(pathname) {
	return (
		pathname.startsWith('/_app/') ||
		/\.(js|css|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/.test(pathname)
	);
}

/* ============================================================
   Offline Fallback HTML
   ============================================================ */

/**
 * Returns a self-contained offline HTML page.
 *
 * This is the last-resort fallback when a navigation request fails and
 * no cached page is available. Includes @media (prefers-color-scheme: dark)
 * for automatic dark mode support in the offline fallback.
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
    @media (prefers-color-scheme: dark) {
      body { background: #1f1f1f; color: #e8eaed; }
      .icon { color: #9aa0a6; }
      h1 { color: #e8eaed; }
      p { color: #9aa0a6; }
      button { background: #8ab4f8; color: #202124; }
      button:hover { background: #aecbfa; }
    }
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
