import { defineConfig, devices } from '@playwright/test';

// Single source of truth for the backend port. The backend process reads API_PORT while
// Playwright's health check and the direct-call specs use BACKEND_PORT, so both the backend's
// API_PORT and the vite /api proxy target are wired to this one value (below). They can't
// diverge, so the backend never listens on a port nothing is waiting on.
const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '9091';
const USE_REAL_PORTAL = process.env.E2E_USE_REAL_PORTAL === 'true';
// Opt in to the generated app-catalog batch specs. Set by the private fleet QA
// harness (CI-Engineering `tools/fleet-qa/`) when running catalog batches; unset
// everywhere else so the default E2E lane stays fast and infra-light.
const RUN_CATALOG_TESTS = process.env.E2E_RUN_CATALOG_TESTS === 'true';
const PORTAL_PORT = process.env.PORTAL_PORT || '8012';
const MOCK_PORTAL_PORT = process.env.MOCK_PORTAL_PORT || '4444';
const SERVER_IP = process.env.SERVER_IP || 'localhost';

// Common env vars needed by the backend
const backendEnv: Record<string, string> = {
  NODE_ENV: 'development',
  E2E_TEST: 'true',
  API_PORT: BACKEND_PORT,
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
  PRIVATE_VPN_USER_DISABLED: 'true',
  DEVICE_ID: process.env.DEVICE_ID || 'test-device-e2e',
  ADVANCED_SETTINGS: 'false',
  DISABLE_PASSWORD_RESET: 'true',
  CI_HUB_DATA_DIR: process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e',
  CI_HUB_APP_DATA_DIR: process.env.CI_HUB_APP_DATA_DIR || '/tmp/ci-hub-e2e/app-data',
  CI_HUB_APP_DIR: process.env.CI_HUB_APP_DIR || process.cwd(),
  CI_HUB_TUNNEL_DIR: process.env.CI_HUB_TUNNEL_DIR || '/tmp/ci-hub-e2e/tunnel',
};

export default defineConfig({
  testDir: './e2e',
  // Extended suites (future/, cross-domain/, platform/) are excluded from the default
  // CI lane for cost and infra reasons. See e2e/README.md and .github/workflows/e2e-extended.yml.
  //
  // `generated/` holds the app-catalog batch specs that the fleet QA harness runs
  // (scripts/run-fleet-tests.ts, .github/workflows/app-catalog-fleet.yml). Ignoring
  // it unconditionally meant those runs matched zero tests — testIgnore applies even
  // when a spec is named explicitly on the command line, so both the harness and the
  // workflow reported "No tests found" while exiting 0. Gate it instead, so the
  // default lane still skips the catalog while the fleet can opt in.
  testIgnore: [
    '**/future/**',
    ...(RUN_CATALOG_TESTS ? [] : ['**/generated/**']),
    '**/cross-domain/**',
    '**/platform/**',
    '**/mcp-openclaw-integration.spec.ts',
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
      // Pin the port contract so vite serves on FRONTEND_PORT (not its default 5005) and
      // proxies /api to the backend on API_PORT. Single source of truth for every entrypoint
      // (CI, extended, fleet, local) so callers don't each have to re-export these.
      env: {
        FRONTEND_PORT,
        API_PORT: BACKEND_PORT,
      },
    },
  ],
});
