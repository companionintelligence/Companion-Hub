/**
 * Maintained multi-store / desktop-adjacent configuration coverage for DAG
 * issue #387. This replaces the previous placeholder skip with deterministic
 * verification that the settings surface can render multiple store sources.
 */

import { test } from '@playwright/test';
import { loginUser } from './fixtures/fixtures';
import { multiStore } from './fixtures/scenarios';
import { verifyAppStoreNames, verifySeededAppStores } from './helpers/verification';

test.describe('Dev Mode (multi-store foundation)', () => {
  test.beforeEach(async () => {
    await multiStore();
  });

  test('app-store records are seeded for multiple sources', async () => {
    await verifySeededAppStores(['ci-apps', 'community-apps']);
  });

  test('settings shows both app-store sources', async ({ page }) => {
    await loginUser(page);
    await verifyAppStoreNames(page, ['CI Apps', 'Community']);
  });
});
