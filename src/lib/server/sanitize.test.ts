/**
 * @fileoverview Unit tests for the iframe-safe HTML sanitizer.
 *
 * Tests cover:
 *   - Script tag removal (inline, with attributes, self-closing, nested)
 *   - Event handler stripping (onclick, onerror, onload, onmouseover, etc.)
 *   - Preservation of visual elements (style, img, svg, tables, links, etc.)
 *   - Edge cases (empty input, plain text, malformed HTML)
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHtmlForIframe } from './sanitize.js';

// =============================================================================
// Script Tag Removal
// =============================================================================

describe('sanitizeHtmlForIframe — script tag removal', () => {
	it('removes <script> tags and their content', () => {
		expect(sanitizeHtmlForIframe('<p>Hello</p><script>alert("xss")</script><p>World</p>')).toBe(
			'<p>Hello</p><p>World</p>'
		);
	});

	it('removes <script> tags with attributes', () => {
		expect(sanitizeHtmlForIframe('<script type="text/javascript" src="evil.js"></script>')).toBe(
			''
		);
	});

	it('removes self-closing <script> tags', () => {
		expect(sanitizeHtmlForIframe('<script/>')).toBe('');
		expect(sanitizeHtmlForIframe('<script src="evil.js"/>')).toBe('');
	});

	it('removes multiple <script> tags', () => {
		expect(sanitizeHtmlForIframe('<script>a()</script><p>OK</p><script>b()</script>')).toBe(
			'<p>OK</p>'
		);
	});

	it('removes <script> tags case-insensitively', () => {
		expect(sanitizeHtmlForIframe('<SCRIPT>alert(1)</SCRIPT>')).toBe('');
		expect(sanitizeHtmlForIframe('<Script>alert(1)</Script>')).toBe('');
	});

	it('handles </script> appearing inside a JS string literal', () => {
		expect(sanitizeHtmlForIframe('<div><script>var x = "</script>"; alert(1)</script></div>')).toBe(
			'<div>"; alert(1)</div>'
		);
	});

	it('removes </script > with whitespace before >', () => {
		expect(sanitizeHtmlForIframe('<div><script>evil()</script >text</div>')).toBe(
			'<div>text</div>'
		);
	});

	it('removes </script\\t\\n> with whitespace variants', () => {
		expect(sanitizeHtmlForIframe('<div><script>evil()</script\t\n>text</div>')).toBe(
			'<div>text</div>'
		);
	});
});

// =============================================================================
// Event Handler Removal
// =============================================================================

describe('sanitizeHtmlForIframe — event handler removal', () => {
	it('strips onclick attributes', () => {
		expect(sanitizeHtmlForIframe('<p onclick="alert(1)">Text</p>')).toBe('<p>Text</p>');
	});

	it('strips onerror attributes', () => {
		expect(sanitizeHtmlForIframe('<img onerror="alert(1)" src="x">')).toBe('<img src="x">');
	});

	it('strips onload attributes', () => {
		expect(sanitizeHtmlForIframe('<body onload="init()">Content</body>')).toBe(
			'<body>Content</body>'
		);
	});

	it('strips onmouseover attributes', () => {
		expect(sanitizeHtmlForIframe('<span onmouseover="highlight()">Text</span>')).toBe(
			'<span>Text</span>'
		);
	});

	it('strips event handlers with single quotes', () => {
		expect(sanitizeHtmlForIframe("<p onclick='alert(1)'>Text</p>")).toBe('<p>Text</p>');
	});

	it('strips event handlers with no quotes', () => {
		expect(sanitizeHtmlForIframe('<p onclick=alert(1)>Text</p>')).toBe('<p>Text</p>');
	});

	it('strips event handlers case-insensitively', () => {
		expect(sanitizeHtmlForIframe('<p ONCLICK="alert(1)">Text</p>')).toBe('<p>Text</p>');
		expect(sanitizeHtmlForIframe('<p OnClick="alert(1)">Text</p>')).toBe('<p>Text</p>');
	});

	it('strips multiple event handlers on the same tag', () => {
		expect(sanitizeHtmlForIframe('<div onclick="a()" onmouseover="b()" class="x">Text</div>')).toBe(
			'<div class="x">Text</div>'
		);
	});

	it('strips event handlers on SVG elements', () => {
		expect(sanitizeHtmlForIframe('<svg onload="alert(1)"><circle r="40"/></svg>')).toBe(
			'<svg><circle r="40"/></svg>'
		);
	});

	it('strips event handlers with spaces around equals', () => {
		expect(sanitizeHtmlForIframe('<p onclick = "alert(1)">Text</p>')).toBe('<p>Text</p>');
	});
});

// =============================================================================
// Preserved Elements (NOT stripped)
// =============================================================================

describe('sanitizeHtmlForIframe — preserved elements', () => {
	it('preserves <style> tags and their content', () => {
		const html = '<style>.red { color: red; }</style><p class="red">Styled</p>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves <img> tags', () => {
		const html = '<img src="https://example.com/photo.jpg" alt="Photo">';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves <svg> tags', () => {
		const html = '<svg viewBox="0 0 100 100"><circle r="40"/></svg>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves <iframe> tags (sandbox handles security)', () => {
		const html = '<iframe src="https://example.com"></iframe>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves <link> tags', () => {
		const html = '<link rel="stylesheet" href="styles.css">';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves tables with attributes', () => {
		const html = '<table width="100%" bgcolor="#fff"><tr><td colspan="2">Cell</td></tr></table>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves links with href', () => {
		const html = '<a href="https://example.com" target="_blank">Link</a>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves form elements (sandbox prevents submission)', () => {
		const html = '<form><input type="text"><button>Submit</button></form>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves inline styles', () => {
		const html = '<p style="color: red; font-size: 16px;">Styled text</p>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves HTML comments', () => {
		const html = '<!-- comment --><p>Text</p>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves all standard formatting tags', () => {
		const html =
			'<h1>Title</h1><p><strong>Bold</strong> <em>Italic</em></p>' +
			'<ul><li>Item</li></ul><blockquote>Quote</blockquote>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('sanitizeHtmlForIframe — edge cases', () => {
	it('returns empty string for empty input', () => {
		expect(sanitizeHtmlForIframe('')).toBe('');
	});

	it('returns empty string for null/undefined input', () => {
		expect(sanitizeHtmlForIframe(null as unknown as string)).toBe('');
		expect(sanitizeHtmlForIframe(undefined as unknown as string)).toBe('');
	});

	it('preserves plain text with no HTML', () => {
		expect(sanitizeHtmlForIframe('Just plain text')).toBe('Just plain text');
	});

	it('handles mixed safe and dangerous content', () => {
		const html =
			'<style>.x{color:red}</style>' +
			'<p onclick="bad()">Safe</p>' +
			'<script>evil()</script>' +
			'<img src="photo.jpg">';
		expect(sanitizeHtmlForIframe(html)).toBe(
			'<style>.x{color:red}</style><p>Safe</p><img src="photo.jpg">'
		);
	});

	it('handles complex real-world email HTML', () => {
		const html =
			'<style>body{font-family:Arial;} .header{background:#1a73e8;}</style>' +
			'<div class="header"><img src="logo.png"></div>' +
			'<table width="600"><tr><td><p>Hello!</p></td></tr></table>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves javascript: URIs (sandbox prevents execution)', () => {
		const html = '<a href="javascript:alert(1)">Link</a>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('preserves data: URIs (sandbox prevents dangerous use)', () => {
		const html = '<img src="data:image/png;base64,abc123">';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});

	it('handles orphaned closing script tag with whitespace', () => {
		expect(sanitizeHtmlForIframe('</script  >')).toBe('');
	});

	it('preserves <noscript> tags', () => {
		const html = '<noscript>Fallback</noscript>';
		expect(sanitizeHtmlForIframe(html)).toBe(html);
	});
});
