/**
 * Playwright config for MCP integration tests (opt-in, Docker-heavy).
 * Usage: BACKEND_PORT=3333 MCP_API_KEY=test-mcp-api-key-e2e npx playwright test --config=playwright.mcp.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = process.env.BACKEND_PORT || '3333';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/mcp-openclaw-integration.spec.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${BACKEND_PORT}`,
    trace: 'off',
  },
  timeout: 300_000,
  projects: [
    {
      name: 'mcp-integration',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
