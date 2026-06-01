/**
 * Platform E2E: Storage Persistence
 *
 * Verifies file writes persist across container restarts.
 */

import { test, expect } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_URL } from './helpers';

const execAsync = promisify(exec);

test.describe
  .serial('Storage Persistence', () => {
    const testContent = `e2e-storage-test-${Date.now()}`;

    test('write a file via /api/write-file', async ({ request }) => {
      const res = await request.post(`${APP_URL}/api/write-file`, {
        data: { filename: 'test.txt', content: testContent },
      });
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    test('read file back via /api/read-file', async ({ request }) => {
      const res = await request.get(`${APP_URL}/api/read-file?filename=test.txt`);
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.content).toBe(testContent);
    });

    test('file persists across container restart', async ({ request }) => {
      // Restart the web container
      await execAsync('docker restart ci-e2e-test-app');

      // Wait for it to come back
      for (let i = 0; i < 30; i++) {
        try {
          const res = await request.get(`${APP_URL}/api/health`);
          if (res.ok()) break;
        } catch {
          /* ignored */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const res = await request.get(`${APP_URL}/api/read-file?filename=test.txt`);
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.content).toBe(testContent);
    });
  });
