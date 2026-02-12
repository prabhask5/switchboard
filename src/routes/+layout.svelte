<!--
  @component Root Layout

  Provides the base HTML shell for all pages. Sets up the Google-style
  font stack and resets default margins. Individual pages handle their
  own layout (login vs. authenticated shell).
-->
<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" />
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

{@render children()}

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
