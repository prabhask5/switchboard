/**
 * @fileoverview Panel Rule Engine for Email Switchboard.
 *
 * Determines which panels a thread belongs to based on configurable
 * regex rules. Each panel has an ordered list of rules that match
 * against the thread's From or To headers.
 *
 * Key model: threads can appear in **multiple** panels simultaneously.
 * A no-rules panel matches ALL threads (inbox-wide view). Operations
 * on a thread in one panel (trash, mark read) carry over to all copies
 * because the underlying thread data is shared.
 *
 * Per-panel matching algorithm (`threadMatchesPanel`):
 *   1. If the panel has no rules → matches ALL threads.
 *   2. Evaluate rules in order: first matching rule wins.
 *   3. If the first matching rule is "accept" → thread belongs to panel.
 *   4. If the first matching rule is "reject" → thread does NOT belong.
 *   5. If no rules match → thread does NOT belong.
 *
 * This is a pure function module with no side effects, making it easy
 * to test and usable on both server and client.
 */

import type { PanelConfig, PanelRule } from './types.js';

// =============================================================================
// Rule Matching
// =============================================================================

/**
 * Tests whether a single rule matches the given from/to values.
 *
 * Creates a case-insensitive regex from the rule's pattern string and
 * tests it against the appropriate header field.
 *
 * Invalid regex patterns are treated as non-matching (with a console
 * warning) rather than throwing, so a single bad rule doesn't break
 * the entire inbox.
 *
 * @param rule - The panel rule to test.
 * @param from - The thread's raw From header value.
 * @param to - The thread's raw To header value.
 * @returns True if the rule's regex pattern matches the target field.
 */
export function matchesRule(rule: PanelRule, from: string, to: string): boolean {
	const target = rule.field === 'from' ? from : to;
	try {
		const regex = new RegExp(rule.pattern, 'i');
		return regex.test(target);
	} catch {
		/*
		 * If the user's regex is invalid, treat it as non-matching.
		 * This prevents a bad pattern from breaking the entire rule engine.
		 * The UI should validate patterns before saving, but we handle
		 * invalid patterns gracefully here as a safety net.
		 */
		console.warn(`[rules] Invalid regex pattern: "${rule.pattern}"`);
		return false;
	}
}

// =============================================================================
// Per-Panel Matching
// =============================================================================

/**
 * Tests whether a thread matches a specific panel's rules.
 *
 * - Panel with no rules → matches ALL threads (inbox-wide panel).
 * - Panel with rules → evaluates rules in order, first match wins.
 *   If the first matching rule is "accept", returns true.
 *   If "reject" or no rules match, returns false.
 *
 * Unlike `assignPanel` (which returns the first matching panel index),
 * this function is used to check each panel independently — allowing
 * a single thread to appear in multiple panels.
 *
 * @param panel - The panel configuration to test against.
 * @param from - The thread's raw From header (e.g., "John Doe <john@example.com>").
 * @param to - The thread's raw To header (e.g., "me@example.com").
 * @returns True if the thread belongs in this panel.
 *
 * @example
 * ```typescript
 * const panel: PanelConfig = {
 *   name: 'Work',
 *   rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
 * };
 * threadMatchesPanel(panel, 'boss@company.com', 'me@gmail.com'); // → true
 * threadMatchesPanel(panel, 'random@other.com', 'me@gmail.com'); // → false
 *
 * const noRulesPanel: PanelConfig = { name: 'All', rules: [] };
 * threadMatchesPanel(noRulesPanel, 'anyone@anywhere.com', '');   // → true
 * ```
 */
export function threadMatchesPanel(panel: PanelConfig, from: string, to: string): boolean {
	/* No rules → inbox-wide panel that shows everything. */
	if (panel.rules.length === 0) return true;

	/* Evaluate rules in order: first match wins. */
	for (const rule of panel.rules) {
		if (matchesRule(rule, from, to)) {
			return rule.action === 'accept';
		}
	}

	/* No rules matched → thread doesn't belong in this panel. */
	return false;
}

// =============================================================================
// Panel Assignment (Legacy)
// =============================================================================

/**
 * Determines which panel a thread belongs to based on panel rules.
 *
 * Returns the index of the first panel whose rules accept the thread.
 * Returns -1 when no panel matches. This function is preserved for
 * backward compatibility but the frontend uses `threadMatchesPanel()`
 * directly to allow threads in multiple panels.
 *
 * @param panels - Array of panel configurations (typically 4 panels).
 * @param from - The thread's raw From header (e.g., "John Doe <john@example.com>").
 * @param to - The thread's raw To header (e.g., "me@example.com").
 * @returns The zero-based index of the first matching panel, or -1 if none match.
 *
 * @example
 * ```typescript
 * const panels: PanelConfig[] = [
 *   { name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com$', action: 'accept' }] },
 *   { name: 'Social', rules: [{ field: 'from', pattern: '@(facebook|twitter)\\.com$', action: 'accept' }] },
 *   { name: 'Other', rules: [] }
 * ];
 *
 * assignPanel(panels, 'Boss <boss@company.com>', 'me@gmail.com'); // → 0 (Work)
 * assignPanel(panels, 'info@twitter.com', 'me@gmail.com');         // → 1 (Social)
 * assignPanel(panels, 'random@unknown.com', 'me@gmail.com');       // → 2 (Other — no rules = matches all)
 * ```
 */
export function assignPanel(panels: PanelConfig[], from: string, to: string): number {
	if (panels.length === 0) return -1;

	for (let i = 0; i < panels.length; i++) {
		if (threadMatchesPanel(panels[i], from, to)) return i;
	}

	return -1;
}

// =============================================================================
// Gmail Query Conversion (for Panel Count Estimates)
// =============================================================================

/**
 * Strips regex metacharacters from a term, keeping only literal text.
 *
 * Converts escaped characters to their literal form (`\.` → `.`) and
 * removes quantifiers, character classes, and other regex syntax that
 * has no equivalent in Gmail search.
 *
 * @param s - A raw regex fragment to clean.
 * @returns A simplified literal string suitable for Gmail search.
 */
function cleanRegexTerm(s: string): string {
	return s
		.replace(/\\(.)/g, '$1') /* Unescape: \. → . */
		.replace(/[*+?{}[\]]/g, '') /* Remove quantifiers/character classes */
		.trim();
}

/**
 * Converts a regex pattern string to an array of Gmail search terms.
 *
 * Handles common regex patterns used in panel rules:
 * - `@company\.com` → `['@company.com']`
 * - `@(twitter|facebook)\.com` → `['@twitter.com', '@facebook.com']`
 * - `newsletter|digest` → `['newsletter', 'digest']`
 *
 * Limitations: Complex regex features (lookahead, backreferences, character
 * classes, quantifiers) are stripped. This produces approximate matches
 * suitable for count estimation, not exact filtering.
 *
 * @param pattern - Regex pattern from a panel rule.
 * @returns Array of simplified search terms.
 */
export function regexToGmailTerms(pattern: string): string[] {
	let clean = pattern.replace(/[\^$]/g, ''); /* Remove anchors */

	/* Handle (a|b) groups: expand with surrounding text. */
	const groupMatch = clean.match(/\(([^)]+)\)/);
	if (groupMatch && groupMatch.index !== undefined) {
		const prefix = clean.slice(0, groupMatch.index);
		const suffix = clean.slice(groupMatch.index + groupMatch[0].length);
		const alts = groupMatch[1].split('|');
		return alts.map((alt) => cleanRegexTerm(prefix + alt + suffix));
	}

	/* Handle top-level | as OR alternatives. */
	if (clean.includes('|')) {
		return clean.split('|').map(cleanRegexTerm);
	}

	return [cleanRegexTerm(clean)];
}

/**
 * Converts a panel's rules to a Gmail search query for count estimation.
 *
 * Accept rules are OR'd together using Gmail's `{}` syntax:
 *   `{from:(@company.com) from:(@partner.com)}`
 *
 * Reject rules are negated:
 *   `-from:(noreply@)`
 *
 * Panels with no rules return an empty string — the caller uses
 * `getInboxLabelCounts()` for exact counts on those panels instead.
 *
 * @param panel - The panel configuration.
 * @returns Gmail search query string, or empty string if no query can
 *   be constructed (i.e., panel has no rules).
 */
export function panelRulesToGmailQuery(panel: PanelConfig): string {
	if (panel.rules.length === 0) return '';

	const acceptParts: string[] = [];
	const rejectParts: string[] = [];

	for (const rule of panel.rules) {
		const field = rule.field; /* 'from' or 'to' */
		const terms = regexToGmailTerms(rule.pattern);
		const termQueries = terms.map((t) => `${field}:(${t})`);

		if (rule.action === 'accept') {
			acceptParts.push(...termQueries);
		} else {
			rejectParts.push(...termQueries.map((tq) => `-${tq}`));
		}
	}

	const parts: string[] = [];
	if (acceptParts.length > 0) {
		/* Single term doesn't need {} wrapping; multiple terms use {} for OR. */
		parts.push(acceptParts.length === 1 ? acceptParts[0] : `{${acceptParts.join(' ')}}`);
	}
	if (rejectParts.length > 0) {
		parts.push(...rejectParts);
	}

	return parts.join(' ');
}

// =============================================================================
// Default Panel Configuration
// =============================================================================

/**
 * Returns the default panel configuration for new users.
 *
 * Four empty panels — all threads fall into "Other" (the last panel)
 * until the user configures their own rules.
 *
 * @returns Array of 4 default panel configurations.
 */
export function getDefaultPanels(): PanelConfig[] {
	return [
		{ name: 'Primary', rules: [] },
		{ name: 'Social', rules: [] },
		{ name: 'Updates', rules: [] },
		{ name: 'Other', rules: [] }
	];
}
