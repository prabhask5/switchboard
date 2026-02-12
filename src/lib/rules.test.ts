/**
 * @fileoverview Unit tests for the panel rule engine.
 *
 * Tests cover:
 *   - matchesRule: individual rule matching against from/to headers
 *   - assignPanel: full panel assignment with multiple panels and rules
 *   - Edge cases: empty panels, invalid regex, reject rules, catch-all behavior
 *   - getDefaultPanels: returns valid default configuration
 */

import { describe, it, expect, vi } from 'vitest';
import { matchesRule, assignPanel, getDefaultPanels } from './rules.js';
import type { PanelConfig, PanelRule } from './types.js';

// =============================================================================
// matchesRule
// =============================================================================

describe('matchesRule', () => {
	it('matches a "from" field rule against the from header', () => {
		/* Pattern without $ anchor to match within angle brackets (e.g., "Boss <boss@company.com>"). */
		const rule: PanelRule = { field: 'from', pattern: '@company\\.com', action: 'accept' };
		expect(matchesRule(rule, 'Boss <boss@company.com>', 'me@gmail.com')).toBe(true);
	});

	it('does not match a "from" rule against the to header', () => {
		const rule: PanelRule = { field: 'from', pattern: '@company\\.com', action: 'accept' };
		expect(matchesRule(rule, 'random@other.com', 'me@company.com')).toBe(false);
	});

	it('matches a "to" field rule against the to header', () => {
		const rule: PanelRule = { field: 'to', pattern: 'team@company\\.com', action: 'accept' };
		expect(matchesRule(rule, 'someone@example.com', 'team@company.com')).toBe(true);
	});

	it('is case-insensitive', () => {
		const rule: PanelRule = { field: 'from', pattern: 'newsletter', action: 'accept' };
		expect(matchesRule(rule, 'NEWSLETTER@example.com', '')).toBe(true);
		expect(matchesRule(rule, 'Monthly Newsletter <news@ex.com>', '')).toBe(true);
	});

	it('supports complex regex patterns', () => {
		const rule: PanelRule = {
			field: 'from',
			pattern: '@(facebook|twitter|instagram)\\.com$',
			action: 'accept'
		};
		expect(matchesRule(rule, 'noreply@facebook.com', '')).toBe(true);
		expect(matchesRule(rule, 'alerts@twitter.com', '')).toBe(true);
		expect(matchesRule(rule, 'notifications@instagram.com', '')).toBe(true);
		expect(matchesRule(rule, 'user@gmail.com', '')).toBe(false);
	});

	it('returns false for an invalid regex pattern', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const rule: PanelRule = { field: 'from', pattern: '[invalid(regex', action: 'accept' };
		expect(matchesRule(rule, 'anything@test.com', '')).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid regex'));
		warnSpy.mockRestore();
	});

	it('works with reject action (still matches, just returns true)', () => {
		const rule: PanelRule = { field: 'from', pattern: 'spam', action: 'reject' };
		expect(matchesRule(rule, 'spam@example.com', '')).toBe(true);
	});

	it('returns false when the pattern does not match', () => {
		const rule: PanelRule = { field: 'from', pattern: 'specific@exact\\.com', action: 'accept' };
		expect(matchesRule(rule, 'different@other.com', '')).toBe(false);
	});

	it('matches against empty strings', () => {
		const rule: PanelRule = { field: 'from', pattern: '^$', action: 'accept' };
		expect(matchesRule(rule, '', '')).toBe(true);
	});
});

// =============================================================================
// assignPanel
// =============================================================================

describe('assignPanel', () => {
	/**
	 * Standard 4-panel setup for testing.
	 * Patterns omit the `$` anchor because raw From headers include
	 * angle brackets (e.g., "Boss <boss@company.com>").
	 */
	const panels: PanelConfig[] = [
		{
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		},
		{
			name: 'Social',
			rules: [{ field: 'from', pattern: '@(facebook|twitter)\\.com', action: 'accept' }]
		},
		{
			name: 'Newsletters',
			rules: [{ field: 'from', pattern: 'newsletter|digest|weekly', action: 'accept' }]
		},
		{ name: 'Other', rules: [] }
	];

	it('assigns a thread to the first matching panel', () => {
		expect(assignPanel(panels, 'boss@company.com', 'me@gmail.com')).toBe(0);
	});

	it('assigns a thread to the second panel when it matches', () => {
		expect(assignPanel(panels, 'noreply@facebook.com', 'me@gmail.com')).toBe(1);
	});

	it('assigns a thread to the third panel when it matches', () => {
		expect(assignPanel(panels, 'Weekly Digest <digest@news.com>', 'me@gmail.com')).toBe(2);
	});

	it('falls through to the last panel (catch-all) for unmatched threads', () => {
		expect(assignPanel(panels, 'random@unknown.com', 'me@gmail.com')).toBe(3);
	});

	it('assigns to first matching panel even if later panels also match', () => {
		/* This from matches both "Work" (@company.com) and "Newsletters" (company). */
		const panelsOverlap: PanelConfig[] = [
			{
				name: 'Work',
				rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
			},
			{
				name: 'Newsletters',
				rules: [{ field: 'from', pattern: 'company', action: 'accept' }]
			},
			{ name: 'Other', rules: [] }
		];
		expect(assignPanel(panelsOverlap, 'news@company.com', '')).toBe(0);
	});

	it('skips a panel when its first matching rule is reject', () => {
		const panelsWithReject: PanelConfig[] = [
			{
				name: 'Work',
				rules: [
					{ field: 'from', pattern: 'spam', action: 'reject' },
					{ field: 'from', pattern: '@company\\.com', action: 'accept' }
				]
			},
			{ name: 'Other', rules: [] }
		];
		/* "spam@company.com" matches the reject rule first → skips Work → lands in Other. */
		expect(assignPanel(panelsWithReject, 'spam@company.com', '')).toBe(1);
		/* "boss@company.com" doesn't match reject, matches accept → Work. */
		expect(assignPanel(panelsWithReject, 'boss@company.com', '')).toBe(0);
	});

	it('handles panels with no rules (they never claim threads)', () => {
		const allEmpty: PanelConfig[] = [
			{ name: 'A', rules: [] },
			{ name: 'B', rules: [] },
			{ name: 'C', rules: [] }
		];
		/* All panels are empty → falls through to last panel. */
		expect(assignPanel(allEmpty, 'anyone@test.com', '')).toBe(2);
	});

	it('returns 0 for an empty panels array', () => {
		expect(assignPanel([], 'test@test.com', '')).toBe(0);
	});

	it('handles a single panel', () => {
		const single: PanelConfig[] = [
			{
				name: 'Everything',
				rules: [{ field: 'from', pattern: '.*', action: 'accept' }]
			}
		];
		expect(assignPanel(single, 'anyone@anywhere.com', '')).toBe(0);
	});

	it('handles a single panel with no rules (catch-all)', () => {
		const single: PanelConfig[] = [{ name: 'All', rules: [] }];
		expect(assignPanel(single, 'test@test.com', '')).toBe(0);
	});

	it('supports "to" field rules for sorting by recipient', () => {
		const panelsWithTo: PanelConfig[] = [
			{
				name: 'Team',
				rules: [{ field: 'to', pattern: 'team@company\\.com', action: 'accept' }]
			},
			{ name: 'Other', rules: [] }
		];
		expect(assignPanel(panelsWithTo, 'anyone@test.com', 'team@company.com')).toBe(0);
		expect(assignPanel(panelsWithTo, 'anyone@test.com', 'me@gmail.com')).toBe(1);
	});

	it('handles multiple rules per panel with mixed accept/reject', () => {
		const multi: PanelConfig[] = [
			{
				name: 'Important',
				rules: [
					{ field: 'from', pattern: 'ceo@company\\.com', action: 'accept' },
					{ field: 'from', pattern: 'cto@company\\.com', action: 'accept' },
					{ field: 'from', pattern: '@company\\.com', action: 'reject' }
				]
			},
			{ name: 'Other', rules: [] }
		];
		/* CEO matches first accept rule. */
		expect(assignPanel(multi, 'ceo@company.com', '')).toBe(0);
		/* CTO matches second accept rule. */
		expect(assignPanel(multi, 'cto@company.com', '')).toBe(0);
		/* Random company email matches reject rule → skip to Other. */
		expect(assignPanel(multi, 'intern@company.com', '')).toBe(1);
	});

	it('handles an invalid regex gracefully (treats as non-matching)', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const badRegex: PanelConfig[] = [
			{
				name: 'Bad',
				rules: [{ field: 'from', pattern: '[bad(regex', action: 'accept' }]
			},
			{ name: 'Other', rules: [] }
		];
		/* Invalid regex doesn't match → falls through to Other. */
		expect(assignPanel(badRegex, 'test@test.com', '')).toBe(1);
		vi.restoreAllMocks();
	});
});

// =============================================================================
// getDefaultPanels
// =============================================================================

describe('getDefaultPanels', () => {
	it('returns 4 panels', () => {
		const defaults = getDefaultPanels();
		expect(defaults).toHaveLength(4);
	});

	it('returns panels with names', () => {
		const defaults = getDefaultPanels();
		for (const panel of defaults) {
			expect(panel.name).toBeTruthy();
			expect(typeof panel.name).toBe('string');
		}
	});

	it('returns panels with empty rules arrays', () => {
		const defaults = getDefaultPanels();
		for (const panel of defaults) {
			expect(panel.rules).toEqual([]);
		}
	});

	it('returns a new array on each call (no shared references)', () => {
		const a = getDefaultPanels();
		const b = getDefaultPanels();
		expect(a).not.toBe(b);
		expect(a[0]).not.toBe(b[0]);
	});

	it('returns the expected panel names: Primary, Social, Updates, Other', () => {
		const defaults = getDefaultPanels();
		const names = defaults.map((p) => p.name);
		expect(names).toEqual(['Primary', 'Social', 'Updates', 'Other']);
	});
});

// =============================================================================
// assignPanel — Additional Edge Cases
// =============================================================================

describe('assignPanel — additional edge cases', () => {
	it('falls through to catch-all when a panel has only reject rules', () => {
		/*
		 * Panel 0 has a reject rule that matches — it explicitly rejects
		 * the thread. Panel 1 is the catch-all (no rules).
		 * The reject means "don't put in this panel", NOT "delete".
		 */
		const panels: PanelConfig[] = [
			{
				name: 'Filtered',
				rules: [{ field: 'from', pattern: '.*', action: 'reject' }]
			},
			{ name: 'Catch-All', rules: [] }
		];
		expect(assignPanel(panels, 'anyone@test.com', '')).toBe(1);
	});

	it('reject only breaks out of current panel, not all panels', () => {
		/*
		 * Panel 0 rejects @spam.com. Panel 1 accepts @spam.com.
		 * The reject in panel 0 should NOT prevent panel 1 from accepting.
		 */
		const panels: PanelConfig[] = [
			{
				name: 'No Spam',
				rules: [{ field: 'from', pattern: '@spam\\.com', action: 'reject' }]
			},
			{
				name: 'Spam Folder',
				rules: [{ field: 'from', pattern: '@spam\\.com', action: 'accept' }]
			},
			{ name: 'Other', rules: [] }
		];
		expect(assignPanel(panels, 'junk@spam.com', '')).toBe(1);
	});

	it('non-matching reject rule does not affect subsequent rules in the same panel', () => {
		/*
		 * Panel has: reject "spam" (doesn't match) → accept "@company.com" (matches).
		 * Since the reject doesn't match, the engine continues to the next rule.
		 */
		const panels: PanelConfig[] = [
			{
				name: 'Work',
				rules: [
					{ field: 'from', pattern: 'spam', action: 'reject' },
					{ field: 'from', pattern: '@company\\.com', action: 'accept' }
				]
			},
			{ name: 'Other', rules: [] }
		];
		expect(assignPanel(panels, 'boss@company.com', '')).toBe(0);
	});
});
