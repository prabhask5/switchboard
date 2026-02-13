/**
 * @fileoverview Per-panel thread counts endpoint.
 *
 * POST /api/threads/counts
 *
 * Returns per-panel thread counts with two strategies:
 *   - **No-rules panels (without search)**: Exact counts via
 *     `users.labels.get(INBOX)` — 1 API call, shared across all no-rules
 *     panels. Response includes `isEstimate: false`.
 *   - **Rules panels (or any panel during search)**: Approximate counts
 *     via `resultSizeEstimate` from `threads.list`. Response includes
 *     `isEstimate: true`.
 *
 * This endpoint is non-critical — failures return error responses,
 * and the UI gracefully degrades to loaded-thread counts.
 *
 * Request Body:
 *   { panels: PanelConfig[], searchQuery?: string }
 *
 * Response:
 *   200: { counts: Array<{ total: number; unread: number; isEstimate: boolean }> }
 *   400: { message: string } — missing or invalid panels array
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getEstimatedCounts, getInboxLabelCounts } from '$lib/server/gmail.js';
import { panelRulesToGmailQuery } from '$lib/rules.js';
import type { PanelConfig } from '$lib/types.js';

/**
 * Handles POST /api/threads/counts.
 *
 * Separates panels into "has rules" vs "no rules" categories, then:
 *   - No-rules panels without search → exact INBOX count (1 API call, shared)
 *   - No-rules panels with search → estimated count via threads.list
 *   - Rules panels → estimated count via threads.list (2 API calls each)
 *
 * This minimizes API usage: if 3 of 4 panels have no rules, we make
 * 1 API call instead of 6.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	/* ── Step 1: Authenticate ──────────────────────────────────────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		if (message.includes('Not authenticated')) {
			error(401, 'Not authenticated');
		}
		error(401, `Session expired: ${message}`);
	}

	/* ── Step 2: Parse request body ────────────────────────────────── */
	let body: { panels?: PanelConfig[]; searchQuery?: string };
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}

	const panels = body.panels;
	if (!Array.isArray(panels) || panels.length === 0) {
		error(400, 'panels array required');
	}

	const searchQuery: string | undefined = body.searchQuery?.trim() || undefined;

	/* ── Step 3: Categorize panels ─────────────────────────────────── */
	const hasNoRules = panels.map((p) => p.rules.length === 0);
	const hasAnyNoRules = hasNoRules.some(Boolean);

	/* ── Step 4: Fetch counts per category ─────────────────────────── */
	try {
		/*
		 * Count result for no-rules panels. Shared across all no-rules
		 * panels since they all represent the same inbox-wide view.
		 */
		let noRulesCount: { total: number; unread: number; isEstimate: boolean } | null = null;

		if (hasAnyNoRules) {
			if (searchQuery) {
				/*
				 * Search active + no rules: use threads.list estimate
				 * with just the search query (no panel-specific filter).
				 */
				const [est] = await getEstimatedCounts(accessToken, [searchQuery]);
				noRulesCount = { ...est, isEstimate: true };
			} else {
				/*
				 * No search + no rules: exact INBOX count via labels.get.
				 * This is 1 API call returning precise threadsTotal/threadsUnread.
				 */
				const exact = await getInboxLabelCounts(accessToken);
				noRulesCount = { ...exact, isEstimate: false };
			}
		}

		/*
		 * Build Gmail queries for rules-based panels only.
		 * Each rules panel needs its own query (combined with searchQuery
		 * when a search is active).
		 */
		const rulesQueries: string[] = [];
		const rulesIndices: number[] = [];

		for (let i = 0; i < panels.length; i++) {
			if (!hasNoRules[i]) {
				let q = panelRulesToGmailQuery(panels[i]);
				/* Combine panel rules with search query using AND semantics. */
				if (searchQuery && q) q = `(${q}) (${searchQuery})`;
				rulesQueries.push(q);
				rulesIndices.push(i);
			}
		}

		const rulesEstimates =
			rulesQueries.length > 0 ? await getEstimatedCounts(accessToken, rulesQueries) : [];

		/* ── Step 5: Assemble final counts in panel order ──────────── */
		const counts = panels.map((_, i) => {
			if (hasNoRules[i]) return noRulesCount!;
			const idx = rulesIndices.indexOf(i);
			return { ...rulesEstimates[idx], isEstimate: true };
		});

		return json({ counts });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads/counts] Gmail API error:', message);

		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Gmail API error: ${message}`);
	}
};
