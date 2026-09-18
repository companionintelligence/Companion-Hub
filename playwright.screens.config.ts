/**
 * Playwright config for documentation screenshot capture.
 *
 * Uses the default Hub stack (mock portal :4444, backend, frontend) but runs only
 * e2e/screens/capture-screens.spec.ts, which is excluded from playwright.config.ts
 * because it writes PNGs into docs/images/screens/.
 *
 * Usage: pnpm run docs:screens
 */

import baseConfig from './playwright.config.ts';

export default {
  ...baseConfig,
  testMatch: '**/screens/capture-screens.spec.ts',
  testIgnore: ['**/generated/**', '**/cross-domain/**', '**/platform/**', '**/mcp-openclaw-integration.spec.ts', '**/app-store-lifecycle.spec.ts'],
  // Each capture test walks a dozen screens in one browser session.
  timeout: 300000,
  // Screenshots are the artifact; a retry would double-write them.
  retries: 0,
};
