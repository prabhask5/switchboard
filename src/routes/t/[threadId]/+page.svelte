<!--
  @component Thread Detail Placeholder

  Displays a placeholder for the thread detail view at /t/[threadId].
  The full thread reader (message list, reply composer, etc.) will be
  implemented in a later PR.

  For now, shows the thread ID and a link back to the inbox.
-->
<script lang="ts">
	import { page } from '$app/stores';
</script>

<svelte:head>
	<title>Thread - Email Switchboard</title>
</svelte:head>

<main class="thread-page">
	<nav class="thread-nav">
		<a href="/" class="back-link">
			<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
				<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
			</svg>
			Back to inbox
		</a>
	</nav>

	<div class="thread-placeholder">
		<h2>Thread {$page.params.threadId}</h2>
		<p class="hint">Thread detail view coming in the next update.</p>
	</div>
</main>

<style>
	.thread-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 24px;
	}

	.thread-nav {
		margin-bottom: 24px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: #5f6368;
		text-decoration: none;
		font-size: 14px;
		padding: 8px 12px;
		border-radius: 4px;
	}

	.back-link:hover {
		background: #f1f3f4;
		color: #202124;
	}

	.thread-placeholder {
		text-align: center;
		padding: 80px 24px;
	}

	.thread-placeholder h2 {
		font-size: 18px;
		font-weight: 400;
		color: #202124;
		margin: 0 0 8px;
		word-break: break-all;
	}

	.hint {
		color: #5f6368;
		font-size: 14px;
		margin: 0;
	}
</style>
