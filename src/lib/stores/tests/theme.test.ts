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

/** Spy on document.documentElement.classList.add/remove. */
let classListAddSpy: ReturnType<typeof vi.fn>;
let classListRemoveSpy: ReturnType<typeof vi.fn>;

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
	// Mock requestAnimationFrame (not available in Node test environment).
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
		writable: true,
		configurable: true
	});
	// Spy on setAttribute and classList for the root element.
	setAttributeSpy = vi.fn();
	classListAddSpy = vi.fn();
	classListRemoveSpy = vi.fn();
	Object.defineProperty(globalThis, 'document', {
		value: {
			documentElement: {
				setAttribute: setAttributeSpy,
				classList: {
					add: classListAddSpy,
					remove: classListRemoveSpy
				}
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
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('light');
	});

	it('returns stored "dark" from localStorage', async () => {
		localStorage.setItem('theme', 'dark');
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('returns stored "light" from localStorage', async () => {
		localStorage.setItem('theme', 'light');
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('light');
	});

	it('ignores invalid localStorage values and checks OS preference', async () => {
		localStorage.setItem('theme', 'blue');
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(true),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('falls back to OS dark preference when nothing stored', async () => {
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(true),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('dark');
	});

	it('falls back to "light" when OS prefers light and nothing stored', async () => {
		Object.defineProperty(globalThis, 'matchMedia', {
			value: createFakeMatchMedia(false),
			writable: true,
			configurable: true
		});
		const { getInitialTheme } = await import('../theme.js');
		expect(getInitialTheme()).toBe('light');
	});
});

describe('toggleTheme()', () => {
	it('flips from light to dark', async () => {
		// Start with no stored value (defaults to light since OS is light).
		const { theme, toggleTheme } = await import('../theme.js');
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
		const { theme, toggleTheme } = await import('../theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		expect(current).toBe('dark');

		toggleTheme();

		expect(current).toBe('light');
		expect(localStorage.setItem).toHaveBeenCalledWith('theme', 'light');
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'light');

		unsub();
	});

	it('adds no-transitions class before setting data-theme', async () => {
		const { toggleTheme } = await import('../theme.js');

		toggleTheme();

		/*
		 * The 'no-transitions' class must be added BEFORE the data-theme
		 * attribute change, so CSS transitions are suppressed during the
		 * variable swap. Verify by checking call order.
		 */
		expect(classListAddSpy).toHaveBeenCalledWith('no-transitions');
		expect(classListAddSpy.mock.invocationCallOrder[0]).toBeLessThan(
			setAttributeSpy.mock.invocationCallOrder[0]
		);
	});

	it('removes no-transitions class asynchronously after toggle', async () => {
		vi.useFakeTimers();
		const { toggleTheme } = await import('../theme.js');

		toggleTheme();

		/* Class should be added synchronously but not yet removed. */
		expect(classListAddSpy).toHaveBeenCalledWith('no-transitions');
		expect(classListRemoveSpy).not.toHaveBeenCalled();

		/* Flush the rAF + setTimeout(0) chain. */
		await vi.advanceTimersToNextTimerAsync();
		await vi.advanceTimersToNextTimerAsync();

		expect(classListRemoveSpy).toHaveBeenCalledWith('no-transitions');
		vi.useRealTimers();
	});

	it('double toggle returns to original', async () => {
		const { theme, toggleTheme } = await import('../theme.js');
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
		const { initTheme } = await import('../theme.js');
		initTheme();
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'light');
	});

	it('syncs the store with the resolved theme', async () => {
		localStorage.setItem('theme', 'dark');
		const { theme, initTheme } = await import('../theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		initTheme();

		expect(current).toBe('dark');
		expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'dark');

		unsub();
	});

	it('does nothing on the server', async () => {
		mockBrowser = false;
		const { initTheme } = await import('../theme.js');
		initTheme();
		expect(setAttributeSpy).not.toHaveBeenCalled();
	});
});

describe('getInitialTheme() — error handling', () => {
	it('propagates error when localStorage.getItem throws', async () => {
		/* Simulate Safari private browsing or storage disabled. */
		Object.defineProperty(globalThis, 'localStorage', {
			value: {
				...createFakeLocalStorage(),
				getItem: vi.fn(() => {
					throw new DOMException('Access denied');
				})
			},
			writable: true,
			configurable: true
		});
		/*
		 * No try/catch in source — error propagates.
		 * getInitialTheme() is called eagerly at module scope
		 * (writable<Theme>(getInitialTheme())), so the error is thrown
		 * during import, not when calling getInitialTheme() manually.
		 */
		await expect(import('../theme.js')).rejects.toThrow('Access denied');
	});

	it('propagates error when matchMedia is undefined', async () => {
		/* No stored value, so it falls through to matchMedia. */
		Object.defineProperty(globalThis, 'matchMedia', {
			value: undefined,
			writable: true,
			configurable: true
		});
		/*
		 * window.matchMedia(...) would throw TypeError since it's undefined.
		 * getInitialTheme() is called eagerly at module scope, so the error
		 * is thrown during import.
		 */
		await expect(import('../theme.js')).rejects.toThrow();
	});
});

describe('toggleTheme() — server-side', () => {
	it('flips the store value but does not touch DOM when browser is false', async () => {
		mockBrowser = false;
		const { theme, toggleTheme } = await import('../theme.js');
		let current: string | undefined;
		const unsub = theme.subscribe((v) => (current = v));

		expect(current).toBe('light'); // server default
		toggleTheme();
		expect(current).toBe('dark');

		/* No DOM interactions should have occurred. */
		expect(setAttributeSpy).not.toHaveBeenCalled();
		expect(classListAddSpy).not.toHaveBeenCalled();

		unsub();
	});
});
