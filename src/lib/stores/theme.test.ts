/**
 * Theme Store Tests
 *
 * Tests for the theme store module: initial theme resolution, localStorage
 * persistence, OS preference detection, toggleTheme flipping + DOM attribute,
 * and initTheme sync. Mocks `browser`, `localStorage`, `matchMedia`, and
 * `document.documentElement`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* --------------------------------------------------------------------------
   Mocks
   -------------------------------------------------------------------------- */

/**
 * We need to mock `$app/environment` before importing the theme module.
 * The `browser` flag determines whether getInitialTheme reads localStorage.
 */
let mockBrowser = true;

vi.mock('$app/environment', () => ({
	get browser() {
		return mockBrowser;
	}
}));

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/** Fake localStorage backed by a plain Map. */
function createFakeLocalStorage() {
	const store = new Map<string, string>();
	return {
		getItem: vi.fn((key: string) => store.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => store.set(key, value)),
		removeItem: vi.fn((key: string) => store.delete(key)),
		clear: vi.fn(() => store.clear()),
		get length() {
			return store.size;
		},
		key: vi.fn((_index: number) => null)
	} satisfies Storage;
}

/** Fake matchMedia that returns the given `matches` value for dark preference. */
function createFakeMatchMedia(prefersDark: boolean) {
	return vi.fn((query: string) => ({
		matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn()
	}));
}

/** Spy on document.documentElement.setAttribute. */
let setAttributeSpy: ReturnType<typeof vi.fn>;

/* --------------------------------------------------------------------------
   Setup / Teardown
   -------------------------------------------------------------------------- */

beforeEach(() => {
	mockBrowser = true;
	// Reset the localStorage mock.
	Object.defineProperty(globalThis, 'localStorage', {
		value: createFakeLocalStorage(),
		writable: true,
		configurable: true
	});
	// Reset matchMedia to default (prefers light).
	Object.defineProperty(globalThis, 'window', {
		value: globalThis,
		writable: true,
		configurable: true
	});
	Object.defineProperty(globalThis, 'matchMedia', {
		value: createFakeMatchMedia(false),
		writable: true,
		configurable: true
	});
	// Spy on setAttribute for the root element.
	setAttributeSpy = vi.fn();
	Object.defineProperty(globalThis, 'document', {
		value: {
			documentElement: {
				setAttribute: setAttributeSpy
			}
		},
		writable: true,
		configurable: true
	});
});

afterEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
});

/* --------------------------------------------------------------------------
   Tests
   -------------------------------------------------------------------------- */

describe('getInitialTheme()', () => {
	it('returns "light" when running on the server (browser = false)', async () => {
		mockBrowser = false;
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('light');
	});

	it('returns stored "dark" from localStorage', async () => {
		localStorage.setItem('theme', 'dark');
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('returns stored "light" from localStorage', async () => {
		localStorage.setItem('theme', 'light');
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('light');
	});

	it('ignores invalid localStorage values and checks OS preference', async () => {
		localStorage.setItem('theme', 'blue');
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(true),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('falls back to OS dark preference when nothing stored', async () => {
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(true),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('falls back to "light" when OS prefers light and nothing stored', async () => {
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(false),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('./theme.js');
		expect(getInitialTheme()).toBe('light');
	});
});

describe('toggleTheme()', () => {
	it('flips from light to dark', async () => {
		// Start with no stored value (defaults to light since OS is light).
		const { theme, toggleTheme } = await import('./theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		toggleTheme();

		expect(current).toBe('dark');
		expect(localStorage.setItem).toHaveBeenCalledWith('theme', 'dark');
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'dark');

		unsub();
	});

	it('flips from dark to light', async () => {
		localStorage.setItem('theme', 'dark');
		const { theme, toggleTheme } = await import('./theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		expect(current).toBe('dark');

		toggleTheme();

		expect(current).toBe('light');
		expect(localStorage.setItem).toHaveBeenCalledWith('theme', 'light');
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'light');

		unsub();
	});

	it('double toggle returns to original', async () => {
		const { theme, toggleTheme } = await import('./theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		const original = current;
		toggleTheme();
		toggleTheme();

		expect(current).toBe(original);

		unsub();
	});
});

describe('initTheme()', () => {
	it('sets data-theme attribute on documentElement', async () => {
		const { initTheme } = await import('./theme.js');
		initTheme();
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'light');
	});

	it('syncs the store with the resolved theme', async () => {
		localStorage.setItem('theme', 'dark');
		const { theme, initTheme } = await import('./theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		initTheme();

		expect(current).toBe('dark');
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'dark');

		unsub();
	});

	it('does nothing on the server', async () => {
		mockBrowser = false;
		const { initTheme } = await import('./theme.js');
		initTheme();
		expect(setAttributeSpy).not.toHaveBeenCalled();
	});
});
