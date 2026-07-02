/**
 * Mock portal scenario definitions.
 *
 * Extracted from server.ts so they can be unit-tested independently
 * and reused by E2E fixture helpers to switch scenarios at runtime.
 */

export const PORTAL_SCENARIOS = ['registered', 'unregistered', 'delayed', 'degraded'] as const;
export type PortalScenario = (typeof PORTAL_SCENARIOS)[number];

type RouteHandler = (url: URL) => { body: unknown; status: number };
type RouteMap = Record<string, RouteHandler>;

/** Shared routes present in every scenario (health / registry). */
const baseRoutes: RouteMap = {
  'GET /v2/': () => ({ body: {}, status: 200 }),
  'GET /v2/ci-os-hub/tags/list': () => ({ body: { name: 'ci-os-hub', tags: ['1.0.0'] }, status: 200 }),
};

/** Registered (default) — everything works. */
const sampleStoreApps = [
  { id: 'ci-openclaw', name: 'OpenClaw', short_desc: 'Agent framework', categories: ['development'], icon: null },
  { id: 'n8n', name: 'n8n', short_desc: 'Workflow automation', categories: ['automation'], icon: null },
];

const sampleAlternatives = {
  productivity: [
    {
      proprietary: [{ name: 'Notion', icon: '', url: 'https://notion.so' }],
      alternatives: [{ name: 'AppFlowy', icon: '', url: '', appSlug: 'appflowy' }],
    },
  ],
};

const registeredRoutes: RouteMap = {
  ...baseRoutes,
  'GET /api/store': () => ({ body: sampleStoreApps, status: 200 }),
  'GET /api/store/alternatives': () => ({ body: sampleAlternatives, status: 200 }),
  'GET /api/devices/registration-status': () => ({ body: { registered: true }, status: 200 }),
  'POST /api/devices/register': () => ({
    body: { success: true, device_id: 'test-device' },
    status: 200,
  }),
  'POST /api/devices/pair': () => ({
    body: {
      success: true,
      organization_id: 'test-org-id',
      organization_name: 'test-org',
      slug: 'test-org',
      subdomain: 'hub-test-org',
      tunnel_id: 'mock-tunnel-id',
      tunnel_token: 'mock-tunnel-token',
      api_key: 'mock-api-key',
      domain: 'test-org.example.com',
    },
    status: 200,
  }),
};

/** Unregistered — portal says device is unknown. */
const unregisteredRoutes: RouteMap = {
  ...baseRoutes,
  'GET /api/store': () => ({ body: sampleStoreApps, status: 200 }),
  'GET /api/store/alternatives': () => ({ body: sampleAlternatives, status: 200 }),
  'GET /api/devices/registration-status': () => ({ body: { registered: false }, status: 200 }),
  'POST /api/devices/register': () => ({
    body: { success: false, error: 'Device not found' },
    status: 404,
  }),
  'POST /api/devices/pair': () => ({
    body: {
      success: true,
      organization_id: 'test-org-id',
      organization_name: 'test-org',
      slug: 'test-org',
      subdomain: 'hub-test-org',
      tunnel_id: 'mock-tunnel-id',
      tunnel_token: 'mock-tunnel-token',
      api_key: 'mock-api-key',
      domain: 'test-org.example.com',
    },
    status: 200,
  }),
};

/** Delayed — registered in DB but public domain is not propagated yet. */
const delayedRoutes: RouteMap = {
  ...baseRoutes,
  'GET /api/store': () => ({ body: sampleStoreApps, status: 200 }),
  'GET /api/store/alternatives': () => ({ body: sampleAlternatives, status: 200 }),
  'GET /api/devices/registration-status': () => ({
    body: { registered: true, public_ready: false, message: 'DNS propagation pending' },
    status: 200,
  }),
  'POST /api/devices/register': () => ({
    body: { success: true, device_id: 'test-device', pending: true },
    status: 202,
  }),
  'POST /api/devices/pair': () => ({
    body: {
      success: true,
      organization_id: 'test-org-id',
      organization_name: 'test-org',
      slug: 'test-org',
      subdomain: 'hub-test-org',
      tunnel_id: 'mock-tunnel-id',
      tunnel_token: 'mock-tunnel-token',
      api_key: 'mock-api-key',
      domain: 'test-org.example.com',
      pending: true,
    },
    status: 202,
  }),
};

/** Degraded — portal is experiencing errors. */
const degradedRoutes: RouteMap = {
  ...baseRoutes,
  'GET /api/store': () => ({ body: { error: 'Service unavailable' }, status: 503 }),
  'GET /api/store/alternatives': () => ({ body: { error: 'Service unavailable' }, status: 503 }),
  'GET /api/devices/registration-status': () => ({
    body: { error: 'Internal server error' },
    status: 500,
  }),
  'POST /api/devices/register': () => ({
    body: { error: 'Service unavailable' },
    status: 503,
  }),
  'POST /api/devices/pair': () => ({
    body: { error: 'Service unavailable' },
    status: 503,
  }),
};

const scenarioMap: Record<PortalScenario, RouteMap> = {
  registered: registeredRoutes,
  unregistered: unregisteredRoutes,
  delayed: delayedRoutes,
  degraded: degradedRoutes,
};

/** Build the route map for a given scenario. */
export const buildRoutes = (scenario: PortalScenario): RouteMap => {
  return scenarioMap[scenario] ?? registeredRoutes;
};
