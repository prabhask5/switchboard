/**
 * @fileoverview HTML Sanitizer for Email Body Content.
 *
 * Gmail messages can contain arbitrary HTML (including scripts, iframes,
 * event handlers, and other dangerous content). Before sending HTML
 * email bodies to the client, we strip all potentially dangerous
 * elements and attributes server-side.
 *
 * Security Model:
 *   - **Allowlist approach**: Only explicitly allowed tags and attributes
 *     pass through. Everything else is stripped.
 *   - **No script execution**: All <script> tags, event handler attributes
 *     (onclick, onerror, etc.), and javascript: URLs are removed.
 *   - **No external resources by default**: <img>, <video>, <audio> tags
 *     are stripped to prevent tracking pixels and mixed content.
 *   - **No iframes/embeds**: Prevents clickjacking and third-party content.
 *   - **Style attributes preserved**: Inline styles are kept for basic
 *     formatting (font, color, alignment) since email HTML relies on them.
 *
 * This is a defense-in-depth measure. The client also renders sanitized
 * HTML inside a sandboxed iframe for additional isolation.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * HTML tags that are safe to render in email body content.
 *
 * This allowlist covers standard email formatting elements:
 *   - Text: p, br, span, strong, em, b, i, u, s, sub, sup, small
 *   - Structure: div, section, article, header, footer, main
 *   - Lists: ul, ol, li
 *   - Tables: table, thead, tbody, tfoot, tr, td, th, caption, colgroup, col
 *   - Links: a (with href sanitization)
 *   - Headings: h1–h6
 *   - Formatting: blockquote, pre, code, hr, center, font
 *   - Definition lists: dl, dt, dd
 */
const ALLOWED_TAGS = new Set([
	/* Text formatting */
	'p',
	'br',
	'span',
	'strong',
	'em',
	'b',
	'i',
	'u',
	's',
	'sub',
	'sup',
	'small',
	'mark',
	'abbr',

	/* Structure */
	'div',
	'section',
	'article',
	'header',
	'footer',
	'main',

	/* Lists */
	'ul',
	'ol',
	'li',

	/* Tables */
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'td',
	'th',
	'caption',
	'colgroup',
	'col',

	/* Links */
	'a',

	/* Headings */
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',

	/* Formatting */
	'blockquote',
	'pre',
	'code',
	'hr',
	'center',
	'font',

	/* Definition lists */
	'dl',
	'dt',
	'dd'
]);

/**
 * HTML attributes that are safe to keep on allowed tags.
 *
 * Style is allowed for email formatting. Href is allowed on <a> tags
 * but sanitized to block javascript: URLs. Class and id are allowed
 * for CSS styling that may be referenced by inline <style> blocks.
 */
const ALLOWED_ATTRS = new Set([
	'style',
	'class',
	'id',
	'href',
	'target',
	'rel',
	'title',
	'dir',
	'lang',

	/* Table attributes */
	'colspan',
	'rowspan',
	'width',
	'height',
	'align',
	'valign',
	'border',
	'cellpadding',
	'cellspacing',
	'bgcolor',

	/* Font attributes (legacy email formatting) */
	'color',
	'face',
	'size'
]);

/**
 * Regex matching HTML event handler attributes (onclick, onerror, onload, etc.).
 * These are always stripped regardless of the allowlist.
 */
const EVENT_HANDLER_REGEX = /^on[a-z]+$/i;

/**
 * Regex matching dangerous URL schemes that could execute JavaScript.
 * Applied to href and other URL-bearing attributes.
 */
const DANGEROUS_URL_REGEX = /^\s*(javascript|vbscript|data):/i;

// =============================================================================
// Sanitizer
// =============================================================================

/**
 * Sanitizes HTML email body content by removing dangerous elements and attributes.
 *
 * Uses a regex-based approach to parse and filter HTML tags. While not as
 * robust as a full DOM parser, it's sufficient for server-side sanitization
 * where we don't have a browser DOM available, and the result is further
 * sandboxed on the client side.
 *
 * Processing steps:
 *   1. Remove all <script>, <style>, <iframe>, <object>, <embed>, <form>,
 *      <input>, <textarea>, <select>, and <button> tags and their content.
 *   2. Strip HTML comments (which can contain conditional IE directives).
 *   3. For remaining tags: keep only those in the allowlist.
 *   4. For allowed tags: keep only allowed attributes, stripping event handlers.
 *   5. Sanitize URLs in href attributes to block javascript: schemes.
 *   6. Add target="_blank" and rel="noopener noreferrer" to all <a> tags.
 *
 * @param html - The raw HTML string from the email body.
 * @returns Sanitized HTML string safe for rendering in a sandboxed container.
 *
 * @example
 * ```typescript
 * sanitizeHtml('<p onclick="alert(1)">Hello <script>evil()</script> world</p>')
 * // → '<p>Hello  world</p>'
 *
 * sanitizeHtml('<a href="javascript:alert(1)">Click</a>')
 * // → '<a>Click</a>'
 * ```
 */
export function sanitizeHtml(html: string): string {
	if (!html) return '';

	let result = html;

	/*
	 * Step 1: Remove dangerous tags and their content entirely.
	 * These tags can execute code or embed external content.
	 * Uses a non-greedy match to handle nested content correctly.
	 */
	const dangerousTags = [
		'script',
		'style',
		'iframe',
		'object',
		'embed',
		'applet',
		'form',
		'input',
		'textarea',
		'select',
		'button',
		'link',
		'meta',
		'base',
		'svg',
		'math'
	];

	for (const tag of dangerousTags) {
		/* Remove opening + content + closing tag (non-greedy). */
		const contentRegex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
		result = result.replace(contentRegex, '');

		/* Remove any remaining self-closing or orphaned opening tags. */
		const selfCloseRegex = new RegExp(`<${tag}[^>]*/?>`, 'gi');
		result = result.replace(selfCloseRegex, '');
	}

	/* Step 2: Remove HTML comments (can contain IE conditional directives). */
	result = result.replace(/<!--[\s\S]*?-->/g, '');

	/*
	 * Step 3 & 4: Process remaining tags.
	 * Match any HTML tag (opening, closing, or self-closing) and decide
	 * whether to keep it based on the allowlist.
	 */
	result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g, (match, tagName, attrs) => {
		const tag = (tagName as string).toLowerCase();

		/* Closing tags: keep if tag is allowed. */
		if (match.startsWith('</')) {
			return ALLOWED_TAGS.has(tag) ? `</${tag}>` : '';
		}

		/* Opening tags: strip if not allowed. */
		if (!ALLOWED_TAGS.has(tag)) {
			return '';
		}

		/* Filter attributes for allowed tags. */
		const cleanAttrs = sanitizeAttributes(tag, (attrs as string) || '');
		const selfClosing = match.endsWith('/>') ? ' /' : '';

		return `<${tag}${cleanAttrs}${selfClosing}>`;
	});

	return result;
}

/**
 * Sanitizes HTML attributes for a given tag.
 *
 * Keeps only allowed attributes, strips event handlers, and sanitizes
 * URL-bearing attributes to prevent javascript: injection.
 *
 * For <a> tags, automatically adds `target="_blank"` and
 * `rel="noopener noreferrer"` for security (prevents tab-nabbing).
 *
 * @param tag - The lowercase tag name.
 * @param attrsString - The raw attribute string from the HTML tag.
 * @returns Sanitized attribute string (with leading space, or empty string).
 */
function sanitizeAttributes(tag: string, attrsString: string): string {
	if (!attrsString.trim()) {
		/* For <a> tags, still add security attributes even with no existing attrs. */
		return tag === 'a' ? ' target="_blank" rel="noopener noreferrer"' : '';
	}

	const cleanAttrs: string[] = [];

	/*
	 * Parse attributes using a regex that handles:
	 *   - attr="value" (double-quoted)
	 *   - attr='value' (single-quoted)
	 *   - attr=value (unquoted)
	 *   - attr (boolean, no value)
	 */
	const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	let attrMatch: RegExpExecArray | null;

	while ((attrMatch = attrRegex.exec(attrsString)) !== null) {
		const attrName = attrMatch[1].toLowerCase();
		const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

		/* Skip event handlers (onclick, onerror, etc.). */
		if (EVENT_HANDLER_REGEX.test(attrName)) continue;

		/* Skip attributes not in the allowlist. */
		if (!ALLOWED_ATTRS.has(attrName)) continue;

		/* Sanitize URL attributes. */
		if (attrName === 'href' && DANGEROUS_URL_REGEX.test(attrValue)) continue;

		/* Escape the attribute value to prevent injection. */
		const escaped = escapeAttrValue(attrValue);
		cleanAttrs.push(`${attrName}="${escaped}"`);
	}

	/* For <a> tags, ensure security attributes are present. */
	if (tag === 'a') {
		if (!cleanAttrs.some((a) => a.startsWith('target='))) {
			cleanAttrs.push('target="_blank"');
		}
		if (!cleanAttrs.some((a) => a.startsWith('rel='))) {
			cleanAttrs.push('rel="noopener noreferrer"');
		}
	}

	return cleanAttrs.length > 0 ? ' ' + cleanAttrs.join(' ') : '';
}

/**
 * Escapes special characters in an HTML attribute value.
 *
 * Prevents attribute injection by escaping quotes and angle brackets.
 *
 * @param value - The raw attribute value.
 * @returns Escaped value safe for use inside double-quoted attributes.
 */
function escapeAttrValue(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
