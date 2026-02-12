<!--
  @component Root Layout

  Provides the base HTML shell for all pages. Sets up the Google-style
  font stack, resets default margins, and includes the global offline
  banner that appears on every page when the user loses connectivity.
-->
<script lang="ts">
	import OfflineBanner from '$lib/components/OfflineBanner.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" />
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

{@render children()}

<!-- Global offline banner — shows on all pages when connectivity is lost -->
<OfflineBanner />

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}

	:global(body) {
		margin: 0;
		font-family:
			'Google Sans',
			Roboto,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Helvetica,
			Arial,
			sans-serif;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		color: #202124;
		background: #f6f8fc;
	}

	:global(a) {
		color: #1a73e8;
		text-decoration: none;
	}

	:global(a:hover) {
		text-decoration: underline;
	}
</style>
