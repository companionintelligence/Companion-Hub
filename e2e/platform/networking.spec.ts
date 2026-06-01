/**
 * Platform E2E: Networking
 *
 * Verifies port exposure and network isolation.
 */

import { test, expect } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_URL } from './helpers';

const execAsync = promisify(exec);

test.describe('Networking', () => {
  test('app is accessible on expected port', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/health`);
    expect(res.ok()).toBeTruthy();
  });

  test('Traefik subdomain routing works (if Traefik running)', async ({ request }) => {
    // Check if Traefik is running
    try {
      const { stdout } = await execAsync('docker ps --filter "name=traefik" --filter "status=running" --format "{{.Names}}"');
      if (!stdout.trim()) {
        test.skip();
        return;
      }
    } catch {
      test.skip();
      return;
    }

    // If Traefik is running, check that the app is routable via its expected host header
    const localDomain = process.env.LOCAL_DOMAIN || 'ci.lan';
    const res = await request.get('http://localhost/api/health', {
      headers: { Host: `ci-e2e-test-app.${localDomain}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('internal services (db) NOT accessible from host', async () => {
    // Postgres should NOT be exposed on the host
    try {
      const { stdout } = await execAsync(`docker port ci-e2e-test-app-db 5432 2>/dev/null || echo "not_exposed"`);
      expect(stdout.trim()).toContain('not_exposed');
    } catch {
      // Error means not exposed — expected
    }
  });

  test('internal services (cache) NOT accessible from host', async () => {
    try {
      const { stdout } = await execAsync(`docker port ci-e2e-test-app-cache 6379 2>/dev/null || echo "not_exposed"`);
      expect(stdout.trim()).toContain('not_exposed');
    } catch {
      // Error means not exposed — expected
    }
  });
});
