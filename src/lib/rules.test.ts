/**
 * @fileoverview Unit tests for the panel rule engine.
 *
 * Tests cover:
 *   - matchesRule: individual rule matching against from/to headers
 *   - threadMatchesPanel: per-panel matching with no-rules, accept, reject, and no-match cases
 *   - assignPanel: full panel assignment with multiple panels and rules
 *   - regexToGmailTerms: regex-to-Gmail search term conversion
 *   - panelRulesToGmailQuery: full panel-to-Gmail query conversion
 *   - getDefaultPanels: returns valid default configuration
 */

import { describe, it, expect, vi } from 'vitest';
import {
	matchesRule,
	threadMatchesPanel,
	assignPanel,
	getDefaultPanels,
	regexToGmailTerms,
	panelRulesToGmailQuery
} from './rules.js';
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
// threadMatchesPanel
// =============================================================================

describe('threadMatchesPanel', () => {
	it('returns true for any thread when panel has no rules', () => {
		/*
		 * A panel with no rules is an "inbox-wide" panel that shows
		 * all threads. This is the default for new/unconfigured panels.
		 */
		const panel: PanelConfig = { name: 'All Mail', rules: [] };
		expect(threadMatchesPanel(panel, 'anyone@anywhere.com', 'me@gmail.com')).toBe(true);
		expect(threadMatchesPanel(panel, '', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'spam@junk.net', 'other@test.com')).toBe(true);
	});

	it('returns true when first matching rule is accept', () => {
		/*
		 * Panel has an accept rule for @company.com. A thread from
		 * that domain should match and return true.
		 */
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'boss@company.com', 'me@gmail.com')).toBe(true);
	});

	it('returns false when first matching rule is reject', () => {
		/*
		 * Panel has a reject rule for spam. A thread matching "spam"
		 * hits the reject rule first → returns false.
		 */
		const panel: PanelConfig = {
			name: 'Filtered',
			rules: [
				{ field: 'from', pattern: 'spam', action: 'reject' },
				{ field: 'from', pattern: '@company\\.com', action: 'accept' }
			]
		};
		expect(threadMatchesPanel(panel, 'spam@company.com', '')).toBe(false);
	});

	it('returns false when no rules match', () => {
		/*
		 * Panel only accepts @company.com. A thread from a completely
		 * different domain matches no rules → returns false.
		 */
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'random@other.com', 'me@gmail.com')).toBe(false);
	});

	it('same thread can match multiple panels', () => {
		/*
		 * Two panels have overlapping rules. A single thread can match
		 * both panels independently — threads appear in multiple panels.
		 */
		const workPanel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		};
		const allCompanyPanel: PanelConfig = {
			name: 'All Company',
			rules: [{ field: 'from', pattern: 'company', action: 'accept' }]
		};

		const from = 'newsletter@company.com';
		const to = 'me@gmail.com';

		/* Thread matches both panels independently. */
		expect(threadMatchesPanel(workPanel, from, to)).toBe(true);
		expect(threadMatchesPanel(allCompanyPanel, from, to)).toBe(true);
	});

	it('evaluates rules in order — first match wins', () => {
		/*
		 * Panel has a reject rule for @company.com BEFORE an accept
		 * rule for @company.com. The reject comes first → returns false,
		 * even though the accept would also match.
		 */
		const panel: PanelConfig = {
			name: 'Tricky',
			rules: [
				{ field: 'from', pattern: '@company\\.com', action: 'reject' },
				{ field: 'from', pattern: '@company\\.com', action: 'accept' }
			]
		};
		expect(threadMatchesPanel(panel, 'boss@company.com', '')).toBe(false);
	});

	it('handles invalid regex gracefully (returns false)', () => {
		/*
		 * An invalid regex pattern should not throw. Instead, matchesRule
		 * treats it as non-matching. Since no rules match, the function
		 * returns false.
		 */
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const panel: PanelConfig = {
			name: 'Bad',
			rules: [{ field: 'from', pattern: '[invalid(regex', action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'test@test.com', '')).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid regex'));
		warnSpy.mockRestore();
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
	 * The last panel has no rules → matches ALL threads (inbox-wide).
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

	it('assigns unmatched threads to no-rules panel (matches all)', () => {
		/*
		 * "Other" has no rules → matches ALL threads. Unmatched threads
		 * fall through to the first no-rules panel (index 3).
		 */
		expect(assignPanel(panels, 'random@unknown.com', 'me@gmail.com')).toBe(3);
	});

	it('returns first matching panel index', () => {
		/*
		 * This "from" matches both "Work" (@company.com) and "Newsletters" (company).
		 * assignPanel returns the first match (index 0).
		 */
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

	it('returns -1 when no panel matches', () => {
		/*
		 * All panels have specific rules and none match the thread.
		 * No no-rules panel exists, so -1 is returned.
		 */
		const strictPanels: PanelConfig[] = [
			{
				name: 'Work',
				rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
			},
			{
				name: 'Social',
				rules: [{ field: 'from', pattern: '@facebook\\.com', action: 'accept' }]
			}
		];
		expect(assignPanel(strictPanels, 'random@unknown.com', 'me@gmail.com')).toBe(-1);
	});

	it('no-rules panels match ALL threads (returns index of first no-rules panel)', () => {
		/*
		 * All panels have no rules → every panel matches all threads.
		 * assignPanel returns the first match: index 0.
		 */
		const allEmpty: PanelConfig[] = [
			{ name: 'A', rules: [] },
			{ name: 'B', rules: [] },
			{ name: 'C', rules: [] }
		];
		expect(assignPanel(allEmpty, 'anyone@test.com', '')).toBe(0);
	});

	it('returns -1 for an empty panels array', () => {
		expect(assignPanel([], 'test@test.com', '')).toBe(-1);
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

	it('handles a single panel with no rules (matches all)', () => {
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
	it('falls through to no-rules panel when a panel has only reject rules', () => {
		/*
		 * Panel 0 has a reject rule that matches — it explicitly rejects
		 * the thread. Panel 1 has no rules → matches all threads.
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

// =============================================================================
// regexToGmailTerms
// =============================================================================

describe('regexToGmailTerms', () => {
	it('converts simple escaped pattern: @company\\.com → @company.com', () => {
		const terms = regexToGmailTerms('@company\\.com');
		expect(terms).toEqual(['@company.com']);
	});

	it('expands (a|b) group with prefix and suffix', () => {
		const terms = regexToGmailTerms('@(twitter|facebook)\\.com');
		expect(terms).toEqual(['@twitter.com', '@facebook.com']);
	});

	it('splits top-level | alternatives', () => {
		const terms = regexToGmailTerms('newsletter|digest');
		expect(terms).toEqual(['newsletter', 'digest']);
	});

	it('removes anchors ^ and $', () => {
		const terms = regexToGmailTerms('^@company\\.com$');
		expect(terms).toEqual(['@company.com']);
	});

	it('removes quantifiers * + ?', () => {
		const terms = regexToGmailTerms('news+letter*');
		expect(terms).toEqual(['newsletter']);
	});

	it('returns single cleaned term for simple pattern', () => {
		const terms = regexToGmailTerms('john@example\\.com');
		expect(terms).toEqual(['john@example.com']);
	});

	it('handles empty pattern', () => {
		const terms = regexToGmailTerms('');
		expect(terms).toEqual(['']);
	});

	it('handles pattern with only anchors', () => {
		const terms = regexToGmailTerms('^$');
		expect(terms).toEqual(['']);
	});

	it('expands group with three alternatives', () => {
		const terms = regexToGmailTerms('@(twitter|facebook|instagram)\\.com');
		expect(terms).toEqual(['@twitter.com', '@facebook.com', '@instagram.com']);
	});

	it('handles top-level alternatives with escapes', () => {
		const terms = regexToGmailTerms('@work\\.com|@personal\\.org');
		expect(terms).toEqual(['@work.com', '@personal.org']);
	});
});

// =============================================================================
// panelRulesToGmailQuery
// =============================================================================

describe('panelRulesToGmailQuery', () => {
	it('converts single accept rule to from:(term)', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', pattern: '@company\\.com', action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com)');
	});

	it('combines multiple accept rules with {} OR syntax', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [
				{ field: 'from', pattern: '@company\\.com', action: 'accept' },
				{ field: 'from', pattern: '@partner\\.com', action: 'accept' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('{from:(@company.com) from:(@partner.com)}');
	});

	it('adds reject rules as negations', () => {
		const panel: PanelConfig = {
			name: 'Filtered',
			rules: [
				{ field: 'from', pattern: '@company\\.com', action: 'accept' },
				{ field: 'from', pattern: 'noreply', action: 'reject' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com) -from:(noreply)');
	});

	it('handles to: field rules', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', pattern: 'team@company\\.com', action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('to:(team@company.com)');
	});

	it('returns empty string for panel with no rules', () => {
		const panel: PanelConfig = { name: 'Empty', rules: [] };
		expect(panelRulesToGmailQuery(panel)).toBe('');
	});

	it('handles mixed accept/reject rules', () => {
		const panel: PanelConfig = {
			name: 'Mix',
			rules: [
				{ field: 'from', pattern: '@company\\.com', action: 'accept' },
				{ field: 'from', pattern: 'spam', action: 'reject' },
				{ field: 'to', pattern: 'team@', action: 'accept' }
			]
		};
		const result = panelRulesToGmailQuery(panel);
		expect(result).toBe('{from:(@company.com) to:(team@)} -from:(spam)');
	});

	it('expands regex groups in panel rules', () => {
		const panel: PanelConfig = {
			name: 'Social',
			rules: [{ field: 'from', pattern: '@(twitter|facebook)\\.com', action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('{from:(@twitter.com) from:(@facebook.com)}');
	});

	it('handles only reject rules (no accept parts)', () => {
		const panel: PanelConfig = {
			name: 'Excluder',
			rules: [
				{ field: 'from', pattern: 'spam', action: 'reject' },
				{ field: 'from', pattern: 'junk', action: 'reject' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('-from:(spam) -from:(junk)');
	});
});

// =============================================================================
// threadMatchesPanel — to field matching
// =============================================================================

describe('threadMatchesPanel — to field matching', () => {
	it('matches on the to field when rule specifies field: "to"', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', pattern: 'team@company\\.com', action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'anyone@test.com', 'team@company.com')).toBe(true);
	});

	it('does not match from field when rule specifies to', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', pattern: 'team@company\\.com', action: 'accept' }]
		};
		/* The from header contains "team@company.com" but the rule checks "to" field. */
		expect(threadMatchesPanel(panel, 'team@company.com', 'me@gmail.com')).toBe(false);
	});

	it('rejects on to field match with reject action', () => {
		const panel: PanelConfig = {
			name: 'Not Mailing Lists',
			rules: [
				{ field: 'to', pattern: 'list-', action: 'reject' },
				{ field: 'from', pattern: '.', action: 'accept' }
			]
		};
		/* Thread sent to a mailing list → rejected by first rule. */
		expect(threadMatchesPanel(panel, 'sender@test.com', 'list-dev@company.com')).toBe(false);
	});

	it('accepts when to field does not match reject rule', () => {
		const panel: PanelConfig = {
			name: 'Not Mailing Lists',
			rules: [
				{ field: 'to', pattern: 'list-', action: 'reject' },
				{ field: 'from', pattern: '.', action: 'accept' }
			]
		};
		/* Thread sent directly to user (not a list) → first rule doesn't match, second accepts. */
		expect(threadMatchesPanel(panel, 'sender@test.com', 'me@gmail.com')).toBe(true);
	});
});

// =============================================================================
// regexToGmailTerms — additional patterns
// =============================================================================

describe('regexToGmailTerms — additional patterns', () => {
	it('handles pattern with only anchors (empty after stripping)', () => {
		const terms = regexToGmailTerms('^$');
		expect(terms).toEqual(['']);
	});

	it('handles pattern with quantifiers', () => {
		const terms = regexToGmailTerms('no-?reply');
		expect(terms).toEqual(['no-reply']);
	});

	it('handles complex character class patterns', () => {
		/* Character classes [abc] are stripped, leaving adjacent text. */
		const terms = regexToGmailTerms('test[0-9]+value');
		expect(terms).toEqual(['testvalue']);
	});

	it('handles pattern with escaped special characters', () => {
		const terms = regexToGmailTerms('user\\.name\\@domain');
		expect(terms).toEqual(['user.name@domain']);
	});

	it('handles multiple top-level alternatives', () => {
		const terms = regexToGmailTerms('alpha|beta|gamma');
		expect(terms).toEqual(['alpha', 'beta', 'gamma']);
	});

	it('expands group with prefix and suffix', () => {
		const terms = regexToGmailTerms('prefix-(a|b|c)-suffix');
		expect(terms).toEqual(['prefix-a-suffix', 'prefix-b-suffix', 'prefix-c-suffix']);
	});

	it('handles empty group alternatives', () => {
		/* (|) — has empty alternatives */
		const terms = regexToGmailTerms('(alpha|)');
		expect(terms).toEqual(['alpha', '']);
	});
});

// =============================================================================
// matchesRule — boundary edge cases
// =============================================================================

describe('matchesRule — boundary edge cases', () => {
	it('matches empty pattern against any string (. matches empty in regex)', () => {
		/* Empty regex matches everything. */
		const rule: PanelRule = { field: 'from', pattern: '', action: 'accept' };
		expect(matchesRule(rule, 'anyone@test.com', '')).toBe(true);
	});

	it('matches with anchored pattern at start', () => {
		const rule: PanelRule = { field: 'from', pattern: '^Newsletter', action: 'accept' };
		expect(matchesRule(rule, 'Newsletter <news@test.com>', '')).toBe(true);
		expect(matchesRule(rule, 'From Newsletter Team', '')).toBe(false);
	});

	it('matches with anchored pattern at end', () => {
		const rule: PanelRule = { field: 'from', pattern: '@company\\.com>$', action: 'accept' };
		expect(matchesRule(rule, 'Boss <boss@company.com>', '')).toBe(true);
	});

	it('handles unicode characters in pattern', () => {
		const rule: PanelRule = { field: 'from', pattern: 'café', action: 'accept' };
		expect(matchesRule(rule, 'Le Café <cafe@test.com>', '')).toBe(true);
	});
});

// =============================================================================
// assignPanel — first-match semantics
// =============================================================================

describe('assignPanel — first-match semantics', () => {
	it('returns first matching panel even when multiple would match', () => {
		const panels: PanelConfig[] = [
			{ name: 'A', rules: [{ field: 'from', pattern: '@test\\.com', action: 'accept' }] },
			{ name: 'B', rules: [{ field: 'from', pattern: 'user', action: 'accept' }] },
			{ name: 'C', rules: [] }
		];
		/* All three panels match user@test.com, but assignPanel returns first (index 0). */
		expect(assignPanel(panels, 'user@test.com', '')).toBe(0);
	});

	it('skips rejected panels and returns next matching one', () => {
		const panels: PanelConfig[] = [
			{ name: 'Exclude', rules: [{ field: 'from', pattern: '.', action: 'reject' }] },
			{ name: 'All', rules: [] }
		];
		/* First panel rejects everything, second panel accepts everything. */
		expect(assignPanel(panels, 'anyone@test.com', '')).toBe(1);
	});
});
