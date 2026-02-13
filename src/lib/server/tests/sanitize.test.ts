/**
 * @fileoverview Unit tests for the email HTML sanitizer.
 *
 * Tests cover:
 *   - Script tag removal (inline, with attributes, self-closing, nested)
 *   - Dangerous embed tag removal (iframe, object, embed, applet, noscript)
 *   - Structural/meta tag removal (link, meta, base)
 *   - Form element stripping (tag removed, children preserved)
 *   - SVG foreignObject stripping
 *   - Event handler stripping (onclick, onerror, onload, onmouseover, etc.)
 *   - Dangerous URI sanitization (javascript:, vbscript:, data:)
 *   - Link safety attributes (target="_blank", rel="noopener noreferrer")
 *   - Preservation of visual elements (style, img, svg, tables, inline styles)
 *   - Edge cases (empty input, plain text, malformed HTML)
 *   - Regex edge cases: > inside quoted attribute values (security-critical)
 *   - srcset dangerous URI sanitization
 */

import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from '../sanitize.js';

// =============================================================================
// Script Tag Removal
// =============================================================================

describe('sanitizeEmailHtml — script tag removal', () => {
	it('removes <script> tags and their content', () => {
		expect(sanitizeEmailHtml('<p>Hello</p><script>alert("xss")</script><p>World</p>')).toBe(
			'<p>Hello</p><p>World</p>'
		);
	});

	it('removes <script> tags with attributes', () => {
		expect(sanitizeEmailHtml('<script type="text/javascript" src="evil.js"></script>')).toBe('');
	});

	it('removes self-closing <script> tags', () => {
		expect(sanitizeEmailHtml('<script/>')).toBe('');
		expect(sanitizeEmailHtml('<script src="evil.js"/>')).toBe('');
	});

	it('removes multiple <script> tags', () => {
		expect(sanitizeEmailHtml('<script>a()</script><p>OK</p><script>b()</script>')).toBe(
			'<p>OK</p>'
		);
	});

	it('removes <script> tags case-insensitively', () => {
		expect(sanitizeEmailHtml('<SCRIPT>alert(1)</SCRIPT>')).toBe('');
		expect(sanitizeEmailHtml('<Script>alert(1)</Script>')).toBe('');
	});

	it('handles </script> appearing inside a JS string literal', () => {
		expect(sanitizeEmailHtml('<div><script>var x = "</script>"; alert(1)</script></div>')).toBe(
			'<div>"; alert(1)</div>'
		);
	});

	it('removes </script > with whitespace before >', () => {
		expect(sanitizeEmailHtml('<div><script>evil()</script >text</div>')).toBe('<div>text</div>');
	});

	it('removes </script\\t\\n> with whitespace variants', () => {
		expect(sanitizeEmailHtml('<div><script>evil()</script\t\n>text</div>')).toBe('<div>text</div>');
	});
});

// =============================================================================
// Dangerous Embed Tag Removal
// =============================================================================

describe('sanitizeEmailHtml — dangerous embed tag removal', () => {
	it('strips <iframe> tags and their content', () => {
		expect(sanitizeEmailHtml('<iframe src="https://evil.com">inner</iframe>')).toBe('');
	});

	it('strips <object> tags and their content', () => {
		expect(
			sanitizeEmailHtml('<object data="evil.swf" type="application/x-shockwave-flash"></object>')
		).toBe('');
	});

	it('strips <embed> tags and their content', () => {
		expect(sanitizeEmailHtml('<embed src="evil.swf" type="application/x-shockwave-flash">')).toBe(
			''
		);
	});

	it('strips <applet> tags and their content', () => {
		expect(sanitizeEmailHtml('<applet code="Evil.class">Loading...</applet>')).toBe('');
	});

	it('strips <noscript> tags and their content', () => {
		expect(sanitizeEmailHtml('<noscript>Fallback content</noscript>')).toBe('');
	});

	it('strips dangerous tags case-insensitively', () => {
		expect(sanitizeEmailHtml('<IFRAME src="x"></IFRAME>')).toBe('');
		expect(sanitizeEmailHtml('<Object data="y"></Object>')).toBe('');
	});

	it('preserves surrounding content when stripping dangerous tags', () => {
		expect(sanitizeEmailHtml('<p>Before</p><iframe src="x">inner</iframe><p>After</p>')).toBe(
			'<p>Before</p><p>After</p>'
		);
	});
});

// =============================================================================
// Structural/Meta Tag Removal
// =============================================================================

describe('sanitizeEmailHtml — structural/meta tag removal', () => {
	it('strips <link> tags', () => {
		expect(sanitizeEmailHtml('<link rel="stylesheet" href="styles.css">')).toBe('');
	});

	it('strips <meta> tags', () => {
		expect(sanitizeEmailHtml('<meta http-equiv="refresh" content="0;url=evil.com">')).toBe('');
	});

	it('strips <base> tags', () => {
		expect(sanitizeEmailHtml('<base href="https://evil.com/">')).toBe('');
	});

	it('preserves surrounding content when stripping structural tags', () => {
		const html = '<link rel="stylesheet" href="x"><p>Content</p><meta charset="utf-8">';
		expect(sanitizeEmailHtml(html)).toBe('<p>Content</p>');
	});
});

// =============================================================================
// Form Element Stripping (tag removed, children preserved)
// =============================================================================

describe('sanitizeEmailHtml — form element stripping', () => {
	it('strips <form> tags but keeps child content', () => {
		expect(sanitizeEmailHtml('<form action="/steal"><p>Enter info:</p></form>')).toBe(
			'<p>Enter info:</p>'
		);
	});

	it('strips <input> tags', () => {
		expect(sanitizeEmailHtml('<input type="text" value="hidden">')).toBe('');
	});

	it('strips <button> tags but keeps child text', () => {
		expect(sanitizeEmailHtml('<button type="submit">Click me</button>')).toBe('Click me');
	});

	it('strips <select>, <option>, and <textarea> tags but keeps child content', () => {
		expect(sanitizeEmailHtml('<select><option>A</option></select>')).toBe('A');
		expect(sanitizeEmailHtml('<textarea>User text</textarea>')).toBe('User text');
	});

	it('strips <optgroup> and <option> tags but keeps child content', () => {
		expect(
			sanitizeEmailHtml(
				'<select><optgroup label="Group"><option>A</option><option>B</option></optgroup></select>'
			)
		).toBe('AB');
	});

	it('strips nested form elements', () => {
		const html = '<form><input type="email"><button>Submit</button>Text</form>';
		expect(sanitizeEmailHtml(html)).toBe('SubmitText');
	});
});

// =============================================================================
// SVG foreignObject Stripping
// =============================================================================

describe('sanitizeEmailHtml — SVG foreignObject stripping', () => {
	it('strips <foreignObject> and its content from SVGs', () => {
		const html = '<svg><foreignObject><div>Dangerous</div></foreignObject><circle r="40"/></svg>';
		expect(sanitizeEmailHtml(html)).toBe('<svg><circle r="40"/></svg>');
	});

	it('handles case-insensitive foreignObject', () => {
		const html = '<svg><FOREIGNOBJECT><p>Bad</p></FOREIGNOBJECT></svg>';
		expect(sanitizeEmailHtml(html)).toBe('<svg></svg>');
	});
});

// =============================================================================
// Event Handler Removal
// =============================================================================

describe('sanitizeEmailHtml — event handler removal', () => {
	it('strips onclick attributes', () => {
		expect(sanitizeEmailHtml('<p onclick="alert(1)">Text</p>')).toBe('<p>Text</p>');
	});

	it('strips onerror attributes', () => {
		expect(sanitizeEmailHtml('<img onerror="alert(1)" src="x">')).toBe('<img src="x">');
	});

	it('strips onload attributes', () => {
		expect(sanitizeEmailHtml('<body onload="init()">Content</body>')).toBe('<body>Content</body>');
	});

	it('strips onmouseover attributes', () => {
		expect(sanitizeEmailHtml('<span onmouseover="highlight()">Text</span>')).toBe(
			'<span>Text</span>'
		);
	});

	it('strips event handlers with single quotes', () => {
		expect(sanitizeEmailHtml("<p onclick='alert(1)'>Text</p>")).toBe('<p>Text</p>');
	});

	it('strips event handlers with no quotes', () => {
		expect(sanitizeEmailHtml('<p onclick=alert(1)>Text</p>')).toBe('<p>Text</p>');
	});

	it('strips event handlers case-insensitively', () => {
		expect(sanitizeEmailHtml('<p ONCLICK="alert(1)">Text</p>')).toBe('<p>Text</p>');
		expect(sanitizeEmailHtml('<p OnClick="alert(1)">Text</p>')).toBe('<p>Text</p>');
	});

	it('strips multiple event handlers on the same tag', () => {
		expect(sanitizeEmailHtml('<div onclick="a()" onmouseover="b()" class="x">Text</div>')).toBe(
			'<div class="x">Text</div>'
		);
	});

	it('strips event handlers on SVG elements', () => {
		expect(sanitizeEmailHtml('<svg onload="alert(1)"><circle r="40"/></svg>')).toBe(
			'<svg><circle r="40"/></svg>'
		);
	});

	it('strips event handlers with spaces around equals', () => {
		expect(sanitizeEmailHtml('<p onclick = "alert(1)">Text</p>')).toBe('<p>Text</p>');
	});
});

// =============================================================================
// Dangerous URI Sanitization
// =============================================================================

describe('sanitizeEmailHtml — dangerous URI sanitization', () => {
	it('strips javascript: URIs from href', () => {
		const result = sanitizeEmailHtml('<a href="javascript:alert(1)">Link</a>');
		/* Verify the dangerous href attribute is completely removed. */
		expect(result).not.toMatch(/href\s*=/i);
		expect(result).toContain('>Link</a>');
	});

	it('strips vbscript: URIs from href', () => {
		const result = sanitizeEmailHtml('<a href="vbscript:MsgBox(1)">Link</a>');
		expect(result).not.toMatch(/href\s*=/i);
	});

	it('strips data:text/html URIs from href', () => {
		const result = sanitizeEmailHtml('<a href="data:text/html,<script>alert(1)</script>">Link</a>');
		expect(result).not.toMatch(/href\s*=\s*"data:text\/html/i);
	});

	it('preserves data:image/ URIs in src attributes', () => {
		const html = '<img src="data:image/png;base64,abc123">';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('strips data:image/ URIs from href (only allowed in src)', () => {
		const result = sanitizeEmailHtml('<a href="data:image/png;base64,abc123">Link</a>');
		expect(result).not.toMatch(/href\s*=\s*"data:/i);
	});

	it('strips javascript: URIs from src', () => {
		const result = sanitizeEmailHtml('<img src="javascript:alert(1)">');
		expect(result).not.toMatch(/src\s*=\s*"javascript:/i);
	});

	it('handles whitespace tricks in javascript: URIs', () => {
		const result = sanitizeEmailHtml('<a href="java\nscript:alert(1)">Link</a>');
		/* After whitespace stripping and normalization, the href should be removed. */
		expect(result).not.toMatch(/href\s*=/i);
	});

	it('handles HTML entity encoding tricks', () => {
		/* &#106; = 'j' — tries to spell "javascript:" with entities. */
		const result = sanitizeEmailHtml('<a href="&#106;avascript:alert(1)">Link</a>');
		/* After entity decoding, the URI resolves to "javascript:" and should be stripped. */
		expect(result).not.toMatch(/href\s*=/i);
	});

	it('handles hex entity encoding tricks', () => {
		/* &#x6A; = 'j' — hex variant of the same trick. */
		const result = sanitizeEmailHtml('<a href="&#x6A;avascript:alert(1)">Link</a>');
		expect(result).not.toMatch(/href\s*=/i);
	});

	it('preserves safe https: URIs', () => {
		const html = '<a href="https://example.com">Link</a>';
		const result = sanitizeEmailHtml(html);
		expect(result).toContain('href="https://example.com"');
	});

	it('preserves safe mailto: URIs', () => {
		const html = '<a href="mailto:user@example.com">Email</a>';
		const result = sanitizeEmailHtml(html);
		expect(result).toContain('href="mailto:user@example.com"');
	});

	it('strips dangerous URIs from xlink:href', () => {
		const result = sanitizeEmailHtml('<use xlink:href="javascript:alert(1)"/>');
		expect(result).not.toMatch(/xlink:href\s*=/i);
	});

	it('strips dangerous URIs from formaction', () => {
		/* Note: form tags are stripped but the attribute test validates the URI pass runs. */
		const result = sanitizeEmailHtml('<div formaction="javascript:alert(1)">X</div>');
		expect(result).not.toMatch(/formaction\s*=/i);
	});

	it('strips mixed-case jAvAsCrIpT: URIs', () => {
		const result = sanitizeEmailHtml('<a href="jAvAsCrIpT:alert(1)">Link</a>');
		expect(result).not.toMatch(/href\s*=/i);
	});

	it('preserves safe http: URIs (not just https)', () => {
		const html = '<a href="http://example.com">Link</a>';
		const result = sanitizeEmailHtml(html);
		expect(result).toContain('href="http://example.com"');
	});

	it('strips data: URIs that are not data:image/ from src', () => {
		const result = sanitizeEmailHtml('<img src="data:text/html,<script>alert(1)</script>">');
		expect(result).not.toMatch(/src\s*=\s*"data:text/i);
	});

	it('strips java&tab;script: URI obfuscation via &tab; entity', () => {
		const input = '<a href="java\tscript:alert(1)">click</a>';
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('javascript:');
		expect(result).not.toContain('alert(1)');
	});

	it('strips java&newline;script: URI obfuscation via newline entity', () => {
		const input = '<a href="java\nscript:alert(1)">click</a>';
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('javascript:');
		expect(result).not.toContain('alert(1)');
	});

	it('strips javascript: in single-quoted href attribute', () => {
		const input = "<a href='javascript:alert(1)'>click</a>";
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('javascript:');
		expect(result).not.toContain('alert(1)');
	});

	it('strips javascript: in unquoted href attribute', () => {
		const input = '<a href=javascript:alert(1)>click</a>';
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('javascript:');
		expect(result).not.toContain('alert(1)');
	});

	it('strips javascript: in poster attribute', () => {
		// video tags may survive if not in the strip list
		const input = '<img poster="javascript:alert(1)" src="safe.jpg">';
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('javascript:');
	});

	it('strips null bytes in URI scheme (\\0 obfuscation)', () => {
		const input = '<a href="java\0script:alert(1)">click</a>';
		const result = sanitizeEmailHtml(input);
		expect(result).not.toContain('alert(1)');
	});
});

// =============================================================================
// Link Safety Attributes
// =============================================================================

describe('sanitizeEmailHtml — link safety attributes', () => {
	it('adds target="_blank" and rel="noopener noreferrer" to <a> tags', () => {
		const result = sanitizeEmailHtml('<a href="https://example.com">Link</a>');
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('replaces existing target attribute', () => {
		const result = sanitizeEmailHtml('<a href="https://example.com" target="_self">Link</a>');
		expect(result).toContain('target="_blank"');
		expect(result).not.toContain('_self');
	});

	it('replaces existing rel attribute', () => {
		const result = sanitizeEmailHtml('<a href="https://example.com" rel="nofollow">Link</a>');
		expect(result).toContain('rel="noopener noreferrer"');
		expect(result).not.toContain('nofollow');
	});

	it('handles <a> tags with no existing attributes', () => {
		const result = sanitizeEmailHtml('<a>Text</a>');
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('preserves href and other attributes while adding safety attrs', () => {
		const result = sanitizeEmailHtml('<a href="https://example.com" class="link">Link</a>');
		expect(result).toContain('href="https://example.com"');
		expect(result).toContain('class="link"');
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('replaces single-quoted target and rel attributes on links', () => {
		const input = "<a href='https://example.com' target='_self' rel='nofollow'>link</a>";
		const result = sanitizeEmailHtml(input);
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('handles unquoted target attribute on links', () => {
		const input = '<a href="https://example.com" target=_self>link</a>';
		const result = sanitizeEmailHtml(input);
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});
});

// =============================================================================
// Preserved Elements (NOT stripped)
// =============================================================================

describe('sanitizeEmailHtml — preserved elements', () => {
	it('preserves <style> tags and their content', () => {
		const html = '<style>.red { color: red; }</style><p class="red">Styled</p>';
		const result = sanitizeEmailHtml(html);
		expect(result).toContain('<style>.red { color: red; }</style>');
		expect(result).toContain('<p class="red">Styled</p>');
	});

	it('preserves <img> tags', () => {
		const html = '<img src="https://example.com/photo.jpg" alt="Photo">';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('preserves <svg> tags (minus foreignObject)', () => {
		const html = '<svg viewBox="0 0 100 100"><circle r="40"/></svg>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('preserves tables with attributes', () => {
		const html = '<table width="100%" bgcolor="#fff"><tr><td colspan="2">Cell</td></tr></table>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('preserves inline styles', () => {
		const html = '<p style="color: red; font-size: 16px;">Styled text</p>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('preserves HTML comments', () => {
		const html = '<!-- comment --><p>Text</p>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('preserves all standard formatting tags', () => {
		const html =
			'<h1>Title</h1><p><strong>Bold</strong> <em>Italic</em></p>' +
			'<ul><li>Item</li></ul><blockquote>Quote</blockquote>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('sanitizeEmailHtml — edge cases', () => {
	it('returns empty string for empty input', () => {
		expect(sanitizeEmailHtml('')).toBe('');
	});

	it('returns empty string for null/undefined input', () => {
		expect(sanitizeEmailHtml(null as unknown as string)).toBe('');
		expect(sanitizeEmailHtml(undefined as unknown as string)).toBe('');
	});

	it('preserves plain text with no HTML', () => {
		expect(sanitizeEmailHtml('Just plain text')).toBe('Just plain text');
	});

	it('handles mixed safe and dangerous content', () => {
		const html =
			'<style>.x{color:red}</style>' +
			'<p onclick="bad()">Safe</p>' +
			'<script>evil()</script>' +
			'<img src="photo.jpg">';
		expect(sanitizeEmailHtml(html)).toBe(
			'<style>.x{color:red}</style><p>Safe</p><img src="photo.jpg">'
		);
	});

	it('handles complex real-world email HTML', () => {
		const html =
			'<style>body{font-family:Arial;} .header{background:#1a73e8;}</style>' +
			'<div class="header"><img src="logo.png"></div>' +
			'<table width="600"><tr><td><p>Hello!</p></td></tr></table>';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});

	it('handles orphaned closing script tag with whitespace', () => {
		expect(sanitizeEmailHtml('</script  >')).toBe('');
	});

	it('handles nested dangerous tags', () => {
		const html = '<iframe><script>alert(1)</script></iframe>';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('handles multiple dangerous tag types mixed with safe content', () => {
		const html =
			'<p>Safe</p>' +
			'<iframe src="x">Bad</iframe>' +
			'<object data="y">Bad</object>' +
			'<p>Also safe</p>';
		expect(sanitizeEmailHtml(html)).toBe('<p>Safe</p><p>Also safe</p>');
	});

	it('strips data: URIs from non-src attributes but preserves data:image in src', () => {
		const html =
			'<img src="data:image/gif;base64,R0lGOD">' +
			'<a href="data:text/html,<script>alert(1)</script>">bad</a>';
		const result = sanitizeEmailHtml(html);
		expect(result).toContain('data:image/gif;base64,R0lGOD');
		expect(result).not.toContain('data:text/html');
	});
});

// =============================================================================
// Regex Edge Cases: > Inside Quoted Attribute Values
// =============================================================================

describe('sanitizeEmailHtml — > inside quoted attributes', () => {
	it('strips <script> with > inside double-quoted attribute value', () => {
		const html = '<script data-x="a > b">alert(1)</script>';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('strips <script> with > inside single-quoted attribute value', () => {
		const html = "<script data-x='a > b'>evil()</script>";
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('strips <iframe> with > inside quoted attribute value', () => {
		const html = '<iframe title="a > b" src="https://evil.com">inner</iframe>';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('strips <object> with > inside quoted attribute value', () => {
		const html = '<object data="evil.swf" title="x > y"></object>';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('adds link safety to <a> with > inside quoted attribute value', () => {
		const result = sanitizeEmailHtml('<a title="a > b" href="https://x.com">Link</a>');
		expect(result).toContain('title="a > b"');
		expect(result).toContain('href="https://x.com"');
		expect(result).toContain('target="_blank"');
		expect(result).toContain('rel="noopener noreferrer"');
	});

	it('strips <form> with > inside quoted attribute, keeps children', () => {
		const html = '<form data-x="a > b"><p>Text</p></form>';
		expect(sanitizeEmailHtml(html)).toBe('<p>Text</p>');
	});

	it('strips <input> with > inside quoted attribute', () => {
		const html = '<input type="text" placeholder="age > 18">';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('handles multiple > characters inside quoted attribute values', () => {
		const html = '<script data-expr="a > b && c > d">evil()</script>';
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('handles > in both single and double quotes on the same tag', () => {
		const html = `<script data-a="x > y" data-b='m > n'>evil()</script>`;
		expect(sanitizeEmailHtml(html)).toBe('');
	});

	it('strips dangerous URI from <a> with > in title (attribute preserved)', () => {
		const result = sanitizeEmailHtml('<a title="a > b" href="javascript:alert(1)">Link</a>');
		expect(result).toContain('title="a > b"');
		expect(result).not.toContain('javascript:');
		expect(result).toContain('target="_blank"');
	});
});

// =============================================================================
// srcset Dangerous URI Sanitization
// =============================================================================

describe('sanitizeEmailHtml — srcset URI sanitization', () => {
	it('strips javascript: URI from srcset', () => {
		const result = sanitizeEmailHtml('<img srcset="javascript:alert(1) 1x">');
		expect(result).not.toMatch(/srcset\s*=\s*"javascript:/i);
	});

	it('strips data: URI from srcset (non-image)', () => {
		const result = sanitizeEmailHtml('<img srcset="data:text/html,evil 1x">');
		expect(result).not.toMatch(/srcset\s*=\s*"data:text/i);
	});

	it('preserves safe https: srcset', () => {
		const html = '<img srcset="https://example.com/img.jpg 1x, https://example.com/img2.jpg 2x">';
		expect(sanitizeEmailHtml(html)).toBe(html);
	});
});
