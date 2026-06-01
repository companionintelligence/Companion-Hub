import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '9091';
const USE_REAL_PORTAL = process.env.E2E_USE_REAL_PORTAL === 'true';
const PORTAL_PORT = process.env.PORTAL_PORT || '8012';
const MOCK_PORTAL_PORT = process.env.MOCK_PORTAL_PORT || '4444';
const SERVER_IP = process.env.SERVER_IP || 'localhost';

// Common env vars needed by the backend
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
  JWT_SECRET: process.env.JWT_SECRET || 'e2e-test-secret',
  CI_CLOUD_URL: process.env.CI_CLOUD_URL || `http://localhost:${USE_REAL_PORTAL ? PORTAL_PORT : MOCK_PORTAL_PORT}`,
  DOMAIN: process.env.DOMAIN || 'ci.computer',
  LOCAL_DOMAIN: process.env.LOCAL_DOMAIN || 'ci.lan',
  DEMO_MODE: 'false',
  GUEST_DASHBOARD: 'false',
  TZ: 'UTC',
  THEME_BASE: 'gray',
  THEME_COLOR: 'blue',
  EXPERIMENTAL_INSECURE_COOKIE: 'true',
  CI_HUB_VERSION: 'e2e',
  INTERNAL_IP: '0.0.0.0',
  ROOT_FOLDER_HOST: process.env.ROOT_FOLDER_HOST || '/tmp/ci-hub-e2e',
  CI_HUB_APP_DATA_PATH: process.env.CI_HUB_APP_DATA_PATH || '/tmp/ci-hub-e2e',
  CI_HUB_FORWARD_AUTH_URL: process.env.CI_HUB_FORWARD_AUTH_URL || 'http://localhost:3000/api/auth/traefik',
  ALLOW_AUTO_THEMES: 'true',
  ALLOW_ERROR_MONITORING: 'false',
  PERSIST_TRAEFIK_CONFIG: 'false',
  PRIVATE_VPN_ENABLED: 'false',
  DEVICE_ID: process.env.DEVICE_ID || 'test-device-e2e',
  ADVANCED_SETTINGS: 'false',
  DISABLE_PASSWORD_RESET: 'true',
  CI_HUB_DATA_DIR: process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e',
  CI_HUB_APP_DATA_DIR: process.env.CI_HUB_APP_DATA_DIR || '/tmp/ci-hub-e2e/app-data',
  CI_HUB_APP_DIR: process.env.CI_HUB_APP_DIR || process.cwd(),
  CI_HUB_TUNNEL_DIR: process.env.CI_HUB_TUNNEL_DIR || '/tmp/ci-hub-e2e/tunnel',
  MCP_API_KEY: process.env.MCP_API_KEY || 'test-mcp-api-key-e2e',
};

export default defineConfig({
  testDir: './e2e',
  testIgnore: [
    '**/future/**',
    '**/generated/**',
    '**/cross-domain/**',
    '**/platform/**',
    ...(USE_REAL_PORTAL ? [] : ['**/app-store-lifecycle.spec.ts']),
  ],
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
  timeout: 60000,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    ...(USE_REAL_PORTAL
      ? [
          {
            // Real CI-Portal for explicit cross-repo runs only.
            command: 'bash e2e/cross-domain/start-portal.sh',
            url: `http://localhost:${PORTAL_PORT}/api/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 120000,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              PORTAL_DIR: process.env.PORTAL_DIR || '',
              PORTAL_PORT,
            },
          },
        ]
      : [
          {
            // Lightweight mock portal — simulates CI Portal for local/CI E2E without hitting production.
            command: 'pnpm exec tsx e2e/mock-portal/server.ts',
            url: `http://localhost:${MOCK_PORTAL_PORT}/___control`,
            reuseExistingServer: !process.env.CI,
            timeout: 15000,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              MOCK_PORTAL_PORT,
              MOCK_PORTAL_SCENARIO: 'registered',
            },
          },
        ]),
    {
      command: 'bash e2e/start-backend.sh',
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: backendEnv,
    },
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
