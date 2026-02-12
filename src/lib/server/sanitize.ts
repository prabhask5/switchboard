/**
 * @fileoverview HTML Sanitizer for Email Body Content.
 *
 * Gmail messages can contain arbitrary HTML (including scripts, iframes,
 * event handlers, and other dangerous content). The client renders email
 * HTML inside a closed Shadow DOM for CSS isolation, but Shadow DOM does
 * NOT prevent script execution — so this sanitizer is the **sole security
 * boundary** against XSS.
 *
 * Sanitization passes (in order):
 *   1. Strip `<script>` tags and content
 *   2. Strip dangerous embed tags (`<iframe>`, `<object>`, `<embed>`, `<applet>`, `<noscript>`) and content
 *   3. Strip structural/meta tags (`<link>`, `<meta>`, `<base>`) and content
 *   4. Strip form-related tags (tag only, keep children): `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`, `<option>`, `<optgroup>`
 *   5. Strip `<foreignObject>` inside SVGs (and its content)
 *   6. Strip event handler attributes (`onclick`, `onerror`, `onload`, etc.)
 *   7. Sanitize dangerous URIs (`javascript:`, `vbscript:`, `data:` except `data:image/`) in `href`, `src`, `srcset`, etc.
 *   8. Add link safety attributes (`target="_blank"`, `rel="noopener noreferrer"`) on all `<a>` tags
 *
 * Preserved: `<style>`, `<img>`, `<svg>` (minus foreignObject), inline `style`
 * attributes, tables, all standard formatting tags.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 */

// =============================================================================
// Sanitizer
// =============================================================================

/**
 * Sanitizes email HTML for safe inline rendering inside a Shadow DOM.
 *
 * This function is the **primary security boundary** — the Shadow DOM provides
 * CSS isolation only, not script sandboxing. All dangerous constructs must be
 * stripped here.
 *
 * Passes (in order):
 *   1. Strip `<script>` tags + content
 *   2. Strip dangerous embed tags + content (`<iframe>`, `<object>`, `<embed>`, `<applet>`, `<noscript>`)
 *   3. Strip structural/meta tags + content (`<link>`, `<meta>`, `<base>`)
 *   4. Strip form element tags (keep children): `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`, `<option>`, `<optgroup>`
 *   5. Strip `<foreignObject>` + content (prevents arbitrary HTML inside SVGs)
 *   6. Strip event handler attributes (`onclick`, `onerror`, `onload`, etc.)
 *   7. Neutralize dangerous URIs (`javascript:`, `vbscript:`, `data:` except `data:image/`) in `href`, `src`, `srcset`, etc.
 *   8. Add safety attributes on `<a>` tags (`target="_blank" rel="noopener noreferrer"`)
 *
 * @param html - The raw HTML string from the email body.
 * @returns HTML string safe for rendering inside a Shadow DOM.
 *
 * @example
 * ```typescript
 * sanitizeEmailHtml('<p onclick="alert(1)">Hello <script>evil()</script> world</p>')
 * // → '<p>Hello  world</p>'
 *
 * sanitizeEmailHtml('<style>.red { color: red }</style><p class="red">Styled</p>')
 * // → '<style>.red { color: red }</style><p class="red">Styled</p>'  (preserved!)
 *
 * sanitizeEmailHtml('<a href="javascript:alert(1)">Click</a>')
 * // → '<a target="_blank" rel="noopener noreferrer">Click</a>'  (href stripped!)
 * ```
 */
export function sanitizeEmailHtml(html: string): string {
	if (!html) return '';

	let result = html;

	/*
	 * Pass 1: Strip <script> tags and their content.
	 *
	 * Three sub-passes handle all cases:
	 *   1. Matched pairs: <script ...>...</script>  (non-greedy)
	 *   2. Self-closing / orphaned opening: <script ...> or <script .../>
	 *   3. Orphaned closing: </script>
	 *
	 * We loop until stable because "</script>" inside a JS string literal
	 * causes the non-greedy match to split the tag prematurely, leaving
	 * fragments that need a second pass (e.g., `var x = "</script>"`).
	 */
	result = stripTagWithContent(result, 'script');

	/*
	 * Pass 2: Strip dangerous embed tags and their content.
	 * These can load or execute arbitrary external content.
	 */
	for (const tag of ['iframe', 'object', 'embed', 'applet', 'noscript']) {
		result = stripTagWithContent(result, tag);
	}

	/*
	 * Pass 3: Strip structural/meta tags and their content.
	 *   - <link> could load external stylesheets or resources
	 *   - <meta> could trigger redirects (http-equiv="refresh")
	 *   - <base> could hijack all relative URLs in the document
	 */
	for (const tag of ['link', 'meta', 'base']) {
		result = stripTagWithContent(result, tag);
	}

	/*
	 * Pass 4: Strip form-related tags (tag only, keep child content).
	 * Prevents form submission / credential harvesting UI while
	 * preserving any text content inside the form elements.
	 * Includes <option>/<optgroup> which are left orphaned after <select> removal.
	 */
	for (const tag of ['form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup']) {
		result = stripTagKeepChildren(result, tag);
	}

	/*
	 * Pass 5: Strip <foreignObject> inside SVGs and its content.
	 * foreignObject can embed arbitrary HTML (including scripts) inside SVG.
	 */
	result = stripTagWithContent(result, 'foreignObject');

	/* Pass 6: Strip event handler attributes (onclick, onerror, onload, etc.). */
	result = result.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');

	/*
	 * Pass 7: Sanitize dangerous URIs.
	 * Strip href/src/srcset/xlink:href/formaction/action/poster attributes when the
	 * value starts with javascript:, vbscript:, or data: (except data:image/).
	 * Handles whitespace/encoding tricks like "java\nscript:" and "&#106;avascript:".
	 */
	result = sanitizeDangerousUris(result);

	/*
	 * Pass 8: Add link safety attributes on all <a> tags.
	 * Ensures target="_blank" and rel="noopener noreferrer" are set,
	 * replacing any existing target/rel attributes first.
	 */
	result = addLinkSafety(result);

	return result;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Regex fragment that matches an HTML tag's attribute list, correctly handling
 * `>` characters inside quoted attribute values.
 *
 * The naive `[^>]*` pattern breaks when an attribute value contains a literal
 * `>` (e.g., `<script title="a > b">`). This pattern handles that by matching:
 *   - `[^>"']`  — any character that's not `>`, `"`, or `'`
 *   - `"[^"]*"` — a complete double-quoted string
 *   - `'[^']*'` — a complete single-quoted string
 *
 * @see https://html.spec.whatwg.org/multipage/syntax.html#attributes-2
 */
const TAG_ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/**
 * Strips a tag and all its content (opening through closing) from HTML.
 * Uses a multi-pass loop to handle nested and malformed cases.
 *
 * @param html - The HTML string to process.
 * @param tag - The tag name to strip (case-insensitive).
 * @returns The HTML with all instances of the tag removed.
 */
function stripTagWithContent(html: string, tag: string): string {
	let result = html;
	let prev;
	do {
		prev = result;
		/* Matched pairs: <tag ...>...</tag> (non-greedy). */
		result = result.replace(
			new RegExp(`<${tag}\\b${TAG_ATTRS}>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'),
			''
		);
		/* Self-closing or orphaned opening: <tag .../> or <tag ...>. */
		result = result.replace(new RegExp(`<${tag}\\b${TAG_ATTRS}/?>`, 'gi'), '');
		/* Orphaned closing: </tag>. */
		result = result.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '');
	} while (result !== prev);
	return result;
}

/**
 * Strips a tag's opening and closing markers but keeps child content.
 * Used for form elements where we want to preserve visible text.
 *
 * @param html - The HTML string to process.
 * @param tag - The tag name to strip (case-insensitive).
 * @returns The HTML with the tag wrappers removed but content preserved.
 */
function stripTagKeepChildren(html: string, tag: string): string {
	let result = html;
	/* Remove opening tags: <tag ...> or <tag .../> */
	result = result.replace(new RegExp(`<${tag}\\b${TAG_ATTRS}/?>`, 'gi'), '');
	/* Remove closing tags: </tag> */
	result = result.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '');
	return result;
}

/**
 * Decodes HTML entities and normalizes whitespace in a URI value
 * to detect obfuscated dangerous protocols like `&#106;avascript:`
 * or `java\nscript:`.
 *
 * @param uri - The raw attribute value (may contain entities/whitespace).
 * @returns The decoded, whitespace-stripped URI for protocol checking.
 */
function decodeAndNormalizeUri(uri: string): string {
	let decoded = uri;

	/* Decode numeric HTML entities: &#106; or &#x6A; → character. */
	decoded = decoded.replace(/&#x([0-9a-f]+);?/gi, (_, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
	decoded = decoded.replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));

	/* Decode named entities commonly used in obfuscation. */
	decoded = decoded.replace(/&tab;/gi, '\t');
	decoded = decoded.replace(/&newline;/gi, '\n');

	/* Strip all whitespace (tabs, newlines, spaces, null bytes) to catch "java\nscript:" tricks. */

	decoded = decoded.replace(/[\s\0]+/g, '');

	return decoded.toLowerCase();
}

/**
 * Checks if a URI value is dangerous (javascript:, vbscript:, or data: except data:image/).
 *
 * @param rawValue - The raw attribute value from the HTML.
 * @param attrName - The attribute name (e.g., "href", "src") for context-specific rules.
 * @returns `true` if the URI is dangerous and should be stripped.
 */
function isDangerousUri(rawValue: string, attrName: string): boolean {
	const normalized = decodeAndNormalizeUri(rawValue);

	if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
		return true;
	}

	if (normalized.startsWith('data:')) {
		/* Allow data:image/* in src attributes (common for inline images). */
		if (attrName.toLowerCase() === 'src' && normalized.startsWith('data:image/')) {
			return false;
		}
		return true;
	}

	return false;
}

/**
 * Strips dangerous URI attributes from HTML tags.
 * Checks href, src, srcset, xlink:href, formaction, action, and poster attributes.
 *
 * @param html - The HTML string to process.
 * @returns The HTML with dangerous URI attributes removed.
 */
function sanitizeDangerousUris(html: string): string {
	/*
	 * Match URI-bearing attributes: href, src, srcset, xlink:href, formaction, action, poster.
	 * Captures: (attrName)=(quote)(value)(quote)
	 */
	const uriAttrs =
		/\s+(href|src|srcset|xlink:href|formaction|action|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

	return html.replace(uriAttrs, (match, attrName, doubleVal, singleVal, unquotedVal) => {
		const value = doubleVal ?? singleVal ?? unquotedVal ?? '';
		if (isDangerousUri(value, attrName)) {
			return '';
		}
		return match;
	});
}

/**
 * Adds `target="_blank"` and `rel="noopener noreferrer"` to all `<a>` tags.
 * Replaces any existing target/rel attributes first.
 *
 * @param html - The HTML string to process.
 * @returns The HTML with safety attributes added to all anchor tags.
 */
function addLinkSafety(html: string): string {
	return html.replace(new RegExp(`<a\\b(${TAG_ATTRS})>`, 'gi'), (_match, attrs: string) => {
		/* Strip existing target and rel attributes. */
		let cleanAttrs = attrs.replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');
		cleanAttrs = cleanAttrs.replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, '');

		return `<a${cleanAttrs} target="_blank" rel="noopener noreferrer">`;
	});
}
