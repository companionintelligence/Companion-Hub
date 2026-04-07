/**
 * Platform E2E: Orchestrator
 *
 * Main entry point that installs the test app, runs all platform specs,
 * then cleans up. Uses serial execution to maintain state across specs.
 *
 * Individual spec files (lifecycle, web-ui, form-fields, etc.) are run
 * by Playwright as separate test files. This orchestrator handles the
 * setup/teardown that wraps the entire suite.
 *
 * Run with: npx playwright test e2e/platform/
 */

import { test, expect } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_URL, installApp, uninstallApp, waitForRunning, cleanupContainers, buildImages,
} from './helpers';

const execAsync = promisify(exec);

test.describe.serial('Platform E2E Suite', () => {
  test('build test app Docker images', async () => {
    test.setTimeout(120_000);

    // Check if images already exist
    try {
      const { stdout } = await execAsync('docker images ci-e2e-test-app-web:latest --format "{{.ID}}"');
      if (stdout.trim()) {
        console.log('Images already built, skipping');
        return;
      }
    } catch {}

    await buildImages();
  });

  test('install test app and wait for running state', async ({ request }) => {
    test.setTimeout(180_000);

    await cleanupContainers();
    await installApp(request);
    await waitForRunning();

    // Verify health endpoint is up
    for (let i = 0; i < 30; i++) {
      try {
        const res = await request.get(`${APP_URL}/api/health`);
        if (res.ok()) return;
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('App health endpoint never became available');
  });

  // The remaining spec files (web-ui, form-fields, multi-service, storage,
  // networking, health) run as separate Playwright test files in e2e/platform/.
  // They expect the app to already be running (setup by this orchestrator or
  // the CI workflow).

  test('cleanup — uninstall test app', async ({ request }) => {
    test.setTimeout(60_000);
    try {
      await uninstallApp(request);
    } catch {
      // Force cleanup if API uninstall fails
      await cleanupContainers();
    }
  });
});
