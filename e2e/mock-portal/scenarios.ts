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

const signUpWithEmail: RouteHandler = (_url, body) => {
  const creds = (body ?? {}) as { email?: unknown; password?: unknown; name?: unknown };
  const email = typeof creds.email === 'string' ? creds.email.trim().toLowerCase() : '';
  const password = typeof creds.password === 'string' ? creds.password : '';
  const name = typeof creds.name === 'string' && creds.name.trim() ? creds.name.trim() : email.split('@')[0];

  if (!email?.includes('@') || password.length < 8) {
    return { body: { code: 'INVALID_SIGN_UP', message: 'Invalid sign-up request' }, status: 400 };
  }

  return { body: { user: { id: 'test-portal-user', email, name, emailVerified: true }, token: 'mock-portal-session' }, status: 200 };
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
  'POST /api/auth/sign-up/email': signUpWithEmail,
  'POST /api/devices/check-in': deviceCheckIn,
};

/** Registered (default) — everything works. */
const sampleStoreApps = [
  { id: 'ci-openclaw', name: 'OpenClaw', short_desc: 'Agent framework', categories: ['development'], icon: null },
  { id: 'n8n', name: 'n8n', short_desc: 'Workflow automation', categories: ['automation'], icon: null },
];

const portalFavicon = (url: string) => `https://www.google.com/s2/favicons?sz=32&domain_url=${url}`;

const sampleAlternatives = {
  utilities: [
    {
      proprietary: [{ name: 'Microsoft Office', icon: '', url: 'https://www.microsoft.com/microsoft-365' }],
      alternatives: [
        { name: 'OnlyOffice', icon: portalFavicon('https://www.onlyoffice.com'), url: 'https://www.onlyoffice.com', appSlug: 'onlyoffice' },
      ],
    },
    {
      proprietary: [{ name: 'Notion', icon: '', url: 'https://www.notion.so' }],
      alternatives: [{ name: 'AppFlowy', icon: portalFavicon('https://appflowy.io'), url: 'https://appflowy.io', appSlug: 'appflowy' }],
    },
    {
      proprietary: [{ name: 'Evernote', icon: '', url: 'https://evernote.com' }],
      alternatives: [{ name: 'Joplin', icon: portalFavicon('https://joplinapp.org'), url: 'https://joplinapp.org', appSlug: 'joplin' }],
    },
    {
      proprietary: [{ name: 'Adobe Acrobat', icon: '', url: 'https://www.adobe.com/acrobat.html' }],
      alternatives: [{ name: 'Stirling PDF', icon: portalFavicon('https://stirlingpdf.io'), url: 'https://stirlingpdf.io', appSlug: 'stirling-pdf' }],
    },
  ],
  social: [
    {
      proprietary: [{ name: 'Slack', icon: '', url: 'https://slack.com' }],
      alternatives: [{ name: 'Mattermost', icon: portalFavicon('https://mattermost.com'), url: 'https://mattermost.com', appSlug: 'mattermost' }],
    },
    {
      proprietary: [{ name: 'Zoom', icon: '', url: 'https://zoom.us' }],
      alternatives: [{ name: 'Jitsi Meet', icon: portalFavicon('https://jitsi.org'), url: 'https://jitsi.org', appSlug: 'jitsi' }],
    },
  ],
  development: [
    {
      proprietary: [{ name: 'Jira', icon: '', url: 'https://www.atlassian.com/software/jira' }],
      alternatives: [{ name: 'Plane', icon: portalFavicon('https://plane.so'), url: 'https://plane.so', appSlug: 'plane' }],
    },
    {
      proprietary: [{ name: 'GitHub', icon: '', url: 'https://github.com' }],
      alternatives: [{ name: 'Gitea', icon: portalFavicon('https://about.gitea.com'), url: 'https://about.gitea.com', appSlug: 'gitea' }],
    },
    {
      proprietary: [{ name: 'VS Code', icon: '', url: 'https://code.visualstudio.com' }],
      alternatives: [{ name: 'code-server', icon: portalFavicon('https://coder.com'), url: 'https://coder.com', appSlug: 'code-server' }],
    },
  ],
  data: [
    {
      proprietary: [{ name: 'Airtable', icon: '', url: 'https://airtable.com' }],
      alternatives: [{ name: 'NocoDB', icon: portalFavicon('https://nocodb.com'), url: 'https://nocodb.com', appSlug: 'nocodb' }],
    },
    {
      proprietary: [{ name: 'Google Drive', icon: '', url: 'https://drive.google.com' }],
      alternatives: [{ name: 'Nextcloud', icon: portalFavicon('https://nextcloud.com'), url: 'https://nextcloud.com', appSlug: 'nextcloud' }],
    },
  ],
  media: [
    {
      proprietary: [{ name: 'Figma', icon: '', url: 'https://www.figma.com' }],
      alternatives: [{ name: 'Penpot', icon: portalFavicon('https://penpot.app'), url: 'https://penpot.app', appSlug: 'penpot' }],
    },
    {
      proprietary: [{ name: 'Miro', icon: '', url: 'https://miro.com' }],
      alternatives: [{ name: 'Excalidraw', icon: portalFavicon('https://excalidraw.com'), url: 'https://excalidraw.com', appSlug: 'excalidraw' }],
    },
  ],
  automation: [
    {
      proprietary: [{ name: 'Google Home', icon: '', url: 'https://home.google.com' }],
      alternatives: [
        {
          name: 'Home Assistant',
          icon: portalFavicon('https://www.home-assistant.io'),
          url: 'https://www.home-assistant.io',
          appSlug: 'home-assistant',
        },
      ],
    },
    {
      proprietary: [{ name: 'Zapier', icon: '', url: 'https://zapier.com' }],
      alternatives: [{ name: 'n8n', icon: portalFavicon('https://n8n.io'), url: 'https://n8n.io', appSlug: 'n8n' }],
    },
  ],
  security: [
    {
      proprietary: [{ name: '1Password', icon: '', url: 'https://1password.com' }],
      alternatives: [
        {
          name: 'Vaultwarden',
          icon: '/brands/vaultwarden.png',
          url: 'https://github.com/dani-garcia/vaultwarden',
          appSlug: 'vaultwarden',
        },
      ],
    },
    {
      proprietary: [{ name: 'AdGuard', icon: '', url: 'https://adguard.com' }],
      alternatives: [{ name: 'Pi-hole', icon: portalFavicon('https://pi-hole.net'), url: 'https://pi-hole.net', appSlug: 'pi-hole' }],
    },
  ],
  finance: [
    {
      proprietary: [{ name: 'Rocket Money', icon: '', url: 'https://www.rocketmoney.com' }],
      alternatives: [{ name: 'Wallos', icon: portalFavicon('https://wallosapp.com'), url: 'https://wallosapp.com', appSlug: 'wallos' }],
    },
  ],
  photography: [
    {
      proprietary: [{ name: 'Google Photos', icon: '', url: 'https://photos.google.com' }],
      alternatives: [{ name: 'Immich', icon: portalFavicon('https://immich.app'), url: 'https://immich.app', appSlug: 'immich' }],
    },
  ],
  ai: [
    {
      proprietary: [{ name: 'ChatGPT', icon: '', url: 'https://chatgpt.com' }],
      alternatives: [{ name: 'Open WebUI', icon: portalFavicon('https://openwebui.com'), url: 'https://openwebui.com', appSlug: 'open-webui' }],
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
