import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { isTauriMobileSync, isMobileClient, getHubBaseUrlSync, initMobileConnection, clearHubConnection } = vi.hoisted(() => ({
  isTauriMobileSync: vi.fn(() => false),
  isMobileClient: vi.fn(() => false),
  getHubBaseUrlSync: vi.fn((): string | null => null),
  initMobileConnection: vi.fn(async () => ({ isMobile: false, hubBaseUrl: null })),
  clearHubConnection: vi.fn(async () => {}),
}));

vi.mock('./lib/mobile-connection', () => ({
  isTauriMobileSync,
  isMobileClient,
  usesCloudConnect: () => isMobileClient(),
  getHubBaseUrlSync,
  needsRemoteHubConnect: () => isMobileClient() && !getHubBaseUrlSync(),
  isCloudConnectPath: (pathname: string) => pathname === '/connect' || pathname.startsWith('/connect/'),
  initMobileConnection,
  clearHubConnection,
}));
vi.mock('./lib/sentry', () => ({ captureHubException: vi.fn(), loadHubSentryDeviceId: vi.fn() }));
vi.mock('./lib/api-fetch', () => ({
  getTauriSessionId: vi.fn(() => null),
  clearStaleServerSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./lib/registration-cache', () => ({ resolveRegistrationStatus: vi.fn(), getCachedRegistrationStatus: vi.fn(() => null) }));
vi.mock('./lib/hub-session-refresh', () => ({
  refreshHubSessionIfDue: vi.fn().mockResolvedValue(false),
  setServerSessionRefreshRecommendedAt: vi.fn(),
}));
vi.mock('./lib/mobile-load-watchdog', () => ({ installMobileLoadWatchdog: vi.fn() }));
vi.mock('./lib/tauri-hub-probe', () => ({ configureHubApiPort: vi.fn(), probeHealthyHubApiPort: vi.fn(async () => null) }));
vi.mock('./lib/hub-runtime-mode', () => ({ usesCrossOriginDesktopApi: () => false }));
vi.mock('./lib/use-mobile-load-timeout', () => ({ shouldTimeBoxMobileLoads: () => false }));
vi.mock('./api-client', () => ({ userContext: vi.fn() }));
vi.mock('./api-client/client.gen', () => ({
  client: {
    getConfig: () => ({}),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    setConfig: vi.fn(),
  },
}));
vi.mock('./hooks/use-update-checker', () => ({ useUpdateChecker: () => {} }));
vi.mock('./components/titlebar/titlebar', () => ({ Titlebar: () => null }));
vi.mock('./components/hub-status/hub-status', () => ({
  HubStatus: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/providers/i18n/i18n-provider', () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  Links: () => null,
  Meta: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

const { Layout, removeOrphanedStartupGates } = await import('./root');

const GATE = '[data-testid="connecting-to-local-api"]';
const tree = (
  <Layout>
    <div data-testid="route-child" />
  </Layout>
);

/** What `react-router build` writes to index.html: the Layout rendered where `document` does not exist. */
function prerender(): string {
  const realDocument = globalThis.document;
  vi.stubGlobal('document', undefined);
  try {
    return renderToString(tree);
  } finally {
    vi.stubGlobal('document', realDocument);
  }
}

describe('root Layout hydration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the first browser pass byte-identical to the prerendered document', () => {
    const prerendered = prerender();
    // Same tree, but now `document` exists — the branch the client takes on hydration.
    const firstClientPass = renderToString(tree);

    expect(prerendered).toContain('data-testid="connecting-to-local-api"');
    expect(prerendered).not.toContain('data-testid="route-child"');
    expect(firstClientPass).toBe(prerendered);
  });

  it('removes only a body-level gate that no React tree owns', () => {
    const orphan = document.createElement('main');
    orphan.setAttribute('data-testid', 'connecting-to-local-api');
    const owned = document.createElement('main');
    owned.setAttribute('data-testid', 'connecting-to-local-api');
    owned.setAttribute('data-hydrated', '');
    const nested = document.createElement('div');
    nested.innerHTML = '<main data-testid="connecting-to-local-api"></main>';
    document.body.append(orphan, owned, nested);

    removeOrphanedStartupGates();

    expect(orphan.isConnected).toBe(false);
    expect(owned.isConnected).toBe(true);
    expect(nested.querySelector(GATE)).not.toBeNull();
    owned.remove();
    nested.remove();
  });

  it('hydrates the prerendered document without a recoverable error and keeps the gate React owns', async () => {
    const html = prerender();
    document.open();
    document.write(`<!DOCTYPE html>${html}`);
    document.close();
    // A third-party script injected into <body> after the prerender, as the
    // Cloudflare tunnel does on every hub hostname.
    const injected = document.createElement('script');
    injected.setAttribute('data-injected', '');
    document.body.appendChild(injected);
    const prerenderedGate = document.querySelector(GATE);
    expect(prerenderedGate).not.toBeNull();

    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(document, tree, { onRecoverableError: (error) => recoverable.push(error) });
    });

    expect(recoverable).toEqual([]);
    expect(consoleError.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringMatching(/hydrat/i));
    // Once the mount effects flip apiReady the route child is in, and no gate — orphan or owned — is left at body level.
    await act(async () => {});
    expect(document.querySelector('[data-testid="route-child"]')).not.toBeNull();
    expect(document.querySelectorAll(`body > ${GATE}`)).toHaveLength(0);
    expect(prerenderedGate?.isConnected).toBe(false);
  });
});
