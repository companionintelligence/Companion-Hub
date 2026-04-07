/**
 * Platform E2E: Orchestrator
 *
 * Builds test app Docker images. App install/uninstall is handled by the
 * CI workflow (or lifecycle.spec.ts for lifecycle-specific tests).
 *
 * Run with: npx playwright test e2e/platform/
 */

import { test } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { buildImages } from './helpers';

const execAsync = promisify(exec);

test.describe
  .serial('Platform E2E Suite', () => {
    test('build test app Docker images', async () => {
      test.setTimeout(120_000);

      // Check if images already exist
      try {
        const { stdout } = await execAsync('docker images ci-e2e-test-app-web:latest --format "{{.ID}}"');
        if (stdout.trim()) {
          return;
        }
      } catch {
        /* ignored */
      }

      await buildImages();
    });
  });
