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
import {
  APP_STARTING_MIDDLEWARE,
  PUBLIC_PATHS_LABEL,
  PUBLIC_PATHS_ROUTER_SUFFIX,
  publicPathsLabels,
  TraefikLabelsBuilder,
  withAppStartingPage,
  withHubLoginOnEveryRouter,
} from '../builders/traefik-labels.builder';
import { APP_DOWN_ROUTER_SUFFIX, SESSION_NO_EDGE_CACHE_MIDDLEWARE, SESSION_ROUTER_SUFFIX, TraefikConfigService } from '../traefik-config.service';

const written = new Map<string, string>();
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  writeHealableTextFile: vi.fn(async (filePath: string, content: string) => {
    written.set(filePath, content);
  }),
}));

const DYNAMIC_DIR = '/data/state/traefik/dynamic';

/** A request as Traefik's router matching sees it. */
interface RouteRequest {
  host: string;
  path: string;
  headers?: Record<string, string>;
}

/**
 * Whether a router rule matches a request, for the matchers the Hub writes (`Host`, `Path`,
 * `PathPrefix`, `Header`, `HeaderRegexp`) joined by `&&`, `||`, `!` and parentheses.
 */
function ruleMatches(rule: string, request: RouteRequest): boolean {
  const tokens = rule.match(/\|\||&&|!|\(|\)|,|`[^`]*`|[A-Za-z]+/g) ?? [];
  let at = 0;
  const header = (name: string) => Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const matcher = (name: string, [first = '', second = '']: string[]): boolean => {
    switch (name) {
      case 'Host':
        return request.host.toLowerCase() === first.toLowerCase();
      case 'Path':
        return request.path === first;
      case 'PathPrefix':
        return request.path.startsWith(first);
      case 'Header':
        return header(first) === second;
      case 'HeaderRegexp': {
        const value = header(first);
        return value !== undefined && new RegExp(second).test(value);
      }
      default:
        throw new Error(`This test knows no matcher ${name}`);
    }
  };
  const factor = (): boolean => {
    const token = tokens[at++] ?? '';
    if (token === '!') return !factor();
    if (token === '(') {
      const value = or();
      at++;
      return value;
    }
    // A matcher: its name, then its arguments in backticks between parentheses.
    at++;
    const args: string[] = [];
    while (at < tokens.length && tokens[at] !== ')') {
      const arg = tokens[at++] ?? '';
      if (arg !== ',') args.push(arg.slice(1, -1));
    }
    at++;
    return matcher(token, args);
  };
  const and = (): boolean => {
    let value = factor();
    while (tokens[at] === '&&') {
      at++;
      value = factor() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[at] === '||') {
      at++;
      value = and() || value;
    }
    return value;
  };
  return or();
}

/**
 * The routers a container's labels give the Docker provider that rank otherwise than their copy in
 * apps.yml, under `<name>@docker`: those with a priority. Without one a Docker router ranks by the
 * length of its rule like its copy and the two are the same route.
 */
function dockerRoutersWithPriority(
  labels: Record<string, string>,
): Record<string, { rule: string; service: string; entryPoints: string[]; priority: number; middlewares: string[] }> {
  const options = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(labels)) {
    const [, router, option] = /^traefik\.http\.routers\.([^.]+)\.([^.]+)$/.exec(key) ?? [];
    if (router && option) options.set(router, { ...options.get(router), [option.toLowerCase()]: value });
  }
  return Object.fromEntries(
    [...options]
      .filter(([, router]) => Number(router.priority) > 0 && router.rule)
      .map(([name, router]) => [
        `${name}@docker`,
        {
          rule: router.rule ?? '',
          service: router.service ?? '',
          entryPoints: (router.entrypoints ?? '').split(','),
          priority: Number(router.priority),
          middlewares: (router.middlewares ?? '').split(',').filter(Boolean),
        },
      ]),
  );
}

/**
 * The router Traefik sends a request on the `web` entry point to: of those whose rule matches, the
 * one with the highest priority, or else the longest rule in bytes. A tie at the top fails the test:
 * Traefik's pick between the two is not defined.
 */
function routerFor(routers: Record<string, { rule: string; entryPoints: string[]; priority?: number }>, request: RouteRequest): string | undefined {
  const ranked = Object.entries(routers)
    .filter(([, router]) => router.entryPoints.includes('web') && ruleMatches(router.rule, request))
    .map(([name, router]) => ({ name, rank: router.priority ?? Buffer.byteLength(router.rule, 'utf8') }))
    .sort((a, b) => b.rank - a.rank);
  const [first, second] = ranked;
  if (first && second && first.rank === second.rank) {
    throw new Error(`${first.name} ties with ${second.name} at ${first.rank}`);
  }
  return first?.name;
}

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

  // The login first, as on every app route: port-expose routes once had none, Public web included.
  it('ends every port-expose route with it, after the Hub login unless that was switched off', async () => {
    await service.syncPortExposeRoutes([
      { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123, requireLogin: true },
      { appUrn: 'other:_user' as AppUrn, traefikHost: 'other-hub1-acme.ci.lan', upstreamPort: 9000, requireLogin: false },
    ]);

    const { routers } = parsed('port-expose.yml').http;
    expect(routers['my-service-_user'].middlewares).toEqual(['ci-hub@file', APP_STARTING_MIDDLEWARE]);
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

    it('reads a router spelled two ways as the one router Traefik makes of it', async () => {
      // Traefik merges the two spellings, sign-in included. Read as two routers, the copy of the half
      // with the rule had no sign-in and outranked the Docker router for every request with a cookie.
      const rule = `${HOST_RULE} && PathPrefix(\`/admin\`)`;
      runningContainers({
        ...publicWebLabels({ enableAuth: false }),
        'traefik.http.routers.wordpress-ci-marketplace-admin.middlewares': 'ci-hub@file,ci-hub-app-starting@file',
        ...route('wordpress-ci-marketplace-ADMIN', rule),
      });
      await service.generateTraefikConfig();

      const names = Object.keys(routers()).filter((name) => name.toLowerCase().startsWith('wordpress-ci-marketplace-admin'));
      expect(names).toEqual([
        'wordpress-ci-marketplace-admin',
        `wordpress-ci-marketplace-admin${SESSION_ROUTER_SUFFIX}`,
        `wordpress-ci-marketplace-admin${APP_DOWN_ROUTER_SUFFIX}`,
      ]);
      const copy = routers()[`wordpress-ci-marketplace-admin${SESSION_ROUTER_SUFFIX}`];
      expect(copy?.rule).toBe(`(${rule}) && (${SESSION_RULE})`);
      // Then the middlewares the container defines, which every router of it gets.
      expect(copy?.middlewares?.slice(0, 3)).toEqual([SESSION_NO_EDGE_CACHE_MIDDLEWARE, 'ci-hub@file', 'ci-hub-app-starting@file']);
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
      await service.syncPortExposeRoutes([
        { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123, requireLogin: false },
      ]);

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

    it('keeps the Hub login on the copy of a port-expose route that has it', async () => {
      await service.syncPortExposeRoutes([
        { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123, requireLogin: true },
      ]);

      const portRouters: Record<string, Router> = parsed('port-expose.yml').http.routers;
      const request = { host: 'my-service-hub1-acme.ci.lan', path: '/', headers: { Cookie: 'sid=1' } };

      expect(routerFor(portRouters, request)).toBe(`my-service-_user${SESSION_ROUTER_SUFFIX}`);
      expect(portRouters[`my-service-_user${SESSION_ROUTER_SUFFIX}`]?.middlewares).toEqual([
        SESSION_NO_EDGE_CACHE_MIDDLEWARE,
        'ci-hub@file',
        APP_STARTING_MIDDLEWARE,
      ]);
      expect(routerFor(portRouters, { ...request, headers: {} })).toBe('my-service-_user');
    });

    /*
     * Every route shape the Hub writes for one app, with the Hub login on: its own routers, the twins
     * of the paths the operator exempted from the login and routes the listing declares on its other
     * services. A copy or twin that outranked the wrong router would let a request with any cookie skip
     * the login, keep the login on an exempt path or send a path to a service the listing doesn't.
     */
    describe('on every route of an app with the Hub login', () => {
      const SERVICE = 'wordpress-ci-marketplace';
      const API_RULE = `${HOST_RULE} && PathPrefix(\`/api\`)`;
      const ADMIN_RULE = `${HOST_RULE} && PathPrefix(\`/api/admin\`)`;
      const FILES_RULE = `${HOST_RULE} && PathPrefix(\`/files\`)`;
      const MEDIA_RULE = `${HOST_RULE} && PathPrefix(\`/media\`)`;
      const PATHS_RULE = ['/hook', '/api', '/media'].map((path) => `Path(\`${path}\`) || PathPrefix(\`${path}/\`)`).join(' || ');
      const project = { 'com.docker.compose.project': 'wordpress_ci-marketplace', 'ci-hub.appurn': 'wordpress:ci-marketplace' };
      const strings = (labels: Record<string, string | boolean>) =>
        Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
      /** The app's main container and the container of the listing's other services, labelled the way the compose builder labels them. */
      const appContainers = ({ requireLogin = true }: { requireLogin?: boolean } = {}) => {
        const hub = new TraefikLabelsBuilder({
          internalPort: 80,
          appId: 'wordpress',
          storeId: 'ci-marketplace',
          exposureMode: 'cloudflare',
          enableAuth: requireLogin,
          cloudflareOriginHostname: ORIGIN_HOST,
          cloudflarePublicHostname: ORIGIN_HOST.replace('.localhost', '.ci0.pw'),
        })
          .addCloudflareLabels()
          .build();
        const paths = publicPathsLabels({ enableAuth: requireLogin, publicPaths: ['/hook', '/api', '/media'] });
        const main = withAppStartingPage(withHubLoginOnEveryRouter(hub, hub, { requireLogin, publicWeb: true }));
        // Routes of the listing's to services of its own. A twin of the main router ranked by its rule
        // (164 bytes) outranked `/api` at 100 and `/media` without a priority. `/api/admin` at 500
        // outranked that twin.
        const listing = withAppStartingPage(
          withHubLoginOnEveryRouter(
            {
              ...route('wordpress-ci-marketplace-api', API_RULE, { priority: '100', service: `${SERVICE}-api` }),
              ...route('wordpress-ci-marketplace-admin', ADMIN_RULE, { priority: '500', service: `${SERVICE}-admin` }),
              ...route('wordpress-ci-marketplace-files', FILES_RULE, { service: `${SERVICE}-files` }),
              ...route('wordpress-ci-marketplace-media', MEDIA_RULE, { service: `${SERVICE}-media` }),
            },
            {},
            { requireLogin, publicWeb: true },
          ),
        );
        return [
          { ...strings(main), ...paths, ...project },
          { ...strings(listing), ...paths, ...project },
        ];
      };
      const COOKIE = { Cookie: 'token=app-session' };
      const allRouters = (containers: Array<Record<string, string>>) => ({
        ...routers(),
        ...Object.assign({}, ...containers.map(dockerRoutersWithPriority)),
      });

      it.each([
        ['/', COOKIE, 'insecure-session', true, SERVICE],
        ['/', {}, 'insecure', true, SERVICE],
        ['/notes/hook', COOKIE, 'insecure-session', true, SERVICE],
        ['/hookx', COOKIE, 'insecure-session', true, SERVICE],
        ['/hook', COOKIE, 'insecure-public-paths-session', false, SERVICE],
        ['/hook/42', { Authorization: 'Bearer app-token' }, 'insecure-public-paths-session', false, SERVICE],
        ['/hook/42', {}, 'insecure-public-paths', false, SERVICE],
        // The listing's `/api` route sends its exempt paths to its own service, with a cookie and without.
        ['/api', {}, 'api-public-paths', false, `${SERVICE}-api`],
        ['/api/v1/runs', COOKIE, 'api-public-paths-session', false, `${SERVICE}-api`],
        ['/api/v1/runs', {}, 'api-public-paths', false, `${SERVICE}-api`],
        // Its route, not exempt: `/api` is, `/apix` is not.
        ['/apix', COOKIE, 'api-session', true, `${SERVICE}-api`],
        ['/apix', {}, 'api@docker', true, `${SERVICE}-api`],
        // A route under an exempt path that outranks the twin of the main router.
        ['/api/admin/users', COOKIE, 'admin-public-paths-session', false, `${SERVICE}-admin`],
        ['/api/admin/users', {}, 'admin-public-paths', false, `${SERVICE}-admin`],
        // Routes without a priority: one behind the login, one exempt.
        ['/files/a.pdf', COOKIE, 'files-session', true, `${SERVICE}-files`],
        ['/files/a.pdf', {}, 'files', true, `${SERVICE}-files`],
        ['/media/a.mp4', COOKIE, 'media-public-paths-session', false, `${SERVICE}-media`],
        ['/media/a.mp4', {}, 'media-public-paths', false, `${SERVICE}-media`],
        ['/sw.js', { ...COOKIE, 'Service-Worker': 'script' }, 'sw-reset-insecure-session', true, SERVICE],
      ] as const)('sends %s with %j to its %s router, the Hub login %s, served by %s', async (path, headers, router, login, target) => {
        const containers = appContainers();
        runningContainers(...containers);
        await service.generateTraefikConfig();

        const all = allRouters(containers);
        const name = routerFor(all, { host: ORIGIN_HOST, path, headers });
        const chain = all[name ?? '']?.middlewares ?? [];

        expect(name).toBe(`wordpress-ci-marketplace-${router}`);
        expect(all[name ?? '']?.service).toBe(target);
        expect(chain.includes('ci-hub@file')).toBe(login);
        // The copy sends the chain of the router it copies, after the header for Cloudflare.
        if (name?.endsWith(SESSION_ROUTER_SUFFIX)) {
          expect(chain).toEqual([SESSION_NO_EDGE_CACHE_MIDDLEWARE, ...(routers()[name.slice(0, -SESSION_ROUTER_SUFFIX.length)]?.middlewares ?? [])]);
        } else {
          expect(chain).not.toContain(SESSION_NO_EDGE_CACHE_MIDDLEWARE);
        }
      });

      it('ranks each twin one above both ranks of its router and its copy one above the twin', async () => {
        const containers = appContainers();
        runningContainers(...containers);
        await service.generateTraefikConfig();

        const docker = Object.assign({}, ...containers.map(dockerRoutersWithPriority));
        const twins = Object.keys(routers()).filter((name) => name.endsWith(PUBLIC_PATHS_ROUTER_SUFFIX));

        // Every router with the login but the service-worker reset, which the login decides.
        expect(twins.sort()).toEqual(['admin', 'api', 'files', 'insecure', 'media'].map((name) => `${SERVICE}-${name}${PUBLIC_PATHS_ROUTER_SUFFIX}`));
        for (const twin of twins) {
          const name = twin.slice(0, -PUBLIC_PATHS_ROUTER_SUFFIX.length);
          const router = routers()[name];
          const rank = Math.max(Buffer.byteLength(router?.rule ?? '', 'utf8'), docker[`${name}@docker`]?.priority ?? 0);

          expect(routers()[twin]).toEqual({
            rule: `(${router?.rule}) && (${PATHS_RULE})`,
            service: router?.service,
            entryPoints: ['web'],
            middlewares: router?.middlewares?.filter((middleware) => middleware !== 'ci-hub@file'),
            priority: rank + 1,
          });
          expect(routers()[`${twin}${SESSION_ROUTER_SUFFIX}`]?.priority).toBe(rank + 2);
        }
      });

      it('keeps the order of the twins while the app is down', async () => {
        const containers = appContainers();
        runningContainers(...containers);
        await service.generateTraefikConfig();

        const down = Object.fromEntries(Object.entries(routers()).filter(([name]) => name.endsWith(APP_DOWN_ROUTER_SUFFIX)));
        const request = (path: string) => routerFor(down, { host: ORIGIN_HOST, path });

        expect(request('/api/v1/runs')).toBe(`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}${APP_DOWN_ROUTER_SUFFIX}`);
        expect(down[request('/api/v1/runs') ?? '']?.middlewares).not.toContain('ci-hub@file');
        expect(request('/apix')).toBe(`${SERVICE}-api${APP_DOWN_ROUTER_SUFFIX}`);
        expect(request('/hook')).toBe(`${SERVICE}-insecure${PUBLIC_PATHS_ROUTER_SUFFIX}${APP_DOWN_ROUTER_SUFFIX}`);
      });

      it('keeps the exempt paths of the listing routes while the main container is down', async () => {
        const [, listing] = appContainers();
        runningContainers(listing ?? {});
        await service.generateTraefikConfig();

        expect(routerFor(routers(), { host: ORIGIN_HOST, path: '/api/v1/runs' })).toBe(`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}`);
      });

      it('reads only the paths the form takes from the label: `/` alone would open the whole app', async () => {
        const [main, listing] = appContainers();
        runningContainers({ ...main, [PUBLIC_PATHS_LABEL]: '/,/hook,/a b' }, { ...listing, [PUBLIC_PATHS_LABEL]: '/,/hook,/a b' });
        await service.generateTraefikConfig();

        expect(routers()[`${SERVICE}-insecure${PUBLIC_PATHS_ROUTER_SUFFIX}`]?.rule).toBe(
          `(${HOST_RULE}) && (Path(\`/hook\`) || PathPrefix(\`/hook/\`))`,
        );
        expect(routerFor(routers(), { host: ORIGIN_HOST, path: '/' })).toBe(`${SERVICE}-insecure`);
      });

      it('keeps only the paths every labelled container names, whichever Docker lists first', async () => {
        const [main, listing] = appContainers();
        const containers = [
          { ...main, [PUBLIC_PATHS_LABEL]: '/hook,/api' },
          { ...listing, [PUBLIC_PATHS_LABEL]: '/hook' },
        ];
        for (const listed of [containers, [...containers].reverse()]) {
          runningContainers(...listed);
          await service.generateTraefikConfig();

          expect(routers()[`${SERVICE}-insecure${PUBLIC_PATHS_ROUTER_SUFFIX}`]?.rule).toBe(
            `(${HOST_RULE}) && (Path(\`/hook\`) || PathPrefix(\`/hook/\`))`,
          );
          expect(routerFor(allRouters(listed), { host: ORIGIN_HOST, path: '/api/v1/runs' })).toBe(`${SERVICE}-api@docker`);
        }
      });

      it('gives no twin while a container of the app has no paths: the operator may have just removed them all', async () => {
        const [main, listing] = appContainers();
        const { [PUBLIC_PATHS_LABEL]: _removed, ...recreated } = listing ?? {};
        for (const listed of [
          [main ?? {}, recreated],
          [recreated, main ?? {}],
        ]) {
          runningContainers(...listed);
          await service.generateTraefikConfig();

          expect(Object.keys(routers()).filter((name) => name.includes(PUBLIC_PATHS_ROUTER_SUFFIX))).toEqual([]);
          expect(routerFor(allRouters(listed), { host: ORIGIN_HOST, path: '/hook/42' })).toBe(`${SERVICE}-insecure`);
        }
      });

      it('never replaces an app router whose name is taken by a twin', async () => {
        const [main, listing] = appContainers();
        runningContainers(main ?? {}, {
          ...listing,
          ...route(`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}`, `${HOST_RULE} && PathPrefix(\`/own\`)`, { middlewares: 'ci-hub@file' }),
        });
        await service.generateTraefikConfig();

        expect(routers()[`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}`]?.rule).toBe(`${HOST_RULE} && PathPrefix(\`/own\`)`);
      });

      it('puts no Hub login on any copy of an app whose operator switched it off and gives it no twin', async () => {
        const [main, listing] = appContainers({ requireLogin: false });
        // Even with the paths on the containers: no router has a login to skip.
        runningContainers({ ...main, [PUBLIC_PATHS_LABEL]: '/hook' }, { ...listing, [PUBLIC_PATHS_LABEL]: '/hook' });
        await service.generateTraefikConfig();

        const copies = Object.entries(routers()).filter(([name]) => name.endsWith(SESSION_ROUTER_SUFFIX));

        expect(copies.map(([name]) => name).sort()).toEqual(
          ['admin', 'api', 'files', 'insecure', 'media'].map((name) => `${SERVICE}-${name}${SESSION_ROUTER_SUFFIX}`),
        );
        expect(copies.flatMap(([, copy]) => copy.middlewares ?? [])).not.toContain('ci-hub@file');
        expect(Object.keys(routers()).filter((name) => name.includes(PUBLIC_PATHS_ROUTER_SUFFIX))).toEqual([]);
        expect(routerFor(routers(), { host: ORIGIN_HOST, path: '/hook', headers: COOKIE })).toBe(`${SERVICE}-insecure${SESSION_ROUTER_SUFFIX}`);
      });

      it('keeps the Hub login on the copy of the Private VPN router and gives its exempt paths to the listing route', async () => {
        const host = 'wordpress.ci-marketplace';
        const hub = new TraefikLabelsBuilder({
          internalPort: 80,
          appId: 'wordpress',
          storeId: 'ci-marketplace',
          exposureMode: 'tailscale',
          enableAuth: true,
        })
          .addTailscaleLabels()
          .build();
        const paths = publicPathsLabels({ enableAuth: true, publicPaths: ['/hook', '/api'] });
        const listing = withAppStartingPage(
          withHubLoginOnEveryRouter(
            route(`${SERVICE}-api`, `Host(\`${host}\`) && PathPrefix(\`/api\`)`, { priority: '100', service: `${SERVICE}-api` }),
            {},
            { requireLogin: true, publicWeb: false },
          ),
        );
        const containers = [
          { ...strings(withAppStartingPage(hub)), ...paths, ...project },
          { ...strings(listing), ...paths, ...project },
        ];
        runningContainers(...containers);
        await service.generateTraefikConfig();

        const all = allRouters(containers);
        const request = { host, path: '/', headers: COOKIE };
        const copy = routerFor(all, request);

        expect(copy).toBe(`${SERVICE}-tailscale${SESSION_ROUTER_SUFFIX}`);
        expect(routers()[copy ?? '']?.middlewares).toEqual([SESSION_NO_EDGE_CACHE_MIDDLEWARE, 'ci-hub@file', APP_STARTING_MIDDLEWARE]);
        expect(routerFor(all, { ...request, path: '/hook' })).toBe(`${SERVICE}-tailscale${PUBLIC_PATHS_ROUTER_SUFFIX}${SESSION_ROUTER_SUFFIX}`);
        expect(routerFor(all, { host, path: '/api/v1/runs' })).toBe(`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}`);
        expect(all[`${SERVICE}-api${PUBLIC_PATHS_ROUTER_SUFFIX}`]?.middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
        expect(routerFor(all, { host, path: '/apix' })).toBe(`${SERVICE}-api@docker`);
      });

      it("gives a port-expose route no twin: an app's exempt paths stay on that app's hosts", async () => {
        runningContainers(...appContainers());
        await service.generateTraefikConfig();
        await service.syncPortExposeRoutes([
          { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123, requireLogin: true },
        ]);

        const all = { ...routers(), ...parsed('port-expose.yml').http.routers };

        expect(Object.keys(parsed('port-expose.yml').http.routers)).toEqual(['my-service-_user', `my-service-_user${SESSION_ROUTER_SUFFIX}`]);
        expect(routerFor(all, { host: 'my-service-hub1-acme.ci.lan', path: '/hook' })).toBe('my-service-_user');
      });
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
