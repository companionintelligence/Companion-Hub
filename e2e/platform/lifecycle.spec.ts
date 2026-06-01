/**
 * Platform E2E: App Lifecycle
 *
 * Tests install, container verification, and uninstall of the test app.
 * Re-installs after uninstall so subsequent specs still have a running app.
 */

import { test, expect } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_ID, login, installApp, uninstallApp, waitForRunning, countContainers, cleanupContainers } from './helpers';

const execAsync = promisify(exec);

test.describe
  .serial('App Lifecycle', () => {
    test.beforeAll(async ({ request }) => {
      await login(request);
      await cleanupContainers();
    });

    test('install test app via Hub API', async ({ request }) => {
      await login(request);
      const result = await installApp(request);
      expect(result).toBeDefined();
    });

    test('all containers reach running state', async () => {
      const running = await waitForRunning(120_000);
      expect(running.length).toBeGreaterThanOrEqual(5);
    });

    test('container count is 5', async () => {
      const count = await countContainers();
      expect(count).toBe(5);
    });

    test('uninstall via Hub API', async ({ request }) => {
      await login(request);
      const result = await uninstallApp(request);
      expect(result).toBeDefined();
    });

    test('all containers removed after uninstall', async () => {
      // Give Docker time to clean up
      await new Promise((r) => setTimeout(r, 10_000));
      const count = await countContainers();
      expect(count).toBe(0);
    });

    test('no orphan containers remain', async () => {
      const { stdout } = await execAsync(`docker ps -a --filter "name=${APP_ID}" --format "{{.Names}}"`);
      const remaining = stdout.trim().split('\n').filter(Boolean);
      expect(remaining).toHaveLength(0);
    });

    test('re-install app for subsequent specs', async ({ request }) => {
      test.setTimeout(180_000);
      await login(request);
      await installApp(request);
      await waitForRunning();
    });
  });
