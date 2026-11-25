import path from 'node:path';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import YAML from 'yaml';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { APP_STARTING_MIDDLEWARE, TraefikLabelsBuilder, withAppStartingPage } from '../builders/traefik-labels.builder';
import { APP_DOWN_ROUTER_SUFFIX, SESSION_NO_EDGE_CACHE_MIDDLEWARE, SESSION_ROUTER_SUFFIX, TraefikConfigService } from '../traefik-config.service';

const written = new Map<string, string>();
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  writeHealableTextFile: vi.fn(async (filePath: string, content: string) => {
    written.set(filePath, content);
  }),
}));

const DYNAMIC_DIR = '/data/state/traefik/dynamic';

/**
 * Which routers the Hub writes for Traefik's file provider end with the app-starting page
 * (CI-Hub#1764): every app route, and never the Hub's own.
 */
describe('TraefikConfigService — the app-starting page', () => {
  let docker: ReturnType<typeof mock<Dockerode>>;
  let service: TraefikConfigService;

  beforeEach(() => {
    written.clear();
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ directories: { dataDir: '/data' } } as never);
    const filesystem = mock<FilesystemService>();
    filesystem.pathExists.mockResolvedValue(false);
    filesystem.readTextFile.mockImplementation(async (filePath: string) => written.get(filePath) ?? null);
    docker = mock<Dockerode>();
    service = new TraefikConfigService(mock<LoggerService>(), config, filesystem, docker, mock<AppsRepository>());
  });

  const parsed = (file: string) => YAML.parse(written.get(`${DYNAMIC_DIR}/${file}`) ?? 'null');

  it('ends every port-expose route with it', async () => {
    await service.syncPortExposeRoutes([
      { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123 },
      { appUrn: 'other:_user' as AppUrn, traefikHost: 'other-hub1-acme.ci.lan', upstreamPort: 9000 },
    ]);

    const { routers } = parsed('port-expose.yml').http;
    expect(routers['my-service-_user'].middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
    expect(routers['other-_user'].middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
  });

  it("never adds it to the Hub's own public route", async () => {
    await service.writeHubRoute('hub1-acme', 'ci0.pw');

    const hub = parsed('hub.yml');
    expect(hub.http.routers['hub-public']).not.toHaveProperty('middlewares');
    expect(written.get(`${DYNAMIC_DIR}/hub.yml`)).not.toContain('ci-hub-app-starting');
  });

  it('carries an app container’s chain into apps.yml, and skips the Hub’s container', async () => {
    const containers: Record<string, { Name: string; Labels: Record<string, string> }> = {
      app: {
        Name: '/nginx-store-id-nginx-1',
        Labels: {
          'ci-hub.appurn': 'nginx:store-id',
          'traefik.enable': 'true',
          'traefik.http.routers.nginx-store-id-insecure.rule': 'Host(`nginx-hub1-acme.ci.lan`)',
          'traefik.http.routers.nginx-store-id-insecure.entrypoints': 'web',
          'traefik.http.routers.nginx-store-id-insecure.service': 'nginx-store-id',
          'traefik.http.routers.nginx-store-id-insecure.middlewares': 'ci-hub-edge-headers@file,ci-hub@file,ci-hub-app-starting@file',
          'traefik.http.services.nginx-store-id.loadbalancer.server.port': '80',
        },
      },
      hub: {
        Name: '/ci-hub',
        Labels: {
          'traefik.enable': 'true',
          'traefik.http.routers.ci-hub.rule': 'Host(`ci-hub.local`)',
          'traefik.http.routers.ci-hub.entrypoints': 'web',
          'traefik.http.routers.ci-hub.service': 'ci-hub',
          'traefik.http.services.ci-hub.loadbalancer.server.port': '5002',
        },
      },
    };
    docker.listContainers.mockResolvedValue(Object.keys(containers).map((Id) => ({ Id })) as never);
    docker.getContainer.mockImplementation(
      (id: string) =>
        ({
          inspect: async () => ({
            Name: containers[id]?.Name,
            Config: { Labels: containers[id]?.Labels },
            // Each app's container is on its own network only, where Traefik reaches it.
            NetworkSettings: { Networks: { 'nginx_store-id_network': { IPAddress: '172.30.0.9' } } },
          }),
        }) as never,
    );

    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;
    expect(routers['nginx-store-id-insecure'].middlewares).toEqual(['ci-hub-edge-headers@file', 'ci-hub@file', 'ci-hub-app-starting@file']);
    expect(routers).not.toHaveProperty('ci-hub');
  });
});

/**
 * What a visitor gets while an app restarts (CI-Hub#1944). A restart runs `compose down` before
 * `compose up`, and Traefik drops everything the Docker provider knew about the app with its
 * containers: its routers and the middlewares its labels define. Only the file provider is left,
 * which is dynamic.yml plus the apps.yml the Hub wrote before the restart.
 */
describe('TraefikConfigService — routes while an app restarts', () => {
  const ORIGIN_HOST = 'wordpress-hub1-acme.localhost';
  const NEXTCLOUD_HOST = 'nextcloud-hub1-acme.localhost';
  let docker: ReturnType<typeof mock<Dockerode>>;
  let appsRepository: ReturnType<typeof mock<AppsRepository>>;
  let service: TraefikConfigService;
  let newService: () => TraefikConfigService;

  beforeEach(() => {
    written.clear();
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ directories: { dataDir: '/data' } } as never);
    const filesystem = mock<FilesystemService>();
    filesystem.pathExists.mockImplementation(async (filePath: string) => written.has(filePath));
    filesystem.readTextFile.mockImplementation(async (filePath: string) => written.get(filePath) ?? null);
    filesystem.removeFile.mockImplementation(async (filePath: string) => {
      written.delete(filePath);
    });
    docker = mock<Dockerode>();
    appsRepository = mock<AppsRepository>();
    appsRepository.getApps.mockResolvedValue([]);
    const logger = mock<LoggerService>();
    newService = () => new TraefikConfigService(logger, config, filesystem, docker, appsRepository);
    service = newService();
  });

  const parsed = (file: string) => YAML.parse(written.get(`${DYNAMIC_DIR}/${file}`) ?? 'null');

  /**
   * A Public Web app from the marketplace behind Hub sign-in (WordPress unless said otherwise),
   * labelled the way the compose builder labels it and compose names its project.
   */
  const publicWebLabels = ({
    appId = 'wordpress',
    host = ORIGIN_HOST,
    chain,
    enableAuth = true,
  }: {
    appId?: string;
    host?: string;
    chain?: string;
    enableAuth?: boolean;
  } = {}) => {
    const labels = withAppStartingPage({
      ...new TraefikLabelsBuilder({
        internalPort: 80,
        appId,
        storeId: 'ci-marketplace',
        exposureMode: 'cloudflare',
        enableAuth,
        cloudflareOriginHostname: host,
        cloudflarePublicHostname: host.replace('.localhost', '.ci0.pw'),
      })
        .addCloudflareLabels()
        .build(),
      // WordPress's manifest adds a middleware of its own through extraLabels.
      [`traefik.http.middlewares.${appId}-ci-marketplace.headers.customrequestheaders.X-Forwarded-Proto`]: 'https',
      'com.docker.compose.project': `${appId}_ci-marketplace`,
      'ci-hub.appurn': `${appId}:ci-marketplace`,
    });
    if (chain) {
      labels[`traefik.http.routers.${appId}-ci-marketplace-insecure.middlewares`] = chain;
    }
    return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
  };

  /** The containers Docker lists as running, each with the labels given. */
  const runningContainers = (...containers: Array<Record<string, string>>) => {
    docker.listContainers.mockResolvedValue(containers.map((_, index) => ({ Id: String(index) })) as never);
    docker.getContainer.mockImplementation(
      (id: string) =>
        ({
          inspect: async () => ({
            Name: `/${containers[Number(id)]?.['com.docker.compose.project']}-web-${id}`,
            Config: { Labels: containers[Number(id)] },
            NetworkSettings: {
              Networks: { [`${containers[Number(id)]?.['com.docker.compose.project']}_network`]: { IPAddress: `172.19.0.${Number(id) + 2}` } },
            },
          }),
        }) as never,
    );
  };

  /** The apps the Hub's database holds, all on Public Web unless said otherwise. */
  const appsInDb = (...apps: Array<{ appId: string; status: AppStatus; exposureMode?: string }>) => {
    appsRepository.getApps.mockResolvedValue(
      apps.map(({ appId, status, exposureMode = 'cloudflare' }) => ({
        appName: appId,
        appStoreSlug: 'ci-marketplace',
        status,
        config: { exposureMode, exposedLocal: true },
        exposureMode,
        exposedLocal: true,
      })) as never,
    );
  };

  /** dynamic.yml as shipped, read off disk (the shared test setup mocks `fs`). */
  const shippedDynamic = async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    return YAML.parse(readFileSync(path.join(__dirname, '../../../../assets/traefik/dynamic/dynamic.yml'), 'utf-8'));
  };

  /**
   * The routers Traefik can still serve for `host` with the Docker provider empty: every middleware
   * and the service must resolve inside the file provider, or Traefik disables the router.
   */
  const fileOnlyRoutersFor = async (host: string) => {
    const dynamic = await shippedDynamic();
    const apps = YAML.parse(written.get(`${DYNAMIC_DIR}/apps.yml`) ?? 'null');
    const middlewares = new Set([...Object.keys(dynamic.http.middlewares ?? {}), ...Object.keys(apps?.http?.middlewares ?? {})]);
    const services = { ...dynamic.http.services, ...apps?.http?.services };
    const inFileProvider = (name: string) => {
      const [base = '', provider = 'file'] = name.split('@');
      return provider === 'file' && middlewares.has(base);
    };
    const routers: Record<string, { rule: string; service: string; middlewares?: string[]; priority?: number }> = apps?.http?.routers ?? {};
    return Object.entries(routers)
      .filter(([, router]) => router.rule === `Host(\`${host}\`)`)
      .filter(([, router]) => (router.middlewares ?? []).every(inFileProvider) && router.service in services)
      .map(([name, router]) => ({ name, ...router, servers: services[router.service].loadBalancer.servers as Array<{ url: string }> }));
  };

  /**
   * Nextcloud's containers are gone (its compose down has run) when WordPress's start, or any other
   * app event, rebuilds apps.yml. `null` means Nextcloud's row is gone too.
   */
  const rebuildWhileNextcloudIsDown = async (nextcloud: { status: AppStatus; exposureMode?: string } | null) => {
    runningContainers(publicWebLabels(), publicWebLabels({ appId: 'nextcloud', host: NEXTCLOUD_HOST }));
    await service.generateTraefikConfig();

    runningContainers(publicWebLabels());
    appsInDb({ appId: 'wordpress', status: 'running' }, ...(nextcloud ? [{ appId: 'nextcloud', ...nextcloud }] : []));
    await service.generateTraefikConfig();
  };

  it('keeps a route to the starting page once compose down has removed the containers, behind forward auth', async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    const [kept, ...others] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(kept).toBeDefined();
    expect(others).toEqual([]);
    const chain = kept?.middlewares ?? [];
    expect(chain[0]).toBe('ci-hub-edge-headers@file');
    expect(chain).toContain('ci-hub@file');
    expect(chain.indexOf('ci-hub@file')).toBeLessThan(chain.indexOf(APP_STARTING_MIDDLEWARE));
    // The public-host headers still reach the page, from their copy in apps.yml.
    expect(chain).toContain('wordpress-ci-marketplace-public-host');
  });

  it("never sends that route to the removed container's address", async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    const [kept] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(kept?.servers).toEqual([{ url: 'http://127.0.0.1:9' }]);
  });

  it("ranks it below the app's own routers, so it never answers while they are up", async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;
    const own = Object.values<{ rule: string; priority?: number }>(routers).filter(
      (router) => router.rule === `Host(\`${ORIGIN_HOST}\`)` && !router.priority,
    );
    const [kept] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(own.length).toBeGreaterThan(0);
    // Traefik ranks a router without a priority by the length of its rule.
    expect(kept?.priority).toBeGreaterThan(0);
    expect(kept?.priority).toBeLessThan(`Host(\`${ORIGIN_HOST}\`)`.length);
  });

  it("keeps the order Traefik gives the app's own routers among their routes to the page", async () => {
    // A path behind Hub sign-in on a host the app otherwise serves to anyone, and an API path with a
    // priority of its own. Tied at one priority, a request for /wp-admin could get the page without
    // the sign-in while the app is down.
    const route = (name: string, rule: string, extra: Record<string, string> = {}) => ({
      [`traefik.http.routers.${name}.rule`]: rule,
      [`traefik.http.routers.${name}.entrypoints`]: 'web',
      [`traefik.http.routers.${name}.service`]: 'wordpress-ci-marketplace',
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`traefik.http.routers.${name}.${key}`, value])),
    });
    runningContainers({
      ...publicWebLabels({ chain: 'ci-hub-edge-headers@file,ci-hub-app-starting@file' }),
      ...route('wordpress-ci-marketplace-admin', `Host(\`${ORIGIN_HOST}\`) && PathPrefix(\`/wp-admin\`)`, {
        middlewares: 'ci-hub-edge-headers@file,ci-hub@file,ci-hub-app-starting@file',
      }),
      ...route('wordpress-ci-marketplace-api', `Host(\`${ORIGIN_HOST}\`) && PathPrefix(\`/api\`)`, { priority: '100' }),
    });
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;
    const down = (name: string) => routers[`wordpress-ci-marketplace-${name}${APP_DOWN_ROUTER_SUFFIX}`];

    expect(down('admin').middlewares).toContain('ci-hub@file');
    expect(down('insecure').middlewares).not.toContain('ci-hub@file');
    expect(down('admin').priority).toBeGreaterThan(down('insecure').priority);
    // The API router's own priority, 100, puts it above the longer /wp-admin rule.
    expect(down('api').priority).toBeGreaterThan(down('admin').priority);
    expect(down('api').priority).toBeLessThan(`Host(\`${ORIGIN_HOST}\`)`.length);
  });

  it("leaves a @docker middleware the app's containers do not define as it is", async () => {
    // The Hub's forward auth as the Hub container's labels define it, which many marketplace apps
    // name. It has no copy in apps.yml, so the kept route keeps naming it and answers only while it
    // exists (on a running Hub, always), never without it.
    runningContainers(
      publicWebLabels({ chain: 'ci-hub-edge-headers@file,ci-hub@docker,wordpress-ci-marketplace-public-host@docker,ci-hub-app-starting@file' }),
    );
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;

    expect(routers[`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`].middlewares).toContain('ci-hub@docker');
    expect(await fileOnlyRoutersFor(ORIGIN_HOST)).toEqual([]);
  });

  it('matches only the requests the app router matches, TLS included', async () => {
    // Without `tls`, the copy of a TLS-only router would answer plain HTTP on that host while the
    // app is up, which the app's own router never does.
    runningContainers({ ...publicWebLabels(), 'traefik.http.routers.wordpress-ci-marketplace-insecure.tls': 'true' });
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;

    expect(routers[`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`].tls).toBe(true);
  });

  it("still sends it to Traefik's loopback when an app names a service of its own like that one", async () => {
    runningContainers({ ...publicWebLabels(), 'traefik.http.services.ci-hub-app-down-wordpress_ci-marketplace.loadbalancer.server.port': '8080' });
    await service.generateTraefikConfig();

    const [kept] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(kept?.servers).toEqual([{ url: 'http://127.0.0.1:9' }]);
  });

  it('never replaces an app router whose name is taken by a down router', async () => {
    runningContainers({
      ...publicWebLabels(),
      [`traefik.http.routers.wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}.rule`]: `Host(\`${ORIGIN_HOST}\`) && PathPrefix(\`/down\`)`,
      [`traefik.http.routers.wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}.entrypoints`]: 'web',
      [`traefik.http.routers.wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}.service`]: 'wordpress-ci-marketplace',
    });
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;

    expect(routers[`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`].service).toBe('wordpress-ci-marketplace');
  });

  it('names a middleware that another container of the same app defines by its copy too', async () => {
    const web = publicWebLabels({
      chain: 'ci-hub-edge-headers@file,ci-hub@file,wordpress-ci-marketplace-proxy-headers@docker,ci-hub-app-starting@file',
    });
    const proxy = {
      'traefik.enable': 'true',
      'traefik.http.middlewares.wordpress-ci-marketplace-proxy-headers.headers.customrequestheaders.X-Script-Name': '/',
      'com.docker.compose.project': 'wordpress_ci-marketplace',
      'ci-hub.appurn': 'wordpress:ci-marketplace',
    };
    runningContainers(web, proxy);
    await service.generateTraefikConfig();

    const [kept] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(kept?.middlewares).toContain('wordpress-ci-marketplace-proxy-headers');
  });

  it('drops every route of an app being uninstalled, the kept one included', async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    // An uninstall regenerates apps.yml once compose down has removed the containers.
    appsInDb({ appId: 'wordpress', status: 'uninstalling' });
    docker.listContainers.mockResolvedValue([] as never);
    await service.generateTraefikConfig();

    expect(written.has(`${DYNAMIC_DIR}/apps.yml`)).toBe(false);
  });

  it('keeps only the route to the page once Stop has taken the containers down', async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    // Stop regenerates apps.yml once compose down has removed the containers, with the app still `stopping`.
    appsInDb({ appId: 'wordpress', status: 'stopping' });
    docker.listContainers.mockResolvedValue([] as never);
    await service.generateTraefikConfig();

    const [kept, ...others] = await fileOnlyRoutersFor(ORIGIN_HOST);
    expect(kept?.name).toBe(`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
    expect(kept?.servers).toEqual([{ url: 'http://127.0.0.1:9' }]);
    expect(others).toEqual([]);
    expect(parsed('apps.yml').http.routers).not.toHaveProperty('wordpress-ci-marketplace-insecure');
  });

  it("keeps an app's route to the page through another app's rebuild while its containers are gone", async () => {
    await rebuildWhileNextcloudIsDown({ status: 'restarting' });

    const [kept, ...others] = await fileOnlyRoutersFor(NEXTCLOUD_HOST);

    expect(kept?.name).toBe(`nextcloud-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
    expect(others).toEqual([]);
    expect(kept?.middlewares).toContain('ci-hub@file');
    expect(kept?.middlewares).toContain('nextcloud-ci-marketplace-public-host');
    expect(kept?.servers).toEqual([{ url: 'http://127.0.0.1:9' }]);
    // Nothing of Nextcloud's points at its old container any more, and WordPress keeps its own routes.
    const { routers } = parsed('apps.yml').http;
    expect(routers).not.toHaveProperty('nextcloud-ci-marketplace-insecure');
    expect(routers).toHaveProperty('wordpress-ci-marketplace-insecure');
    expect(routers).toHaveProperty(`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
  });

  it.each<AppStatus>(['running', 'starting', 'restarting', 'updating', 'resetting', 'backing_up', 'restoring', 'stopping', 'stopped'])(
    'keeps it while the app is %s',
    async (status) => {
      await rebuildWhileNextcloudIsDown({ status });

      expect(await fileOnlyRoutersFor(NEXTCLOUD_HOST)).toHaveLength(1);
    },
  );

  it.each<AppStatus>(['uninstalling', 'install_failed', 'missing'])('drops it once the app is %s', async (status) => {
    await rebuildWhileNextcloudIsDown({ status });

    expect(parsed('apps.yml').http.routers).not.toHaveProperty(`nextcloud-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
  });

  it('drops it once the app is uninstalled', async () => {
    await rebuildWhileNextcloudIsDown(null);

    expect(parsed('apps.yml').http.routers).not.toHaveProperty(`nextcloud-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
  });

  it('drops it once the app is no longer on Public Web or the VPN', async () => {
    // Switched to local only: compose up gives its containers no Traefik labels, so no rebuild sees them.
    await rebuildWhileNextcloudIsDown({ status: 'restarting', exposureMode: 'local' });

    expect(parsed('apps.yml').http.routers).not.toHaveProperty(`nextcloud-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
  });

  it("drops it when the Hub cannot read its apps' status", async () => {
    runningContainers(publicWebLabels(), publicWebLabels({ appId: 'nextcloud', host: NEXTCLOUD_HOST }));
    await service.generateTraefikConfig();

    runningContainers(publicWebLabels());
    appsRepository.getApps.mockRejectedValue(new Error('database unavailable'));
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;
    expect(routers).not.toHaveProperty(`nextcloud-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`);
    expect(routers).toHaveProperty('wordpress-ci-marketplace-insecure');
  });

  describe('requests that carry a session', () => {
    const SESSION_RULE = 'HeaderRegexp(`Cookie`, `.`) || HeaderRegexp(`Authorization`, `.`)';
    const HOST_RULE = `Host(\`${ORIGIN_HOST}\`)`;
    const route = (name: string, rule: string, extra: Record<string, string> = {}) => ({
      [`traefik.http.routers.${name}.rule`]: rule,
      [`traefik.http.routers.${name}.entrypoints`]: 'web',
      [`traefik.http.routers.${name}.service`]: 'wordpress-ci-marketplace',
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`traefik.http.routers.${name}.${key}`, value])),
    });
    type Router = { rule: string; service: string; entryPoints: string[]; middlewares?: string[]; priority?: number };
    const routers = (): Record<string, Router> => parsed('apps.yml').http.routers;

    it('sends them on an app route without the Hub sign-in through a copy that tells Cloudflare not to keep the answer', async () => {
      runningContainers(publicWebLabels({ enableAuth: false }));
      await service.generateTraefikConfig();

      const own = routers()['wordpress-ci-marketplace-insecure'];
      const copy = routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`];

      expect(own?.middlewares).not.toContain('ci-hub@file');
      expect(own?.middlewares).not.toContain(SESSION_NO_EDGE_CACHE_MIDDLEWARE);
      expect(copy).toEqual({
        rule: `(${HOST_RULE}) && (${SESSION_RULE})`,
        service: own?.service,
        entryPoints: ['web'],
        // First, so it has the last word on the answer; then the app route's own chain.
        middlewares: [SESSION_NO_EDGE_CACHE_MIDDLEWARE, ...(own?.middlewares ?? [])],
        // Traefik ranks the app route by the length of its rule.
        priority: HOST_RULE.length + 1,
      });
    });

    it('leaves requests without a cookie or Authorization header to the app route, so a public site stays cached', async () => {
      runningContainers(publicWebLabels({ enableAuth: false }));
      await service.generateTraefikConfig();

      const plain = Object.entries(routers()).filter(([, router]) => router.rule === HOST_RULE && router.service === 'wordpress-ci-marketplace');

      expect(plain.map(([name]) => name)).toEqual(['wordpress-ci-marketplace-insecure']);
      expect(plain[0]?.[1].middlewares).not.toContain(SESSION_NO_EDGE_CACHE_MIDDLEWARE);
      expect(plain[0]?.[1]).not.toHaveProperty('priority');
    });

    it("keeps the order Traefik gives the app's routers, so a path behind the sign-in still gets it", async () => {
      // A path behind the Hub sign-in with a priority of its own (as Skyvern's API has) and a longer
      // rule without one. A copy that outranked either would hand its requests to the open route.
      runningContainers({
        ...publicWebLabels({ enableAuth: false }),
        ...route('wordpress-ci-marketplace-api', `${HOST_RULE} && PathPrefix(\`/api\`)`, {
          priority: '100',
          middlewares: 'ci-hub@file,ci-hub-app-starting@file',
        }),
        ...route('wordpress-ci-marketplace-files', `${HOST_RULE} && PathPrefix(\`/files\`)`),
      });
      await service.generateTraefikConfig();

      const copy = (name: string) => routers()[`wordpress-ci-marketplace-${name}${SESSION_ROUTER_SUFFIX}`];

      expect(copy('api')?.middlewares).toContain('ci-hub@file');
      expect(copy('api')?.priority).toBe(101);
      expect(copy('files')?.priority).toBe(`${HOST_RULE} && PathPrefix(\`/files\`)`.length + 1);
      expect(copy('insecure')?.priority).toBe(HOST_RULE.length + 1);
      // Each copy over its own route but under every route that ranks above that one.
      expect(copy('insecure')?.priority).toBeLessThan(`${HOST_RULE} && PathPrefix(\`/files\`)`.length);
      expect(copy('files')?.priority).toBeLessThan(100);
    });

    it("ranks a copy over both of its route's ranks when the label sets a priority lower than the rule length", async () => {
      // The Docker router ranks by the label, its copy in apps.yml by the length of its rule.
      runningContainers({ ...publicWebLabels({ enableAuth: false }), 'traefik.http.routers.wordpress-ci-marketplace-insecure.priority': '5' });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`]?.priority).toBe(HOST_RULE.length + 1);
    });

    it('reads a priority label under any spelling, as Traefik does', async () => {
      runningContainers({ ...publicWebLabels({ enableAuth: false }), 'traefik.http.routers.wordpress-ci-marketplace-insecure.Priority': '500' });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`]?.priority).toBe(501);
    });

    it('gives a copy to a router whose entry points label is spelled in capitals', async () => {
      // Traefik serves it on the web entry point all the same. Without a copy it could tie with the
      // copy of a route it outranks by one.
      const rule = `${HOST_RULE} && PathPrefix(\`/caps\`)`;
      runningContainers({
        ...publicWebLabels({ enableAuth: false }),
        'traefik.http.routers.wordpress-ci-marketplace-caps.rule': rule,
        'traefik.http.routers.wordpress-ci-marketplace-caps.entryPoints': 'web',
        'traefik.http.routers.wordpress-ci-marketplace-caps.service': 'wordpress-ci-marketplace',
      });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-caps${SESSION_ROUTER_SUFFIX}`]).toMatchObject({
        rule: `(${rule}) && (${SESSION_RULE})`,
        entryPoints: ['web'],
        priority: rule.length + 1,
      });
    });

    it('ranks a copy by the length of its rule in bytes, as Traefik counts it', async () => {
      const rule = `${HOST_RULE} && PathPrefix(\`/données/été\`)`;
      runningContainers({ ...publicWebLabels({ enableAuth: false }), ...route('wordpress-ci-marketplace-files', rule) });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-files${SESSION_ROUTER_SUFFIX}`]?.priority).toBe(Buffer.byteLength(rule, 'utf8') + 1);
    });

    it('writes a priority label too large for an integer Traefik reads as the highest one it can', async () => {
      // Traefik drops the whole file provider over one file it can't read, dynamic.yml with it.
      runningContainers({
        ...publicWebLabels({ enableAuth: false }),
        'traefik.http.routers.wordpress-ci-marketplace-insecure.priority': '99999999999999999999',
      });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`]?.priority).toBe(Number.MAX_SAFE_INTEGER);
      expect(written.get(`${DYNAMIC_DIR}/apps.yml`)).toContain(`priority: ${Number.MAX_SAFE_INTEGER}\n`);
    });

    it('copies the router apps.yml holds when two containers define it', async () => {
      // A second container of the app with a router of the same name and no Hub sign-in. apps.yml holds
      // the last container's router; a copy of the other's would skip the sign-in for any request with a cookie.
      const sidecar = {
        'com.docker.compose.project': 'wordpress_ci-marketplace',
        'ci-hub.appurn': 'wordpress:ci-marketplace',
        ...route('wordpress-ci-marketplace-insecure', HOST_RULE, { middlewares: APP_STARTING_MIDDLEWARE }),
      };
      runningContainers(sidecar, publicWebLabels());
      await service.generateTraefikConfig();

      const own = routers()['wordpress-ci-marketplace-insecure'];
      const copy = routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`];

      expect(own?.middlewares).toContain('ci-hub@file');
      expect(copy?.middlewares).toEqual([SESSION_NO_EDGE_CACHE_MIDDLEWARE, ...(own?.middlewares ?? [])]);
    });

    it('gives a route behind the Hub sign-in a copy too, with the sign-in', async () => {
      runningContainers(publicWebLabels());
      await service.generateTraefikConfig();

      const copy = routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`];

      expect(copy?.middlewares?.[0]).toBe(SESSION_NO_EDGE_CACHE_MIDDLEWARE);
      expect(copy?.middlewares).toContain('ci-hub@file');
      expect(copy?.middlewares?.indexOf('ci-hub@file')).toBeLessThan(copy?.middlewares?.indexOf(APP_STARTING_MIDDLEWARE) ?? -1);
    });

    it('never replaces an app router whose name is taken by a copy', async () => {
      runningContainers({
        ...publicWebLabels({ enableAuth: false }),
        ...route(`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`, `${HOST_RULE} && PathPrefix(\`/session\`)`),
      });
      await service.generateTraefikConfig();

      expect(routers()[`wordpress-ci-marketplace-insecure${SESSION_ROUTER_SUFFIX}`]?.rule).toBe(`${HOST_RULE} && PathPrefix(\`/session\`)`);
    });

    it('keeps no copy once Stop has taken the containers down', async () => {
      runningContainers(publicWebLabels({ enableAuth: false }));
      await service.generateTraefikConfig();

      appsInDb({ appId: 'wordpress', status: 'stopping' });
      docker.listContainers.mockResolvedValue([] as never);
      await service.generateTraefikConfig();

      expect(Object.keys(routers()).filter((name) => name.endsWith(SESSION_ROUTER_SUFFIX))).toEqual([]);
    });

    it('sends them on a port-expose route through the same kind of copy', async () => {
      await service.syncPortExposeRoutes([{ appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123 }]);

      const portRouters: Record<string, Router> = parsed('port-expose.yml').http.routers;
      const rule = 'Host(`my-service-hub1-acme.ci.lan`)';

      expect(portRouters[`my-service-_user${SESSION_ROUTER_SUFFIX}`]).toEqual({
        rule: `(${rule}) && (${SESSION_RULE})`,
        service: 'my-service-_user',
        entryPoints: ['web'],
        middlewares: [SESSION_NO_EDGE_CACHE_MIDDLEWARE, APP_STARTING_MIDDLEWARE],
        priority: rule.length + 1,
      });
      expect(portRouters['my-service-_user']?.middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
    });
  });

  it('keeps it after the Hub itself restarts, from the apps.yml it wrote', async () => {
    runningContainers(publicWebLabels({ appId: 'nextcloud', host: NEXTCLOUD_HOST }));
    await service.generateTraefikConfig();

    // A new Hub process: nothing in memory, only apps.yml on disk.
    service = newService();
    docker.listContainers.mockResolvedValue([] as never);
    appsInDb({ appId: 'nextcloud', status: 'restarting' });
    await service.generateTraefikConfig();

    expect(await fileOnlyRoutersFor(NEXTCLOUD_HOST)).toHaveLength(1);
  });
});
