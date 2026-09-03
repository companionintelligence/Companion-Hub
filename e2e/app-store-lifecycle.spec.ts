/**
 * App store lifecycle E2E test.
 *
 * Exercises the Portal's app store pipeline end-to-end:
 *   1. Upload a minimal test app bundle to Portal via POST /api/store/ingest
 *   2. Publish it via POST /api/store/publish/:id
 *   3. Verify it appears in the store catalog via GET /api/store
 *   4. Verify install data is returned via GET /api/store/:id/install
 *
 * This test uses the real Portal (miniflare with local R2/D1) — no mocks.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORTAL_URL = process.env.PORTAL_URL || `http://localhost:${process.env.PORTAL_PORT || '8012'}`;
const ADMIN_API_KEY = 'e2e-cross-domain-admin-api-key-value';

const TEST_APP_ID = `e2e-test-app-${Date.now()}`;
const TEST_APP_CONFIG = {
  id: TEST_APP_ID,
  name: 'E2E Test App',
  version: '1.0.0',
  description: 'A minimal test app for E2E store lifecycle verification',
  short_desc: 'Test app for E2E',
  categories: ['utilities'],
  port: 8080,
};

const TEST_COMPOSE = {
  services: [
    {
      name: 'main',
      image: 'traefik/whoami:latest',
      isMain: true,
      internalPort: 80,
    },
  ],
};

/**
 * Create a minimal .tar.gz app bundle in a temp directory.
 * Bundle structure:
 *   config.json
 *   docker-compose.json
 */
function createTestBundle(): Buffer {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-app-bundle-'));
  const bundleDir = path.join(tmpDir, 'app');

  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(bundleDir, 'config.json'), JSON.stringify(TEST_APP_CONFIG));
  writeFileSync(path.join(bundleDir, 'docker-compose.json'), JSON.stringify(TEST_COMPOSE));

  const tarPath = path.join(tmpDir, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', tmpDir, 'app'], { stdio: 'pipe' });

  const buffer = readFileSync(tarPath);
  rmSync(tmpDir, { recursive: true, force: true });
  return buffer;
}

test.describe('App Store Lifecycle with Real R2', () => {
  test.skip(process.env.E2E_USE_REAL_PORTAL !== 'true', 'Requires real CI-Portal (start-portal.sh)');

  test('ingest, publish, and fetch app from Portal store', async ({ request }) => {
    // Step 1: Upload the app bundle to Portal
    const bundle = createTestBundle();

    const ingestResponse = await request.post(`${PORTAL_URL}/api/store/ingest`, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: bundle,
    });

    expect(ingestResponse.ok(), `Ingest failed: ${await ingestResponse.text()}`).toBeTruthy();
    const ingestData = await ingestResponse.json();
    expect(ingestData.success).toBe(true);
    expect(ingestData.id).toBe(TEST_APP_ID);
    expect(ingestData.status).toBe('pending');

    // Step 2: Publish the app (no local registry images, so it should succeed)
    const publishResponse = await request.post(`${PORTAL_URL}/api/store/publish/${TEST_APP_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: JSON.stringify({ public: true }),
    });

    expect(publishResponse.ok(), `Publish failed: ${await publishResponse.text()}`).toBeTruthy();
    const publishData = await publishResponse.json();
    expect(publishData.success).toBe(true);
    expect(publishData.status).toBe('published');

    // Step 3: Verify the app appears in the store catalog
    const catalogResponse = await request.get(`${PORTAL_URL}/api/store`);
    expect(catalogResponse.ok()).toBeTruthy();
    const catalog = await catalogResponse.json();
    expect(Array.isArray(catalog)).toBeTruthy();

    const testApp = catalog.find((app: { id?: string; title?: string }) => app.id === TEST_APP_ID);
    expect(testApp, `App ${TEST_APP_ID} not found in catalog`).toBeTruthy();
    expect(testApp.title).toBe(TEST_APP_CONFIG.name);

    // Step 4: Verify install data is returned
    const installResponse = await request.get(`${PORTAL_URL}/api/store/${TEST_APP_ID}/install`);
    expect(installResponse.ok(), `Install fetch failed: ${await installResponse.text()}`).toBeTruthy();
    const installData = await installResponse.json();
    expect(installData.files).toBeTruthy();
    expect(installData.files['config.json']).toBeTruthy();
    expect(installData.files['docker-compose.json']).toBeTruthy();

    // Verify config.json contains the app config
    const config = JSON.parse(installData.files['config.json']);
    expect(config.id).toBe(TEST_APP_ID);
    expect(config.name).toBe(TEST_APP_CONFIG.name);

    // Step 5: Clean up — remove the test app
    const removeResponse = await request.post(`${PORTAL_URL}/api/store/remove`, {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: JSON.stringify({ slug: TEST_APP_ID, hard: true }),
    });
    expect(removeResponse.ok()).toBeTruthy();
  });

  test('app detail endpoint returns enriched data', async ({ request }) => {
    // Upload and publish a test app first
    const bundle = createTestBundle();

    await request.post(`${PORTAL_URL}/api/store/ingest`, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: bundle,
    });

    await request.post(`${PORTAL_URL}/api/store/publish/${TEST_APP_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: JSON.stringify({ public: false }),
    });

    // Fetch app detail
    const detailResponse = await request.get(`${PORTAL_URL}/api/store/${TEST_APP_ID}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();
    expect(detail.id).toBe(TEST_APP_ID);
    expect(detail.title).toBe(TEST_APP_CONFIG.name);
    expect(detail.status).toBe('published');
    expect(detail.icon).toBeTruthy();

    // Clean up
    await request.post(`${PORTAL_URL}/api/store/remove`, {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_API_KEY,
      },
      data: JSON.stringify({ slug: TEST_APP_ID, hard: true }),
    });
  });
});
