/**
 * @fileoverview Attachment download endpoint.
 *
 * GET /api/thread/[id]/attachment?messageId=X&attachmentId=Y&filename=Z&mimeType=W
 *
 * Fetches a single email attachment from Gmail and streams the decoded
 * binary data to the client with the appropriate Content-Type and
 * Content-Disposition headers for download.
 *
 * Gmail stores large attachments separately from the message payload.
 * When `format=full` is used, attachment parts have a `body.attachmentId`
 * instead of inline `body.data`. This endpoint fetches the actual content
 * via Gmail's dedicated attachments endpoint and decodes the base64url
 * data into raw bytes.
 *
 * Query Parameters:
 *   - messageId: The Gmail message ID containing the attachment (required)
 *   - attachmentId: The Gmail attachment ID (required)
 *   - filename: The original filename for Content-Disposition (required)
 *   - mimeType: The MIME type for Content-Type header (optional, defaults to application/octet-stream)
 *
 * Response:
 *   200: Raw binary data with Content-Disposition: attachment; filename="..."
 *   400: { message: string } — missing required query params
 *   401: { message: string } — not authenticated
 *   500: { message: string } — Gmail API error
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccessToken } from '$lib/server/auth.js';
import { getAttachment } from '$lib/server/gmail.js';

/**
 * Handles GET /api/thread/[id]/attachment.
 *
 * Validates required query parameters, mints an access token, fetches the
 * attachment data from Gmail, decodes it from base64url, and returns it
 * as a binary response with download headers.
 */
export const GET: RequestHandler = async ({ cookies, url }) => {
	/* ── Validate query parameters ─────────────────────────────────── */
	const messageId = url.searchParams.get('messageId');
	const attachmentId = url.searchParams.get('attachmentId');
	const filename = url.searchParams.get('filename');
	const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';

	if (!messageId) error(400, 'Missing messageId query parameter');
	if (!attachmentId) error(400, 'Missing attachmentId query parameter');
	if (!filename) error(400, 'Missing filename query parameter');

	/* ── Mint access token ─────────────────────────────────────────── */
	let accessToken: string;
	try {
		accessToken = await getAccessToken(cookies);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		if (message.includes('Not authenticated')) {
			console.warn('[/api/thread/attachment] Access token:', message);
			error(401, 'Not authenticated');
		}
		console.error('[/api/thread/attachment] Access token error:', message);
		error(401, `Session expired: ${message}`);
	}

	/* ── Fetch attachment data from Gmail ──────────────────────────── */
	try {
		const base64urlData = await getAttachment(accessToken, messageId, attachmentId);

		/*
		 * Decode base64url → raw bytes.
		 * Gmail returns attachment data in base64url encoding (RFC 4648 §5).
		 * We convert to standard base64, then decode to a Buffer.
		 */
		const base64 = base64urlData.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const binaryData = Buffer.from(padded, 'base64');

		/*
		 * Sanitize the filename for the Content-Disposition header.
		 * Removes characters that could cause header injection or
		 * filesystem issues (quotes, newlines, null bytes).
		 */
		const safeFilename = filename.replace(/["\r\n\0]/g, '_');

		return new Response(binaryData, {
			status: 200,
			headers: {
				'Content-Type': mimeType,
				'Content-Disposition': `attachment; filename="${safeFilename}"`,
				'Content-Length': String(binaryData.length),
				/* Prevent caching of attachment data (may contain sensitive content). */
				'Cache-Control': 'no-store'
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[/api/thread/attachment] Gmail API error:', message);

		if (message.includes('401') || message.includes('invalid_grant')) {
			error(401, 'Session expired. Please sign in again.');
		}
		if (message.includes('404')) {
			error(404, 'Attachment not found');
		}

		error(500, `Failed to download attachment: ${message}`);
	}
};
