import { describe, expect, it } from 'vitest';
import { APP_STARTING_MIDDLEWARE, TraefikLabelsBuilder, withAppStartingPage } from '../traefik-labels.builder';

const base = {
  internalPort: 12002,
  appId: 'ci-planning',
  storeId: 'ci-marketplace',
  cloudflareOriginHostname: 'ci-planning-core-2.ci.lan',
  exposureMode: 'cloudflare' as const,
};

const build = (overrides: Partial<ConstructorParameters<typeof TraefikLabelsBuilder>[0]> = {}) =>
  new TraefikLabelsBuilder({ ...base, ...overrides }).addCloudflareLabels().build();

describe('TraefikLabelsBuilder — forward-auth middleware', () => {
  it('attaches the middleware to the plain-HTTP router as well as the TLS one', () => {
    const labels = build({ enableAuth: true });

    // The `web` entrypoint is the one the Cloudflare tunnel connects to. Leaving it unguarded
    // let every remote request reach the app unauthenticated while the TLS entrypoint — the
    // one an operator would curl from the appliance — looked correctly gated.
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-insecure.middlewares']).toBe('ci-hub-edge-headers@file,ci-hub@file');
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace.middlewares']).toBe('ci-hub-edge-headers@file,ci-hub@file');
  });

  it('guards every router it creates, so no entrypoint is left open', () => {
    const labels = build({ enableAuth: true });

    // Enumerated rather than asserted individually: a future router added to addCloudflareLabels
    // without a middleware would silently reopen the hole this test exists to close.
    const routers = new Set(
      Object.keys(labels)
        .map((key) => /^traefik\.http\.routers\.([^.]+)\./.exec(key)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    for (const router of routers) {
      expect(labels[`traefik.http.routers.${router}.middlewares`], `router ${router} is unguarded`).toBe('ci-hub-edge-headers@file,ci-hub@file');
    }
  });

  it('attaches no login to either router when auth is disabled, only the edge-header strip', () => {
    const labels = build({ enableAuth: false });

    expect(labels['traefik.http.routers.ci-planning-ci-marketplace.middlewares']).toBe('ci-hub-edge-headers@file');
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-insecure.middlewares']).toBe('ci-hub-edge-headers@file');
  });

  it('forwards public host headers to the app after edge auth', () => {
    const labels = build({ enableAuth: true, cloudflarePublicHostname: 'ci-planning-core-2.example.com' });

    expect(labels['traefik.http.middlewares.ci-planning-ci-marketplace-public-host.headers.customrequestheaders.X-Forwarded-Host']).toBe(
      'ci-planning-core-2.example.com',
    );
    expect(labels['traefik.http.middlewares.ci-planning-ci-marketplace-public-host.headers.customrequestheaders.X-Forwarded-Proto']).toBe('https');
    expect(labels['traefik.http.middlewares.ci-planning-ci-marketplace-public-host.headers.customrequestheaders.X-Forwarded-Port']).toBe('443');
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace.middlewares']).toBe(
      'ci-hub-edge-headers@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker',
    );
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-insecure.middlewares']).toBe(
      'ci-hub-edge-headers@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker',
    );
  });

  it('still forwards public host headers when app-level auth is disabled', () => {
    const labels = build({ enableAuth: false, cloudflarePublicHostname: 'ci-planning-core-2.example.com' });

    expect(labels['traefik.http.routers.ci-planning-ci-marketplace.middlewares']).toBe(
      'ci-hub-edge-headers@file,ci-planning-ci-marketplace-public-host@docker',
    );
    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-insecure.middlewares']).toBe(
      'ci-hub-edge-headers@file,ci-planning-ci-marketplace-public-host@docker',
    );
  });

  it('creates no routers at all outside cloudflare exposure', () => {
    const labels = new TraefikLabelsBuilder({ ...base, exposureMode: 'local', enableAuth: true }).addCloudflareLabels().build();

    expect(Object.keys(labels).some((key) => key.startsWith('traefik.http.routers.'))).toBe(false);
  });
});

describe('withAppStartingPage', () => {
  const routerChains = (labels: Record<string, string | boolean>) =>
    Object.fromEntries(Object.entries(labels).filter(([key]) => /^traefik\.http\.routers\.[^.]+\.middlewares$/i.test(key)));

  it('ends every router this builder makes with the page, after the edge strip and the login', () => {
    const labels = withAppStartingPage(build({ enableAuth: true, cloudflarePublicHostname: 'ci-planning-hub1.example.com' }));

    expect(routerChains(labels)).toEqual({
      'traefik.http.routers.ci-planning-ci-marketplace.middlewares':
        'ci-hub-edge-headers@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker,ci-hub-app-starting@file',
      'traefik.http.routers.ci-planning-ci-marketplace-insecure.middlewares':
        'ci-hub-edge-headers@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker,ci-hub-app-starting@file',
    });
  });

  it('gives a router with no chain one of its own', () => {
    const labels = withAppStartingPage(new TraefikLabelsBuilder({ ...base, exposureMode: 'tailscale' }).addTailscaleLabels().build());

    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-tailscale.middlewares']).toBe(APP_STARTING_MIDDLEWARE);
  });

  it('extends a chain under the spelling it was given instead of adding a second one', () => {
    const labels = withAppStartingPage({
      'traefik.http.routers.app.rule': 'Host(`app.ci.lan`)',
      'traefik.http.routers.app.Middlewares': 'ci-hub@file',
    });

    expect(labels['traefik.http.routers.app.Middlewares']).toBe('ci-hub@file,ci-hub-app-starting@file');
    expect(labels).not.toHaveProperty('traefik.http.routers.app.middlewares');
  });

  it('adds it once, wherever a chain already has it', () => {
    const once = withAppStartingPage(build({ enableAuth: true }));

    expect(withAppStartingPage(once)).toEqual(once);
    expect(
      withAppStartingPage({ 'traefik.http.routers.app.middlewares': 'ci-hub-app-starting@file, ci-hub@file' })[
        'traefik.http.routers.app.middlewares'
      ],
    ).toBe('ci-hub-app-starting@file,ci-hub@file');
  });

  it('leaves labels without HTTP routers alone: no route, no page', () => {
    const local = new TraefikLabelsBuilder({ ...base, exposureMode: 'local' }).addCloudflareLabels().build();
    const tcpOnly = {
      'traefik.enable': true,
      'traefik.tcp.routers.db.rule': 'HostSNI(`*`)',
      'traefik.http.services.db.loadbalancer.server.port': '5432',
    };

    expect(withAppStartingPage(local)).toEqual(local);
    expect(withAppStartingPage(tcpOnly)).toEqual(tcpOnly);
  });
});
