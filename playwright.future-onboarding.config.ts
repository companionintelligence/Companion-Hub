/**
 * Playwright config for future onboarding AI setup E2E.
 *
 * Uses the default Hub stack (mock portal :4444, backend, frontend) but runs
 * only e2e/future/onboarding-ai-setup.spec.ts — excluded from playwright.config.ts.
 *
 * Usage: pnpm e2e:future:onboarding
 */

import baseConfig from './playwright.config.ts';

export default {
  ...baseConfig,
  testMatch: '**/future/onboarding-ai-setup.spec.ts',
  testIgnore: ['**/generated/**', '**/cross-domain/**', '**/platform/**', '**/mcp-openclaw-integration.spec.ts', '**/app-store-lifecycle.spec.ts'],
};
