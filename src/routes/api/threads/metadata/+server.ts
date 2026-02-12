/**
 * @fileoverview Batch thread metadata endpoint.
 *
 * POST /api/threads/metadata
 *
 * Accepts a JSON body with `{ ids: string[] }` and returns full metadata
 * (Subject, From, To, Date, labels, message count) for each thread.
 *
 * This is the second phase of the two-phase fetch pattern:
 *   1. Client calls GET /api/threads to get thread IDs.
 *   2. Client calls POST /api/threads/metadata with those IDs.
 *
 * Uses Gmail's batch endpoint to fetch all threads in a single HTTP call
 * (up to 100 per batch, split automatically for larger sets).
 *
 * Request:
 *   POST with JSON body: { ids: string[] } (1–100 thread IDs)
 *
 * Response:
 *   200: { threads: ThreadMetadata[] }
 *   400: { message: string } — invalid request body
 *   401: { message: string } — not authenticated or session expired
 *   500: { message: string } — Gmail API error
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { z } from 'zod';
import { getAccessToken } from '$lib/server/auth.js';
import { batchGetThreadMetadata } from '$lib/server/gmail.js';

/**
 * Zod schema for the request body.
 *
 * Validates that `ids` is a non-empty array of strings with a maximum
 * of 100 items (matching Gmail's batch endpoint limit).
 */
const metadataRequestSchema = z.object({
	ids: z
		.array(z.string().min(1))
		.min(1, 'At least one thread ID is required')
		.max(100, 'Maximum 100 thread IDs per request')
});

/**
 * Handles POST /api/threads/metadata.
 *
 * Validates the request body with Zod, mints an access token, then
 * batch-fetches thread metadata from the Gmail API.
 */
export const POST: RequestHandler = async ({ cookies, request }) => {
	/* ── Step 1: Parse and validate request body ──────────────────── */
	let ids: string[];
	try {
		const body: unknown = await request.json();
		const parsed = metadataRequestSchema.parse(body);
		ids = parsed.ids;
	} catch (err) {
		if (err instanceof z.ZodError) {
			const message = err.issues.map((i) => i.message).join('; ');
			error(400, `Invalid request: ${message}`);
		}
		error(400, 'Invalid JSON body');
	}

	/* ── Step 2: Mint access token from refresh token cookie ──────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads/metadata] Access token error:', message);

		if (message.includes('Not authenticated')) {
			error(401, 'Not authenticated');
		}
		error(401, `Session expired: ${message}`);
	}

	/* ── Step 3: Batch fetch thread metadata ──────────────────────── */
	try {
		const threads = await batchGetThreadMetadata(accessToken, ids);
		return json({ threads });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/threads/metadata] Gmail batch error:', message);

		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}

		error(500, `Gmail API error: ${message}`);
	}
};
