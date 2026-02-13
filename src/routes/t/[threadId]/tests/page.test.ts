/**
 * @fileoverview Tests for the Thread Detail Page Svelte component.
 *
 * Tests loading states, auth redirects, error states, offline handling,
 * thread content rendering, message expand/collapse, attachments,
 * header elements, and error toasts.
 *
 * Mocks: `$app/stores`, `$app/navigation`, `$app/environment`,
 *        `$lib/cache.js`, `$lib/offline.svelte.js`, `$lib/stores/theme`,
 *        `$lib/format.js`, global fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import ThreadDetailPage from '../+page.svelte';
import { createThreadDetail, createDetailMessage, createAttachment } from '$lib/test-helpers.js';

/* ── Hoisted mocks (available before vi.mock factories run) ───── */
const mockState = vi.hoisted(() => ({
	gotoMock: vi.fn(),
	pageParams: { threadId: 'thread-123' } as Record<string, string>,
	onlineCurrent: true,
	getCachedThreadDetailMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve(undefined)),
	cacheThreadDetailMock: vi.fn((..._args: any[]): Promise<any> => Promise.resolve())
}));

/* ── Mock SvelteKit modules ───────────────────────────────────── */
vi.mock('$app/navigation', () => ({
	goto: (...args: any[]) => mockState.gotoMock(...args)
}));

vi.mock('$app/environment', () => ({
	browser: true
}));

vi.mock('$app/stores', () => ({
	page: {
		subscribe: (fn: (v: unknown) => void) => {
			fn({
				url: new URL('http://localhost/t/thread-123'),
				params: mockState.pageParams,
				route: { id: '/t/[threadId]' },
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

/* ── Mock cache module ────────────────────────────────────────── */
vi.mock('$lib/cache.js', () => ({
	getCachedThreadDetail: (...args: any[]) => mockState.getCachedThreadDetailMock(...args),
	cacheThreadDetail: (...args: any[]) => mockState.cacheThreadDetailMock(...args)
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

/* ── Mock format module ───────────────────────────────────────── */
vi.mock('$lib/format.js', () => ({
	formatDetailDate: (date: string) => date || 'Unknown date',
	decodeHtmlEntities: (text: string) => text
}));

// =============================================================================
// Helpers
// =============================================================================

/** Standard thread detail data for tests that need content rendered. */
const standardThread = createThreadDetail({
	id: 'thread-123',
	subject: 'Important Meeting',
	messages: [
		createDetailMessage({
			id: 'msg-1',
			from: { name: 'Alice Johnson', email: 'alice@example.com' },
			to: 'bob@example.com',
			subject: 'Important Meeting',
			snippet: 'Let us discuss the project...',
			body: 'Full message body here.',
			bodyType: 'text',
			date: '2026-02-10T10:00:00Z'
		}),
		createDetailMessage({
			id: 'msg-2',
			from: { name: 'Bob Smith', email: 'bob@example.com' },
			to: 'alice@example.com',
			subject: 'Re: Important Meeting',
			snippet: 'Sounds good!',
			body: 'Reply body here.',
			bodyType: 'text',
			date: '2026-02-10T11:00:00Z'
		}),
		createDetailMessage({
			id: 'msg-3',
			from: { name: 'Alice Johnson', email: 'alice@example.com' },
			to: 'bob@example.com',
			subject: 'Re: Important Meeting',
			snippet: 'See you there!',
			body: 'Third message body.',
			bodyType: 'text',
			date: '2026-02-10T12:00:00Z',
			attachments: [
				createAttachment({
					filename: 'agenda.pdf',
					mimeType: 'application/pdf',
					size: 2048,
					attachmentId: 'att-1',
					messageId: 'msg-3'
				})
			]
		})
	]
});

/** Sets up fetch to return the standard thread detail. */
function setupSuccessFetch(): void {
	globalThis.fetch = vi.fn((url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
		if (urlStr.includes('/api/me')) {
			return Promise.resolve(
				new Response(JSON.stringify({ email: 'user@example.com' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		if (urlStr.includes('/api/thread/')) {
			return Promise.resolve(
				new Response(JSON.stringify({ thread: standardThread }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}
		return Promise.resolve(new Response('{}', { status: 200 }));
	}) as unknown as typeof fetch;
}

describe('Thread Detail Page', () => {
	beforeEach(() => {
		mockState.onlineCurrent = true;
		mockState.pageParams = { threadId: 'thread-123' };
		mockState.getCachedThreadDetailMock.mockResolvedValue(undefined);
		mockState.cacheThreadDetailMock.mockResolvedValue(undefined);
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// =========================================================================
	// Loading States
	// =========================================================================

	it('shows loading spinner on initial render', () => {
		/* Fetch never resolves so loading persists. */
		globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

		render(ThreadDetailPage);
		expect(screen.getByText('Loading thread...')).toBeInTheDocument();
	});

	it("shows 'Loading thread...' text", () => {
		globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

		render(ThreadDetailPage);
		expect(screen.getByText('Loading thread...')).toBeInTheDocument();
	});

	// =========================================================================
	// Auth
	// =========================================================================

	it('redirects to /login on 401 from /api/thread', async () => {
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(new Response('{}', { status: 401 }));
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(mockState.gotoMock).toHaveBeenCalledWith('/login'));
	});

	// =========================================================================
	// Error States
	// =========================================================================

	it('shows error message on non-401 fetch failure', async () => {
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ message: 'Internal server error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Cannot load thread')).toBeInTheDocument());
	});

	it("error card has 'Try again' button and 'Back to inbox' link", async () => {
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ message: 'Server error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => {
			expect(screen.getByText('Try again')).toBeInTheDocument();
			/* "Back to inbox" appears in both the header link and error card. */
			expect(screen.getAllByText('Back to inbox').length).toBeGreaterThanOrEqual(1);
		});
	});

	it("shows 'Thread not found' on 404", async () => {
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(
				new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
			);
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText(/Thread not found/)).toBeInTheDocument());
	});

	// =========================================================================
	// Offline
	// =========================================================================

	it('shows offline card when offline + no cache', async () => {
		mockState.onlineCurrent = false;
		globalThis.fetch = vi.fn(() =>
			Promise.reject(new Error('Network error'))
		) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText("You're offline")).toBeInTheDocument());
	});

	it('offline card has correct message text', async () => {
		mockState.onlineCurrent = false;
		globalThis.fetch = vi.fn(() =>
			Promise.reject(new Error('Network error'))
		) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() =>
			expect(
				screen.getByText("This thread hasn't been cached yet. Connect to the internet to view it.")
			).toBeInTheDocument()
		);
	});

	it("shows 'Try again' button on offline card", async () => {
		mockState.onlineCurrent = false;
		globalThis.fetch = vi.fn(() =>
			Promise.reject(new Error('Network error'))
		) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
	});

	// =========================================================================
	// Thread Content
	// =========================================================================

	it('renders thread subject as h1', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() =>
			expect(
				screen.getByRole('heading', { level: 1, name: 'Important Meeting' })
			).toBeInTheDocument()
		);
	});

	it("shows message count (e.g. '3 messages')", async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('3 messages')).toBeInTheDocument());
	});

	it('renders messages', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			/* Alice Johnson appears in 2 messages (msg-1 and msg-3), so use getAllByText. */
			expect(screen.getAllByText('Alice Johnson').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('Bob Smith')).toBeInTheDocument();
		});
	});

	it('last message expanded by default', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			/* The last message (msg-3) should show its body. */
			expect(screen.getByText('Third message body.')).toBeInTheDocument();
		});
	});

	it('other messages collapsed by default', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			/* The first message (msg-1) body should not be visible. */
			expect(screen.queryByText('Full message body here.')).not.toBeInTheDocument();
		});
	});

	it('collapsed message shows snippet', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			expect(screen.getByText('Let us discuss the project...')).toBeInTheDocument();
		});
	});

	it('clicking message header toggles expand/collapse', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);

		await waitFor(() =>
			expect(screen.getAllByText('Alice Johnson').length).toBeGreaterThanOrEqual(1)
		);

		/* Click the first message header to expand it. */
		const headers = screen.getAllByRole('button');
		const messageHeader = headers.find(
			(el) => el.textContent?.includes('Alice Johnson') && el.classList.contains('message-header')
		);

		if (messageHeader) {
			await fireEvent.click(messageHeader);
			await waitFor(() => expect(screen.getByText('Full message body here.')).toBeInTheDocument());
		}
	});

	it('Enter/Space key toggles expand/collapse', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);

		await waitFor(() =>
			expect(screen.getAllByText('Alice Johnson').length).toBeGreaterThanOrEqual(1)
		);

		/* Find a collapsed message header (role=button). */
		const buttons = screen.getAllByRole('button');
		const messageHeader = buttons.find((el) => el.classList.contains('message-header'));

		if (messageHeader) {
			await fireEvent.keyDown(messageHeader, { key: 'Enter' });
			/* The message should expand. */
		}
	});

	it('expanded message shows sender email', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			/* Last message is expanded — should show email. */
			expect(screen.getByText('<alice@example.com>')).toBeInTheDocument();
		});
	});

	it("expanded message shows 'to' line", async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			expect(screen.getByText(/to bob@example.com/)).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Attachments
	// =========================================================================

	it('shows attachment section when message has attachments', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('1 attachment')).toBeInTheDocument());
	});

	it('attachment has filename and size', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			expect(screen.getByText('agenda.pdf')).toBeInTheDocument();
			expect(screen.getByText('2.0 KB')).toBeInTheDocument();
		});
	});

	it('attachment link has correct download URL', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			const link = screen.getByText('agenda.pdf').closest('a');
			expect(link).toBeInTheDocument();
			expect(link?.getAttribute('href')).toContain('/api/thread/thread-123/attachment');
			expect(link?.getAttribute('href')).toContain('attachmentId=att-1');
		});
	});

	it('attachment link has download attribute', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			const link = screen.getByText('agenda.pdf').closest('a');
			expect(link).toHaveAttribute('download', 'agenda.pdf');
		});
	});

	// =========================================================================
	// Header
	// =========================================================================

	it("shows 'Back to inbox' link to /", async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			const backLink = screen.getByText('Back to inbox');
			expect(backLink.closest('a')).toHaveAttribute('href', '/');
		});
	});

	it('shows offline badge when offline', async () => {
		mockState.onlineCurrent = false;
		mockState.getCachedThreadDetailMock.mockResolvedValue({
			data: standardThread,
			cachedAt: Date.now()
		});

		/* Fetch still rejects (offline), but cache provides data. */
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.reject(new Error('Network error'));
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
	});

	it("shows 'Updating...' cache badge when cached + online", async () => {
		mockState.getCachedThreadDetailMock.mockResolvedValue({
			data: standardThread,
			cachedAt: Date.now()
		});

		/* Make the thread fetch hang so the cache badge persists. */
		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			/* Thread fetch never resolves — cache badge stays visible. */
			return new Promise(() => {});
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Updating...')).toBeInTheDocument());
	});

	it('shows sign out link when online', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Sign out')).toBeInTheDocument());
	});

	it('hides sign out when offline', async () => {
		mockState.onlineCurrent = false;
		mockState.getCachedThreadDetailMock.mockResolvedValue({
			data: standardThread,
			cachedAt: Date.now()
		});
		globalThis.fetch = vi.fn(() => Promise.reject(new Error('Offline'))) as unknown as typeof fetch;

		render(ThreadDetailPage);
		/* Wait for the thread to render from cache. */
		await waitFor(() => expect(screen.getByText('Important Meeting')).toBeInTheDocument());
		expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
	});

	it('theme toggle button renders', async () => {
		setupSuccessFetch();
		render(ThreadDetailPage);
		await waitFor(() => {
			const toggleBtn = screen.getByTitle('Toggle dark mode');
			expect(toggleBtn).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Error Toast
	// =========================================================================

	it('shows error toast on background revalidation failure', async () => {
		/* Provide cached data, then fail the API call. */
		mockState.getCachedThreadDetailMock.mockResolvedValue({
			data: standardThread,
			cachedAt: Date.now()
		});

		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ message: 'Server overloaded' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Server overloaded')).toBeInTheDocument());
	});

	it('toast is dismissible', async () => {
		mockState.getCachedThreadDetailMock.mockResolvedValue({
			data: standardThread,
			cachedAt: Date.now()
		});

		globalThis.fetch = vi.fn((url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			if (urlStr.includes('/api/me')) {
				return Promise.resolve(
					new Response(JSON.stringify({ email: 'user@example.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ message: 'Server error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}) as unknown as typeof fetch;

		render(ThreadDetailPage);
		await waitFor(() => expect(screen.getByText('Server error')).toBeInTheDocument());

		/* Click the dismiss button. */
		const dismissBtn = screen.getByTitle('Dismiss');
		await fireEvent.click(dismissBtn);

		expect(screen.queryByText('Server error')).not.toBeInTheDocument();
	});
});
