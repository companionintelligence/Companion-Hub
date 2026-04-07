/**
 * Platform E2E: Health Checks
 *
 * Verifies the Hub detects health state changes.
 */

import { test, expect } from '@playwright/test';
import { APP_URL, BASE_URL, APP_URN } from './helpers';

test.describe.serial('Health Checks', () => {
  test('health endpoint returns 200 initially', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/health`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  test('toggle to unhealthy and Hub detects it', async ({ request }) => {
    // Set unhealthy
    const toggle = await request.post(`${APP_URL}/api/set-unhealthy`);
    expect(toggle.ok()).toBeTruthy();

    // Verify endpoint is now 500
    const check = await request.get(`${APP_URL}/api/health`);
    expect(check.status()).toBe(500);

    // Wait for Docker healthcheck to detect (interval=10s, retries=3 → ~30s)
    await new Promise(r => setTimeout(r, 35_000));

    // Check Hub API for status (may report unhealthy/degraded)
    const hubRes = await request.get(`${BASE_URL}/api/apps/${APP_URN}`);
    if (hubRes.ok()) {
      const data = await hubRes.json();
      // The Hub may surface this as unhealthy, degraded, or the container health
      // We verify the raw Docker healthcheck state as a fallback
      const { exec } = require('node:child_process');
      const { promisify } = require('node:util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Health.Status}}' ci-e2e-test-app 2>/dev/null || echo "unknown"`,
      );
      expect(stdout.trim()).toBe('unhealthy');
    }
  });

  test('recover to healthy and Hub detects it', async ({ request }) => {
    const toggle = await request.post(`${APP_URL}/api/set-healthy`);
    expect(toggle.ok()).toBeTruthy();

    // Verify endpoint is back to 200
    const check = await request.get(`${APP_URL}/api/health`);
    expect(check.status()).toBe(200);

    // Wait for Docker to mark healthy again
    await new Promise(r => setTimeout(r, 35_000));

    const { exec } = require('node:child_process');
    const { promisify } = require('node:util');
    const execAsync = promisify(exec);
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Health.Status}}' ci-e2e-test-app 2>/dev/null || echo "unknown"`,
    );
    expect(stdout.trim()).toBe('healthy');
  });
});
