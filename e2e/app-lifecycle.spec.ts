/**
 * Maintained lifecycle foundation coverage for DAG issue #387.
 *
 * Full Docker-in-Docker lifecycle install tests remain in e2e/future/, but
 * this file keeps the critical reconciliation baseline active in normal CI.
 */

import { test } from '@playwright/test';
import { loginUser } from './fixtures/fixtures';
import { appLifecycleReconciliation } from './fixtures/scenarios';
import { verifyDashboard, verifyInstalledAppState } from './helpers/verification';

test.describe('App Lifecycle (reconciliation foundation)', () => {
  test.beforeEach(async () => {
    await appLifecycleReconciliation();
  });

  test('stuck app remains visible in the seeded reconciliation state', async () => {
    await verifyInstalledAppState('test-stuck-app', 'installing');
  });

  test('dashboard remains reachable with reconciliation data present', async ({ page }) => {
    await loginUser(page);
    await verifyDashboard(page);
  });
});
