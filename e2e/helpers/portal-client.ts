/**
 * Client helper for switching the mock portal scenario at runtime.
 *
 * Used by E2E fixtures to configure the portal before each test.
 */

import type { PortalScenario } from '../mock-portal/scenarios.js';

const MOCK_PORTAL_URL = `http://localhost:${process.env.MOCK_PORTAL_PORT || '4444'}`;

/** Switch the running mock portal to a different scenario. */
export async function setPortalScenario(scenario: PortalScenario) {
  const res = await fetch(`${MOCK_PORTAL_URL}/___control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set portal scenario to "${scenario}": ${res.status}`);
  }
}

/** Get the current scenario of the running mock portal. */
export async function getPortalScenario(): Promise<PortalScenario> {
  const res = await fetch(`${MOCK_PORTAL_URL}/___control`);
  const data = (await res.json()) as { scenario: PortalScenario };
  return data.scenario;
}
