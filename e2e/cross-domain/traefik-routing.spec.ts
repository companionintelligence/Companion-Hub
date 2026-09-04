/**
 * Traefik routing verification E2E test (cross-domain).
 *
 * Verifies that Traefik correctly routes requests based on dynamic
 * YAML configuration files in the watched directory.
 *
 * Architecture:
 *   Traefik runs as a container in the cross-domain Docker stack,
 *   watching .internal-e2e/state/traefik/dynamic/ for YAML config files.
 *   The Hub backend writes these files during registration and app installs.
 *
 * Tests:
 *   1. Traefik container is running and dashboard accessible
 *   2. Seeded route config is picked up by Traefik
 *   3. Requests to the configured hostname via Traefik reach the Hub backend
 *   4. Unknown hosts get 404
 *   5. Service config correctly references the backend
 *
 * Prerequisites:
 *   - Cross-domain Docker stack running (includes Traefik on port 8880)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

const TRAEFIK_HTTP_PORT = process.env.TRAEFIK_HTTP_PORT || '8880';
const TRAEFIK_API_PORT = process.env.TRAEFIK_API_PORT || '8881';
const HUB_CONTAINER = 'ci-hub-e2e-hub';

// The Hub uses ci.localhost as its domain in the cross-domain config.
// We seed a test route to verify Traefik's file provider functionality.
const HUB_DOMAIN = 'ci.localhost';
const TEST_HOSTNAME = `e2e-traefik-test.${HUB_DOMAIN}`;

// Path inside the Hub container where the state volume is mounted.
// The Traefik container mounts the same host directory read-only at /dynamic.
// We write via the Hub container (read-write mount) so Traefik picks up changes.
const HUB_DYNAMIC_DIR = '/data/state/traefik/dynamic';

// The Hub backend API listens on port 9091 inside the container.
// The compose service name is ci-hub (Docker DNS name on the shared network).
const HUB_INTERNAL_HOST = 'ci-hub';
const HUB_INTERNAL_PORT = '9091';

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
 * Seed a Traefik dynamic config that routes TEST_HOSTNAME to the Hub backend.
 * Uses docker cp to copy into the container's dynamic config directory.
 */
function seedTestRoute() {
  const config = `http:
  routers:
    e2e-test-router:
      rule: "Host(\`${TEST_HOSTNAME}\`)"
      service: e2e-test-service
      entryPoints:
        - web
  services:
    e2e-test-service:
      loadBalancer:
        servers:
          - url: "http://${HUB_INTERNAL_HOST}:${HUB_INTERNAL_PORT}"
`;
  execSync(`docker exec ${HUB_CONTAINER} mkdir -p ${HUB_DYNAMIC_DIR}`, { stdio: 'pipe' });
  execSync(`docker exec -i ${HUB_CONTAINER} tee ${HUB_DYNAMIC_DIR}/e2e-test.yml > /dev/null`, { input: config, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Clean up seeded route configs inside the Hub container.
 */
function cleanupRoutes() {
  try {
    execSync(`docker exec ${HUB_CONTAINER} rm -f ${HUB_DYNAMIC_DIR}/e2e-test.yml`, { stdio: 'pipe' });
  } catch {
    // Container may already be stopped during teardown
  }
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

  test.afterAll(() => {
    cleanupRoutes();
  });

  test('Traefik container is running and API is accessible', async ({ request }) => {
    const res = await request.get(`http://localhost:${TRAEFIK_API_PORT}/api/overview`);
    expect(res.ok(), `Traefik API not accessible: ${res.status()}`).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty('http');
  });

  test('Traefik picks up seeded route config', async ({ request }) => {
    seedTestRoute();

    // Poll Traefik API until the router appears (file provider polls every ~2s)
    const testRouter = await pollTraefikApi<TraefikRouter>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r) => r.name?.includes('e2e-test-router'),
      description: 'e2e-test-router',
    });

    expect(testRouter, 'Test router not found in Traefik config').toBeTruthy();
    expect(testRouter.rule).toContain(TEST_HOSTNAME);
    expect(testRouter.status).toBe('enabled');
  });

  test('requests through Traefik with Host header reach Hub backend', async ({ request }) => {
    // Ensure test route exists
    seedTestRoute();
    await pollTraefikApi<TraefikRouter>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r) => r.name?.includes('e2e-test-router'),
      description: 'e2e-test-router',
    });

    // Make a request through Traefik with the test hostname
    const res = await request.get(`http://localhost:${TRAEFIK_HTTP_PORT}/api/health`, {
      headers: { Host: TEST_HOSTNAME },
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

  test('Traefik services list shows test service', async ({ request }) => {
    seedTestRoute();

    const testService = await pollTraefikApi<TraefikService>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/services`,
      predicate: (s) => s.name?.includes('e2e-test-service'),
      description: 'e2e-test-service',
    });

    expect(testService, 'Test service not found in Traefik').toBeTruthy();
    expect(testService.loadBalancer?.servers?.length).toBeGreaterThan(0);
    const serverUrl = testService.loadBalancer?.servers?.[0]?.url ?? '';
    expect(serverUrl).toContain(HUB_INTERNAL_HOST);
  });
});
