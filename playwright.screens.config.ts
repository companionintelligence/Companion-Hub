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
  // The base list minus the one entry that exists to keep THIS spec out of the default lane.
  // Derived rather than copied, so an ignore added to the base config applies here too.
  testIgnore: (baseConfig.testIgnore as string[]).filter((glob) => glob !== '**/screens/**'),
  // Each capture test walks a dozen screens in one browser session.
  timeout: 300000,
  // Screenshots are the artifact; a retry would double-write them.
  retries: 0,
};
