/**
 * Traefik routing verification E2E test (cross-domain).
 *
 * Verifies that Traefik correctly routes requests based on the
 * Hub-generated dynamic configuration.
 *
 * Architecture:
 *   Traefik runs as a container in the cross-domain Docker stack,
 *   watching .internal-e2e/state/traefik/dynamic/ for YAML config files.
 *   The Hub backend writes these files during registration and app installs.
 *
 * Tests:
 *   1. Traefik container is running and dashboard accessible
 *   2. Hub-generated route config is picked up by Traefik
 *   3. Requests to the hub hostname via Traefik reach the Hub backend
 *   4. Unknown hosts get 404
 *   5. Service config points to the Hub backend
 *
 * Prerequisites:
 *   - Cross-domain Docker stack running (includes Traefik on port 8880)
 *   - Device registration completed (Hub generates Traefik config on pairing)
 */

import { test, expect } from '@playwright/test';

const TRAEFIK_HTTP_PORT = process.env.TRAEFIK_HTTP_PORT || '8880';
const TRAEFIK_API_PORT = process.env.TRAEFIK_API_PORT || '8881';

// The Hub uses ci.localhost as its domain in the cross-domain config
const HUB_DOMAIN = 'ci.localhost';

interface TraefikRouter {
  name: string;
  rule: string;
  status: string;
  service: string;
}

interface TraefikService {
  name: string;
  status: string;
  loadBalancer?: { servers: Array<{ url: string }> };
}

/**
 * Poll a Traefik API list endpoint until an item matching `predicate` appears.
 * Returns the matched item, or throws after `timeoutMs`.
 */
async function pollTraefikApi<T>(opts: {
  request: { get(url: string): Promise<{ ok(): boolean; json(): Promise<unknown> }> };
  endpoint: string;
  predicate: (item: T) => boolean;
  description: string;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<T> {
  const { request, endpoint, predicate, description, intervalMs = 500, timeoutMs = 15000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request.get(endpoint);
      if (res.ok()) {
        const items = (await res.json()) as T[];
        const match = items.find(predicate);
        if (match) return match;
      }
    } catch {
      // Traefik may not be ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description} at ${endpoint} after ${timeoutMs}ms`);
}

test.describe('Traefik Routing Verification', () => {
  test.beforeAll(async () => {
    if (process.env.E2E_TEST !== 'true') {
      throw new Error('Must run with E2E_TEST=true');
    }
  });

  test('Traefik container is running and API is accessible', async ({ request }) => {
    // Traefik dashboard/API on port 8881
    const res = await request.get(`http://localhost:${TRAEFIK_API_PORT}/api/overview`);
    expect(res.ok(), `Traefik API not accessible: ${res.status()}`).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty('http');
  });

  test('Traefik picks up Hub-generated route config', async ({ request }) => {
    // The Hub generates dynamic Traefik config during bootstrap/registration.
    // Poll until we find a router with a rule matching *.ci.localhost
    const hubRouter = await pollTraefikApi<TraefikRouter>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r) => r.rule?.includes(HUB_DOMAIN) && r.name?.includes('hub'),
      description: `Hub router matching *.${HUB_DOMAIN}`,
    });

    expect(hubRouter, 'Hub router not found in Traefik config').toBeTruthy();
    expect(hubRouter.rule).toContain(HUB_DOMAIN);
    expect(hubRouter.status).toBe('enabled');
  });

  test('requests through Traefik with Host header reach Hub backend', async ({ request }) => {
    // First, discover the actual hostname the Hub registered with
    const hubRouter = await pollTraefikApi<TraefikRouter>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r) => r.rule?.includes(HUB_DOMAIN) && r.name?.includes('hub'),
      description: `Hub router matching *.${HUB_DOMAIN}`,
    });

    // Extract the hostname from the rule, e.g. Host(`hub-xxx.ci.localhost`) -> hub-xxx.ci.localhost
    const hostMatch = hubRouter.rule.match(/Host\(`([^`]+)`\)/);
    expect(hostMatch, `Could not parse hostname from router rule: ${hubRouter.rule}`).toBeTruthy();
    const hubHostname = hostMatch?.[1] ?? '';
    expect(hubHostname.length).toBeGreaterThan(0);

    // Make a request to Traefik's HTTP port with the Hub's actual hostname
    const res = await request.get(`http://localhost:${TRAEFIK_HTTP_PORT}/api/health`, {
      headers: { Host: hubHostname },
    });

    // The Hub backend health endpoint should respond through Traefik
    expect(res.ok(), `Request through Traefik failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('requests without matching Host header get 404', async ({ request }) => {
    const res = await request.get(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      headers: { Host: 'nonexistent.ci.localhost' },
    });

    // Traefik returns 404 when no router matches
    expect(res.status()).toBe(404);
  });

  test('Traefik services list shows hub-service', async ({ request }) => {
    const hubService = await pollTraefikApi<TraefikService>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/services`,
      predicate: (s) => s.name?.includes('hub-service'),
      description: 'hub-service service',
    });

    expect(hubService, 'Hub service not found in Traefik').toBeTruthy();
    // Verify the service has at least one backend server configured
    expect(hubService.loadBalancer?.servers?.length).toBeGreaterThan(0);
    // The server URL should point to a Hub backend (port 5002 or 3000)
    const serverUrl = hubService.loadBalancer?.servers?.[0]?.url ?? '';
    expect(serverUrl).toMatch(/:\d{4}$/);
  });
});
