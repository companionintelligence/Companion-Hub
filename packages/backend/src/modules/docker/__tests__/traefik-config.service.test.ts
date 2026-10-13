import path from 'node:path';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import YAML from 'yaml';
import { hubNetworkName } from '@/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
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
    service = new TraefikConfigService(mock<LoggerService>(), config, filesystem, docker);
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
  const CONTAINER_IP = '172.19.0.2';
  let docker: ReturnType<typeof mock<Dockerode>>;
  let service: TraefikConfigService;

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
    service = new TraefikConfigService(mock<LoggerService>(), config, filesystem, docker);
  });

  const parsed = (file: string) => YAML.parse(written.get(`${DYNAMIC_DIR}/${file}`) ?? 'null');

  /** A Public Web WordPress behind Hub sign-in, labelled the way the compose builder labels it. */
  const publicWebLabels = (chainOverride?: string): Record<string, string> => {
    const labels = withAppStartingPage({
      ...new TraefikLabelsBuilder({
        internalPort: 80,
        appId: 'wordpress',
        storeId: 'ci-marketplace',
        exposureMode: 'cloudflare',
        enableAuth: true,
        cloudflareOriginHostname: ORIGIN_HOST,
        cloudflarePublicHostname: 'wordpress-hub1-acme.ci0.pw',
      })
        .addCloudflareLabels()
        .build(),
      // WordPress's manifest adds a middleware of its own through extraLabels.
      'traefik.http.middlewares.wordpress-ci-marketplace.headers.customrequestheaders.X-Forwarded-Proto': 'https',
    });
    if (chainOverride) {
      labels['traefik.http.routers.wordpress-ci-marketplace-insecure.middlewares'] = chainOverride;
    }
    return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
  };

  const runningContainers = (labels: Record<string, string>) => {
    docker.listContainers.mockResolvedValue([{ Id: 'wordpress' }] as never);
    docker.getContainer.mockImplementation(
      () =>
        ({
          inspect: async () => ({
            Name: '/wordpress_ci-marketplace-wordpress-1',
            Config: { Labels: labels },
            NetworkSettings: { Networks: { [hubNetworkName()]: { IPAddress: CONTAINER_IP } } },
          }),
        }) as never,
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

  it("leaves a @docker middleware the app's container does not define as it is", async () => {
    // The Hub's forward auth named by the Hub container's labels: with no copy in apps.yml, the kept
    // route must lose it the way the app's own route does, never answer without it.
    runningContainers(publicWebLabels('ci-hub-edge-headers@file,ci-hub@docker,wordpress-ci-marketplace-public-host@docker,ci-hub-app-starting@file'));
    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;

    expect(routers[`wordpress-ci-marketplace-insecure${APP_DOWN_ROUTER_SUFFIX}`].middlewares).toContain('ci-hub@docker');
    expect(await fileOnlyRoutersFor(ORIGIN_HOST)).toEqual([]);
  });

  it('drops every route of an app that is no longer running, the kept one included', async () => {
    runningContainers(publicWebLabels());
    await service.generateTraefikConfig();

    // A Stop (or an uninstall) regenerates apps.yml once compose down has removed the containers.
    docker.listContainers.mockResolvedValue([] as never);
    await service.generateTraefikConfig();

    expect(written.has(`${DYNAMIC_DIR}/apps.yml`)).toBe(false);
  });
});
