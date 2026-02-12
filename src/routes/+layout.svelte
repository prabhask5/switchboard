<!--
  @component Root Layout

  Provides the base HTML shell for all pages. Imports the global CSS (theme
  variables + reset), initialises the theme store on first mount, and includes
  the global offline banner and update toast that appear on every page.

  Accessibility:
    - Skip-to-content link for keyboard users (visually hidden, shown on focus).
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

<!-- Skip link for keyboard navigation (visible only on focus). -->
<a href="#main-content" class="skip-link">Skip to main content</a>

{@render children()}

<!-- Global offline banner — shows on all pages when connectivity is lost -->
<OfflineBanner />

<!-- Global update toast — shows when a new service worker version is available -->
<UpdateToast />
