import { describe, expect, it } from 'vitest';
import {
  APP_STARTING_MIDDLEWARE,
  TraefikLabelsBuilder,
  withAppStartingPage,
  withHubLoginOnEveryRouter,
  withSignInUnderFileProvider,
} from '../traefik-labels.builder';

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
      // The service worker reset routers (#2324) put their middleware in front of the same forward auth.
      const expected = router.includes('-sw-reset')
        ? 'ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file'
        : 'ci-hub-edge-headers@file,ci-hub@file';
      expect(labels[`traefik.http.routers.${router}.middlewares`], `router ${router} is unguarded`).toBe(expected);
    }
  });

  // A browser holding a worker from before the sign-in can only update it through these (#2324).
  describe('service worker reset routers', () => {
    const host = 'Host(`ci-planning-core-2.ci.lan`)';

    it('take only a worker script fetch of /sw.js, on both entry points, for the app service', () => {
      const labels = build({ enableAuth: true });

      for (const [router, entrypoint] of [
        ['ci-planning-ci-marketplace-sw-reset-insecure', 'web'],
        ['ci-planning-ci-marketplace-sw-reset', 'websecure'],
      ] as const) {
        expect(labels[`traefik.http.routers.${router}.rule`]).toBe(`${host} && Path(\`/sw.js\`) && Header(\`Service-Worker\`, \`script\`)`);
        expect(labels[`traefik.http.routers.${router}.entrypoints`]).toBe(entrypoint);
        expect(labels[`traefik.http.routers.${router}.service`]).toBe('ci-planning-ci-marketplace');
        expect(labels[`traefik.http.routers.${router}.priority`]).toBeUndefined();
      }
      expect(labels['traefik.http.routers.ci-planning-ci-marketplace-sw-reset.tls.certresolver']).toBe('myresolver');
    });

    it('rank above the app router only by their longer rule', () => {
      const labels = build({ enableAuth: true });

      const appRule = String(labels['traefik.http.routers.ci-planning-ci-marketplace.rule']);
      const resetRule = String(labels['traefik.http.routers.ci-planning-ci-marketplace-sw-reset.rule']);
      expect(resetRule.startsWith(`${appRule} && `)).toBe(true);
      expect(resetRule.length).toBeGreaterThan(appRule.length);
    });

    it('keep the public host middleware after the forward auth', () => {
      const labels = build({ enableAuth: true, cloudflarePublicHostname: 'ci-planning-core-2.example.com' });

      expect(labels['traefik.http.routers.ci-planning-ci-marketplace-sw-reset.middlewares']).toBe(
        'ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker',
      );
    });

    it('are left out when the app has no sign-in in front, or no public route', () => {
      const open = build({ enableAuth: false });
      const local = new TraefikLabelsBuilder({ ...base, exposureMode: 'local', enableAuth: true }).addCloudflareLabels().build();
      const tailscale = new TraefikLabelsBuilder({ ...base, exposureMode: 'tailscale', enableAuth: true }).addTailscaleLabels().build();

      for (const labels of [open, local, tailscale]) {
        expect(Object.keys(labels).filter((key) => key.includes('-sw-reset'))).toEqual([]);
      }
    });
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
      'traefik.http.routers.ci-planning-ci-marketplace-sw-reset.middlewares':
        'ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker,ci-hub-app-starting@file',
      'traefik.http.routers.ci-planning-ci-marketplace-sw-reset-insecure.middlewares':
        'ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file,ci-planning-ci-marketplace-public-host@docker,ci-hub-app-starting@file',
    });
  });

  it('puts the Hub login in front of the Private VPN router when the login is on', () => {
    const labels = withAppStartingPage(
      new TraefikLabelsBuilder({ ...base, exposureMode: 'tailscale', enableAuth: true }).addTailscaleLabels().build(),
    );

    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-tailscale.middlewares']).toBe(`ci-hub@file,${APP_STARTING_MIDDLEWARE}`);
  });

  it('gives a router with no chain one of its own', () => {
    const labels = withAppStartingPage(new TraefikLabelsBuilder({ ...base, exposureMode: 'tailscale' }).addTailscaleLabels().build());

    expect(labels['traefik.http.routers.ci-planning-ci-marketplace-tailscale.middlewares']).toBe(APP_STARTING_MIDDLEWARE);
  });

  // One chain, under the spelling TraefikConfigService reads: its file-provider copy of the router
  // matches the option `middlewares` exactly, so a chain left under another spelling lost the Hub
  // login there.
  it('extends a chain given under another spelling, under the spelling TraefikConfigService reads', () => {
    const labels = withAppStartingPage({
      'traefik.http.routers.app.rule': 'Host(`app.ci.lan`)',
      'traefik.http.routers.app.Middlewares': 'ci-hub@file',
    });

    expect(labels['traefik.http.routers.app.middlewares']).toBe('ci-hub@file,ci-hub-app-starting@file');
    expect(labels).not.toHaveProperty('traefik.http.routers.app.Middlewares');
  });

  it('merges a router’s chains under two spellings into one', () => {
    const labels = withAppStartingPage({
      'traefik.http.routers.app.rule': 'Host(`app.ci.lan`)',
      'traefik.http.routers.app.middlewares': 'ci-hub@file',
      'traefik.http.routers.APP.MIDDLEWARES': 'app-headers@docker,CI-HUB@file',
    });

    expect(Object.keys(labels).filter((key) => key.toLowerCase().endsWith('.middlewares'))).toEqual(['traefik.http.routers.app.middlewares']);
    expect(labels['traefik.http.routers.app.middlewares']).toBe('ci-hub@file,app-headers@docker,ci-hub-app-starting@file');
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

describe('withSignInUnderFileProvider', () => {
  // The Hub container's labels define `ci-hub@docker`, and the Hub's own image update leaves them as
  // the installed compose file had them. `ci-hub@file` is what the Hub wrote on this boot, so a
  // manifest's own router gets the current sign-in, cache header included (CI-Engineering#510).
  it('puts the file provider’s sign-in where a manifest named the Docker provider’s, in the same place', () => {
    const labels = withSignInUnderFileProvider({
      'traefik.http.routers.app-api.rule': 'Host(`app.ci.lan`) && PathPrefix(`/api`)',
      'traefik.http.routers.app-api.middlewares': 'app-strip@docker,CI-HUB@docker',
      'traefik.http.routers.app-files.middlewares': 'ci-hub@docker',
    });

    expect(labels['traefik.http.routers.app-api.middlewares']).toBe('app-strip@docker,ci-hub@file');
    expect(labels['traefik.http.routers.app-files.middlewares']).toBe('ci-hub@file');
    expect(labels['traefik.http.routers.app-api.rule']).toBe('Host(`app.ci.lan`) && PathPrefix(`/api`)');
  });

  it('names the sign-in once when a chain already has the file provider’s', () => {
    const labels = withSignInUnderFileProvider({ 'traefik.http.routers.app.middlewares': 'ci-hub@file,app-headers@docker,ci-hub@docker' });

    expect(labels['traefik.http.routers.app.middlewares']).toBe('ci-hub@file,app-headers@docker');
  });

  it('leaves chains without the Docker provider’s sign-in and every other label alone', () => {
    const labels = {
      'traefik.http.routers.app.middlewares': 'app-headers@docker, ci-hub@file',
      'traefik.http.middlewares.app-headers.headers.customresponseheaders.X-Note': 'ci-hub@docker',
      'traefik.tcp.routers.db.middlewares': 'ci-hub@docker',
    };

    expect(withSignInUnderFileProvider(labels)).toEqual(labels);
  });
});

describe('withHubLoginOnEveryRouter', () => {
  const chain = (labels: Record<string, string | boolean>, router: string) => labels[`traefik.http.routers.${router}.middlewares`];
  const on = { requireLogin: true, publicWeb: false };

  it('gives a router a manifest declared with no chain the Hub login', () => {
    const labels = withHubLoginOnEveryRouter({ 'traefik.http.routers.app-admin.rule': 'Host(`a.ci.lan`) && PathPrefix(`/admin`)' }, {}, on);

    expect(chain(labels, 'app-admin')).toBe('ci-hub@file');
  });

  // A rewrite ahead of the login would change the request the login sees.
  it("moves the login ahead of the manifest's own middlewares, and keeps those once", () => {
    const labels = withHubLoginOnEveryRouter(
      { 'traefik.http.routers.app-admin.middlewares': 'app-rewrite@docker,ci-hub@docker,app-headers@docker,app-rewrite@docker' },
      {},
      on,
    );

    expect(chain(labels, 'app-admin')).toBe('ci-hub@file,app-rewrite@docker,app-headers@docker');
  });

  it('puts the edge header strip first on a Public web app', () => {
    const labels = withHubLoginOnEveryRouter(
      { 'traefik.http.routers.app-admin.middlewares': 'app-headers@docker' },
      {},
      { requireLogin: true, publicWeb: true },
    );

    expect(chain(labels, 'app-admin')).toBe('ci-hub-edge-headers@file,ci-hub@file,app-headers@docker');
  });

  it('leaves the login off only when the operator switched it off, and takes out one the manifest set', () => {
    const labels = withHubLoginOnEveryRouter(
      { 'traefik.http.routers.app-admin.middlewares': 'ci-hub@file,app-headers@docker' },
      {},
      { requireLogin: false, publicWeb: false },
    );

    expect(chain(labels, 'app-admin')).toBe('app-headers@docker');
  });

  it('folds two spellings of one router into one chain, as Traefik reads them as one router', () => {
    const labels = withHubLoginOnEveryRouter(
      { 'traefik.http.routers.App-Admin.middlewares': 'app-a@docker', 'traefik.http.routers.app-admin.MIDDLEWARES': 'app-b@docker' },
      {},
      on,
    );

    expect(chain(labels, 'App-Admin')).toBe('ci-hub@file,app-a@docker,app-b@docker');
    expect(Object.keys(labels).filter((key) => key.toLowerCase().endsWith('.middlewares'))).toHaveLength(1);
  });

  it("leaves the Hub's own routers as they are: the service-worker reset runs before the login there", () => {
    const hub = { 'traefik.http.routers.app-sw-reset.middlewares': 'ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file' };
    const labels = withHubLoginOnEveryRouter({ ...hub }, hub, { requireLogin: true, publicWeb: true });

    expect(chain(labels, 'app-sw-reset')).toBe('ci-hub-edge-headers@file,ci-hub-sw-reset@file,ci-hub@file');
  });
});

describe('addPublicPathRouters', () => {
  const R = 'traefik.http.routers.ci-planning-ci-marketplace';
  const withPaths = (overrides: Partial<ConstructorParameters<typeof TraefikLabelsBuilder>[0]> = {}) =>
    new TraefikLabelsBuilder({ ...base, enableAuth: true, publicPaths: ['/hook', '/api/v1/events/'], ...overrides })
      .addCloudflareLabels()
      .addTailscaleLabels()
      .addPublicPathRouters()
      .build();

  it('gives each Public web router a twin for the paths, with the same chain but no login', () => {
    const labels = withPaths();
    const rule = 'Path(`/hook`) || PathPrefix(`/hook/`) || Path(`/api/v1/events`) || PathPrefix(`/api/v1/events/`)';

    for (const router of ['', '-insecure']) {
      expect(labels[`${R}${router}-public-paths.rule`]).toBe(`(Host(\`ci-planning-core-2.ci.lan\`)) && (${rule})`);
      expect(labels[`${R}${router}-public-paths.service`]).toBe('ci-planning-ci-marketplace');
      expect(labels[`${R}${router}-public-paths.middlewares`]).toBe('ci-hub-edge-headers@file');
      // The router with the login is untouched.
      expect(labels[`${R}${router}.middlewares`]).toBe('ci-hub-edge-headers@file,ci-hub@file');
    }
    expect(labels[`${R}-insecure-public-paths.entrypoints`]).toBe('web');
    expect(labels[`${R}-public-paths.entrypoints`]).toBe('websecure');
    expect(labels[`${R}-public-paths.tls.certresolver`]).toBe('myresolver');
  });

  it('gives the service-worker reset routers no twin: the login decides that fetch', () => {
    expect(Object.keys(withPaths()).filter((key) => key.includes('sw-reset') && key.includes('public-paths'))).toEqual([]);
  });

  it('gives the Private VPN router one too', () => {
    const labels = withPaths({ exposureMode: 'tailscale' });

    expect(labels[`${R}-tailscale-public-paths.rule`]).toContain('PathPrefix(`/hook/`)');
    expect(labels[`${R}-tailscale-public-paths` + '.middlewares']).toBeUndefined();
  });

  it('adds nothing with the login off (everything is open) or with no paths', () => {
    for (const labels of [withPaths({ enableAuth: false }), withPaths({ publicPaths: [] }), withPaths({ publicPaths: undefined })]) {
      expect(Object.keys(labels).filter((key) => key.includes('public-paths'))).toEqual([]);
    }
  });
});
