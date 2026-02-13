<!--
  @component Login Page

  Gmail-style sign-in page with a centered card. The "Sign in with Google"
  button navigates to /auth/google (server-side redirect to Google consent).

  data-sveltekit-preload-data="off" prevents SvelteKit from trying to
  preload the server redirect endpoint.

  Offline-aware: when the user is offline, disables the sign-in button
  and shows a message explaining that an internet connection is required.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	/**
	 * If Google denied consent, the error param will be present
	 * (e.g. ?error=access_denied). We show it as a user-friendly message.
	 */
	const errorParam = $derived($page.url.searchParams.get('error'));

	/** Whether the browser is currently offline. */
	let offline = $state(false);

	onMount(() => {
		if (!browser) return;

		offline = !navigator.onLine;

		/** Handler for the browser's 'offline' event. */
		const goOffline = () => {
			offline = true;
		};

		/** Handler for the browser's 'online' event. */
		const goOnline = () => {
			offline = false;
		};

		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

		return () => {
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
		};
	});
</script>

<svelte:head>
	<title>Sign in - Email Switchboard</title>
</svelte:head>

<main class="login-page">
	<div class="login-card">
		<!-- Logo + brand name -->
		<div class="logo">
			<img src="/favicon.svg" alt="" width="32" height="32" />
			<span class="logo-text">Switchboard</span>
		</div>

		<h1>Sign in</h1>
		<p class="subtitle">to continue to Email Switchboard</p>

		{#if errorParam}
			<div class="error-banner" role="alert">
				{errorParam === 'access_denied'
					? 'You denied access. Please try again to use Email Switchboard.'
					: `Authentication error: ${errorParam}`}
			</div>
		{/if}

		{#if offline}
			<div class="offline-notice" role="alert">
				You need to be online to sign in. Please check your internet connection.
			</div>
		{/if}

		{#if offline}
			<span class="google-btn disabled" aria-disabled="true">
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
					<path
						d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
						fill="#4285F4"
					/>
					<path
						d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
						fill="#34A853"
					/>
					<path
						d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
						fill="#FBBC05"
					/>
					<path
						d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
						fill="#EA4335"
					/>
				</svg>
				Sign in with Google
			</span>
		{:else}
			<a href="/auth/google" class="google-btn" data-sveltekit-preload-data="off">
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
					<path
						d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
						fill="#4285F4"
					/>
					<path
						d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
						fill="#34A853"
					/>
					<path
						d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
						fill="#FBBC05"
					/>
					<path
						d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
						fill="#EA4335"
					/>
				</svg>
				Sign in with Google
			</a>
		{/if}

		<p class="note">We only request access to read and manage your Gmail inbox.</p>
	</div>
</main>

<style>
	.login-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		background: var(--color-bg-primary);
	}

	.login-card {
		background: var(--color-bg-surface);
		padding: 48px 40px 36px;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		text-align: center;
		max-width: 450px;
		width: 90%;
	}

	.logo {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		margin-bottom: 16px;
	}

	.logo-text {
		font-size: 22px;
		font-weight: 500;
		color: var(--color-text-secondary);
		font-family: 'Google Sans', Roboto, sans-serif;
	}

	h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 400;
		color: var(--color-text-primary);
	}

	.subtitle {
		color: var(--color-text-secondary);
		margin: 8px 0 32px;
		font-size: 16px;
	}

	.error-banner {
		background: var(--color-error-surface);
		color: var(--color-error);
		padding: 12px 16px;
		border-radius: 4px;
		font-size: 14px;
		margin-bottom: 24px;
		text-align: left;
	}

	.offline-notice {
		background: var(--color-warning-surface);
		color: var(--color-warning);
		border: 1px solid var(--color-warning-border);
		padding: 12px 16px;
		border-radius: 4px;
		font-size: 14px;
		margin-bottom: 24px;
		text-align: left;
	}

	.google-btn {
		display: inline-flex;
		align-items: center;
		gap: 12px;
		padding: 10px 24px;
		background: var(--color-bg-surface);
		color: var(--color-text-primary);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 0.2s,
			box-shadow 0.2s;
		font-family: 'Google Sans', Roboto, sans-serif;
		letter-spacing: 0.25px;
	}

	.google-btn:hover {
		background: var(--color-bg-surface-dim);
		box-shadow: var(--color-google-btn-shadow);
		text-decoration: none;
	}

	.google-btn.disabled {
		opacity: 0.5;
		cursor: not-allowed;
		pointer-events: none;
	}

	.note {
		margin-top: 32px;
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.4;
	}
</style>
