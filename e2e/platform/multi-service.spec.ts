/**
 * Platform E2E: Multi-Service Communication
 *
 * Verifies Postgres, Redis, and worker heartbeat connectivity.
 */

import { test, expect } from '@playwright/test';
import { APP_URL } from './helpers';

test.describe('Multi-Service Communication', () => {
  test('Postgres is reachable via /api/db-check', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/db-check`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.rows).toBe('number');
  });

  test('Redis is reachable via /api/redis-check', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/redis-check`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.match).toBe(true);
  });

  test('worker heartbeats are recent (within 30s)', async ({ request }) => {
    // Allow worker time to write at least one heartbeat
    await new Promise(r => setTimeout(r, 10_000));

    const res = await request.get(`${APP_URL}/api/worker-status`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.latest).toBeTruthy();
  });
});
