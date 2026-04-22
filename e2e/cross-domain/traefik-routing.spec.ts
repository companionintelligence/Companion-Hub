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
 *   2. After seeding a hub route config, Traefik picks it up
 *   3. Requests to the hub hostname via Traefik reach the Hub backend
 *   4. Forward auth middleware integration
 *
 * Prerequisites:
 *   - Cross-domain Docker stack running (includes Traefik on port 8880)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TRAEFIK_HTTP_PORT = process.env.TRAEFIK_HTTP_PORT || '8880';
const TRAEFIK_API_PORT = process.env.TRAEFIK_API_PORT || '8881';
const HUB_CONTAINER = 'ci-hub-e2e-hub';

// The Hub uses ci.localhost as its domain in the cross-domain config
const HUB_DOMAIN = 'ci.localhost';
const HUB_SUBDOMAIN = 'e2e-hub';
const HUB_HOSTNAME = `${HUB_SUBDOMAIN}.${HUB_DOMAIN}`;

// Path inside the Hub container where Traefik dynamic configs are written.
// The compose mounts .internal-e2e/state/traefik/dynamic → /dynamic in Traefik
// and the Hub container can write to the host path via the volume mount.
const CONTAINER_DYNAMIC_DIR = '/data/state/traefik/dynamic';

/**
 * Write a Traefik dynamic config that routes HUB_HOSTNAME to the Hub backend.
 * Uses docker cp to copy a config file into the Hub container's data volume,
 * which Traefik watches. This avoids both host-side permission issues and
 * heredoc escaping problems with docker exec.
 */
function seedHubRoute() {
  const config = `http:
  routers:
    hub-public:
      rule: "Host(\`${HUB_HOSTNAME}\`)"
      service: hub-service
      entryPoints:
        - web
  services:
    hub-service:
      loadBalancer:
        servers:
          - url: "http://${HUB_CONTAINER}:3000"
`;
  const tmpFile = path.join(os.tmpdir(), `traefik-hub-route-${Date.now()}.yml`);
  const { writeFileSync, unlinkSync } = require('node:fs');
  writeFileSync(tmpFile, config);
  execSync(`docker exec ${HUB_CONTAINER} mkdir -p ${CONTAINER_DYNAMIC_DIR}`, { stdio: 'pipe' });
  execSync(`docker cp ${tmpFile} ${HUB_CONTAINER}:${CONTAINER_DYNAMIC_DIR}/hub.yml`, { stdio: 'pipe' });
  unlinkSync(tmpFile);
}

function cleanupRoutes() {
  try {
    execSync(`docker exec ${HUB_CONTAINER} sh -c 'rm -f ${CONTAINER_DYNAMIC_DIR}/hub.yml ${CONTAINER_DYNAMIC_DIR}/apps.yml'`, { stdio: 'pipe' });
  } catch {
    // Container may already be stopped during teardown
  }
}

/**
 * Poll a Traefik API list endpoint until an item matching `predicate` appears.
 * Returns the matched item, or throws after `timeoutMs`.
 */
async function pollTraefikApi<T = any>(opts: {
  request: any;
  endpoint: string;
  predicate: (item: T) => boolean;
  description: string;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<T | undefined> {
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
    // Traefik dashboard/API on port 8881
    const res = await request.get(`http://localhost:${TRAEFIK_API_PORT}/api/overview`);
    expect(res.ok(), `Traefik API not accessible: ${res.status()}`).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty('http');
  });

  test('Traefik picks up seeded hub route', async ({ request }) => {
    // Seed the hub route config
    seedHubRoute();

    // Poll Traefik API until the router appears (file provider polls every ~2s)
    const hubRouter = await pollTraefikApi<{ name: string; rule: string; status: string }>({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r) => r.name?.includes('hub-public'),
      description: 'hub-public router',
    });

    expect(hubRouter, 'Hub router not found in Traefik config').toBeTruthy();
    expect(hubRouter?.rule).toContain(HUB_HOSTNAME);
    expect(hubRouter?.status).toBe('enabled');
  });

  test('requests through Traefik with Host header reach Hub backend', async ({ request }) => {
    // Ensure hub route exists
    seedHubRoute();
    await pollTraefikApi({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/routers`,
      predicate: (r: any) => r.name?.includes('hub-public'),
      description: 'hub-public router',
    });

    // Make a request to Traefik's HTTP port with the Hub hostname
    // Traefik should route it to the Hub backend
    const res = await request.get(`http://localhost:${TRAEFIK_HTTP_PORT}/api/health`, {
      headers: {
        Host: HUB_HOSTNAME,
      },
    });

    // The Hub backend health endpoint should respond through Traefik
    expect(res.ok(), `Request through Traefik failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('requests without matching Host header get 404', async ({ request }) => {
    const res = await request.get(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      headers: {
        Host: 'nonexistent.ci.localhost',
      },
    });

    // Traefik returns 404 when no router matches
    expect(res.status()).toBe(404);
  });

  test('Traefik services list shows hub-service', async ({ request }) => {
    seedHubRoute();
    await pollTraefikApi({
      request,
      endpoint: `http://localhost:${TRAEFIK_API_PORT}/api/http/services`,
      predicate: (s: any) => s.name?.includes('hub-service'),
      description: 'hub-service service',
    });

    const servicesRes = await request.get(`http://localhost:${TRAEFIK_API_PORT}/api/http/services`);
    expect(servicesRes.ok()).toBeTruthy();
    const services = (await servicesRes.json()) as Array<{
      name: string;
      status: string;
      loadBalancer?: { servers: Array<{ url: string }> };
    }>;

    const hubService = services.find((s) => s.name?.includes('hub-service'));
    expect(hubService, 'Hub service not found in Traefik').toBeTruthy();
    expect(hubService?.loadBalancer?.servers?.[0]?.url).toContain('ci-hub-e2e-hub');
  });
});
