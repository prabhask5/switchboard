/**
 * @fileoverview Tests for the Login Page Svelte component.
 *
 * Tests rendering of the sign-in card, online/offline state transitions,
 * error banner display from URL parameters, and accessibility attributes.
 *
 * Mocks: `$app/environment` (browser = true), `$app/stores` (page store)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import LoginPage from '../+page.svelte';

/* ── Mock SvelteKit modules ───────────────────────────────────── */
vi.mock('$app/environment', () => ({
	browser: true
}));

/**
 * Configurable page store mock. Each test can override the URL to test
 * different query parameter scenarios (e.g., ?error=access_denied).
 * Uses vi.hoisted() so the variable is available when vi.mock runs.
 */
const mockState = vi.hoisted(() => ({
	url: new URL('http://localhost/login')
}));

vi.mock('$app/stores', () => ({
	page: {
		subscribe: (fn: (v: unknown) => void) => {
			fn({
				url: mockState.url,
				params: {},
				route: { id: '/login' },
				status: 200,
				error: null,
				data: {},
				form: null,
				state: {}
			});
			return () => {};
		}
	}
}));

describe('Login Page', () => {
	/** Stores the original navigator.onLine descriptor. */
	const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');

	/** Sets navigator.onLine to a specific value. */
	function setOnlineStatus(online: boolean): void {
		Object.defineProperty(navigator, 'onLine', {
			value: online,
			writable: true,
			configurable: true
		});
	}

	beforeEach(() => {
		setOnlineStatus(true);
		mockState.url = new URL('http://localhost/login');
	});

	afterEach(() => {
		cleanup();
		if (originalDescriptor) {
			Object.defineProperty(navigator, 'onLine', originalDescriptor);
		}
	});

	// =========================================================================
	// Rendering
	// =========================================================================

	it("renders 'Sign in' heading", () => {
		render(LoginPage);
		expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
	});

	it("renders subtitle 'to continue to Email Switchboard'", () => {
		render(LoginPage);
		expect(screen.getByText('to continue to Email Switchboard')).toBeInTheDocument();
	});

	it('renders Google sign-in button with Google SVG icon', () => {
		render(LoginPage);
		const link = screen.getByText('Sign in with Google');
		expect(link).toBeInTheDocument();
		/* The link should contain an SVG icon. */
		const svg = link.querySelector('svg');
		expect(svg).toBeInTheDocument();
	});

	it('renders permission note about Gmail access', () => {
		render(LoginPage);
		expect(
			screen.getByText('We only request access to read and manage your Gmail inbox.')
		).toBeInTheDocument();
	});

	// =========================================================================
	// Online State
	// =========================================================================

	it('sign-in button is an <a> link to /auth/google when online', () => {
		render(LoginPage);
		const link = screen.getByText('Sign in with Google');
		expect(link.tagName).toBe('A');
		expect(link).toHaveAttribute('href', '/auth/google');
	});

	it("link has data-sveltekit-preload-data='off'", () => {
		render(LoginPage);
		const link = screen.getByText('Sign in with Google');
		expect(link).toHaveAttribute('data-sveltekit-preload-data', 'off');
	});

	it('sign-in button is a disabled <span> when offline', () => {
		setOnlineStatus(false);
		render(LoginPage);
		const button = screen.getByText('Sign in with Google');
		expect(button.tagName).toBe('SPAN');
	});

	it("disabled span has aria-disabled='true'", () => {
		setOnlineStatus(false);
		render(LoginPage);
		const button = screen.getByText('Sign in with Google');
		expect(button).toHaveAttribute('aria-disabled', 'true');
	});

	// =========================================================================
	// Error Banner
	// =========================================================================

	it('shows access_denied message when ?error=access_denied', () => {
		mockState.url = new URL('http://localhost/login?error=access_denied');
		render(LoginPage);
		expect(
			screen.getByText('You denied access. Please try again to use Email Switchboard.')
		).toBeInTheDocument();
	});

	it('shows generic error message for other error params', () => {
		mockState.url = new URL('http://localhost/login?error=server_error');
		render(LoginPage);
		expect(screen.getByText('Authentication error: server_error')).toBeInTheDocument();
	});

	it("error banner has role='alert'", () => {
		mockState.url = new URL('http://localhost/login?error=access_denied');
		render(LoginPage);
		const alerts = screen.getAllByRole('alert');
		const errorAlert = alerts.find((el) => el.textContent?.includes('You denied access'));
		expect(errorAlert).toBeInTheDocument();
	});

	it('no error banner when no error param', () => {
		render(LoginPage);
		/* Should not find any alert with error text. */
		const alerts = screen.queryAllByRole('alert');
		const errorAlerts = alerts.filter(
			(el) => el.textContent?.includes('denied') || el.textContent?.includes('Authentication error')
		);
		expect(errorAlerts).toHaveLength(0);
	});

	// =========================================================================
	// Offline Notice
	// =========================================================================

	it('shows offline notice when navigator.onLine=false', () => {
		setOnlineStatus(false);
		render(LoginPage);
		expect(
			screen.getByText('You need to be online to sign in. Please check your internet connection.')
		).toBeInTheDocument();
	});

	it("offline notice has role='alert'", () => {
		setOnlineStatus(false);
		render(LoginPage);
		const alerts = screen.getAllByRole('alert');
		const offlineAlert = alerts.find((el) => el.textContent?.includes('You need to be online'));
		expect(offlineAlert).toBeInTheDocument();
	});

	it('no offline notice when online', () => {
		render(LoginPage);
		expect(
			screen.queryByText('You need to be online to sign in. Please check your internet connection.')
		).not.toBeInTheDocument();
	});
});
