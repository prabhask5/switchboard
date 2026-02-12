/**
 * Knip Configuration - Unused Code & Dependency Detector
 *
 * Knip statically analyzes the project to find unused files, exports, and dependencies.
 * This config tells Knip which files are entry points, which to ignore, and how to
 * handle SvelteKit-specific conventions (e.g., file-based routing).
 *
 * Run with: `npx knip`
 *
 * @see https://knip.dev/
 */

import type { KnipConfig } from 'knip';

const config: KnipConfig = {
	/**
	 * Entry points that Knip uses as the starting point for dependency tracing.
	 * Anything not reachable from these entries is considered unused.
	 */
	entry: ['src/routes/**/*.{ts,svelte}', 'src/lib/index.ts', 'src/app.html'],

	/** The full set of project source files that Knip should analyze for unused exports */
	project: ['src/**/*.{ts,svelte}'],

	/**
	 * Files to exclude from the unused-code analysis.
	 *   - *.d.ts: Type declaration files are consumed by TypeScript, not import-traced by Knip
	 *   - test files: Test utilities may not be imported from production code
	 */
	ignore: ['**/*.d.ts', '**/*.test.ts'],

	/**
	 * Dependencies to exclude from the "unused dependency" report.
	 *   - zod: Will be used in PR 2 for runtime validation of panel rules and request bodies
	 */
	ignoreDependencies: ['zod'],

	/**
	 * Exported symbols to exclude from the "unused export" report.
	 * These are public API functions/types that will be consumed in future PRs:
	 *   - hasRefreshToken: Used in layout guards (PR 2)
	 *   - getCsrfToken: Used in CSRF validation middleware (PR 4)
	 *   - TokenResponse, GmailProfile, OAuthFlowInit: Shared types used across modules
	 *   - PkcePair: Type export for PKCE utility
	 */
	ignoreExportsUsedInFile: true,

	/** Point Knip to the Svelte config so it understands SvelteKit's file conventions */
	svelte: {
		config: ['svelte.config.js']
	}
};

export default config;
