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
 *
 * 4. TWO MCP API KEYS. Settings → MCP led with "Active keys: 0" in the committed
 *    `mcp-tools` shot — a labelled zero above a catalogue of twenty working
 *    tools, which reads as a product nobody has ever connected anything to. The
 *    keys seeded here are REAL rows in the same `api_key` table
 *    `ApiKeyService.create` writes, minted the same way: 32 random bytes, hex,
 *    SHA-256'd, and only the hash stored. The raw value is generated inside this
 *    process and never printed, written or returned, so no usable credential
 *    exists anywhere — the Hub simply has two keys it cannot show you, which is
 *    exactly the state of a Hub whose operator connected two agents last month.
 *    Nothing credential-shaped is invented: no key string appears in this repo,
 *    in the DB dump, or in any frame. Rows are keyed by name so a re-run does
 *    not stack up a growing count.
 *
 * 5. THE TUNNEL TOKEN, WRITTEN AFTER THE ROW. The Hub counts itself registered
 *    only with a registration row AND a tunnel token on disk. start-backend.sh
 *    writes a dummy token before boot, but since #1472 ("Run the tunnel only
 *    while this Hub is registered") the backend removes a token it finds with no
 *    registration row — and at boot there is none, because this script runs
 *    after the backend is up. The row then lands beside an empty tunnel dir and
 *    the Hub reports `unregistered`, so every page redirects to
 *    /device-registration and every shot times out on its `waitFor`. Measured on
 *    2026-09-27: the stage had not been able to film a signed-in frame since
 *    #1472. Writing the token here, after the row, is what e2e's `locallyReady`
 *    fixture does (e2e/fixtures/hub-states.ts), for the same reason.
 *
 * 6. THE OPERATOR'S PORTAL LINK. Since the one-operator-per-Portal-person work
 *    (#1402, #1437), a password login that names a Portal subject with no
 *    `federated_identity` row, on a Hub that already has an operator, is
 *    admitted only after Portal WhoIs confirms org membership. The mock portal
 *    has no WhoIs route, so that check is `unknown` and login answers 503
 *    AUTH_ERROR_ORG_CHECK_UNAVAILABLE — every `before` block's login fails and
 *    every shot times out on the page behind it. A linked operator takes the
 *    other path, which admits on `unknown` unless the user was revoked. So the
 *    seed writes the link an operator's first sign-in would have written:
 *    issuer = this Hub's CI_CLOUD_URL (AuthService.getPublicPortalBaseUrl),
 *    subject = the id the mock portal signs every accepted email in as
 *    (e2e/mock-portal/scenarios.ts). This is the state of a Hub whose operator
 *    has signed in before, not a bypass: the password is still checked by the
 *    mock portal on every login.
 */

// Dynamic imports on purpose: these modules are TS sources compiled on the fly by
// tsx, and a static ESM import of them from a .mts entrypoint fails to resolve
// their named exports ("does not provide an export named 'db'").
const schema = await import('../../packages/backend/src/core/database/drizzle/schema');
const { db } = await import('../../e2e/helpers/db');
const { testUser } = await import('../../e2e/helpers/constants');
const { createHash, randomBytes } = await import('node:crypto');
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { eq, inArray } = await import('drizzle-orm');

const { apiKey, app, deviceRegistration, federatedIdentity, user } = schema;

/** The org/device identity storyboard.json is written against. */
const ORG = { id: 'capture-org', slug: 'acme', name: 'Acme', hubSubdomain: 'hub-living-room-server-acme' };

const OPERATOR_EMAIL = process.env.CAPTURE_OPERATOR_EMAIL ?? 'owner@acme.com';

/** Header item 6. Normalised the way AuthService.getPublicPortalBaseUrl normalises it. */
const PORTAL_ISSUER = (process.env.CI_CLOUD_URL ?? '').trim().replace(/\/$/, '');
const PORTAL_SUBJECT = 'test-portal-user';

/** Where start-backend.sh and e2e/fixtures/hub-states.ts put the token — see header item 5. */
const TUNNEL_DIR = process.env.CI_HUB_TUNNEL_DIR ?? join(process.env.CI_HUB_DATA_DIR ?? '/tmp/ci-hub-e2e', 'tunnel');

/** Marketplace apps shown as installed on /home. Immich is excluded — see the header. */
const INSTALLED = ['jellyfin', 'home-assistant', 'nextcloud'];

/**
 * Operator MCP keys, as an operator would have created them: named for the machine holding them,
 * scoped to the agent surface, and capability-differentiated so the card's "read-only, read &
 * write, or full access" line describes something that is actually true of this Hub.
 */
const MCP_KEYS: { name: string; capability: 'read' | 'write' | 'full' }[] = [
  { name: 'Studio laptop', capability: 'write' },
  { name: 'Living room tablet', capability: 'read' },
];

async function main() {
  await db
    .insert(deviceRegistration)
    .values({ ...ORG, tunnelId: null, provisioningPhase: 'locally_ready' })
    .onConflictDoNothing();

  // After the row, never before: a token with no row is a leftover the backend removes.
  mkdirSync(TUNNEL_DIR, { recursive: true });
  writeFileSync(join(TUNNEL_DIR, 'token'), 'e2e-mock-tunnel-token', 'utf-8');

  await db
    .insert(user)
    .values({ username: OPERATOR_EMAIL, password: testUser.hashedPassword, operator: true, hasCompletedOnboarding: true })
    .onConflictDoNothing();

  if (!PORTAL_ISSUER) throw new Error('CI_CLOUD_URL is unset — export the stage env before seeding (see header item 6)');
  const [operator] = await db.select({ id: user.id }).from(user).where(eq(user.username, OPERATOR_EMAIL));
  await db
    .insert(federatedIdentity)
    .values({ userId: operator.id, issuer: PORTAL_ISSUER, subject: PORTAL_SUBJECT, email: OPERATOR_EMAIL, emailVerified: true })
    .onConflictDoNothing();

  await db
    .insert(app)
    .values(INSTALLED.map((appName) => ({ status: 'running' as const, config: {}, appStoreSlug: 'ci-marketplace', appName })))
    .onConflictDoNothing();

  // Idempotent re-arm: a re-run inside a capture session exists to undo the
  // status sync, so push every row back to `running` whether or not it is new.
  await db.update(app).set({ status: 'running' });

  // Replace-by-name rather than insert-or-ignore: the hash of a fresh random key never collides, so
  // onConflictDoNothing would add two more rows on every re-run and the shot's key count would
  // climb. Deleting first keeps it at exactly MCP_KEYS.length without ever reusing a secret.
  await db.delete(apiKey).where(
    inArray(
      apiKey.name,
      MCP_KEYS.map(({ name }) => name),
    ),
  );
  await db.insert(apiKey).values(
    MCP_KEYS.map(({ name, capability }) => {
      // Mirrors ApiKeyService.create: 32 random bytes as hex, first 8 chars kept as the display
      // prefix, SHA-256 of the whole thing stored. `raw` dies with this function.
      const raw = randomBytes(32).toString('hex');

      return {
        name,
        capability,
        scopes: ['mcp'],
        prefix: raw.slice(0, 8),
        hashedKey: createHash('sha256').update(raw).digest('hex'),
        managed: false,
        ownerAppUrn: null,
        expiresAt: null,
      };
    }),
  );

  // biome-ignore lint/suspicious/noConsole: capture-stage script progress output
  console.log(
    `seeded org=${ORG.slug} (+tunnel token) operator=${OPERATOR_EMAIL} (portal link ${PORTAL_SUBJECT}) apps=${INSTALLED.join(',')} mcp-keys=${MCP_KEYS.length} (raw values discarded)`,
  );
  process.exit(0);
}

await main();
