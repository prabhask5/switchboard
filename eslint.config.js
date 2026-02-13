/**
 * ESLint Flat Configuration
 *
 * Uses ESLint's flat config format with support for:
 *   - JavaScript (ESLint recommended rules)
 *   - TypeScript (via @typescript-eslint)
 *   - Svelte components (via eslint-plugin-svelte)
 *   - Prettier compatibility (disables formatting rules that conflict with Prettier)
 *
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */

import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
	/** Base JavaScript recommended rules */
	js.configs.recommended,

	/** Prettier compat: turns off all rules that conflict with Prettier formatting */
	prettier,

	/**
	 * TypeScript-specific configuration.
	 * Applied to .ts files (Svelte files handled separately below).
	 */
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module'
			},
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		plugins: {
			'@typescript-eslint': ts
		},
		rules: {
			...ts.configs.recommended.rules,

			// Warn on unused vars; allow _ prefix for intentionally unused params
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],

			// Allow explicit `any` — Gmail API responses are complex
			'@typescript-eslint/no-explicit-any': 'off',

			// TypeScript handles no-undef better than ESLint for type-only imports
			'no-undef': 'off'
		}
	},

	/** Svelte recommended lint rules (accessibility, reactivity, component patterns) */
	...svelte.configs['flat/recommended'],

	/** Svelte + Prettier compat */
	...svelte.configs['flat/prettier'],

	/**
	 * Svelte component-specific overrides.
	 */
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: tsParser
			}
		},
		rules: {
			// Allow {@html ...} for rendering sanitized email HTML
			'svelte/no-at-html-tags': 'off',
			'svelte/no-navigation-without-resolve': 'off',
			'no-undef': 'off',
			'no-unused-vars': 'off'
		}
	},

	/**
	 * Node.js config files (svelte.config.js, etc.) — need `process` global.
	 */
	{
		files: ['svelte.config.js'],
		languageOptions: {
			globals: {
				...globals.node
			}
		}
	},

	/**
	 * Global ignore patterns.
	 */
	{
		ignores: [
			'.svelte-kit/',
			'.vercel/',
			'build/',
			'node_modules/',
			'static/sw.js',
			'**/*.svelte.ts' /* Svelte 5 rune modules — validated by svelte-check, not ESLint */
		]
	}
];
