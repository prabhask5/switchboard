/**
 * Theme Store
 *
 * Manages the application's light/dark colour scheme using a Svelte writable store.
 * The theme preference is persisted in localStorage and also applied to the root
 * `<html>` element via a `data-theme` attribute so that CSS can style accordingly.
 *
 * Resolution order for the initial theme:
 *   1. Explicit user choice stored in localStorage (`'light'` or `'dark'`).
 *   2. OS-level preference detected via the `prefers-color-scheme` media query.
 *   3. Falls back to `'light'` on the server (no DOM/media queries available).
 *
 * Reactive pattern: Svelte `writable` store. Components subscribe via `$theme` and
 * are re-rendered whenever `toggleTheme` or `initTheme` updates the value.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

/** The two supported colour schemes. */
export type Theme = 'light' | 'dark';

/**
 * Determines the theme that should be active when the store is first created.
 *
 * @returns The resolved theme, preferring a stored choice, then the OS preference,
 *          then `'light'` as the server-side default.
 */
export function getInitialTheme(): Theme {
	// Server-side rendering has no access to localStorage or matchMedia.
	if (!browser) return 'light';

	// 1. Check for an explicit user preference saved in a previous session.
	const stored = localStorage.getItem('theme');
	if (stored === 'light' || stored === 'dark') return stored;

	// 2. Fall back to the operating system's colour-scheme preference.
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Svelte writable store holding the current theme (`'light'` or `'dark'`).
 *
 * Initialized eagerly via {@link getInitialTheme} so the correct value is available
 * on the very first client-side render.
 */
export const theme = writable<Theme>(getInitialTheme());

/**
 * Toggles the theme between `'light'` and `'dark'`.
 *
 * On the client this also:
 *   - Persists the new value to localStorage for future sessions.
 *   - Sets the `data-theme` attribute on `<html>` so CSS variables update immediately.
 *
 * @returns void
 */
export function toggleTheme(): void {
	theme.update((t) => {
		const next = t === 'dark' ? 'light' : 'dark';
		if (browser) {
			localStorage.setItem('theme', next);

			// Suppress CSS transitions during the theme switch to prevent
			// elements with background transitions (e.g. unread thread rows)
			// from "flashing" as CSS variable values change instantly.
			document.documentElement.classList.add('no-transitions');
			document.documentElement.setAttribute('data-theme', next);

			// Re-enable transitions after the browser has painted the new theme.
			// requestAnimationFrame fires before the next paint, and the nested
			// rAF + setTimeout(0) ensures we wait until after that paint
			// completes before removing the class.
			requestAnimationFrame(() => {
				setTimeout(() => {
					document.documentElement.classList.remove('no-transitions');
				}, 0);
			});
		}
		return next;
	});
}

/**
 * Applies the resolved theme to the DOM and syncs the store.
 *
 * This should be called once during app initialisation (e.g. in a root layout's
 * `onMount`) to ensure the `data-theme` attribute is set before the first paint,
 * preventing a flash of the wrong colour scheme.
 *
 * @returns void
 */
export function initTheme(): void {
	if (!browser) return;
	const t = getInitialTheme();
	document.documentElement.setAttribute('data-theme', t);
	// Re-set the store in case the resolved theme differs from the SSR default
	// (e.g. the server assumed 'light' but the user's OS prefers 'dark').
	theme.set(t);
}
