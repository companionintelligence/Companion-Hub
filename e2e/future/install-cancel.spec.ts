/**
 * Install Cancel — FUTURE Docker-in-Docker coverage (CI-Hub#826, Phase 1).
 *
 * Cancelling an in-progress install needs a real, slow image pull to abort
 * mid-flight, so it requires Docker-in-Docker (e.g. e2e/docker-compose.e2e.yml)
 * and is intentionally kept out of the normal CI lane to avoid timing flakiness.
 * The unit/integration coverage for the cancel path lives in:
 *
 *   - packages/backend/src/modules/app-lifecycle/__tests__/app-operation-registry.test.ts
 *   - packages/backend/src/modules/app-lifecycle/__tests__/app-lifecycle.service.test.ts (cancelOperation + finalization)
 *   - packages/backend/src/modules/app-lifecycle/commands/__tests__/install-app-command.test.ts (abort + compensation)
 *   - packages/frontend/.../cancel-install-dialog.test.tsx, app-actions.test.tsx, app-sse-cache.test.ts
 *
 * This stub documents the intended end-to-end scenario for a future DinD run.
 */

import { test } from '@playwright/test';

test.describe('install cancel (DinD)', () => {
  // Skipped: requires a real large-image pull to cancel mid-download.
  test.skip('cancelling a large install removes the partial app and leaves no orphans', async () => {
    // 1. Install a known-large marketplace app.
    // 2. Wait for status 'installing' with download progress > ~60 (pull stage).
    // 3. Click the Cancel button → confirm in CancelInstallDialog.
    // 4. Assert an `install_cancelled` SSE returns the UI to the store/install state.
    // 5. Assert no leftover containers/networks/volumes for the app project, the app
    //    dir + data dir are removed, ports are released, and the DB record is gone
    //    (reuse e2e/helpers/verification.ts → verifyInstalledAppState for the absence check).
  });
});
