/**
 * Hub state fixture factories.
 *
 * Each function prepares the database and filesystem to put the Hub
 * into a specific launch-critical state for testing.
 *
 * Now uses a real Portal (miniflare) instead of a mock portal server.
 * The Hub's isRegistered() checks its own DB + tunnel token file —
 * no Portal call is needed during standard E2E tests.
 *
 * States:
 *   - freshUnregistered: clean DB, no tunnel token
 *   - locallyReady:      registered org in DB, tunnel token on disk
 */

import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { clearDatabase, db, seedOrganization } from '../helpers/db';

const TUNNEL_TOKEN_PATH = path.join(process.env.CI_HUB_APP_DIR || process.cwd(), 'tunnel', 'token');
const DATA_DIR = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';

/** Ensure the tunnel token file exists on disk (backend checks this). */
function writeTunnelToken(token = 'e2e-mock-tunnel-token') {
  const dir = path.dirname(TUNNEL_TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TUNNEL_TOKEN_PATH, token, 'utf-8');
}

/** Remove the tunnel token file so isRegistered() returns false. */
function removeTunnelToken() {
  if (fs.existsSync(TUNNEL_TOKEN_PATH)) {
    fs.unlinkSync(TUNNEL_TOKEN_PATH);
  }
}

/** Ensure required data directories exist (mirrors start-backend.sh). */
function ensureDataDirs() {
  const dirs = ['state', 'logs', 'apps', 'app-data', 'repos', 'backups', 'user-config', 'media'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }
  const traefikDirs = ['config', 'dynamic', 'tls'];
  for (const d of traefikDirs) {
    fs.mkdirSync(path.join(DATA_DIR, 'state', 'traefik', d), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Hub states
// ---------------------------------------------------------------------------

/** Fresh unregistered Hub — no org, no users, no tunnel token. */
export async function freshUnregistered() {
  await clearDatabase();
  removeTunnelToken();
  ensureDataDirs();
}

/**
 * Locally ready Hub — registered org + tunnel token seeded in local state.
 *
 * Seeds the DB with an organisation record and writes a tunnel token file.
 * This fixture does NOT call Portal; it only sets up local state so that
 * the Hub's isRegistered() check (DB + tunnel token file) returns true.
 */
export async function locallyReady() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
}

/**
 * Publicly delayed Hub — org registered but public DNS not propagated.
 *
 * With a real Portal, this is the natural state after registration:
 * the Hub is registered locally but the tunnel/DNS isn't actually
 * reachable from the internet. Same DB state as locallyReady.
 */
export async function publiclyDelayed() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
}

/**
 * Degraded Hub — org registered but portal is experiencing errors.
 *
 * With a real Portal, we can't easily simulate 500s. This state is
 * functionally identical to locallyReady for standard E2E tests:
 * the Hub has local registration state and doesn't depend on Portal
 * being healthy for normal operation.
 */
export async function degradedHub() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
}

// ---------------------------------------------------------------------------
// Convenience: seed a test app store
// ---------------------------------------------------------------------------

export const TEST_APP_STORE = {
  slug: 'ci-apps',
  hash: 'e2e-test-hash-001',
  name: 'CI Apps',
  enabled: true,
  url: 'https://github.com/companionintelligence/CI-App-Store',
  branch: 'main',
} as const;

export const SECONDARY_APP_STORE = {
  slug: 'community-apps',
  hash: 'e2e-test-hash-002',
  name: 'Community',
  enabled: true,
  url: 'https://github.com/example/community-store',
  branch: 'main',
} as const;

export async function seedAppStore(store = TEST_APP_STORE) {
  await db.insert(schema.appStore).values(store).onConflictDoNothing();
}

export async function seedMultipleAppStores() {
  await seedAppStore(TEST_APP_STORE);
  await seedAppStore(SECONDARY_APP_STORE);
}
