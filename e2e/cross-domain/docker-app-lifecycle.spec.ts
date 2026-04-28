/**
 * Docker app install/start/stop E2E test (cross-domain).
 *
 * Tests the Hub's full app lifecycle via the real Docker stack:
 *   1. Seed a minimal test app (traefik/whoami) in the Hub's marketplace
 *   2. Install the app via Hub API (triggers docker compose up)
 *   3. Verify the app container is running
 *   4. Stop the app via Hub API
 *   5. Verify the app container is stopped
 *   6. Clean up (uninstall)
 *
 * Prerequisites:
 *   - Hub Docker stack running (docker-compose.local.yml + cross-domain override)
 *   - Docker socket accessible from Hub container
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { db } from '../helpers/db';
import { testUser } from '../helpers/constants';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';

const HUB_BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;
const HUB_CONTAINER = 'ci-hub-e2e-hub';

// DATA_DIR inside the container is /data (set via CI_HUB_DATA_DIR env)
const CONTAINER_DATA_DIR = '/data';

const TEST_STORE_SLUG = 'e2e-test-store';
const TEST_APP_NAME = 'whoami';
const TEST_APP_URN = `${TEST_APP_NAME}:${TEST_STORE_SLUG}`;

// Minimal config.json for the test app (matches appInfoSchema)
const TEST_APP_CONFIG = {
  id: TEST_APP_NAME,
  urn: TEST_APP_URN,
  available: true,
  port: 18080,
  name: 'E2E Whoami',
  description: 'Minimal HTTP responder for E2E testing',
  version: '1.0.0',
  tipi_version: 1,
  short_desc: 'E2E test app',
  author: 'E2E',
  source: 'https://github.com/traefik/whoami',
  categories: ['utilities'],
  form_fields: [],
  dynamic_config: true,
  supported_architectures: ['arm64', 'amd64'],
};

// docker-compose.json (V2 schema) — uses traefik/whoami, a tiny HTTP responder
const TEST_COMPOSE_JSON = {
  schemaVersion: 2,
  services: [
    {
      name: TEST_APP_NAME,
      image: 'traefik/whoami:latest',
      isMain: true,
      internalPort: 80,
    },
  ],
};

/** Auth headers for Hub API calls. */
function authHeaders(sessionId: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-ci-hub-session': sessionId };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

/**
 * Seed the test app files inside the Hub container.
 * The Hub reads apps from ${DATA_DIR}/repos/{storeSlug}/apps/{appName}/.
 * Since /data/repos is NOT volume-mounted, we must write inside the container.
 */
function seedAppFilesInContainer() {
  const appDir = `${CONTAINER_DATA_DIR}/repos/${TEST_STORE_SLUG}/apps/${TEST_APP_NAME}`;
  const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const os = require('node:os');

  // Create temp directory with app files
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'e2e-app-seed-'));
  writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(TEST_APP_CONFIG, null, 2));
  writeFileSync(join(tmpDir, 'docker-compose.json'), JSON.stringify(TEST_COMPOSE_JSON, null, 2));

  // Create target directory and copy files into container
  execSync(`docker exec ${HUB_CONTAINER} mkdir -p ${appDir}`, { stdio: 'pipe' });
  execSync(`docker cp ${join(tmpDir, 'config.json')} ${HUB_CONTAINER}:${appDir}/config.json`, { stdio: 'pipe' });
  execSync(`docker cp ${join(tmpDir, 'docker-compose.json')} ${HUB_CONTAINER}:${appDir}/docker-compose.json`, { stdio: 'pipe' });

  // Verify files exist
  const check = execSync(`docker exec ${HUB_CONTAINER} ls ${appDir}/`, { encoding: 'utf-8' });
  if (!check.includes('config.json')) {
    throw new Error(`Failed to seed app files. Directory contents: ${check}`);
  }

  // Clean up temp dir
  rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Clean up seeded app files inside the container.
 */
function cleanupAppFilesInContainer() {
  try {
    execSync(`docker exec ${HUB_CONTAINER} rm -rf ${CONTAINER_DATA_DIR}/repos/${TEST_STORE_SLUG}`, { stdio: 'pipe' });
  } catch {
    // Container may be stopped during teardown
  }
}

/** Helper: login to Hub API and return session ID. */
async function loginToHub(): Promise<string> {
  // First ensure the test user exists in the DB
  await db
    .insert(schema.user)
    .values({
      password: testUser.hashedPassword,
      username: testUser.email,
      operator: true,
      hasCompletedOnboarding: true,
    })
    .onConflictDoNothing();

  // Login via API
  const res = await fetch(`${HUB_BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUser.email, password: testUser.password }),
  });

  if (!res.ok) {
    throw new Error(`Hub login failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { sessionId?: string; success?: boolean };
  if (!body.sessionId) {
    throw new Error('No sessionId in login response');
  }

  return body.sessionId;
}

/** Helper: wait for app status to reach a target state. */
async function waitForAppStatus(sessionId: string, appUrn: string, targetStatus: string, timeoutMs = 120000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${HUB_BACKEND_URL}/api/apps/${encodeURIComponent(appUrn)}`, {
      headers: authHeaders(sessionId),
    });
    if (res.ok) {
      const data = (await res.json()) as { status?: string; info?: { status?: string } };
      const status = data.status || data.info?.status;
      if (status === targetStatus) return status;
      if (status === 'install_error' || status === 'start_error') {
        throw new Error(`App entered error state: ${status}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`App did not reach status "${targetStatus}" within ${timeoutMs}ms`);
}

test.describe
  .skip('Docker App Install/Start/Stop', () => {
    // SKIP: The Hub's marketplace caches stores at startup and reads app configs
    // from git-cloned repos via `MarketplaceService.initialize()`. Seeding files
    // inside the container after startup doesn't trigger a re-scan, and calling
    // POST /marketplace/pull tries to git-clone the store URL (which doesn't exist).
    //
    // To properly test this, we need either:
    //   1. A real git repo (or local git server) to serve as the app store
    //   2. A pre-seeded store in the Docker image build
    //   3. An API endpoint that triggers a local-only rescan without git pull
    //
    // Tracked for follow-up implementation.
    let sessionId: string;

    test.beforeAll(async () => {
      // Safety guard
      if (process.env.E2E_TEST !== 'true') {
        throw new Error('Must run with E2E_TEST=true');
      }

      // Seed organization (required for registration status)
      await db.delete(schema.app);
      await db.delete(schema.appStore);
      await db
        .insert(schema.deviceRegistration)
        .values({
          id: 'test-org-docker',
          name: 'Docker Test Org',
          slug: 'docker-test-org',
          tunnelId: null,
          domain: 'docker-test.example.com',
        })
        .onConflictDoNothing();

      // Create tunnel token inside the Hub container so isRegistered() returns true
      try {
        execSync(`docker exec ${HUB_CONTAINER} mkdir -p /app/tunnel`, { stdio: 'pipe' });
        execSync(`docker exec ${HUB_CONTAINER} sh -c "echo e2e-docker-test-token > /app/tunnel/token"`, { stdio: 'pipe' });
      } catch (err) {
        console.warn('Failed to create tunnel token inside Hub container:', err);
      }

      // Seed the app store in the DB
      await db
        .insert(schema.appStore)
        .values({
          slug: TEST_STORE_SLUG,
          hash: 'e2e-docker-hash',
          name: 'E2E Test Store',
          enabled: true,
          url: 'https://example.com/e2e-store',
          branch: 'main',
        })
        .onConflictDoNothing();

      // Seed test app files inside the Hub container
      seedAppFilesInContainer();

      // Trigger marketplace pull so the Hub picks up the new store
      try {
        await fetch(`${HUB_BACKEND_URL}/api/marketplace/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        // Pull might fail if auth is required — that's fine, the files are already seeded
      }

      // Login to get session
      sessionId = await loginToHub();
    });

    test.afterAll(async () => {
      // Clean up: uninstall the app if installed
      try {
        await fetch(`${HUB_BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(TEST_APP_URN)}/uninstall`, {
          method: 'DELETE',
          headers: authHeaders(sessionId, 'application/json'),
          body: JSON.stringify({ removeBackups: true }),
        });
        // Wait a bit for Docker cleanup
        await new Promise((r) => setTimeout(r, 5000));
      } catch {
        // Ignore cleanup errors
      }

      // Clean up files inside container
      cleanupAppFilesInContainer();

      // Clean up DB
      await db.delete(schema.app);
      await db.delete(schema.appStore);
    });

    test('Hub marketplace sees the test app', async () => {
      // Give Hub a moment to pick up the new store files
      await new Promise((r) => setTimeout(r, 3000));

      // Try the search endpoint which is the primary marketplace API
      const res = await fetch(`${HUB_BACKEND_URL}/api/marketplace/apps/search?pageSize=50`, {
        headers: authHeaders(sessionId),
      });

      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>;
        const apps = Array.isArray(data) ? data : (data.data ?? []);
        const testApp = apps.find((a) => a.id === TEST_APP_NAME);
        expect(testApp, `Test app "${TEST_APP_NAME}" not found in marketplace results. Got: ${JSON.stringify(apps.map((a) => a.id))}`).toBeTruthy();
        expect(testApp?.name).toBe('E2E Whoami');
      } else {
        // If search endpoint doesn't work, try the /all endpoint
        const allRes = await fetch(`${HUB_BACKEND_URL}/api/marketplace/all`, {
          headers: authHeaders(sessionId),
        });
        expect(allRes.ok, `Marketplace /all failed: ${allRes.status}`).toBeTruthy();
        const allData = (await allRes.json()) as Array<{ id?: string; name?: string }>;
        const testApp = allData.find((a) => a.id === TEST_APP_NAME);
        expect(testApp, `Test app "${TEST_APP_NAME}" not found in /all`).toBeTruthy();
      }
    });

    test('install the test app via API', async () => {
      const res = await fetch(`${HUB_BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(TEST_APP_URN)}/install`, {
        method: 'POST',
        headers: authHeaders(sessionId, 'application/json'),
        body: JSON.stringify({ port: 18080, exposureMode: 'local' }),
      });

      expect(res.ok, `Install request failed: ${await res.text()}`).toBeTruthy();
      const body = (await res.json()) as { requestId?: string };
      expect(body.requestId).toBeTruthy();

      // Wait for the app to be running (docker pull + compose up)
      const status = await waitForAppStatus(sessionId, TEST_APP_URN, 'running', 180000);
      expect(status).toBe('running');
    });

    test('stop the app via API', async () => {
      const res = await fetch(`${HUB_BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(TEST_APP_URN)}/stop`, {
        method: 'POST',
        headers: authHeaders(sessionId),
      });

      expect(res.ok, `Stop request failed: ${await res.text()}`).toBeTruthy();

      // Wait for stopped status
      const status = await waitForAppStatus(sessionId, TEST_APP_URN, 'stopped', 60000);
      expect(status).toBe('stopped');
    });

    test('start the app via API', async () => {
      const res = await fetch(`${HUB_BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(TEST_APP_URN)}/start`, {
        method: 'POST',
        headers: authHeaders(sessionId),
      });

      expect(res.ok, `Start request failed: ${await res.text()}`).toBeTruthy();

      // Wait for running status
      const status = await waitForAppStatus(sessionId, TEST_APP_URN, 'running', 120000);
      expect(status).toBe('running');
    });

    test('uninstall the app via API', async () => {
      const res = await fetch(`${HUB_BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(TEST_APP_URN)}/uninstall`, {
        method: 'DELETE',
        headers: authHeaders(sessionId, 'application/json'),
        body: JSON.stringify({ removeBackups: true }),
      });

      expect(res.ok, `Uninstall request failed: ${await res.text()}`).toBeTruthy();

      // Verify app is removed from the apps list
      await new Promise((r) => setTimeout(r, 5000));
      const appsRes = await fetch(`${HUB_BACKEND_URL}/api/apps`, {
        headers: authHeaders(sessionId),
      });
      expect(appsRes.ok).toBeTruthy();

      const apps = (await appsRes.json()) as Array<{ id?: string; appName?: string }>;
      const installed = apps.find((a) => a.appName === TEST_APP_NAME);
      expect(installed).toBeFalsy();
    });
  });
