/**
 * @fileoverview Tests for the UpdateToast Svelte component.
 *
 * Tests service worker update detection, toast visibility, button actions
 * (Update/Dismiss), and edge cases (missing SW, double-click guard).
 *
 * Mocks: `$app/environment` (browser = true), `navigator.serviceWorker`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import UpdateToast from '../UpdateToast.svelte';

/* ── Mock SvelteKit modules ───────────────────────────────────── */
vi.mock('$app/environment', () => ({
	browser: true
}));

// =============================================================================
// Helpers
// =============================================================================

/** Creates a mock ServiceWorkerRegistration with configurable waiting worker. */
function createMockRegistration(hasWaiting = false) {
	const waitingWorker = hasWaiting
		? { postMessage: vi.fn(), state: 'installed' as ServiceWorkerState }
		: null;
	return {
		waiting: waitingWorker,
		installing: null,
		active: { state: 'activated' as ServiceWorkerState },
		update: vi.fn(() => Promise.resolve()),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	};
}

/** Creates a mock navigator.serviceWorker object. */
function createMockServiceWorker(registration: ReturnType<typeof createMockRegistration> | null) {
	const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
	return {
		getRegistration: vi.fn(() => Promise.resolve(registration)),
		ready: Promise.resolve(registration),
		controller: { state: 'activated' as ServiceWorkerState },
		addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		}),
		removeEventListener: vi.fn(),
		_listeners: listeners
	};
}

describe('UpdateToast', () => {
	/** Stores the original navigator.serviceWorker descriptor. */
	const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

	/** Sets up navigator.serviceWorker mock. */
	function setupServiceWorker(mock: ReturnType<typeof createMockServiceWorker> | undefined): void {
		Object.defineProperty(navigator, 'serviceWorker', {
			value: mock,
			writable: true,
			configurable: true
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		/* Restore original navigator.serviceWorker. */
		if (originalDescriptor) {
			Object.defineProperty(navigator, 'serviceWorker', originalDescriptor);
		} else {
			/* If it didn't exist, delete it. */
			try {
				Object.defineProperty(navigator, 'serviceWorker', {
					value: undefined,
					writable: true,
					configurable: true
				});
			} catch {
				/* Some environments don't allow this — ignore. */
			}
		}
	});

	it('is not rendered when no waiting service worker', async () => {
		const reg = createMockRegistration(false);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		/* Advance past initial setTimeout(1000) but not the 60s setInterval. */
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('renders toast when registration has waiting worker', async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByRole('alert')).toBeInTheDocument();
	});

	it("shows 'A new version is available' text", async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByText('A new version is available')).toBeInTheDocument();
	});

	it('Update button exists', async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByText('Update')).toBeInTheDocument();
	});

	it("Dismiss button has aria-label='Dismiss'", async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByLabelText('Dismiss')).toBeInTheDocument();
	});

	it('clicking Dismiss hides the toast', async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByRole('alert')).toBeInTheDocument();

		await fireEvent.click(screen.getByLabelText('Dismiss'));

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('clicking Update sends SKIP_WAITING to waiting worker', async () => {
		const reg = createMockRegistration(true);
		const swMock = createMockServiceWorker(reg);
		setupServiceWorker(swMock);

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		await fireEvent.click(screen.getByText('Update'));

		/* Let the getRegistration promise resolve. */
		await vi.advanceTimersByTimeAsync(500);

		expect(reg.waiting!.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
	});

	it('clicking Update listens for controllerchange', async () => {
		const reg = createMockRegistration(true);
		const swMock = createMockServiceWorker(reg);
		setupServiceWorker(swMock);

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		await fireEvent.click(screen.getByText('Update'));
		await vi.advanceTimersByTimeAsync(500);

		/* Verify controllerchange listener was added. */
		const addedEvents = swMock.addEventListener.mock.calls.map((call: unknown[]) => call[0]);
		expect(addedEvents).toContain('controllerchange');
	});

	it('clicking Update hides the toast immediately', async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.getByRole('alert')).toBeInTheDocument();

		await fireEvent.click(screen.getByText('Update'));

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('is not rendered when navigator.serviceWorker is undefined', async () => {
		setupServiceWorker(undefined);

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('shows toast when SW_INSTALLED message received', async () => {
		const reg = createMockRegistration(false);
		const swMock = createMockServiceWorker(reg);
		setupServiceWorker(swMock);

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		/* No toast initially. */
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();

		/* Now simulate a waiting worker appearing. */
		(reg as { waiting: unknown }).waiting = {
			postMessage: vi.fn(),
			state: 'installed'
		};

		/* Simulate the SW_INSTALLED message. */
		const messageListeners = swMock._listeners['message'] ?? [];
		for (const listener of messageListeners) {
			listener({ data: { type: 'SW_INSTALLED' } });
		}

		/* The component delays 500ms after SW_INSTALLED before checking. */
		await vi.advanceTimersByTimeAsync(600);

		expect(screen.getByRole('alert')).toBeInTheDocument();
	});

	it('toast contains refresh/reload icon SVG', async () => {
		const reg = createMockRegistration(true);
		setupServiceWorker(createMockServiceWorker(reg));

		render(UpdateToast);
		await vi.advanceTimersByTimeAsync(2000);

		const alert = screen.getByRole('alert');
		const svgs = alert.querySelectorAll('svg');
		/* Should have at least the refresh icon + dismiss icon. */
		expect(svgs.length).toBeGreaterThanOrEqual(2);
	});
});
