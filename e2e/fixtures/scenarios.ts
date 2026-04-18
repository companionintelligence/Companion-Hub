/**
 * Scenario fixture factories for composite launch-path testing.
 *
 * Each scenario combines a hub state with additional data seeding
 * to represent a realistic end-to-end verification path.
 *
 * Scenarios:
 *   - firstInstallPath:              locally ready Hub, no users yet
 *   - appLifecycleReconciliation:    locally ready Hub + app in inconsistent state
 *   - multiStore:                    locally ready Hub + multiple app stores
 */

import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { db } from '../helpers/db';
import { locallyReady, seedAppStore, seedMultipleAppStores, TEST_APP_STORE } from './hub-states';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * First install path — the Hub is locally ready and registered,
 * but no operator account has been created yet.
 */
export async function firstInstallPath() {
  await locallyReady();
  // No users, no app stores — this exercises the account-creation launch path.
}

/**
 * App lifecycle reconciliation — the Hub is locally ready, but an app
 * is in an inconsistent "installing" state (e.g. interrupted install).
 * Tests should verify the system can reconcile this on next boot/check.
 */
export async function appLifecycleReconciliation() {
  await locallyReady();
  await seedAppStore();

  // Seed an app stuck in "installing" state (simulates interrupted install)
  await db.insert(schema.app).values({
    status: 'installing',
    config: { id: 'test-stuck-app' },
    version: 1,
    appStoreSlug: TEST_APP_STORE.slug,
    appName: 'test-stuck-app',
  });
}

/**
 * Multi-store — the Hub is locally ready with multiple app store sources.
 * Tests can verify store switching, listing from multiple sources, etc.
 */
export async function multiStore() {
  await locallyReady();
  await seedMultipleAppStores();
}
