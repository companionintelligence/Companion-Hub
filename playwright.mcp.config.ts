/**
 * Playwright config for MCP integration tests (opt-in, Docker-heavy).
 *
 * Usage: `pnpm e2e:mcp` (override BACKEND_PORT / MCP_API_KEY to point at another stack).
 *
 * MCP_API_KEY is not a live credential on its own — SEC-MCP-8 removed the guard's env fallback.
 * The spec inserts it into the hashed key store itself; see `seedMcpApiKey()`.
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
