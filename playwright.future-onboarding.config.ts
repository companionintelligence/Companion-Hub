/**
 * Playwright config for future onboarding AI setup E2E.
 *
 * Uses the default Hub stack (mock portal :4444, backend, frontend) but runs
 * only e2e/future/onboarding-ai-setup.spec.ts — excluded from playwright.config.ts.
 *
 * Usage: pnpm e2e:future:onboarding
 */

import path from 'node:path';
import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.ts';

const inferenceFixturePort = process.env.FTUE_INFERENCE_FIXTURE_PORT ?? '18090';
const inferenceFixtureUrl = `http://127.0.0.1:${inferenceFixturePort}`;
const marketplaceDir = path.resolve('e2e/future/fixtures/marketplace');
const hostMetricsFixture = path.resolve('e2e/future/fixtures/host_metrics.apple-silicon.json');
const baseWebServers = Array.isArray(baseConfig.webServer) ? baseConfig.webServer : baseConfig.webServer ? [baseConfig.webServer] : [];

const webServers = baseWebServers.map((server) => {
  const command = typeof server.command === 'string' ? server.command : '';
  const sharedEnvironment = {
    ...server.env,
    CI_MARKETPLACE_DIR: marketplaceDir,
  };

  if (command.includes('start-backend.sh')) {
    return {
      ...server,
      reuseExistingServer: false,
      env: {
        ...sharedEnvironment,
        ARCHITECTURE: 'arm64',
        CI_HUB_HOST_PLATFORM: 'darwin',
        E2E_COPY_MARKETPLACE: 'true',
        E2E_HOST_METRICS_FIXTURE: hostMetricsFixture,
        RABBITMQ_QUEUE_PREFIX: 'ftue-e2e',
        OLLAMA_URL: `${inferenceFixtureUrl}/ollama`,
        DSPARK_URL: `${inferenceFixtureUrl}/dspark`,
        MTPLX_URL: `${inferenceFixtureUrl}/mtplx`,
        VLLM_URL: `${inferenceFixtureUrl}/vllm`,
        SPECULATIVE_INFERENCE_URL: `${inferenceFixtureUrl}/lucebox`,
        LUCEBOX_URL: `${inferenceFixtureUrl}/lucebox`,
        LEMONADE_URL: `${inferenceFixtureUrl}/lemonade`,
      },
    };
  }

  return {
    ...server,
    reuseExistingServer: false,
    env: sharedEnvironment,
  };
});

export default defineConfig({
  ...baseConfig,
  testMatch: '**/future/onboarding-ai-setup.spec.ts',
  testIgnore: ['**/generated/**', '**/cross-domain/**', '**/platform/**', '**/mcp-openclaw-integration.spec.ts', '**/app-store-lifecycle.spec.ts'],
  timeout: 180_000,
  expect: {
    ...baseConfig.expect,
    timeout: 20_000,
  },
  webServer: [
    {
      command: 'pnpm exec tsx e2e/future/fixtures/inference-engine-server.ts',
      url: `${inferenceFixtureUrl}/___control`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        FTUE_INFERENCE_FIXTURE_PORT: inferenceFixturePort,
      },
    },
    ...webServers,
  ],
});
