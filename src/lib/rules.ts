/**
 * @fileoverview Panel Rule Engine for Email Switchboard.
 *
 * Determines which inbox panel a thread belongs to based on configurable
 * regex rules. Each panel has an ordered list of rules that match
 * against the thread's From or To headers.
 *
 * Algorithm:
 *   1. For each panel (in order), evaluate its rules against the thread.
 *   2. A panel's rules are evaluated in order: first matching rule wins.
 *   3. If the first matching rule is "accept", the thread belongs to that panel.
 *   4. If the first matching rule is "reject", skip to the next panel.
 *   5. If no rules match for a panel, skip to the next panel.
 *   6. If no panel claims the thread, it falls into the last panel (catch-all).
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
// Panel Assignment
// =============================================================================

/**
 * Determines which panel a thread belongs to based on panel rules.
 *
 * Evaluates each panel's rules in order. The first panel whose rules
 * "accept" the thread claims it. If no panel claims the thread, it
 * defaults to the last panel (catch-all / "Other").
 *
 * @param panels - Array of panel configurations (typically 4 panels).
 * @param from - The thread's raw From header (e.g., "John Doe <john@example.com>").
 * @param to - The thread's raw To header (e.g., "me@example.com").
 * @returns The zero-based index of the panel this thread belongs to.
 *
 * @example
 * ```typescript
 * const panels: PanelConfig[] = [
 *   { name: 'Work', rules: [{ field: 'from', pattern: '@company\\.com$', action: 'accept' }] },
 *   { name: 'Social', rules: [{ field: 'from', pattern: '@(facebook|twitter)\\.com$', action: 'accept' }] },
 *   { name: 'Newsletters', rules: [{ field: 'from', pattern: 'newsletter|digest', action: 'accept' }] },
 *   { name: 'Other', rules: [] }
 * ];
 *
 * assignPanel(panels, 'Boss <boss@company.com>', 'me@gmail.com'); // → 0 (Work)
 * assignPanel(panels, 'info@twitter.com', 'me@gmail.com');         // → 1 (Social)
 * assignPanel(panels, 'random@unknown.com', 'me@gmail.com');       // → 3 (Other)
 * ```
 */
export function assignPanel(panels: PanelConfig[], from: string, to: string): number {
	if (panels.length === 0) return 0;

	for (let i = 0; i < panels.length; i++) {
		const panel = panels[i];

		/* A panel with no rules never claims threads (except as catch-all). */
		if (panel.rules.length === 0) continue;

		/* Evaluate rules in order: first match wins. */
		for (const rule of panel.rules) {
			if (matchesRule(rule, from, to)) {
				if (rule.action === 'accept') {
					return i;
				}
				/* action === 'reject': this panel explicitly rejected → skip to next panel. */
				break;
			}
		}
	}

	/* No panel claimed the thread → fall through to the last panel (catch-all). */
	return panels.length - 1;
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
