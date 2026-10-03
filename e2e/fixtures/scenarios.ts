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
 *   - installedApp:                  locally ready Hub + a running nginx:alpine app
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { db } from '../helpers/db';
import { locallyReady, seedAppStore, seedMultipleAppStores, TEST_APP_STORE } from './hub-states';

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';

/** Opt-in lane. The default Playwright run must not start a container. */
export const E2E_WITH_DOCKER = process.env.E2E_WITH_DOCKER === 'true';

export const INSTALLED_APP = {
  name: 'e2e-nginx',
  storeSlug: 'e2e-store',
  storeName: 'E2E Store',
  hostPort: 18080,
  image: 'nginx:alpine',
} as const;

const COMPOSE_PROJECT = 'cihub-e2e-installed-app';
const COMPOSE_DIR = path.join(DATA_DIR, 'e2e-installed-app');
const COMPOSE_FILE = path.join(COMPOSE_DIR, 'compose.yml');

let containerStarted = false;

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

const INSTALLED_COMPOSE = {
  services: [{ name: 'web', image: INSTALLED_APP.image, internalPort: 80, isMain: true }],
};

const STORE_COMPOSE = {
  services: [{ name: 'web', image: INSTALLED_APP.image, internalPort: 80, isMain: true, restart: 'unless-stopped' }],
};

function appInfo(storeSlug: string, version: string) {
  const writtenAt = Date.now() - 60_000;
  return {
    id: INSTALLED_APP.name,
    urn: `${INSTALLED_APP.name}:${storeSlug}`,
    available: true,
    port: 80,
    name: 'E2E Nginx',
    short_desc: 'nginx for end-to-end coverage',
    author: 'E2E',
    source: 'https://hub.docker.com/_/nginx',
    categories: ['utilities'],
    version,
    cihub_app_version: 1,
    exposable: true,
    no_gui: false,
    supported_architectures: ['amd64', 'arm64'],
    dynamic_config: true,
    created_at: writtenAt,
    updated_at: writtenAt,
  };
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAppTree(root: string, storeSlug: string, version: string, compose: unknown) {
  writeJson(path.join(root, 'config.json'), appInfo(storeSlug, version));
  writeJson(path.join(root, 'docker-compose.json'), compose);
  const description = path.join(root, 'metadata', 'description.md');
  fs.mkdirSync(path.dirname(description), { recursive: true });
  fs.writeFileSync(description, '# E2E Nginx\n\nA running nginx used by the installed-app end-to-end lane.\n');
}

async function ensureNginxContainer() {
  fs.mkdirSync(COMPOSE_DIR, { recursive: true });
  fs.writeFileSync(COMPOSE_FILE, `services:\n  web:\n    image: ${INSTALLED_APP.image}\n    ports:\n      - "${INSTALLED_APP.hostPort}:80"\n`);
  if (containerStarted) return;
  await execFileAsync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'up', '-d'], { timeout: 120_000 });
  containerStarted = true;
}

/**
 * A running one-service app, plus the store copy the details and update
 * screens read. Starts nginx:alpine only when E2E_WITH_DOCKER=true.
 *
 * The store row is in the database. After login, PATCH
 * `/api/marketplace/e2e-store` so the already-running backend loads it.
 * Without that, the details listing and the update diff still see the
 * stores from process start.
 */
export async function installedApp() {
  if (!E2E_WITH_DOCKER) {
    throw new Error('installedApp() starts Docker. Set E2E_WITH_DOCKER=true to run this lane.');
  }

  await locallyReady();

  const storeRoot = path.join(DATA_DIR, 'repos', INSTALLED_APP.storeSlug, 'apps', INSTALLED_APP.name);
  const installedStoreRoot = path.join(DATA_DIR, 'apps', INSTALLED_APP.storeSlug, INSTALLED_APP.name);
  const customRoot = path.join(DATA_DIR, 'apps', '_user', INSTALLED_APP.name);

  writeAppTree(storeRoot, INSTALLED_APP.storeSlug, '1.1.0', STORE_COMPOSE);
  writeAppTree(installedStoreRoot, INSTALLED_APP.storeSlug, '1.0.0', INSTALLED_COMPOSE);
  writeAppTree(customRoot, '_user', '1.0.0', INSTALLED_COMPOSE);

  await db
    .insert(schema.appStore)
    .values({
      slug: INSTALLED_APP.storeSlug,
      hash: 'e2e-installed-app-store',
      name: INSTALLED_APP.storeName,
      enabled: true,
      url: 'https://example.com/e2e-store',
      branch: 'main',
    })
    .onConflictDoNothing();

  const running = {
    status: 'running' as const,
    config: {},
    version: 1,
    port: INSTALLED_APP.hostPort,
    openPort: true,
    exposedLocal: true,
    exposureMode: 'local',
    localSubdomain: INSTALLED_APP.name,
    appName: INSTALLED_APP.name,
  };

  await db.insert(schema.app).values([
    { ...running, appStoreSlug: INSTALLED_APP.storeSlug },
    { ...running, appStoreSlug: '_user' },
  ]);

  await ensureNginxContainer();
}

/** Stop the nginx compose project this scenario started. */
export async function stopInstalledApp() {
  if (!containerStarted && !fs.existsSync(COMPOSE_FILE)) return;
  try {
    await execFileAsync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'down', '--remove-orphans'], {
      timeout: 60_000,
    });
  } catch {
    // The container may already be gone. The files below still need to go.
  }
  containerStarted = false;
  fs.rmSync(COMPOSE_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'repos', INSTALLED_APP.storeSlug), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'apps', INSTALLED_APP.storeSlug), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'apps', '_user', INSTALLED_APP.name), { recursive: true, force: true });
}
