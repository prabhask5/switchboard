/**
 * @fileoverview Unit tests for the panel rule engine.
 *
 * Tests cover:
 *   - matchesRule: individual rule matching against from/to headers using address lists
 *   - threadMatchesPanel: per-panel matching with no-rules, accept, reject, and no-match cases
 *   - panelRulesToGmailQuery: full panel-to-Gmail query conversion with address lists
 *   - getDefaultPanels: returns valid default configuration
 */

import { describe, it, expect } from 'vitest';
import {
	matchesRule,
	threadMatchesPanel,
	getDefaultPanels,
	panelRulesToGmailQuery
} from '../rules.js';
import type { PanelConfig, PanelRule } from '../types.js';

// =============================================================================
// matchesRule
// =============================================================================

describe('matchesRule', () => {
	it('matches a "from" field rule against the from header', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
		expect(matchesRule(rule, 'Boss <boss@company.com>', 'me@gmail.com')).toBe(true);
	});

	it('does not match a "from" rule against the to header', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
		expect(matchesRule(rule, 'random@other.com', 'me@company.com')).toBe(false);
	});

	it('matches a "to" field rule against the to header', () => {
		const rule: PanelRule = { field: 'to', addresses: ['team@company.com'], action: 'accept' };
		expect(matchesRule(rule, 'someone@example.com', 'team@company.com')).toBe(true);
	});

	it('is case-insensitive', () => {
		const rule: PanelRule = { field: 'from', addresses: ['newsletter'], action: 'accept' };
		expect(matchesRule(rule, 'NEWSLETTER@example.com', '')).toBe(true);
		expect(matchesRule(rule, 'Monthly Newsletter <news@ex.com>', '')).toBe(true);
	});

	it('matches domain suffix (@domain.com)', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@github.com'], action: 'accept' };
		expect(matchesRule(rule, 'noreply@github.com', '')).toBe(true);
		expect(matchesRule(rule, 'alerts@github.com', '')).toBe(true);
		expect(matchesRule(rule, 'user@gmail.com', '')).toBe(false);
	});

	it('matches exact email address', () => {
		const rule: PanelRule = {
			field: 'from',
			addresses: ['ceo@company.com'],
			action: 'accept'
		};
		expect(matchesRule(rule, 'ceo@company.com', '')).toBe(true);
		expect(matchesRule(rule, 'intern@company.com', '')).toBe(false);
	});

	it('matches any address in the list (OR semantics)', () => {
		const rule: PanelRule = {
			field: 'from',
			addresses: ['@facebook.com', '@twitter.com', '@instagram.com'],
			action: 'accept'
		};
		expect(matchesRule(rule, 'noreply@facebook.com', '')).toBe(true);
		expect(matchesRule(rule, 'alerts@twitter.com', '')).toBe(true);
		expect(matchesRule(rule, 'notifications@instagram.com', '')).toBe(true);
		expect(matchesRule(rule, 'user@gmail.com', '')).toBe(false);
	});

	it('returns false for empty addresses array', () => {
		const rule: PanelRule = { field: 'from', addresses: [], action: 'accept' };
		expect(matchesRule(rule, 'anything@test.com', '')).toBe(false);
	});

	it('skips empty string addresses in the array', () => {
		const rule: PanelRule = { field: 'from', addresses: ['', '  ', '@test.com'], action: 'accept' };
		expect(matchesRule(rule, 'user@test.com', '')).toBe(true);
		/* Empty strings alone should not match. */
		const emptyOnly: PanelRule = { field: 'from', addresses: ['', ''], action: 'accept' };
		expect(matchesRule(emptyOnly, 'anything@test.com', '')).toBe(false);
	});

	it('works with reject action (still matches, just returns true)', () => {
		const rule: PanelRule = { field: 'from', addresses: ['spam'], action: 'reject' };
		expect(matchesRule(rule, 'spam@example.com', '')).toBe(true);
	});

	it('returns false when no address matches', () => {
		const rule: PanelRule = {
			field: 'from',
			addresses: ['specific@exact.com'],
			action: 'accept'
		};
		expect(matchesRule(rule, 'different@other.com', '')).toBe(false);
	});

	it('returns false when target is empty string', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
		expect(matchesRule(rule, '', '')).toBe(false);
	});
});

// =============================================================================
// threadMatchesPanel
// =============================================================================

describe('threadMatchesPanel', () => {
	it('returns true for any thread when panel has no rules', () => {
		const panel: PanelConfig = { name: 'All Mail', rules: [] };
		expect(threadMatchesPanel(panel, 'anyone@anywhere.com', 'me@gmail.com')).toBe(true);
		expect(threadMatchesPanel(panel, '', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'spam@junk.net', 'other@test.com')).toBe(true);
	});

	it('returns true when first matching rule is accept', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'boss@company.com', 'me@gmail.com')).toBe(true);
	});

	it('returns false when first matching rule is reject', () => {
		const panel: PanelConfig = {
			name: 'Filtered',
			rules: [
				{ field: 'from', addresses: ['spam'], action: 'reject' },
				{ field: 'from', addresses: ['@company.com'], action: 'accept' }
			]
		};
		/* "spam@company.com" matches the reject rule first. */
		expect(threadMatchesPanel(panel, 'spam@company.com', '')).toBe(false);
	});

	it('returns false when no rules match', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'random@other.com', 'me@gmail.com')).toBe(false);
	});

	it('same thread can match multiple panels', () => {
		const workPanel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
		};
		const allCompanyPanel: PanelConfig = {
			name: 'All Company',
			rules: [{ field: 'from', addresses: ['company'], action: 'accept' }]
		};
		const from = 'newsletter@company.com';
		const to = 'me@gmail.com';
		expect(threadMatchesPanel(workPanel, from, to)).toBe(true);
		expect(threadMatchesPanel(allCompanyPanel, from, to)).toBe(true);
	});

	it('evaluates rules in order — first match wins', () => {
		const panel: PanelConfig = {
			name: 'Tricky',
			rules: [
				{ field: 'from', addresses: ['@company.com'], action: 'reject' },
				{ field: 'from', addresses: ['@company.com'], action: 'accept' }
			]
		};
		expect(threadMatchesPanel(panel, 'boss@company.com', '')).toBe(false);
	});

	it('handles empty addresses (returns false — no match)', () => {
		const panel: PanelConfig = {
			name: 'Empty',
			rules: [{ field: 'from', addresses: [], action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'test@test.com', '')).toBe(false);
	});

	it('handles mixed accept/reject rules', () => {
		const panel: PanelConfig = {
			name: 'Important',
			rules: [
				{ field: 'from', addresses: ['ceo@company.com'], action: 'accept' },
				{ field: 'from', addresses: ['cto@company.com'], action: 'accept' },
				{ field: 'from', addresses: ['@company.com'], action: 'reject' }
			]
		};
		expect(threadMatchesPanel(panel, 'ceo@company.com', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'cto@company.com', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'intern@company.com', '')).toBe(false);
	});
});

// =============================================================================
// threadMatchesPanel — to field matching
// =============================================================================

describe('threadMatchesPanel — to field matching', () => {
	it('matches on the to field when rule specifies field: "to"', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', addresses: ['team@company.com'], action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'anyone@test.com', 'team@company.com')).toBe(true);
	});

	it('does not match from field when rule specifies to', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', addresses: ['team@company.com'], action: 'accept' }]
		};
		expect(threadMatchesPanel(panel, 'team@company.com', 'me@gmail.com')).toBe(false);
	});

	it('rejects on to field match with reject action', () => {
		const panel: PanelConfig = {
			name: 'Not Mailing Lists',
			rules: [
				{ field: 'to', addresses: ['list-'], action: 'reject' },
				{ field: 'from', addresses: ['@'], action: 'accept' }
			]
		};
		expect(threadMatchesPanel(panel, 'sender@test.com', 'list-dev@company.com')).toBe(false);
	});

	it('accepts when to field does not match reject rule', () => {
		const panel: PanelConfig = {
			name: 'Not Mailing Lists',
			rules: [
				{ field: 'to', addresses: ['list-'], action: 'reject' },
				{ field: 'from', addresses: ['@'], action: 'accept' }
			]
		};
		expect(threadMatchesPanel(panel, 'sender@test.com', 'me@gmail.com')).toBe(true);
	});
});

// =============================================================================
// panelRulesToGmailQuery
// =============================================================================

describe('panelRulesToGmailQuery', () => {
	it('converts single address accept rule to from:(addr)', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', addresses: ['@company.com'], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com)');
	});

	it('combines multiple addresses from one rule with {} OR syntax', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [{ field: 'from', addresses: ['@company.com', '@partner.com'], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('{from:(@company.com) from:(@partner.com)}');
	});

	it('combines addresses from multiple accept rules', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [
				{ field: 'from', addresses: ['@company.com'], action: 'accept' },
				{ field: 'from', addresses: ['@partner.com'], action: 'accept' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('{from:(@company.com) from:(@partner.com)}');
	});

	it('adds reject rules as negations', () => {
		const panel: PanelConfig = {
			name: 'Filtered',
			rules: [
				{ field: 'from', addresses: ['@company.com'], action: 'accept' },
				{ field: 'from', addresses: ['noreply@company.com'], action: 'reject' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com) -from:(noreply@company.com)');
	});

	it('handles to: field rules', () => {
		const panel: PanelConfig = {
			name: 'Team',
			rules: [{ field: 'to', addresses: ['team@company.com'], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('to:(team@company.com)');
	});

	it('returns empty string for panel with no rules', () => {
		const panel: PanelConfig = { name: 'Empty', rules: [] };
		expect(panelRulesToGmailQuery(panel)).toBe('');
	});

	it('handles mixed accept/reject rules with multiple addresses', () => {
		const panel: PanelConfig = {
			name: 'Mix',
			rules: [
				{ field: 'from', addresses: ['@company.com'], action: 'accept' },
				{ field: 'from', addresses: ['spam@company.com'], action: 'reject' },
				{ field: 'to', addresses: ['team@company.com'], action: 'accept' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe(
			'{from:(@company.com) to:(team@company.com)} -from:(spam@company.com)'
		);
	});

	it('handles only reject rules (no accept parts)', () => {
		const panel: PanelConfig = {
			name: 'Excluder',
			rules: [
				{ field: 'from', addresses: ['spam@x.com'], action: 'reject' },
				{ field: 'from', addresses: ['junk@y.com'], action: 'reject' }
			]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('-from:(spam@x.com) -from:(junk@y.com)');
	});

	it('skips empty and whitespace-only addresses', () => {
		const panel: PanelConfig = {
			name: 'Sparse',
			rules: [{ field: 'from', addresses: ['', '  ', '@company.com', ''], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com)');
	});

	it('returns empty string when all addresses are empty', () => {
		const panel: PanelConfig = {
			name: 'AllEmpty',
			rules: [{ field: 'from', addresses: ['', '  '], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('');
	});

	it('trims whitespace from addresses', () => {
		const panel: PanelConfig = {
			name: 'Trimmed',
			rules: [{ field: 'from', addresses: ['  @company.com  '], action: 'accept' }]
		};
		expect(panelRulesToGmailQuery(panel)).toBe('from:(@company.com)');
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
// matchesRule — additional edge cases
// =============================================================================

describe('matchesRule — additional edge cases', () => {
	it('matches partial domain (substring matching)', () => {
		/* "company" is a substring of "boss@company.com" */
		const rule: PanelRule = { field: 'from', addresses: ['company'], action: 'accept' };
		expect(matchesRule(rule, 'boss@company.com', '')).toBe(true);
	});

	it('handles unicode in addresses', () => {
		const rule: PanelRule = { field: 'from', addresses: ['café'], action: 'accept' };
		expect(matchesRule(rule, 'Le Café <cafe@test.com>', '')).toBe(true);
	});

	it('handles angle brackets in From header', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
		expect(matchesRule(rule, 'Boss <boss@company.com>', '')).toBe(true);
	});

	it('case-insensitive matching works for uppercase addresses', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@COMPANY.COM'], action: 'accept' };
		expect(matchesRule(rule, 'boss@company.com', '')).toBe(true);
	});

	it('case-insensitive matching works for uppercase target', () => {
		const rule: PanelRule = { field: 'from', addresses: ['@company.com'], action: 'accept' };
		expect(matchesRule(rule, 'BOSS@COMPANY.COM', '')).toBe(true);
	});
});

// =============================================================================
// threadMatchesPanel — additional edge cases
// =============================================================================

describe('threadMatchesPanel — additional edge cases', () => {
	it('falls through to no-rules panel when a panel has only reject rules', () => {
		/*
		 * This tests the behavior within one panel: all-reject with a matching
		 * rule means the thread is rejected by that panel.
		 */
		const panel: PanelConfig = {
			name: 'Filtered',
			rules: [{ field: 'from', addresses: ['@'], action: 'reject' }]
		};
		expect(threadMatchesPanel(panel, 'anyone@test.com', '')).toBe(false);
	});

	it('non-matching reject rule does not affect subsequent rules', () => {
		const panel: PanelConfig = {
			name: 'Work',
			rules: [
				{ field: 'from', addresses: ['spam'], action: 'reject' },
				{ field: 'from', addresses: ['@company.com'], action: 'accept' }
			]
		};
		/* "spam" doesn't match "boss@company.com", so it falls through to the accept. */
		expect(threadMatchesPanel(panel, 'boss@company.com', '')).toBe(true);
	});

	it('multiple addresses in one rule act as OR', () => {
		const panel: PanelConfig = {
			name: 'Social',
			rules: [
				{
					field: 'from',
					addresses: ['@facebook.com', '@twitter.com', '@instagram.com'],
					action: 'accept'
				}
			]
		};
		expect(threadMatchesPanel(panel, 'noreply@facebook.com', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'noreply@twitter.com', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'noreply@instagram.com', '')).toBe(true);
		expect(threadMatchesPanel(panel, 'noreply@gmail.com', '')).toBe(false);
	});
});
