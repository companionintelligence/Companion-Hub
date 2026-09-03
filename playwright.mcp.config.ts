/**
 * Playwright config for MCP integration tests (opt-in, Docker-heavy).
 *
 * Usage: `pnpm e2e:mcp` (override BACKEND_PORT / MCP_API_KEY to point at another stack).
 *
 * Spreads the base config so this lane boots the same stack (mock portal, backend, frontend) and
 * waits on the backend's /api/health before running — mirroring playwright.future-onboarding.config.ts.
 * Standing alone it had no `webServer` at all, so an unattended run had nothing to talk to; the base
 * `testIgnore` excludes this spec from the default lane, so it must be cleared here.
 *
 * BACKEND_PORT must agree with the spec's own default (3000) — it calls the API directly rather than
 * through `baseURL`, so a mismatch here silently points the health check at a different process than
 * the one under test.
 *
 * MCP_API_KEY is not a live credential on its own — SEC-MCP-8 removed the guard's env fallback.
 * The spec inserts it into the hashed key store itself; see `seedMcpApiKey()`.
 */
import { defineConfig, devices } from '@playwright/test';

import baseConfig from './playwright.config.ts';

export default defineConfig({
  ...baseConfig,
  testDir: './e2e',
  testMatch: '**/mcp-openclaw-integration.spec.ts',
  // Base ignores this spec (it is opt-in); clear the inherited list or nothing runs.
  testIgnore: ['**/generated/**', '**/cross-domain/**', '**/platform/**', '**/future/**'],
  fullyParallel: false,
  // No retries, unlike the other lanes: the describes are ordered (one test creates the app the next
  // asserts on) and every beforeAll clears the database, so a retried test re-runs against state its
  // predecessor no longer holds and fails for the wrong reason.
  retries: 0,
  workers: 1,
  // Reporter is inherited: the base picks the HTML reporter under CI, which is what the workflow's
  // `playwright-report/` artifact upload collects. Overriding to 'list' here made that upload empty.
  timeout: 300_000,
  projects: [
    {
      name: 'mcp-integration',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Mock portal + backend only. Every test here drives the API over `fetch` — none opens a page — so
  // the base config's third server (a full frontend build, then preview) would add minutes to the
  // nightly lane and a failure surface for something under test never touches. Restore the full
  // array if a test in this spec ever needs the UI.
  webServer: Array.isArray(baseConfig.webServer) ? baseConfig.webServer.slice(0, 2) : baseConfig.webServer,
});
