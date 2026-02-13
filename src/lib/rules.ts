/**
 * @fileoverview Panel Rule Engine for Email Switchboard.
 *
 * Determines which panels a thread belongs to based on configurable
 * address-list rules. Each panel has an ordered list of rules that match
 * against the thread's From or To headers using case-insensitive
 * substring matching on email addresses or domain suffixes.
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
 * Uses case-insensitive substring matching: each address in the rule's
 * `addresses` array is checked against the appropriate header field.
 * If any address matches (via `includes()`), the rule matches.
 *
 * @param rule - The panel rule to test.
 * @param from - The thread's raw From header value.
 * @param to - The thread's raw To header value.
 * @returns True if any address in the rule matches the target field.
 *
 * @example
 * ```typescript
 * const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
 * matchesRule(rule, 'Boss <boss@company.com>', 'me@gmail.com'); // → true
 * matchesRule(rule, 'random@other.com', 'me@gmail.com');        // → false
 * ```
 */
export function matchesRule(rule: PanelRule, from: string, to: string): boolean {
	const target = (rule.field === 'from' ? from : to).toLowerCase();
	return rule.addresses.some((addr) => {
		const normalized = addr.toLowerCase();
		return normalized !== '' && target.includes(normalized);
	});
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
 * This function is used to check each panel independently — allowing
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
 *   rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
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
// Gmail Query Conversion (for Panel Count Estimates)
// =============================================================================

/**
 * Converts a panel's rules to a Gmail search query for count estimation.
 *
 * Each address in accept rules becomes a `from:(addr)` or `to:(addr)` term.
 * Multiple accept terms are OR'd together using Gmail's `{}` syntax:
 *   `{from:(@company.com) from:(@partner.com)}`
 *
 * Reject rules are negated:
 *   `-from:(noreply@company.com)`
 *
 * Panels with no rules return an empty string — the caller uses
 * `getInboxLabelCounts()` for exact counts on those panels instead.
 *
 * @param panel - The panel configuration.
 * @returns Gmail search query string, or empty string if no query can
 *   be constructed (i.e., panel has no rules or all addresses are empty).
 *
 * @example
 * ```typescript
 * const panel: PanelConfig = {
 *   name: 'Work',
 *   rules: [{ field: 'from', addresses: ['@company.com', '@partner.org'], action: 'accept' }]
 * };
 * panelRulesToGmailQuery(panel);
 * // → '{from:(@company.com) from:(@partner.org)}'
 * ```
 */
export function panelRulesToGmailQuery(panel: PanelConfig): string {
	if (panel.rules.length === 0) return '';

	const acceptParts: string[] = [];
	const rejectParts: string[] = [];

	for (const rule of panel.rules) {
		const field = rule.field; /* 'from' or 'to' */
		for (const addr of rule.addresses) {
			if (!addr.trim()) continue;
			const term = `${field}:(${addr.trim()})`;
			if (rule.action === 'accept') {
				acceptParts.push(term);
			} else {
				rejectParts.push(`-${term}`);
			}
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
