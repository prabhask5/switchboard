/**
 * @fileoverview Tests for the OfflineBanner Svelte component.
 *
 * Tests rendering, online/offline transitions, accessibility attributes,
 * and cleanup behaviour. The component uses the browser's online/offline
 * events to reactively show/hide a fixed pill-shaped banner.
 *
 * Mocks: `$app/environment` (browser = true)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import OfflineBanner from '../OfflineBanner.svelte';

/* ── Mock SvelteKit modules ───────────────────────────────────── */
vi.mock('$app/environment', () => ({
	browser: true
}));

describe('OfflineBanner', () => {
	/** Stores the original navigator.onLine descriptor so we can restore it. */
	const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');

	/**
	 * Helper: sets navigator.onLine to a specific value.
	 * Uses Object.defineProperty because navigator.onLine is read-only.
	 */
	function setOnlineStatus(online: boolean): void {
		Object.defineProperty(navigator, 'onLine', {
			value: online,
			writable: true,
			configurable: true
		});
	}

	beforeEach(() => {
		/* Default to online so most tests start with no banner. */
		setOnlineStatus(true);
	});

	afterEach(() => {
		cleanup();
		/* Restore original navigator.onLine descriptor. */
		if (originalDescriptor) {
			Object.defineProperty(navigator, 'onLine', originalDescriptor);
		}
	});

	it('is not rendered when navigator.onLine is true', () => {
		render(OfflineBanner);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('is rendered with role="alert" when navigator.onLine starts false', () => {
		setOnlineStatus(false);
		render(OfflineBanner);
		expect(screen.getByRole('alert')).toBeInTheDocument();
	});

	it('shows correct text: "You\'re offline. Some features may not work."', () => {
		setOnlineStatus(false);
		render(OfflineBanner);
		expect(screen.getByRole('alert')).toHaveTextContent(
			"You're offline. Some features may not work."
		);
	});

	it('appears when offline event fires (online → offline transition)', async () => {
		render(OfflineBanner);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		window.dispatchEvent(new Event('offline'));

		/* Svelte 5 batches state updates — wait for DOM to reflect the change. */
		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
	});

	it('disappears when online event fires (offline → online transition)', async () => {
		setOnlineStatus(false);
		render(OfflineBanner);
		expect(screen.getByRole('alert')).toBeInTheDocument();

		window.dispatchEvent(new Event('online'));

		await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
	});

	it('handles rapid online/offline toggling', async () => {
		render(OfflineBanner);

		window.dispatchEvent(new Event('offline'));
		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

		window.dispatchEvent(new Event('online'));
		await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

		window.dispatchEvent(new Event('offline'));
		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

		window.dispatchEvent(new Event('online'));
		await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
	});

	it('contains WiFi icon SVG', () => {
		setOnlineStatus(false);
		render(OfflineBanner);

		const alert = screen.getByRole('alert');
		const svg = alert.querySelector('svg');
		expect(svg).toBeInTheDocument();
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
	});

	it('cleans up event listeners on unmount', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');

		const { unmount } = render(OfflineBanner);
		unmount();

		/* Verify both offline and online listeners were removed. */
		const removedEvents = removeSpy.mock.calls.map((call) => call[0]);
		expect(removedEvents).toContain('offline');
		expect(removedEvents).toContain('online');

		removeSpy.mockRestore();
	});
});
