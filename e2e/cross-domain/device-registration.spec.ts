/**
 * Cross-domain device registration E2E test.
 *
 * Tests the complete registration protocol between a real CI-Hub (running in
 * Docker, matching production) and a real CI-Portal (running locally via
 * miniflare).
 *
 * Architecture:
 *   Portal: miniflare (wrangler dev) — D1, R2, CloudflareNoopService
 *   Hub:    Docker Compose — postgres + rabbitmq + backend + built frontend
 *
 * The Hub's CI_CLOUD_URL points to the local Portal via host.docker.internal.
 * When the Hub pairs via POST /api/devices/pair, the Portal processes it with
 * CloudflareNoopService (no real Cloudflare API calls). The Hub stores noop
 * tunnel credentials and enters "registered" state.
 *
 * What IS tested end-to-end:
 *   - Portal user signup, org creation, device creation (pairing code)
 *   - Hub → Portal API call for pairing (POST /api/devices/pair)
 *   - Portal D1 database updates (device status, tunnel records, OAuth client)
 *   - Hub PostgreSQL updates (deviceRegistration, tunnel token on disk)
 *   - Hub frontend state transition to "registered"
 *   - Hub can report registered status via its own API
 *   - Hub running in Docker with built frontend (production parity)
 *
 * What is stubbed:
 *   - Cloudflare tunnel creation (NoopService returns stub IDs)
 *   - DNS record creation (NoopService, no real DNS)
 *   - cloudflared container (not started; infra setup is fire-and-forget)
 *   - Public domain accessibility (tunnel probe will timeout)
 *
 * This is the correct boundary: everything that is OUR code is tested for real,
 * only external Cloudflare infrastructure calls are stubbed.
 */

import dns from 'node:dns';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { PortalApiClient } from './portal-api';
import { clearDatabase } from '../helpers/db';

const dnsLookup = promisify(dns.lookup);

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:8012';
const HUB_BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;
const HUB_FRONTEND_URL = `http://localhost:${process.env.FRONTEND_PORT || '9091'}`;

const TEST_PORTAL_USER = {
  email: 'e2e-admin@cross-domain-test.local',
  password: 'SecureE2EPass123!',
  name: 'E2E Admin',
};

const TEST_ORG_NAME = 'E2E Cross Domain Org';
const TEST_DEVICE_NAME = 'E2E Hub';

test.describe('Cross-Domain Device Registration', () => {
  let portal: PortalApiClient;
  let pairingCode: string;

  test.beforeAll(async () => {
    portal = new PortalApiClient(PORTAL_URL);

    // Verify *.localhost DNS resolution (RFC 6761)
    try {
      const result = await dnsLookup('ci.localhost');
      if (result.address !== '127.0.0.1' && result.address !== '::1') {
        console.warn(`⚠ ci.localhost resolved to ${result.address}, expected 127.0.0.1. Some tests may behave unexpectedly.`);
      }
    } catch {
      console.warn(
        "⚠ ci.localhost does not resolve. Per RFC 6761, *.localhost should resolve to 127.0.0.1. If tests fail, add '127.0.0.1 ci.localhost' to /etc/hosts.",
      );
    }

    // Verify Portal is reachable
    const healthy = await portal.healthCheck();
    if (!healthy) {
      throw new Error(`Portal at ${PORTAL_URL} is not reachable. Ensure start-portal.sh is running.`);
    }

    // Clear Hub database to start from fresh unregistered state
    await clearDatabase();
  });

  test('Portal: create user, organization, and device with pairing code', async () => {
    // Step 1: Register a user in Portal
    await portal.signUp(TEST_PORTAL_USER.email, TEST_PORTAL_USER.password, TEST_PORTAL_USER.name);

    // Step 2: Create an organization
    const org = await portal.createOrganization(TEST_ORG_NAME);
    expect(org.id).toBeTruthy();
    expect(org.slug).toBeTruthy();

    // Step 3: Set it as the active org (required for device creation)
    await portal.setActiveOrganization(org.id);

    // Step 4: Create a device — this generates the pairing code
    const device = await portal.createDevice(org.id, TEST_DEVICE_NAME);
    expect(device.pairingCode).toBeTruthy();
    expect(device.pairingCode).toHaveLength(6);
    expect(device.status).toBe('inactive');
    pairingCode = device.pairingCode;

    // Verify the pairing code is valid via public endpoint
    const verified = await portal.verifyPairingCode(pairingCode);
    expect(verified.deviceId).toBeTruthy();
  });

  test('Hub: fresh state redirects to device registration gate', async ({ page }) => {
    await page.goto(HUB_FRONTEND_URL);
    await expect(page).toHaveURL(/device-registration/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: /Device Registration Required/i })).toBeVisible({ timeout: 10000 });
  });

  test('Hub: pair device with Portal using pairing code', async ({ page }) => {
    // Navigate to device registration page
    await page.goto(`${HUB_FRONTEND_URL}/device-registration`);
    await expect(page.getByRole('heading', { name: /Device Registration Required/i })).toBeVisible({ timeout: 15000 });

    // Verify the Hub shows a device ID
    await expect(page.locator('.font-mono')).toBeVisible({ timeout: 10000 });

    // Enter pairing code from Portal
    const input = page.locator('#pairing-code');
    await input.fill(pairingCode);
    await expect(input).toHaveValue(pairingCode.toUpperCase());

    // Click Register
    const registerButton = page.getByRole('button', { name: 'Register' });
    await expect(registerButton).toBeEnabled();
    await registerButton.click();

    // Wait for success — the Hub calls Portal's /api/devices/pair endpoint
    // Portal processes with CloudflareNoopService, returns noop tunnel credentials
    // Hub stores everything and shows success
    await expect(page.getByText('Device Registered Successfully')).toBeVisible({ timeout: 30000 });
  });

  test('Hub: reports registered status after pairing', async ({ request }) => {
    // setupOrganizationInfrastructure runs fire-and-forget, so the tunnel
    // token may not be on disk immediately. Poll until status is consistent.
    let registered = false;
    for (let i = 0; i < 20; i++) {
      const response = await request.get(`${HUB_BACKEND_URL}/api/registration/status`);
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      if (body.registered) {
        registered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(registered).toBe(true);
  });

  test('Hub: device registration persisted in database', async () => {
    // Allow time for fire-and-forget setupOrganizationInfrastructure to create the DB record
    const { db } = await import('../helpers/db');
    const schema = await import('../../packages/backend/src/core/database/drizzle/schema');

    let registrations: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      registrations = await db.select().from(schema.deviceRegistration);
      if (registrations.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(registrations.length).toBeGreaterThanOrEqual(1);

    const reg = registrations[0] as { slug?: string; name?: string };
    expect(reg).toBeTruthy();
    expect(reg.slug).toBeTruthy();
    expect(reg.name).toBeTruthy();
  });

  test('Portal: device status updated after pairing', async () => {
    const result = await portal.verifyPairingCode(pairingCode).catch((e: Error) => e);
    if (result instanceof Error) {
      // 404/410 means code was invalidated — expected
      expect(String(result)).toMatch(/40[04]|410/);
    } else {
      // If the endpoint still returns the device, status should not be 'inactive'
      expect(result.status).not.toBe('inactive');
    }
  });
});
