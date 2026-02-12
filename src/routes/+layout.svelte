<!--
  @component Root Layout

  Provides the base HTML shell for all pages. Imports the global CSS (theme
  variables + reset), initialises the theme store on first mount, and includes
  the global offline banner and update toast that appear on every page.
-->
<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { initTheme } from '$lib/stores/theme';
	import OfflineBanner from '$lib/components/OfflineBanner.svelte';
	import UpdateToast from '$lib/components/UpdateToast.svelte';

	let { children } = $props();

	onMount(() => {
		initTheme();
	});
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" />
	<meta name="theme-color" content="#ffffff" />
</svelte:head>

{@render children()}

<!-- Global offline banner — shows on all pages when connectivity is lost -->
<OfflineBanner />

<!-- Global update toast — shows when a new service worker version is available -->
<UpdateToast />
