import path from 'node:path';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import YAML from 'yaml';
import { hubNetworkName } from '@/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { APP_STARTING_MIDDLEWARE, TraefikLabelsBuilder, withAppStartingPage } from '../builders/traefik-labels.builder';
import { APP_DOWN_ROUTER_SUFFIX, TraefikConfigService } from '../traefik-config.service';

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
            NetworkSettings: { Networks: { [hubNetworkName()]: { IPAddress: '172.30.0.9' } } },
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
  const publicWebLabels = ({ appId = 'wordpress', host = ORIGIN_HOST, chain }: { appId?: string; host?: string; chain?: string } = {}) => {
    const labels = withAppStartingPage({
      ...new TraefikLabelsBuilder({
        internalPort: 80,
        appId,
        storeId: 'ci-marketplace',
        exposureMode: 'cloudflare',
        enableAuth: true,
        cloudflareOriginHostname: host,
        cloudflarePublicHostname: host.replace('.localhost', '.ci0.pw'),
      })
        .addCloudflareLabels()
        .build(),
      // WordPress's manifest adds a middleware of its own through extraLabels.
      [`traefik.http.middlewares.${appId}-ci-marketplace.headers.customrequestheaders.X-Forwarded-Proto`]: 'https',
      'com.docker.compose.project': `${appId}_ci-marketplace`,
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
            NetworkSettings: { Networks: { [hubNetworkName()]: { IPAddress: `172.19.0.${Number(id) + 2}` } } },
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
    };
    runningContainers(web, proxy);
    await service.generateTraefikConfig();

    const [kept] = await fileOnlyRoutersFor(ORIGIN_HOST);

    expect(kept?.middlewares).toContain('wordpress-ci-marketplace-proxy-headers');
  });

  it('drops every route of an app that is no longer running, the kept one included', async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    // A Stop (or an uninstall) regenerates apps.yml once compose down has removed the containers.
    appsInDb({ appId: 'wordpress', status: 'stopping' });
    docker.listContainers.mockResolvedValue([] as never);
    await service.generateTraefikConfig();

    expect(written.has(`${DYNAMIC_DIR}/apps.yml`)).toBe(false);
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

  it.each<AppStatus>(['running', 'starting', 'restarting', 'updating', 'resetting', 'backing_up', 'restoring'])(
    'keeps it while the app is %s',
    async (status) => {
      await rebuildWhileNextcloudIsDown({ status });

      expect(await fileOnlyRoutersFor(NEXTCLOUD_HOST)).toHaveLength(1);
    },
  );

  it.each<AppStatus>(['stopping', 'stopped', 'uninstalling', 'install_failed', 'missing'])('drops it once the app is %s', async (status) => {
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
