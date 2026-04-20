/**
 * Playwright configuration for cross-domain E2E tests.
 *
 * Runs a real CI-Portal via miniflare alongside the Hub's full stack
 * (postgres, rabbitmq, backend, frontend) to test cross-domain flows
 * like device registration.
 *
 * Prerequisites:
 *   - Docker running (for postgres + rabbitmq via docker-compose)
 *   - CI-Portal repo cloned adjacent to CI-Hub (see PORTAL_DIR)
 *   - pnpm installed
 *
 * Usage:
 *   # Start infra first (postgres + rabbitmq)
 *   docker compose -f docker-compose.local.yml up ci-hub-db ci-os-hub-queue -d
 *
 *   # Run cross-domain tests
 *   pnpm e2e:cross-domain
 */

import { defineConfig, devices } from '@playwright/test';

const PORTAL_DIR = process.env.PORTAL_DIR || '';
const PORTAL_PORT = process.env.PORTAL_PORT || '8002';
const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '9091';
const SERVER_IP = process.env.SERVER_IP || 'localhost';

const backendEnv: Record<string, string> = {
  NODE_ENV: 'development',
  E2E_TEST: 'true',
  POSTGRES_HOST: process.env.POSTGRES_HOST || 'localhost',
  POSTGRES_PORT: process.env.POSTGRES_PORT || '6543',
  POSTGRES_USERNAME: process.env.POSTGRES_USERNAME || 'companion',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || 'postgres',
  POSTGRES_DBNAME: process.env.POSTGRES_DBNAME || 'companiondb',
  RABBITMQ_HOST: process.env.RABBITMQ_HOST || 'localhost',
  RABBITMQ_PORT: process.env.RABBITMQ_PORT || '5672',
  RABBITMQ_USERNAME: process.env.RABBITMQ_USERNAME || 'companion',
  RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD || 'admin',
  JWT_SECRET: process.env.JWT_SECRET || 'e2e-cross-domain-jwt-secret',
  // Point Hub at the real local Portal instead of mock
  CI_CLOUD_URL: `http://localhost:${PORTAL_PORT}`,
  DOMAIN: process.env.DOMAIN || 'ci.computer',
  LOCAL_DOMAIN: process.env.LOCAL_DOMAIN || 'ci.lan',
  DEMO_MODE: 'false',
  GUEST_DASHBOARD: 'false',
  TZ: 'UTC',
  THEME_BASE: 'gray',
  THEME_COLOR: 'blue',
  EXPERIMENTAL_INSECURE_COOKIE: 'true',
  CI_HUB_VERSION: 'e2e-cross-domain',
  INTERNAL_IP: '0.0.0.0',
  ROOT_FOLDER_HOST: process.env.ROOT_FOLDER_HOST || '/tmp/ci-hub-e2e',
  CI_HUB_APP_DATA_PATH: process.env.CI_HUB_APP_DATA_PATH || '/tmp/ci-hub-e2e',
  CI_HUB_FORWARD_AUTH_URL: process.env.CI_HUB_FORWARD_AUTH_URL || `http://localhost:${BACKEND_PORT}/api/auth/traefik`,
  ALLOW_AUTO_THEMES: 'true',
  ALLOW_ERROR_MONITORING: 'false',
  PERSIST_TRAEFIK_CONFIG: 'false',
  DEVICE_ID: process.env.DEVICE_ID || 'e2e-cross-domain-device',
  ADVANCED_SETTINGS: 'false',
  DISABLE_PASSWORD_RESET: 'true',
  CI_HUB_DATA_DIR: process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e',
  CI_HUB_APP_DATA_DIR: process.env.CI_HUB_APP_DATA_DIR || '/tmp/ci-hub-e2e/app-data',
  CI_HUB_APP_DIR: process.env.CI_HUB_APP_DIR || process.cwd(),
};

export default defineConfig({
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
    // 2. Hub backend
    {
      command: 'bash e2e/start-backend.sh',
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: backendEnv,
    },
    // 3. Hub frontend
    {
      command: process.env.CI ? 'pnpm run --filter frontend build && pnpm run --filter frontend preview' : 'pnpm run --filter frontend dev',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 120000 : 60000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
