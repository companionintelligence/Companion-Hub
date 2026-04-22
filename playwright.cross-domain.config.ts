/**
 * Playwright configuration for cross-domain E2E tests.
 *
 * Runs a real CI-Portal via miniflare alongside the Hub Docker stack
 * to test cross-domain flows like device registration.
 *
 * Architecture:
 *   Portal:  miniflare (wrangler dev) on host
 *   Hub:     Docker Compose (Dockerfile.dev + docker-compose.local.yml override)
 *            - backend (NestJS) on port 3000
 *            - frontend (Vite dev mode) on port 9091
 *            - postgres on port 6543
 *            - rabbitmq on port 5672
 *            No Traefik — frontend runs in Vite dev mode, not a production build.
 *
 * Prerequisites:
 *   - Docker running
 *   - CI-Portal repo cloned adjacent to CI-Hub (see PORTAL_DIR)
 *   - pnpm installed
 *
 * Usage:
 *   pnpm e2e:cross-domain
 */

import { defineConfig, devices } from '@playwright/test';

process.env.E2E_SUITE = 'cross-domain';

// Set E2E_TEST for the spec safety guard (prevents accidental DB wipes outside E2E context)
process.env.E2E_TEST = 'true';
const PORTAL_DIR = process.env.PORTAL_DIR || '';
const PORTAL_PORT = process.env.PORTAL_PORT || '8012';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '9091';
const SERVER_IP = process.env.SERVER_IP || 'localhost';

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e/cross-domain',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://${SERVER_IP}:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  timeout: 90000,
  projects: [
    {
      name: 'cross-domain',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    // 1. CI-Portal via miniflare (wrangler dev)
    {
      command: 'bash e2e/cross-domain/start-portal.sh',
      url: `http://localhost:${PORTAL_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORTAL_DIR,
        PORTAL_PORT,
      },
    },
    // 2. Hub via Docker Compose (backend + frontend + postgres + rabbitmq)
    {
      command: 'bash e2e/cross-domain/start-hub-docker.sh',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 300000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORTAL_PORT,
      },
    },
  ],
});
