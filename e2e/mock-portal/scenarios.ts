/**
 * Mock portal scenario definitions.
 *
 * Extracted from server.ts so they can be unit-tested independently
 * and reused by E2E fixture helpers to switch scenarios at runtime.
 */

import { testUser } from '../helpers/constants.js';

export const PORTAL_SCENARIOS = ['registered', 'unregistered', 'delayed', 'degraded'] as const;
export type PortalScenario = (typeof PORTAL_SCENARIOS)[number];

/** `body` is the parsed JSON request body, or undefined for GETs / unparseable payloads. */
type RouteHandler = (url: URL, body?: unknown) => { body: unknown; status: number };
type RouteMap = Record<string, RouteHandler>;

/**
 * Hub login is Portal-backed. `AuthService.login` (packages/backend/src/modules/auth/
 * auth.service.ts) does NOT check the local password column — it POSTs the credentials
 * to the Portal's `/api/auth/sign-in/email` and only then creates the local session
 * (landed in #604, "Portal-backed password reset flow"). Without this route the mock
 * portal 404s, the Hub maps that to AUTH_ERROR_INVALID_CREDENTIALS, and *every*
 * authenticated E2E spec and video capture fails at the login form.
 *
 * Credentials are checked rather than waved through, so `e2e/error-states.spec.ts`
 * still gets a rejection for a wrong password and an unknown email.
 *
 * MOCK_PORTAL_OPERATOR_EMAIL / _PASSWORD add one extra accepted pair. The video
 * capture stage uses it: its operator is `owner@acme.com` rather than
 * `test@test.com`, because the login screen and Settings → Security both print
 * the operator's address on screen (video/stage/seed.mts).
 */
const EXTRA_OPERATOR = {
  email: process.env.MOCK_PORTAL_OPERATOR_EMAIL?.trim().toLowerCase(),
  password: process.env.MOCK_PORTAL_OPERATOR_PASSWORD,
};

const signInWithEmail: RouteHandler = (_url, body) => {
  const creds = (body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof creds.email === 'string' ? creds.email.trim().toLowerCase() : '';
  const password = typeof creds.password === 'string' ? creds.password : '';

  const accepted =
    (email === testUser.email && password === testUser.password) ||
    (Boolean(EXTRA_OPERATOR.email) && email === EXTRA_OPERATOR.email && password === EXTRA_OPERATOR.password);

  if (!accepted) {
    return { body: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }, status: 401 };
  }

  return { body: { user: { id: 'test-portal-user', email, emailVerified: true }, token: 'mock-portal-session' }, status: 200 };
};

/**
 * Device liveness ping. `RegistrationService.validateRegistration` posts here on a
 * loop; three non-2xx answers drive the Hub into the `degraded` provisioning phase,
 * which is a state no capture or spec should be filmed in by accident.
 */
const deviceCheckIn: RouteHandler = () => ({ body: { active: true, device_id: 'test-device' }, status: 200 });

/** Shared routes present in every scenario (health / registry / auth). */
const baseRoutes: RouteMap = {
  'GET /v2/': () => ({ body: {}, status: 200 }),
  'GET /v2/ci-hub/tags/list': () => ({ body: { name: 'ci-hub', tags: ['1.0.0'] }, status: 200 }),
  'POST /api/auth/sign-in/email': signInWithEmail,
  'POST /api/devices/check-in': deviceCheckIn,
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
  // Definitive "this hardware is not a device we know". 400 is the only status
  // RegistrationService.probePortalDeviceActive reads as a hard no; anything else
  // is treated as "maybe", which raises the `local_unregistered_portal_active`
  // drift signal and puts the "Reconnect this Hub" recovery dialog over the
  // pairing form — the wrong screen for an unregistered Hub.
  'POST /api/devices/check-in': () => ({ body: { active: false, error: 'Device not found' }, status: 400 }),
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
  // Degraded means the Portal is unhealthy, so the shared auth/check-in routes
  // from baseRoutes have to fail here too.
  'POST /api/auth/sign-in/email': () => ({ body: { error: 'Service unavailable' }, status: 503 }),
  'POST /api/devices/check-in': () => ({ body: { error: 'Service unavailable' }, status: 503 }),
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
