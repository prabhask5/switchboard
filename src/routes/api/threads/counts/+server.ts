/**
 * @fileoverview Estimated per-panel thread counts endpoint.
 *
 * POST /api/threads/counts
 *
 * Accepts panel configurations in the request body, converts their rules
 * to Gmail search queries using `panelRulesToGmailQuery()`, and returns
 * estimated total and unread counts per panel using Gmail's
 * `resultSizeEstimate` (no actual thread data is fetched).
 *
 * This endpoint is non-critical — failures return empty counts rather
 * than error pages, so the UI gracefully degrades to loaded-thread counts.
 *
 * Request Body:
 *   { panels: PanelConfig[] }
 *
 * Response:
 *   200: { counts: Array<{ total: number; unread: number }> }
 *   400: { message: string } — missing or invalid panels array
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getEstimatedCounts } from '$lib/server/gmail.js';
import { panelRulesToGmailQuery } from '$lib/rules.js';
import type { PanelConfig } from '$lib/types.js';

/**
 * Handles POST /api/threads/counts.
 *
 * Converts each panel's regex rules to Gmail search queries, then calls
 * `getEstimatedCounts()` to fetch `resultSizeEstimate` for total and
 * unread threads per panel. The last panel with no rules is treated as
 * the catch-all: its query negates all other panels' accept queries.
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
	let body: { panels?: PanelConfig[] };
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}

	const panels = body.panels;
	if (!Array.isArray(panels) || panels.length === 0) {
		error(400, 'panels array required');
	}

	/* ── Step 3: Build Gmail queries per panel ─────────────────────── */
	const queries: string[] = [];
	const acceptQueries: string[] = []; /* Collect for catch-all negation. */

	for (let i = 0; i < panels.length; i++) {
		const panel = panels[i];
		if (panel.rules.length > 0) {
			const q = panelRulesToGmailQuery(panel);
			queries.push(q);
			if (q) acceptQueries.push(q);
		} else if (i === panels.length - 1) {
			/* Last panel with no rules = catch-all → negate all other panels. */
			queries.push(panelRulesToGmailQuery(panel, acceptQueries));
		} else {
			/* Middle panel with no rules — always empty (no threads match). */
			queries.push('');
		}
	}

	/* ── Step 4: Fetch estimated counts from Gmail ─────────────────── */
	try {
		const counts = await getEstimatedCounts(accessToken, queries);
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
