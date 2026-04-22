/**
 * Portal API helpers for standard E2E tests.
 *
 * Wraps the PortalApiClient from cross-domain tests behind convenience
 * functions for common E2E operations (seeding registrations, etc.).
 * The real miniflare Portal replaces the old mock portal server.
 */

import { PortalApiClient } from '../cross-domain/portal-api';

const PORTAL_URL = `http://localhost:${process.env.PORTAL_PORT || '8012'}`;

/**
 * Create a PortalApiClient connected to the E2E Portal instance.
 */
export function createPortalClient(): PortalApiClient {
  return new PortalApiClient(PORTAL_URL);
}

/**
 * Seed a "registered" state on the Portal: create user, org, device.
 * Returns the pairing code for use with Hub pairing.
 */
export async function seedPortalRegistration(opts?: { email?: string; password?: string; orgName?: string; deviceName?: string }) {
  const {
    email = 'e2e-standard@test.local',
    password = 'SecureE2EPass123!',
    orgName = 'E2E Standard Org',
    deviceName = 'E2E Standard Hub',
  } = opts ?? {};

  const portal = createPortalClient();

  // Create user
  await portal.signUp(email, password, 'E2E User');

  // Create organization
  const org = await portal.createOrganization(orgName);
  await portal.setActiveOrganization(org.id);

  // Create device
  const device = await portal.createDevice(org.id, deviceName);

  return {
    portal,
    org,
    device,
    pairingCode: device.pairingCode,
  };
}
