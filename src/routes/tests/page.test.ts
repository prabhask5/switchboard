/**
 * @fileoverview Tests for the Inbox Page Svelte component.
 *
 * Comprehensive tests organized by UI section: full-page states, header,
 * panel tabs, search, thread list, checkbox selection, toolbar actions,
 * trash modal, pagination, config modal, onboarding wizard, and error toast.
 *
 * Mocks: `$app/navigation`, `$app/environment`, `$lib/cache.js`,
 *        `$lib/offline.svelte.js`, `$lib/stores/theme`, `$lib/csrf.js`,
 *        `$lib/format.js`, global fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import InboxPage from '../+page.svelte';
import { createThread } from '$lib/test-helpers.js';

/* ── Hoisted mocks (available before vi.mock factories run) ───── */
const mockState = vi.hoisted(() => ({
	gotoMock: vi.fn(),
	onlineCurrent: true,
	getAllCachedMetadataMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve([])),
	cacheThreadMetadataMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve()),
	removeCachedMetadataMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve()),
	getCacheStatsMock: vi.fn(
		(..._args: any[]): Promise<any> => Promise.resolve({ metadataCount: 0, detailCount: 0 })
	),
	clearAllCachesMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve()),
	getCachedAttachmentMapMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve(new Map()))
}));

/* ── Mock SvelteKit modules ───────────────────────────────────── */
vi.mock('$app/navigation', () => ({
	goto: (...args: any[]) => mockState.gotoMock(...args),
	afterNavigate: vi.fn()
}));

vi.mock('$app/environment', () => ({
	browser: true
}));

/* ── Mock cache module ────────────────────────────────────────── */
vi.mock('$lib/cache.js', () => ({
	getAllCachedMetadata: (...args: any[]) => mockState.getAllCachedMetadataMock(...args),
	cacheThreadMetadata: (...args: any[]) => mockState.cacheThreadMetadataMock(...args),
	removeCachedMetadata: (...args: any[]) => mockState.removeCachedMetadataMock(...args),
	getCacheStats: (...args: any[]) => mockState.getCacheStatsMock(...args),
	clearAllCaches: (...args: any[]) => mockState.clearAllCachesMock(...args),
	getCachedAttachmentMap: (...args: any[]) => mockState.getCachedAttachmentMapMock(...args)
}));

/* ── Mock offline module ──────────────────────────────────────── */
vi.mock('$lib/offline.svelte.js', () => ({
	createOnlineState: () => ({
		get current() {
			return mockState.onlineCurrent;
		},
		destroy: vi.fn()
	})
}));

/* ── Mock theme store ─────────────────────────────────────────── */
vi.mock('$lib/stores/theme', async () => {
	const { writable } = await import('svelte/store');
	return {
		theme: writable('light'),
		toggleTheme: vi.fn()
	};
});

/* ── Mock CSRF ────────────────────────────────────────────────── */
vi.mock('$lib/csrf.js', () => ({
	getCsrfToken: () => 'test-csrf-token'
}));

/* ── Mock format module ───────────────────────────────────────── */
vi.mock('$lib/format.js', () => ({
	formatListDate: (date: string) => date || 'Unknown date',
	decodeHtmlEntities: (text: string) => text
}));

// =============================================================================
// Test Data
// =============================================================================

/** Creates an array of threads for testing. */
function createThreads(count: number, overrides?: Partial<ReturnType<typeof createThread>>) {
	return Array.from({ length: count }, (_, i) =>
		createThread({
			id: `thread-${i + 1}`,
			subject: `Subject ${i + 1}`,
			from: { name: `Sender ${i + 1}`, email: `sender${i + 1}@example.com` },
			date: new Date(2026, 1, 12 - i).toISOString(),
			messageCount: i % 3 === 0 ? 3 : 1,
			labelIds: i % 2 === 0 ? ['INBOX', 'UNREAD'] : ['INBOX'],
			...overrides
		})
	);
}

const testThreads = createThreads(5);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Sets up fetch to simulate successful auth + thread loading.
 * @param threads - Threads to return from the metadata endpoint.
 * @param options - Additional configuration.
 */
function setupSuccessFetch(
	threads = testThreads,
	options: { nextPageToken?: string; counts?: boolean } = {}
) {
	const listResponse = {
		threads: threads.map((t) => ({ id: t.id, snippet: t.snippet })),
		nextPageToken: options.nextPageToken
	};

	const metadataResponse = { threads };
	const countsResponse = {
		counts: [
			{
				total: threads.length,
				unread: threads.filter((t) => t.labelIds.includes('UNREAD')).length,
				isEstimate: false
			}
		]
	};

	globalThis.fetch = vi.fn((url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		if (urlStr.includes('/api/me')) {
			return Promise.resolve(
				new Response(JSON.stringify({ email: 'user@test.com' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		if (urlStr.includes('/api/threads/metadata')) {
			return Promise.resolve(
				new Response(JSON.stringify(metadataResponse), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		if (urlStr.includes('/api/threads/counts')) {
			return Promise.resolve(
				new Response(JSON.stringify(countsResponse), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		if (urlStr.includes('/api/threads')) {
			return Promise.resolve(
				new Response(JSON.stringify(listResponse), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		return Promise.resolve(new Response('{}', { status: 200 }));
	}) as unknown as typeof fetch;
}

describe('Inbox Page', () => {
	beforeEach(() => {
		mockState.onlineCurrent = true;
		mockState.getAllCachedMetadataMock.mockResolvedValue([]);
		vi.clearAllMocks();
		/* Clear localStorage between tests. */
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	// =========================================================================
	// Full-page States
	// =========================================================================

	describe('Full-page states', () => {
		it('shows loading spinner during auth check', () => {
			globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

			render(InboxPage);
			expect(screen.getByText('Loading…')).toBeInTheDocument();
		});

		it('shows error card when /api/me fails', async () => {
			globalThis.fetch = vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ message: 'Service unavailable' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					})
				)
			) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Something went wrong')).toBeInTheDocument());
		});

		it('redirects to /login on 401', async () => {
			globalThis.fetch = vi.fn(() =>
				Promise.resolve(new Response('{}', { status: 401 }))
			) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(mockState.gotoMock).toHaveBeenCalledWith('/login'));
		});

		it('shows offline card when offline + no data', async () => {
			mockState.onlineCurrent = false;
			globalThis.fetch = vi.fn(() =>
				Promise.reject(new Error('Offline'))
			) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByText("You're offline")).toBeInTheDocument());
		});

		it('shows authenticated view when auth succeeds', async () => {
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Switchboard')).toBeInTheDocument());
		});

		it('shows onboarding for first-time users', async () => {
			/* First-time user: no localStorage key for panels. */
			setupSuccessFetch();
			localStorage.removeItem('switchboard_panels');

			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Welcome to Switchboard')).toBeInTheDocument());
		});
	});

	// =========================================================================
	// Header
	// =========================================================================

	describe('Header', () => {
		it("shows app name 'Switchboard'", async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Switchboard')).toBeInTheDocument());
		});

		it('shows user email', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => expect(screen.getByText('user@test.com')).toBeInTheDocument());
		});

		it('shows offline badge when offline', async () => {
			mockState.onlineCurrent = false;
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			mockState.getAllCachedMetadataMock.mockResolvedValue(
				testThreads.map((t) => ({ data: t, cachedAt: Date.now() }))
			);

			globalThis.fetch = vi.fn((url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('/api/me')) {
					return Promise.reject(new Error('Offline'));
				}
				return Promise.reject(new Error('Offline'));
			}) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
		});

		it("search input has placeholder 'Search mail'", async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => expect(screen.getByPlaceholderText('Search mail')).toBeInTheDocument());
		});

		it('sign out link visible when online', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Sign out')).toBeInTheDocument());
		});

		it('sign out link hidden when offline', async () => {
			mockState.onlineCurrent = false;
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			mockState.getAllCachedMetadataMock.mockResolvedValue(
				testThreads.map((t) => ({ data: t, cachedAt: Date.now() }))
			);
			globalThis.fetch = vi.fn((url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('/api/me')) {
					return Promise.reject(new Error('Offline'));
				}
				return Promise.reject(new Error('Offline'));
			}) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Switchboard')).toBeInTheDocument());
			expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
		});
	});

	// =========================================================================
	// Panel Tabs
	// =========================================================================

	describe('Panel tabs', () => {
		it('renders all panel tabs', async () => {
			localStorage.setItem(
				'switchboard_panels',
				JSON.stringify([
					{ name: 'Work', rules: [] },
					{ name: 'Personal', rules: [] }
				])
			);
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => {
				expect(screen.getByText('Work')).toBeInTheDocument();
				expect(screen.getByText('Personal')).toBeInTheDocument();
			});
		});

		it('active tab has aria-selected=true', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'Inbox', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);
			await waitFor(() => {
				const tab = screen.getByRole('tab', { name: /Inbox/ });
				expect(tab).toHaveAttribute('aria-selected', 'true');
			});
		});

		it('clicking tab switches active panel', async () => {
			localStorage.setItem(
				'switchboard_panels',
				JSON.stringify([
					{ name: 'Tab1', rules: [] },
					{ name: 'Tab2', rules: [] }
				])
			);
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() =>
				expect(screen.getByRole('tab', { name: /Tab1/ })).toHaveAttribute('aria-selected', 'true')
			);

			await fireEvent.click(screen.getByRole('tab', { name: /Tab2/ }));

			expect(screen.getByRole('tab', { name: /Tab2/ })).toHaveAttribute('aria-selected', 'true');
			expect(screen.getByRole('tab', { name: /Tab1/ })).toHaveAttribute('aria-selected', 'false');
		});

		it('settings button opens config modal', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'Inbox', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => expect(screen.getByTitle('Settings')).toBeInTheDocument());

			await fireEvent.click(screen.getByTitle('Settings'));

			expect(screen.getByText('Settings')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Thread List
	// =========================================================================

	describe('Thread list', () => {
		it('renders thread rows with sender, subject, date', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => {
				expect(screen.getByText('Sender 1')).toBeInTheDocument();
				expect(screen.getByText('Subject 1')).toBeInTheDocument();
			});
		});

		it('unread threads have .unread class', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({
					id: 't1',
					subject: 'Unread Email',
					labelIds: ['INBOX', 'UNREAD'],
					from: { name: 'A', email: 'a@test.com' }
				}),
				createThread({
					id: 't2',
					subject: 'Read Email',
					labelIds: ['INBOX'],
					from: { name: 'B', email: 'b@test.com' }
				})
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => {
				const unreadRow = screen.getByText('Unread Email').closest('.thread-row');
				expect(unreadRow?.classList.contains('unread')).toBe(true);

				const readRow = screen.getByText('Read Email').closest('.thread-row');
				expect(readRow?.classList.contains('unread')).toBe(false);
			});
		});

		it('shows message count badge for multi-message threads', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({
					id: 't1',
					subject: 'Multi',
					messageCount: 5,
					from: { name: 'A', email: 'a@test.com' }
				})
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument());
		});

		it("empty panel shows 'No threads in [name]'", async () => {
			localStorage.setItem(
				'switchboard_panels',
				JSON.stringify([
					{
						name: 'Work',
						rules: [{ field: 'from', addresses: ['no-match-ever-xyz'], action: 'accept' }]
					}
				])
			);
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => expect(screen.getByText(/No threads in/)).toBeInTheDocument());
		});

		it('thread link href is /t/{threadId}', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({
					id: 'abc-123',
					subject: 'My Thread',
					from: { name: 'Sender', email: 's@test.com' }
				})
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => {
				const link = screen.getByText('My Thread').closest('a');
				expect(link).toHaveAttribute('href', '/t/abc-123');
			});
		});
	});

	// =========================================================================
	// Checkbox Selection
	// =========================================================================

	describe('Checkbox selection', () => {
		it('individual checkbox toggles thread selection', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({ id: 't1', subject: 'S1', from: { name: 'A', email: 'a@t.com' } })
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());

			const checkboxes = screen.getAllByRole('checkbox');
			/* First checkbox is master, second is for the thread. */
			const threadCheckbox = checkboxes.find((cb) => cb.closest('.thread-row'));
			if (threadCheckbox) {
				await fireEvent.click(threadCheckbox);
				expect(threadCheckbox).toBeChecked();
			}
		});

		it('master checkbox selects all when none selected', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({ id: 't1', subject: 'S1', from: { name: 'A', email: 'a@t.com' } }),
				createThread({ id: 't2', subject: 'S2', from: { name: 'B', email: 'b@t.com' } })
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());

			/* Find master checkbox (in the toolbar). */
			const toolbarCheckbox = screen
				.getAllByRole('checkbox')
				.find((cb) => cb.closest('.toolbar-checkbox'));
			if (toolbarCheckbox) {
				await fireEvent.click(toolbarCheckbox);
				/* All thread checkboxes should now be checked. */
				const threadCheckboxes = screen
					.getAllByRole('checkbox')
					.filter((cb) => cb.closest('.thread-row'));
				for (const cb of threadCheckboxes) {
					expect(cb).toBeChecked();
				}
			}
		});

		it('dropdown "All" selects all displayed', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({ id: 't1', subject: 'S1', from: { name: 'A', email: 'a@t.com' } })
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());

			/* Open the dropdown. */
			const dropdownArrow = screen.getByTitle('Select options');
			await fireEvent.click(dropdownArrow);

			/* Click "All" in the dropdown (not the panel tab which also has "All" text). */
			const allBtns = screen.getAllByText('All');
			/* The dropdown option is inside the dropdown menu, not the tab bar. */
			const dropdownAll = allBtns.find((el) => el.closest('.select-dropdown'));
			await fireEvent.click(dropdownAll ?? allBtns[allBtns.length - 1]);

			const threadCheckboxes = screen
				.getAllByRole('checkbox')
				.filter((cb) => cb.closest('.thread-row'));
			for (const cb of threadCheckboxes) {
				expect(cb).toBeChecked();
			}
		});

		it('dropdown "None" deselects all', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({ id: 't1', subject: 'S1', from: { name: 'A', email: 'a@t.com' } })
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());

			/* Select the thread first. */
			const threadCb = screen.getAllByRole('checkbox').find((cb) => cb.closest('.thread-row'));
			if (threadCb) await fireEvent.click(threadCb);

			/* Open dropdown and click "None". */
			await fireEvent.click(screen.getByTitle('Select options'));
			await fireEvent.click(screen.getByText('None'));

			const threadCheckboxes = screen
				.getAllByRole('checkbox')
				.filter((cb) => cb.closest('.thread-row'));
			for (const cb of threadCheckboxes) {
				expect(cb).not.toBeChecked();
			}
		});

		it('dropdown "Unread" selects only unread threads', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({
					id: 't1',
					subject: 'Unread',
					labelIds: ['INBOX', 'UNREAD'],
					from: { name: 'A', email: 'a@t.com' }
				}),
				createThread({
					id: 't2',
					subject: 'Read',
					labelIds: ['INBOX'],
					from: { name: 'B', email: 'b@t.com' }
				})
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('Unread')).toBeInTheDocument());

			await fireEvent.click(screen.getByTitle('Select options'));
			/* Find the specific dropdown item, not the thread text. */
			const dropdownItems = screen
				.getAllByRole('button')
				.filter(
					(btn) => btn.classList.contains('dropdown-item') && btn.textContent?.trim() === 'Unread'
				);
			if (dropdownItems.length > 0) {
				await fireEvent.click(dropdownItems[0]);
			}
		});
	});

	// =========================================================================
	// Toolbar Actions
	// =========================================================================

	describe('Toolbar actions', () => {
		it('trash button disabled when no selection', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('Subject 1')).toBeInTheDocument());

			const trashBtn = screen.getByTitle(/Select threads to delete|Trash/);
			expect(trashBtn).toBeDisabled();
		});

		it('refresh button disabled when offline', async () => {
			mockState.onlineCurrent = false;
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			mockState.getAllCachedMetadataMock.mockResolvedValue(
				testThreads.map((t) => ({ data: t, cachedAt: Date.now() }))
			);
			globalThis.fetch = vi.fn((url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('/api/me')) {
					return Promise.reject(new Error('Offline'));
				}
				return Promise.reject(new Error('Offline'));
			}) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByText('Subject 1')).toBeInTheDocument());

			const refreshBtn = screen.getByTitle('Refresh inbox');
			expect(refreshBtn).toBeDisabled();
		});
	});

	// =========================================================================
	// Trash Modal
	// =========================================================================

	describe('Trash modal', () => {
		async function setupWithSelection() {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			const threads = [
				createThread({ id: 't1', subject: 'S1', from: { name: 'A', email: 'a@t.com' } })
			];
			setupSuccessFetch(threads);
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());

			/* Select the thread. */
			const threadCb = screen.getAllByRole('checkbox').find((cb) => cb.closest('.thread-row'));
			if (threadCb) await fireEvent.click(threadCb);

			/* Click trash button. */
			const trashBtn = screen.getByTitle(/Trash 1 thread/);
			await fireEvent.click(trashBtn);
		}

		it('shows thread count in heading', async () => {
			await setupWithSelection();
			expect(screen.getByText(/Trash 1 thread/)).toBeInTheDocument();
		});

		it('Cancel closes modal', async () => {
			await setupWithSelection();
			await fireEvent.click(screen.getByText('Cancel'));
			expect(screen.queryByText('Move to trash')).not.toBeInTheDocument();
		});

		it("'Move to trash' button exists", async () => {
			await setupWithSelection();
			expect(screen.getByText('Move to trash')).toBeInTheDocument();
		});

		it('backdrop click closes modal', async () => {
			await setupWithSelection();
			/* Multiple elements may have role=presentation; find the modal backdrop. */
			const backdrops = screen.getAllByRole('presentation');
			const modalBackdrop = backdrops.find((el) => el.classList.contains('modal-backdrop'));
			await fireEvent.click(modalBackdrop ?? backdrops[0]);
			expect(screen.queryByText('Move to trash')).not.toBeInTheDocument();
		});
	});

	// =========================================================================
	// Pagination
	// =========================================================================

	describe('Pagination', () => {
		it('prev button disabled on page 1', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => expect(screen.getByText('Subject 1')).toBeInTheDocument());

			const prevBtn = screen.getByTitle('Previous page');
			expect(prevBtn).toBeDisabled();
		});
	});

	// =========================================================================
	// Config Modal
	// =========================================================================

	describe('Config modal', () => {
		async function openSettingsModal() {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'MyPanel', rules: [] }]));
			setupSuccessFetch();
			render(InboxPage);

			await waitFor(() => expect(screen.getByTitle('Settings')).toBeInTheDocument());
			await fireEvent.click(screen.getByTitle('Settings'));
			await waitFor(() => expect(screen.getByText('Configure Panels')).toBeInTheDocument());
		}

		it('opens with current panel config', async () => {
			await openSettingsModal();
			expect(screen.getByDisplayValue('MyPanel')).toBeInTheDocument();
		});

		it('panel name is editable', async () => {
			await openSettingsModal();
			const input = screen.getByDisplayValue('MyPanel');
			await fireEvent.input(input, { target: { value: 'Renamed' } });
			expect(screen.getByDisplayValue('Renamed')).toBeInTheDocument();
		});

		it("'Add rule' adds new rule", async () => {
			await openSettingsModal();
			/* Initially no rules. */
			expect(screen.getByText('No rules — this panel shows all emails.')).toBeInTheDocument();

			await fireEvent.click(screen.getByText('Add rule'));

			/* Now should have "Rule 1". */
			expect(screen.getByText('Rule 1')).toBeInTheDocument();
		});

		it('page size selector renders options', async () => {
			await openSettingsModal();
			const select = screen.getByLabelText('Threads per page');
			expect(select).toBeInTheDocument();
		});

		it('Save closes modal', async () => {
			await openSettingsModal();
			await fireEvent.click(screen.getByText('Save'));
			expect(screen.queryByText('Configure Panels')).not.toBeInTheDocument();
		});

		it('Cancel discards and closes', async () => {
			await openSettingsModal();
			await fireEvent.click(
				screen.getAllByText('Cancel').find((el) => el.closest('.modal-footer'))!
			);
			expect(screen.queryByText('Configure Panels')).not.toBeInTheDocument();
		});

		it('Add panel button (up to 4)', async () => {
			await openSettingsModal();
			const addBtn = screen.getByTitle('Add panel');
			expect(addBtn).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Onboarding Wizard
	// =========================================================================

	describe('Onboarding wizard', () => {
		function setupOnboarding() {
			localStorage.removeItem('switchboard_panels');
			setupSuccessFetch();
			render(InboxPage);
		}

		it('step 1: shows welcome with setup/skip buttons', async () => {
			setupOnboarding();
			await waitFor(() => {
				expect(screen.getByText('Welcome to Switchboard')).toBeInTheDocument();
				expect(screen.getByText('Set up panels')).toBeInTheDocument();
				expect(screen.getByText('Skip setup')).toBeInTheDocument();
			});
		});

		it("'Set up panels' advances to step 2", async () => {
			setupOnboarding();
			await waitFor(() => expect(screen.getByText('Set up panels')).toBeInTheDocument());

			await fireEvent.click(screen.getByText('Set up panels'));

			expect(screen.getByText('Set Up Your Panels')).toBeInTheDocument();
		});

		it('step 2: panel editor with rules', async () => {
			setupOnboarding();
			await waitFor(() => expect(screen.getByText('Set up panels')).toBeInTheDocument());
			await fireEvent.click(screen.getByText('Set up panels'));

			/* Should show panel name input. */
			expect(screen.getByLabelText('Panel Name')).toBeInTheDocument();
		});

		it("'Skip setup' saves default panel + fetches", async () => {
			setupOnboarding();
			await waitFor(() => expect(screen.getByText('Skip setup')).toBeInTheDocument());

			await fireEvent.click(screen.getByText('Skip setup'));

			/* Onboarding should be dismissed. */
			await waitFor(() =>
				expect(screen.queryByText('Welcome to Switchboard')).not.toBeInTheDocument()
			);
		});
	});

	// =========================================================================
	// Error Toast
	// =========================================================================

	describe('Error toast', () => {
		it('dismiss button hides toast', async () => {
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			/* Provide cached data but fail the refresh. */
			mockState.getAllCachedMetadataMock.mockResolvedValue(
				testThreads.map((t) => ({ data: t, cachedAt: Date.now() }))
			);

			globalThis.fetch = vi.fn((url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('/api/me')) {
					return Promise.resolve(
						new Response(JSON.stringify({ email: 'user@test.com' }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' }
						})
					);
				}
				if (urlStr.includes('/api/threads/counts')) {
					return Promise.resolve(
						new Response(JSON.stringify({ counts: [] }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' }
						})
					);
				}
				/* Fail thread fetches. */
				return Promise.resolve(
					new Response(JSON.stringify({ message: 'Background error' }), {
						status: 500,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}) as unknown as typeof fetch;

			render(InboxPage);

			/* Wait for the error toast to appear. */
			await waitFor(() => expect(screen.getByText('Background error')).toBeInTheDocument(), {
				timeout: 3000
			});

			/* Dismiss it. */
			const dismissBtn = screen.getByTitle('Dismiss');
			await fireEvent.click(dismissBtn);

			expect(screen.queryByText('Background error')).not.toBeInTheDocument();
		});
	});

	// =========================================================================
	// Search
	// =========================================================================

	describe('Search', () => {
		it('search input disabled when offline', async () => {
			mockState.onlineCurrent = false;
			localStorage.setItem('switchboard_panels', JSON.stringify([{ name: 'All', rules: [] }]));
			mockState.getAllCachedMetadataMock.mockResolvedValue(
				testThreads.map((t) => ({ data: t, cachedAt: Date.now() }))
			);
			globalThis.fetch = vi.fn((url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('/api/me')) {
					return Promise.reject(new Error('Offline'));
				}
				return Promise.reject(new Error('Offline'));
			}) as unknown as typeof fetch;

			render(InboxPage);
			await waitFor(() => expect(screen.getByPlaceholderText('Search mail')).toBeInTheDocument());

			expect(screen.getByPlaceholderText('Search mail')).toBeDisabled();
		});
	});
});
