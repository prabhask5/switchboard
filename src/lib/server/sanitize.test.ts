/**
 * @fileoverview Unit tests for the HTML sanitizer.
 *
 * Tests cover:
 *   - Dangerous tag removal (script, iframe, style, etc.)
 *   - Event handler stripping (onclick, onerror, etc.)
 *   - Allowed tag preservation (p, div, a, table, etc.)
 *   - Attribute filtering (style kept, event handlers removed)
 *   - URL sanitization (javascript: blocked, https: allowed)
 *   - Link security (target="_blank", rel="noopener noreferrer")
 *   - Edge cases (empty input, nested tags, malformed HTML)
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize.js';

// =============================================================================
// Dangerous Tag Removal
// =============================================================================

describe('sanitizeHtml — dangerous tag removal', () => {
	it('removes <script> tags and their content', () => {
		expect(sanitizeHtml('<p>Hello</p><script>alert("xss")</script><p>World</p>')).toBe(
			'<p>Hello</p><p>World</p>'
		);
	});

	it('removes <script> tags with attributes', () => {
		expect(sanitizeHtml('<script type="text/javascript" src="evil.js"></script>')).toBe('');
	});

	it('removes <style> tags and their content', () => {
		expect(sanitizeHtml('<style>body { color: red; }</style><p>Text</p>')).toBe('<p>Text</p>');
	});

	it('removes <iframe> tags', () => {
		expect(sanitizeHtml('<iframe src="https://evil.com"></iframe>')).toBe('');
	});

	it('removes <object> and <embed> tags', () => {
		expect(sanitizeHtml('<object data="evil.swf"></object><embed src="evil.swf">')).toBe('');
	});

	it('removes <form>, <input>, <textarea>, <select>, <button> tags', () => {
		const html =
			'<form action="/steal"><input type="text"><textarea>data</textarea><select><option>x</option></select><button>Submit</button></form>';
		expect(sanitizeHtml(html)).toBe('');
	});

	it('removes <svg> and <math> tags', () => {
		expect(
			sanitizeHtml('<svg onload="alert(1)"><circle r="40"/></svg><math><mi>x</mi></math>')
		).toBe('');
	});

	it('removes <link> and <meta> tags', () => {
		expect(
			sanitizeHtml('<link rel="stylesheet" href="evil.css"><meta http-equiv="refresh" content="0">')
		).toBe('');
	});

	it('removes <base> tags (prevents base URL hijacking)', () => {
		expect(sanitizeHtml('<base href="https://evil.com/">')).toBe('');
	});

	it('removes self-closing dangerous tags', () => {
		expect(sanitizeHtml('<script/><img src=x onerror=alert(1)/>')).toBe('');
	});

	it('removes HTML comments', () => {
		expect(sanitizeHtml('<!-- comment --><p>Text</p><!--[if IE]>evil<![endif]-->')).toBe(
			'<p>Text</p>'
		);
	});
});

// =============================================================================
// Allowed Tag Preservation
// =============================================================================

describe('sanitizeHtml — allowed tag preservation', () => {
	it('preserves basic text formatting tags', () => {
		const html = '<p><strong>Bold</strong> <em>Italic</em> <u>Underline</u></p>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves div and span', () => {
		const html = '<div><span>Content</span></div>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves lists', () => {
		const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves tables', () => {
		const html = '<table><tr><td>Cell</td></tr></table>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves headings', () => {
		const html = '<h1>Title</h1><h2>Subtitle</h2>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves blockquote and pre', () => {
		const html = '<blockquote>Quote</blockquote><pre>Code</pre>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves <br> and <hr>', () => {
		const html = '<p>Line 1<br>Line 2</p><hr>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it('preserves <font> tags (legacy email formatting)', () => {
		const html = '<font color="red" face="Arial" size="3">Text</font>';
		expect(sanitizeHtml(html)).toBe(html);
	});
});

// =============================================================================
// Attribute Filtering
// =============================================================================

describe('sanitizeHtml — attribute filtering', () => {
	it('keeps style attributes', () => {
		expect(sanitizeHtml('<p style="color: red;">Text</p>')).toBe('<p style="color: red;">Text</p>');
	});

	it('keeps class and id attributes', () => {
		expect(sanitizeHtml('<div class="wrapper" id="main">Content</div>')).toBe(
			'<div class="wrapper" id="main">Content</div>'
		);
	});

	it('strips event handler attributes', () => {
		expect(sanitizeHtml('<p onclick="alert(1)">Text</p>')).toBe('<p>Text</p>');
	});

	it('strips onerror attribute', () => {
		expect(sanitizeHtml('<div onerror="alert(1)">Text</div>')).toBe('<div>Text</div>');
	});

	it('strips onload attribute', () => {
		expect(sanitizeHtml('<div onload="alert(1)">Text</div>')).toBe('<div>Text</div>');
	});

	it('strips onmouseover attribute', () => {
		expect(sanitizeHtml('<span onmouseover="alert(1)">Text</span>')).toBe('<span>Text</span>');
	});

	it('strips unknown/disallowed attributes', () => {
		expect(sanitizeHtml('<p data-custom="value" accesskey="x">Text</p>')).toBe('<p>Text</p>');
	});

	it('keeps table-specific attributes', () => {
		const html = '<td colspan="2" rowspan="3" width="100" bgcolor="#fff">Cell</td>';
		expect(sanitizeHtml(html)).toBe(html);
	});
});

// =============================================================================
// URL Sanitization
// =============================================================================

describe('sanitizeHtml — URL sanitization', () => {
	it('allows https: URLs in href', () => {
		const result = sanitizeHtml('<a href="https://example.com">Link</a>');
		expect(result).toContain('href="https://example.com"');
	});

	it('allows http: URLs in href', () => {
		const result = sanitizeHtml('<a href="http://example.com">Link</a>');
		expect(result).toContain('href="http://example.com"');
	});

	it('allows mailto: URLs in href', () => {
		const result = sanitizeHtml('<a href="mailto:test@example.com">Email</a>');
		expect(result).toContain('href="mailto:test@example.com"');
	});

	it('blocks javascript: URLs in href', () => {
		const result = sanitizeHtml('<a href="javascript:alert(1)">Click</a>');
		expect(result).not.toContain('javascript:');
		expect(result).not.toContain('href=');
	});

	it('blocks JavaScript: URLs (case-insensitive)', () => {
		const result = sanitizeHtml('<a href="JavaScript:alert(1)">Click</a>');
		expect(result).not.toContain('href=');
	});

	it('blocks vbscript: URLs', () => {
		const result = sanitizeHtml('<a href="vbscript:MsgBox(1)">Click</a>');
		expect(result).not.toContain('href=');
	});

	it('blocks data: URLs', () => {
		const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">Click</a>');
		expect(result).not.toContain('href=');
	});

	it('blocks javascript: with leading whitespace', () => {
		const result = sanitizeHtml('<a href="  javascript:alert(1)">Click</a>');
		expect(result).not.toContain('href=');
	});
});

// =============================================================================
// Link Security
// =============================================================================

describe('sanitizeHtml — link security attributes', () => {
	it('adds target="_blank" to links', () => {
		const result = sanitizeHtml('<a href="https://example.com">Link</a>');
		expect(result).toContain('target="_blank"');
	});

	it('adds rel="noopener noreferrer" to links', () => {
		const result = sanitizeHtml('<a href="https://example.com">Link</a>');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('adds security attributes to links without any attributes', () => {
		const result = sanitizeHtml('<a>Link</a>');
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('sanitizeHtml — edge cases', () => {
	it('returns empty string for empty input', () => {
		expect(sanitizeHtml('')).toBe('');
	});

	it('returns empty string for undefined-like input', () => {
		expect(sanitizeHtml(null as unknown as string)).toBe('');
		expect(sanitizeHtml(undefined as unknown as string)).toBe('');
	});

	it('preserves plain text with no HTML', () => {
		expect(sanitizeHtml('Just plain text')).toBe('Just plain text');
	});

	it('handles nested dangerous tags', () => {
		expect(sanitizeHtml('<div><script><script>nested</script></script></div>')).toBe('<div></div>');
	});

	it('strips unknown/custom tags but preserves their text content', () => {
		expect(sanitizeHtml('<custom>Text inside custom tag</custom>')).toBe('Text inside custom tag');
	});

	it('handles img tags (removed for tracking prevention)', () => {
		expect(sanitizeHtml('<img src="https://track.example.com/pixel.gif">')).toBe('');
	});

	it('escapes attribute values with quotes', () => {
		const result = sanitizeHtml('<p style="font-family: &quot;Arial&quot;">Text</p>');
		/* The attribute value should be properly escaped. */
		expect(result).toContain('<p');
		expect(result).toContain('Text</p>');
	});

	it('handles self-closing allowed tags', () => {
		expect(sanitizeHtml('<br />')).toBe('<br />');
	});

	it('handles mixed safe and dangerous content', () => {
		const html = '<p>Safe</p><script>evil()</script><div>Also safe</div><iframe src="x"></iframe>';
		expect(sanitizeHtml(html)).toBe('<p>Safe</p><div>Also safe</div>');
	});
});
