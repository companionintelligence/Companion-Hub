import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = process.env.BACKEND_PORT || '3000';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '9091';
const SERVER_IP = process.env.SERVER_IP || 'localhost';

// Common env vars needed by the backend
const backendEnv: Record<string, string> = {
  NODE_ENV: 'development',
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
  CI_CLOUD_URL: process.env.CI_CLOUD_URL || 'https://app.companionintelligence.com',
  DOMAIN: process.env.DOMAIN || 'ci.computer',
  LOCAL_DOMAIN: process.env.LOCAL_DOMAIN || 'ci.lan',
  DEMO_MODE: 'false',
  GUEST_DASHBOARD: 'false',
  TZ: 'UTC',
  THEME_BASE: 'gray',
  THEME_COLOR: 'blue',
  EXPERIMENTAL_INSECURE_COOKIE: 'true',
  CI_HUB_VERSION: 'e2e',
  TIPI_VERSION: 'e2e',
  INTERNAL_IP: '0.0.0.0',
  ROOT_FOLDER_HOST: process.env.ROOT_FOLDER_HOST || '/tmp/ci-hub-e2e',
  RUNTIPI_APP_DATA_PATH: process.env.RUNTIPI_APP_DATA_PATH || '/tmp/ci-hub-e2e',
  RUNTIPI_FORWARD_AUTH_URL: 'http://localhost:3000/api/auth/traefik',
  ALLOW_AUTO_THEMES: 'true',
  ALLOW_ERROR_MONITORING: 'false',
  PERSIST_TRAEFIK_CONFIG: 'false',
  DEVICE_ID: process.env.DEVICE_ID || 'test-device-e2e',
  ADVANCED_SETTINGS: 'false',
  DISABLE_PASSWORD_RESET: 'true',
  TIPI_DATA_DIR: process.env.TIPI_DATA_DIR || '/tmp/ci-hub-e2e',
  TIPI_APP_DATA_DIR: process.env.TIPI_APP_DATA_DIR || '/tmp/ci-hub-e2e/app-data',
  TIPI_APP_DIR: process.env.TIPI_APP_DIR || process.cwd(),
};

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/future/**', '**/generated/**'],
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
      command: process.env.CI ? 'bun run --filter frontend build && bun run --filter frontend preview' : 'bun run --filter frontend dev',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 120000 : 60000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
