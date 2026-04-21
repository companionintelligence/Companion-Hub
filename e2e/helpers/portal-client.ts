/**
 * Client helper for switching the mock portal scenario at runtime.
 *
 * Used by E2E fixtures to configure the portal before each test.
 */

import { PORTAL_SCENARIOS, type PortalScenario } from '../mock-portal/scenarios.js';

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

function isPortalScenario(value: unknown): value is PortalScenario {
  return typeof value === 'string' && PORTAL_SCENARIOS.includes(value as PortalScenario);
}

/** Get the current scenario of the running mock portal. */
export async function getPortalScenario(): Promise<PortalScenario> {
  const res = await fetch(`${MOCK_PORTAL_URL}/___control`);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body ? ` — ${body}` : '';
    throw new Error(`Failed to get portal scenario: ${res.status} ${res.statusText}${detail}`);
  }

  const data = (await res.json()) as unknown;
  const scenario = typeof data === 'object' && data !== null && 'scenario' in data ? (data as { scenario?: unknown }).scenario : undefined;

  if (!isPortalScenario(scenario)) {
    const received = JSON.stringify(data);
    throw new Error(`Mock portal returned invalid scenario payload: ${received}. Expected one of: ${PORTAL_SCENARIOS.join(', ')}`);
  }

  return scenario;
}
