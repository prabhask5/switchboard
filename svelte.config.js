/**
 * SvelteKit Configuration
 *
 * Uses adapter-vercel when deploying to Vercel (detected via the VERCEL env var
 * that Vercel sets automatically during builds), and adapter-node for local
 * development and self-hosted deployments. Both run on the Node.js runtime.
 */

import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: process.env.VERCEL ? adapterVercel() : adapterNode(),
		alias: {
			$lib: './src/lib'
		}
	}
};

export default config;
