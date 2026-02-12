/**
 * @fileoverview HTML Sanitizer for Email Body Content.
 *
 * Gmail messages can contain arbitrary HTML (including scripts, iframes,
 * event handlers, and other dangerous content). The client renders email
 * HTML inside a sandboxed iframe (`sandbox="allow-same-origin allow-popups"`),
 * which prevents script execution, form submission, and most dangerous
 * behaviors at the browser level.
 *
 * This module provides a defense-in-depth server-side sanitization pass
 * that strips only the most dangerous constructs:
 *   - `<script>` tags and their content
 *   - Event handler attributes (`onclick`, `onerror`, `onload`, etc.)
 *
 * Everything else — including `<style>`, `<img>`, `<svg>`, `<link>`,
 * tables, and all CSS — is preserved so emails render with their
 * original styling, just like they would in Gmail.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 */

// =============================================================================
// Sanitizer
// =============================================================================

/**
 * Light sanitization for email HTML rendered inside a sandboxed iframe.
 *
 * The client renders email bodies in an `<iframe>` with
 * `sandbox="allow-same-origin allow-popups"`, which prevents script
 * execution, form submission, and most other dangerous behaviors.
 * This function provides defense-in-depth by stripping:
 *
 *   - `<script>` tags and their content
 *   - Event handler attributes (`onclick`, `onerror`, `onload`, etc.)
 *
 * Everything else — including `<style>`, `<img>`, `<svg>`, `<link>`,
 * tables, and all CSS — is preserved so emails render with their
 * original styling, just like they would in Gmail.
 *
 * @param html - The raw HTML string from the email body.
 * @returns HTML string safe for rendering inside a sandboxed iframe.
 *
 * @example
 * ```typescript
 * sanitizeHtmlForIframe('<p onclick="alert(1)">Hello <script>evil()</script> world</p>')
 * // → '<p>Hello  world</p>'
 *
 * sanitizeHtmlForIframe('<style>.red { color: red }</style><p class="red">Styled</p>')
 * // → '<style>.red { color: red }</style><p class="red">Styled</p>'  (preserved!)
 * ```
 */
export function sanitizeHtmlForIframe(html: string): string {
	if (!html) return '';

	let result = html;

	/*
	 * Strip <script> tags and their content (defense-in-depth).
	 *
	 * Three passes handle all cases:
	 *   1. Matched pairs: <script ...>...</script>  (non-greedy)
	 *   2. Self-closing / orphaned opening: <script ...> or <script .../>
	 *   3. Orphaned closing: </script>
	 *
	 * We loop until stable because "</script>" inside a JS string literal
	 * causes the non-greedy match to split the tag prematurely, leaving
	 * fragments that need a second pass (e.g., `var x = "</script>"`).
	 */
	let prev;
	do {
		prev = result;
		result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
		result = result.replace(/<script\b[^>]*\/?>/gi, '');
		result = result.replace(/<\/script\s*>/gi, '');
	} while (result !== prev);

	/* Strip event handler attributes (onclick, onerror, onload, etc.). */
	result = result.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');

	return result;
}
