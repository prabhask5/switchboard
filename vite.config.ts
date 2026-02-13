/**
 * Vite Configuration for Email Switchboard
 *
 * Configures the Vite build tool for the SvelteKit application. This file handles:
 *   1. SvelteKit integration via the official Vite plugin
 *   2. Custom service worker versioning via the `serviceWorkerVersion` plugin
 *   3. Vitest configuration for unit testing
 *
 * The custom `serviceWorkerVersion` plugin ensures the service worker (static/sw.js)
 * gets a fresh version stamp on every build, which triggers cache invalidation for
 * returning users. It patches the `APP_VERSION` constant with a base-36 timestamp,
 * making the SW file byte-different on each build so the browser detects the update.
 *
 * @see https://vite.dev/config/
 */

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Custom Vite plugin that patches the service worker version on each build.
 *
 * Hooks into the `buildStart` lifecycle event to generate a unique version string
 * (base-36 timestamp) and inject it into `static/sw.js` by replacing the
 * `APP_VERSION` constant. This causes the browser to detect a new service worker
 * on the next visit, triggering the install -> waiting -> activate lifecycle.
 *
 * @returns A Vite plugin object with `name` and `buildStart` hooks.
 */
function serviceWorkerVersion() {
	return {
		name: 'service-worker-version',

		buildStart() {
			// Generate a compact, unique version using base-36 encoding of the current timestamp.
			const version = Date.now().toString(36);
			const swPath = resolve('static/sw.js');

			try {
				let swContent = readFileSync(swPath, 'utf-8');
				// Use a regex to find and replace the APP_VERSION constant regardless of its current value.
				swContent = swContent.replace(
					/const APP_VERSION = ['"][^'"]*['"]/,
					`const APP_VERSION = '${version}'`
				);
				writeFileSync(swPath, swContent);
				console.log(`[SW] Updated service worker version to: ${version}`);
			} catch (e) {
				console.warn('[SW] Could not update service worker version:', e);
			}
		}
	};
}

export default defineConfig({
	plugins: [
		sveltekit(), // Core SvelteKit Vite integration (routing, SSR, etc.)
		serviceWorkerVersion() // Custom plugin: SW version patching on each build
	],
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}', 'static/**/*.{test,spec}.{js,ts}'],
		environment: 'jsdom',
		setupFiles: ['./src/lib/vitest-setup.ts']
	},
	// Svelte 5 uses package.json "exports" conditions to select browser vs server bundle.
	// Without "browser" condition, jsdom tests resolve to the server bundle which lacks
	// mount(). Adding "browser" ensures @testing-library/svelte can render components.
	resolve: {
		conditions: process.env.VITEST ? ['browser'] : []
	}
});
