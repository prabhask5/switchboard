<!--
  @component Home Page

  The main landing page after authentication. Fetches /api/me on mount
  to determine if the user is signed in, then shows:
    - Loading state while checking auth
    - "Connected as <email>" with sign-out option if authenticated
    - Redirect to /login if not authenticated

  In future PRs this will become the inbox view with panels.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	/** The authenticated user's email address, or null if loading/unauthenticated. */
	let email: string | null = $state(null);

	/** Whether the initial auth check is still in progress. */
	let loading: boolean = $state(true);

	/** Error message if the profile fetch failed for a non-auth reason. */
	let errorMessage: string | null = $state(null);

	onMount(async () => {
		try {
			const res = await fetch('/api/me');

			if (res.status === 401) {
				/* Not authenticated — redirect to login. */
				goto('/login');
				return;
			}

			if (!res.ok) {
				/*
				 * SvelteKit's error() returns { message: "..." } in the JSON body.
				 * We try both `message` and `error` for compatibility.
				 */
				const body = await res.json().catch(() => ({}));
				errorMessage = body.message ?? body.error ?? `HTTP ${res.status}`;
				return;
			}

			const data: { email: string } = await res.json();
			email = data.email;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Network error';
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Switchboard – Inbox</title>
</svelte:head>

{#if loading}
	<!-- Gmail-style loading spinner -->
	<main class="loading-page">
		<div class="loading-content">
			<div class="spinner"></div>
			<p>Loading…</p>
		</div>
	</main>
{:else if errorMessage}
	<main class="error-page">
		<div class="error-card">
			<h2>Something went wrong</h2>
			<p>{errorMessage}</p>
			<a href="/login" class="btn">Sign in again</a>
		</div>
	</main>
{:else if email}
	<!-- Authenticated state — placeholder until inbox UI is built in PR 2 -->
	<div class="app-shell">
		<header class="app-header">
			<div class="header-left">
				<span class="app-name">Switchboard</span>
			</div>
			<div class="header-right">
				<span class="user-email">{email}</span>
				<a href="/logout" class="sign-out-btn" data-sveltekit-preload-data="off"> Sign out </a>
			</div>
		</header>

		<main class="main-content">
			<div class="connected-card">
				<div class="check-icon">
					<svg viewBox="0 0 24 24" width="48" height="48" fill="#34a853">
						<path
							d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
						/>
					</svg>
				</div>
				<h2>Connected as {email}</h2>
				<p class="hint">Inbox view with panels coming in the next update.</p>
			</div>
		</main>
	</div>
{/if}

<style>
	/* ── Loading state ─────────────────────────────────────────────── */
	.loading-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	.loading-content {
		text-align: center;
		color: #5f6368;
	}

	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid #dadce0;
		border-top-color: #1a73e8;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		margin: 0 auto 16px;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Error state ───────────────────────────────────────────────── */
	.error-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	.error-card {
		background: white;
		border: 1px solid #dadce0;
		border-radius: 8px;
		padding: 40px;
		text-align: center;
		max-width: 400px;
	}

	.error-card h2 {
		margin: 0 0 8px;
		font-size: 18px;
		font-weight: 500;
		color: #c5221f;
	}

	.error-card p {
		color: #5f6368;
		margin: 0 0 24px;
		font-size: 14px;
	}

	.btn {
		display: inline-block;
		padding: 8px 24px;
		background: #1a73e8;
		color: white;
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
	}

	.btn:hover {
		background: #1765cc;
		text-decoration: none;
	}

	/* ── App shell (authenticated) ─────────────────────────────────── */
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.app-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: white;
		border-bottom: 1px solid #dadce0;
		height: 64px;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.app-name {
		font-size: 22px;
		color: #5f6368;
		font-weight: 400;
		letter-spacing: 0;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.user-email {
		font-size: 14px;
		color: #5f6368;
	}

	.sign-out-btn {
		font-size: 14px;
		color: #5f6368;
		padding: 8px 16px;
		border: 1px solid #dadce0;
		border-radius: 4px;
		text-decoration: none;
	}

	.sign-out-btn:hover {
		background: #f1f3f4;
		text-decoration: none;
	}

	/* ── Connected placeholder ─────────────────────────────────────── */
	.main-content {
		flex: 1;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.connected-card {
		text-align: center;
		padding: 40px;
	}

	.check-icon {
		margin-bottom: 16px;
	}

	.connected-card h2 {
		margin: 0 0 8px;
		font-size: 18px;
		font-weight: 400;
		color: #202124;
	}

	.hint {
		color: #5f6368;
		font-size: 14px;
		margin: 0;
	}
</style>
