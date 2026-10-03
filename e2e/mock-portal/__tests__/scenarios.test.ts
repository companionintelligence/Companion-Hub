/**
 * Unit tests for mock portal scenario logic.
 *
 * Run with: pnpm exec tsx --test e2e/mock-portal/__tests__/scenarios.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, PORTAL_SCENARIOS, type PortalScenario } from '../scenarios.js';

const dummyUrl = new URL('http://localhost:4444/');

describe('PORTAL_SCENARIOS', () => {
  it('includes all expected scenario names', () => {
    assert.deepStrictEqual([...PORTAL_SCENARIOS], ['registered', 'unregistered', 'delayed', 'degraded', 'removed']);
  });
});

describe('buildRoutes', () => {
  it('returns routes for every known scenario', () => {
    for (const scenario of PORTAL_SCENARIOS) {
      const routes = buildRoutes(scenario);
      assert.ok(routes, `No routes for scenario: ${scenario}`);
      assert.ok(typeof routes === 'object');
    }
  });

  it('falls back to registered for unknown scenario', () => {
    const routes = buildRoutes('nonexistent' as PortalScenario);
    const handler = routes['GET /api/devices/registration-status'];
    assert.ok(handler);
    const result = handler(dummyUrl);
    assert.deepStrictEqual(result.body, { registered: true });
  });

  describe('registered scenario', () => {
    const routes = buildRoutes('registered');

    it('has v2 registry endpoint', () => {
      const handler = routes['GET /v2/'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
    });

    it('allows email sign-up and returns a portal token', () => {
      const handler = routes['POST /api/auth/sign-up/email'];
      assert.ok(handler);
      const result = handler(dummyUrl, { email: 'new@example.com', password: 'SecurePass123!', name: 'New' });
      assert.strictEqual(result.status, 200);
      const body = result.body as { token?: string; user?: { email?: string } };
      assert.strictEqual(body.token, 'mock-portal-session');
      assert.strictEqual(body.user?.email, 'new@example.com');
    });

    it('answers WhoIs with membership in the seeded org', () => {
      const handler = routes['POST /api/whois'];
      assert.ok(handler);
      const result = handler(dummyUrl, { subject: 'test-portal-user', organizationId: 'test-org-id', appIds: ['e2e-nginx'] });
      assert.strictEqual(result.status, 200);
      const body = result.body as {
        organizations?: Array<{ organizationId?: string; user?: { role?: string }; apps?: Array<{ appId?: string; can?: string[] }> }>;
      };
      assert.strictEqual(body.organizations?.[0]?.organizationId, 'test-org-id');
      assert.strictEqual(body.organizations?.[0]?.user?.role, 'owner');
      assert.strictEqual(body.organizations?.[0]?.apps?.[0]?.appId, 'e2e-nginx');
      assert.ok(body.organizations?.[0]?.apps?.[0]?.can?.includes('view'));
    });

    it('reports device as registered', () => {
      const handler = routes['GET /api/devices/registration-status'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.strictEqual((result.body as { registered: boolean }).registered, true);
    });

    it('allows device registration', () => {
      const handler = routes['POST /api/devices/register'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.strictEqual((result.body as { success: boolean }).success, true);
    });

    it('returns successful pair response', () => {
      const handler = routes['POST /api/devices/pair'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      const body = result.body as { success: boolean; organization_id: string; tunnel_id: string };
      assert.strictEqual(body.success, true);
      assert.ok(body.organization_id);
      assert.ok(body.tunnel_id);
    });

    it('returns sample app store catalog', () => {
      const handler = routes['GET /api/store'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.ok(Array.isArray(result.body));
      assert.ok((result.body as unknown[]).length > 0);
    });

    it('returns store alternatives', () => {
      const handler = routes['GET /api/store/alternatives'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.ok(typeof result.body === 'object');
    });
  });

  describe('unregistered scenario', () => {
    const routes = buildRoutes('unregistered');

    it('reports device as not registered', () => {
      const handler = routes['GET /api/devices/registration-status'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.strictEqual((result.body as { registered: boolean }).registered, false);
    });

    it('rejects device registration', () => {
      const handler = routes['POST /api/devices/register'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 404);
      assert.strictEqual((result.body as { success: boolean }).success, false);
    });

    it('allows pairing with a valid code', () => {
      const handler = routes['POST /api/devices/pair'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      assert.strictEqual((result.body as { success: boolean }).success, true);
    });

    it("refuses check-in with CI-Portal's 401, not the 400 the Hub reads as a schema refusal", () => {
      const handler = routes['POST /api/devices/check-in'];
      assert.ok(handler);
      const result = handler(dummyUrl, { device_id: 'test-device' });
      assert.strictEqual(result.status, 401);
      assert.deepStrictEqual(result.body, { error: 'Invalid Device Key', code: 'UNAUTHORIZED' });
    });
  });

  describe('removed scenario', () => {
    const routes = buildRoutes('removed');

    it('refuses the device key on every device-authenticated route', () => {
      for (const route of ['POST /api/devices/check-in', 'GET /api/entitlements/check', 'GET /api/store'] as const) {
        const handler = routes[route];
        assert.ok(handler, `Missing ${route}`);
        const result = handler(dummyUrl);
        assert.strictEqual(result.status, 401, `${route} should refuse the key`);
        assert.strictEqual((result.body as { code?: string }).code, 'UNAUTHORIZED');
      }
    });

    it('still pairs with a fresh code, which is the way back', () => {
      const handler = routes['POST /api/devices/pair'];
      assert.ok(handler);
      assert.strictEqual(handler(dummyUrl).status, 200);
    });
  });

  describe('delayed scenario', () => {
    const routes = buildRoutes('delayed');

    it('reports device as registered but not publicly ready', () => {
      const handler = routes['GET /api/devices/registration-status'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
      const body = result.body as { registered: boolean; public_ready: boolean };
      assert.strictEqual(body.registered, true);
      assert.strictEqual(body.public_ready, false);
    });

    it('returns 202 for registration (pending)', () => {
      const handler = routes['POST /api/devices/register'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 202);
    });

    it('returns 202 for pairing (pending)', () => {
      const handler = routes['POST /api/devices/pair'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 202);
    });
  });

  describe('degraded scenario', () => {
    const routes = buildRoutes('degraded');

    it('returns 500 for registration status', () => {
      const handler = routes['GET /api/devices/registration-status'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 500);
    });

    it('returns 503 for store', () => {
      const handler = routes['GET /api/store'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 503);
    });

    it('returns 503 for WhoIs', () => {
      const handler = routes['POST /api/whois'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 503);
    });

    it('returns 503 for registration', () => {
      const handler = routes['POST /api/devices/register'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 503);
    });

    it('still serves v2 registry (base routes)', () => {
      const handler = routes['GET /v2/'];
      assert.ok(handler);
      const result = handler(dummyUrl);
      assert.strictEqual(result.status, 200);
    });
  });

  describe('base routes present in every scenario', () => {
    const BASE_ROUTES = ['GET /v2/', 'GET /v2/ci-hub/tags/list'] as const;

    for (const scenario of PORTAL_SCENARIOS) {
      it(`scenario "${scenario}" exposes all base routes`, () => {
        const routes = buildRoutes(scenario);
        for (const route of BASE_ROUTES) {
          assert.ok(routes[route], `Missing base route "${route}" in scenario "${scenario}"`);
          const result = routes[route](dummyUrl);
          assert.strictEqual(result.status, 200, `Base route "${route}" in scenario "${scenario}" returned non-200`);
        }
      });
    }
  });

  describe('registration-status semantics per scenario', () => {
    const expectations: Record<PortalScenario, boolean> = {
      registered: true,
      unregistered: false,
      delayed: true,
      degraded: false, // 500 means the field isn't trustworthy — handler returns an error body
      removed: true, // Portal-side removal is what the Hub cannot see from this route
    };

    for (const scenario of PORTAL_SCENARIOS) {
      it(`scenario "${scenario}" registration-status returns expected HTTP status`, () => {
        const routes = buildRoutes(scenario);
        const handler = routes['GET /api/devices/registration-status'];
        assert.ok(handler, `Missing registration-status route in scenario "${scenario}"`);
        const result = handler(dummyUrl);
        if (scenario === 'degraded') {
          assert.strictEqual(result.status, 500);
        } else {
          assert.strictEqual(result.status, 200);
          assert.strictEqual(
            (result.body as { registered: boolean }).registered,
            expectations[scenario],
            `"registered" field mismatch for scenario "${scenario}"`,
          );
        }
      });
    }
  });
});
