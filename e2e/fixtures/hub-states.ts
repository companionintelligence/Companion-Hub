/**
 * Hub state fixture factories.
 *
 * Each function prepares the database, filesystem, and mock portal
 * to put the Hub into a specific launch-critical state for testing.
 *
 * States:
 *   - freshUnregistered: clean DB, no tunnel token, portal says "not registered"
 *   - locallyReady:      registered org in DB, tunnel token on disk, portal says "registered"
 *   - publiclyDelayed:   registered org in DB, tunnel token on disk, portal says "DNS pending"
 *   - degradedHub:       registered org in DB, tunnel token on disk, portal returns 500s
 */

import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { clearDatabase, db, seedOrganization } from '../helpers/db';
import { setPortalScenario } from '../helpers/portal-client';

const TUNNEL_TOKEN_PATH = path.join(process.cwd(), 'tunnel', 'token');
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
  await setPortalScenario('unregistered');
}

/** Locally ready Hub — registered org, tunnel token, portal confirms. */
export async function locallyReady() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
  await setPortalScenario('registered');
}

/** Publicly delayed Hub — org registered but public DNS not propagated. */
export async function publiclyDelayed() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
  await setPortalScenario('delayed');
}

/** Degraded Hub — org registered but portal is returning errors. */
export async function degradedHub() {
  await clearDatabase();
  await seedOrganization();
  writeTunnelToken();
  ensureDataDirs();
  await setPortalScenario('degraded');
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
