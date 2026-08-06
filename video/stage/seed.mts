/**
 * Seed the Companion Hub capture stage.
 *
 *   pnpm exec tsx video/stage/seed.mts     # from the repo root, with the stage env exported
 *
 * This replaces the inline `pnpm exec tsx -e "…"` snippet video/README.md used to
 * carry: a committed script can be reviewed, re-run and referenced from
 * CI-Engineering `tools/stages.json` for an unattended re-shoot.
 *
 * WHAT IT SEEDS AND WHY EACH PIECE IS SHAPED THE WAY IT IS
 *
 * 1. THE ORGANISATION. `e2e/helpers/db.ts` -> `seedOrganization()` writes the slug
 *    `test-org`, and that slug is not an internal detail: the Expose-a-port form
 *    renders the live subdomain preview `<app>-test-org.ci.computer`, so it lands
 *    in the frame. The capture stage uses `acme` instead — the same placeholder
 *    org the editorial reference cut uses
 *    (videos/ci-tutorial-video/storyboard/v2/scenes-v2.json → meta.notes), and the
 *    one storyboard.json's fictional URLs are written against.
 *
 * 2. THE OPERATOR. Same reason. `e2e/helpers/constants.ts` seeds `test@test.com`,
 *    which the login screen prints in its "Sign in as …" hint and Settings →
 *    Security prints again as the change-username placeholder. Visible test data
 *    in a product video reads as a mistake even though nothing about it is false.
 *    The password hash is the one from e2e/helpers/constants.ts, so the password
 *    is still `password`; only the address changes. Hub login is Portal-backed
 *    (see e2e/mock-portal/scenarios.ts), so the mock portal has to accept the same
 *    pair — export MOCK_PORTAL_OPERATOR_EMAIL / _PASSWORD before starting it.
 *
 * 3. THE INSTALLED APPS. DB rows only, no Docker install in flight:
 *    `populateAppInfo` (packages/backend/src/modules/apps/apps.service.ts) falls
 *    back to the marketplace catalog when the installed files are absent, so
 *    `hub-home` gets real tiles with real logos off the CI-Marketplace checkout.
 *
 *    Immich is deliberately NOT one of them. Two shots (`app-details`,
 *    `install-dialog`) film Immich's *store* page and need its Install button, and
 *    the app header swaps Install for Open/Uninstall the moment the app is
 *    installed — that is what made `install-dialog` fail on its
 *    `[data-testid='action-install']` wait.
 *
 *    ⚠ These rows do NOT stay `running`. `app.service.ts` publishes
 *    `sync_app_statuses` on a five-minute cron, and AppStatusSyncService flips
 *    any app with no matching Docker container to `missing`. Seed, then capture
 *    inside that window. Re-run this script before each pass.
 */

// Dynamic imports on purpose: these modules are TS sources compiled on the fly by
// tsx, and a static ESM import of them from a .mts entrypoint fails to resolve
// their named exports ("does not provide an export named 'db'").
const schema = await import('../../packages/backend/src/core/database/drizzle/schema');
const { db } = await import('../../e2e/helpers/db');
const { testUser } = await import('../../e2e/helpers/constants');

const { app, deviceRegistration, user } = schema;

/** The org/device identity storyboard.json is written against. */
const ORG = { id: 'capture-org', slug: 'acme', name: 'Acme', hubSubdomain: 'hub-living-room-server-acme' };

const OPERATOR_EMAIL = process.env.CAPTURE_OPERATOR_EMAIL ?? 'owner@acme.com';

/** Marketplace apps shown as installed on /home. Immich is excluded — see the header. */
const INSTALLED = ['jellyfin', 'home-assistant', 'nextcloud'];

async function main() {
  await db
    .insert(deviceRegistration)
    .values({ ...ORG, tunnelId: null, provisioningPhase: 'locally_ready' })
    .onConflictDoNothing();

  await db
    .insert(user)
    .values({ username: OPERATOR_EMAIL, password: testUser.hashedPassword, operator: true, hasCompletedOnboarding: true })
    .onConflictDoNothing();

  await db
    .insert(app)
    .values(INSTALLED.map((appName) => ({ status: 'running' as const, config: {}, appStoreSlug: 'ci-marketplace', appName })))
    .onConflictDoNothing();

  // Idempotent re-arm: a re-run inside a capture session exists to undo the
  // status sync, so push every row back to `running` whether or not it is new.
  await db.update(app).set({ status: 'running' });

  // biome-ignore lint/suspicious/noConsole: capture-stage script progress output
  console.log(`seeded org=${ORG.slug} operator=${OPERATOR_EMAIL} apps=${INSTALLED.join(',')}`);
  process.exit(0);
}

await main();
