import { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { LEGACY_NETWORK_NAME, hubContainerName, hubNetworkName, isHubApplianceContainerName } from '@/common/constants';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { writeHealableTextFile } from '@/common/helpers/bind-mount-helpers';
import { storedExposureForm } from '@ci-hub/common/types';
import { Injectable, Inject } from '@nestjs/common';
import Dockerode from 'dockerode';
import * as yaml from 'yaml';
import { ADDRESS_KEPT_STATUSES } from '../apps/app-starting-page';
import { AppsRepository } from '../apps/apps.repository';
import { APP_STARTING_MIDDLEWARE } from './builders/traefik-labels.builder';
import { DOCKERODE } from './constants';

export interface PortExposeRoute {
  appUrn: string;
  traefikHost: string;
  upstreamPort: number;
}

interface TraefikRouter {
  rule: string;
  service: string;
  entryPoints: string[];
  middlewares?: string[];
  tls?: boolean;
  priority?: number;
}

interface TraefikService {
  loadBalancer: {
    servers: Array<{ url: string }>;
    serversTransport?: string;
  };
}

interface TraefikConfig {
  http: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
    middlewares?: Record<string, Record<string, unknown>>;
    serversTransports?: Record<string, { insecureSkipVerify: boolean }>;
  };
}

/**
 * Set a value on a deeply nested object using a path of keys.
 * E.g. setNestedValue(obj, ['headers', 'customrequestheaders', 'X-Forwarded-Proto'], 'https')
 * produces { headers: { customrequestheaders: { 'X-Forwarded-Proto': 'https' } } }
 */
function setNestedValue(obj: Record<string, unknown>, path: string[], value: string) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!key) return;
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey) {
    current[lastKey] = value;
  }
}

/** Suffix of the router {@link appDownRouter} adds next to each app router in apps.yml. */
export const APP_DOWN_ROUTER_SUFFIX = '-down';

/**
 * The services those routers send to, one per app, all on Traefik's own loopback, where nothing
 * listens. Every request fails at once with a 502, which `ci-hub-app-starting` turns into the Hub's
 * page. Never the app's old address: Docker gives a freed address to the next container that joins
 * the network. The rest of the name is the app's compose project, which is how a later rebuild
 * tells whose a down router is once the app's containers are gone.
 */
const APP_DOWN_SERVICE_PREFIX = 'ci-hub-app-down-';
const APP_DOWN_SERVICE_URL = 'http://127.0.0.1:9';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/**
 * While its containers are gone, an app keeps its down routers in these states: running, coming
 * back by itself (the page says starting) or stopped (the page says so and points at Start). Uninstall
 * marks the app `uninstalling` before it takes it down, so a removed app keeps none. The Cloudflare
 * sync keeps a Public Web app's DNS record in the same states; see `ADDRESS_KEPT_STATUSES`.
 */
const APP_DOWN_KEPT_STATUSES: ReadonlySet<AppStatus> = ADDRESS_KEPT_STATUSES;

/**
 * A copy of an app router that still answers while the app's containers are gone (CI-Hub#1944).
 *
 * A restart runs `compose down` before `compose up`. Traefik drops the app's Docker routers with
 * the containers, and drops their copies in apps.yml too, because a copy names the app's
 * public-host middleware the way its labels do (`<app>-public-host@docker`). With no router left,
 * visitors got Traefik's `404 page not found` instead of "<app> is starting…". The same happens while
 * a container with a health check starts: Traefik's Docker provider skips it until it is healthy.
 *
 * Same rule, entry points and middleware chain as the app's router, so forward auth still answers
 * first and a visitor who is not signed in gets the login. The middlewares the app's containers
 * define are named by their copies in this file instead of `@docker`. Its `priority` is low enough
 * that it only answers once the app's own routers are gone; see {@link TraefikConfigService.generateTraefikConfig}.
 */
function appDownRouter(router: TraefikRouter, appMiddlewares: ReadonlySet<string>, service: string, priority: number): TraefikRouter {
  const chain = (router.middlewares ?? []).map((name) => {
    const trimmed = name.trim();
    const base = trimmed.endsWith('@docker') ? trimmed.slice(0, -'@docker'.length) : null;
    return base !== null && appMiddlewares.has(base) ? base : trimmed;
  });
  const middlewares = [...new Set(chain)];
  if (!middlewares.includes(APP_STARTING_MIDDLEWARE)) {
    middlewares.push(APP_STARTING_MIDDLEWARE);
  }
  // A copy of the entry points, or the YAML writer prints an alias to the app router's list. `tls` is
  // kept so the copy matches the same requests as the router: without it, a TLS-only router's copy
  // would answer plain HTTP on that host while the app is up.
  return {
    rule: router.rule,
    service,
    entryPoints: [...router.entryPoints],
    middlewares,
    ...(router.tls !== undefined && { tls: router.tls }),
    priority,
  };
}

/** A down router as an earlier rebuild wrote it to apps.yml. */
function isAppDownRouter(value: unknown): value is TraefikRouter {
  const router = value as Partial<TraefikRouter> | null;
  return (
    typeof router?.rule === 'string' &&
    typeof router.service === 'string' &&
    router.service.startsWith(APP_DOWN_SERVICE_PREFIX) &&
    Array.isArray(router.entryPoints) &&
    (router.middlewares === undefined || (Array.isArray(router.middlewares) && router.middlewares.every((name) => typeof name === 'string')))
  );
}

/** The app's compose project, the name DockerReadFacade.getComposeProjectName gives it. */
function composeProjectOf(app: { appName: string; appStoreSlug: string }): string {
  return createAppUrn(app.appName, app.appStoreSlug).replace(':', '_');
}

/** Whether the app goes out through Traefik at all: on Public Web or the Private VPN, by its stored form. */
function isExposedThroughTraefik(app: Parameters<typeof storedExposureForm>[0]): boolean {
  const { exposureMode, exposedLocal } = storedExposureForm(app);
  return (exposureMode || (exposedLocal ? 'cloudflare' : 'local')) !== 'local';
}

@Injectable()
export class TraefikConfigService {
  private readonly mainNetworkName: string;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly appsRepository: AppsRepository,
  ) {
    this.mainNetworkName = hubNetworkName();
  }

  /**
   * Write Traefik routes for port-expose workloads (host port proxies).
   */
  public async syncPortExposeRoutes(routes: PortExposeRoute[]): Promise<void> {
    try {
      const { directories } = this.config.getConfig();
      const configPath = `${directories.dataDir}/state/traefik/dynamic/port-expose.yml`;

      if (routes.length === 0) {
        if (await this.filesystem.pathExists(configPath)) {
          await this.filesystem.removeFile(configPath);
          this.logger.info('Removed empty port-expose Traefik config');
        }
        return;
      }

      const config: TraefikConfig = {
        http: {
          routers: {},
          services: {},
        },
      };

      for (const route of routes) {
        const routerId = route.appUrn.replace(':', '-');
        config.http.routers[routerId] = {
          rule: `Host(\`${route.traefikHost}\`)`,
          service: routerId,
          entryPoints: ['web'],
          // An app route like any other: when the person's own service behind the port is down,
          // Traefik answered the same bare 502 (CI-Hub#1764).
          middlewares: [APP_STARTING_MIDDLEWARE],
        };
        config.http.services[routerId] = {
          loadBalancer: {
            servers: [{ url: `http://host.docker.internal:${route.upstreamPort}` }],
          },
        };
      }

      const yamlContent = yaml.stringify(config, { indent: 2 });
      await writeHealableTextFile(configPath, yamlContent.endsWith('\n') ? yamlContent : `${yamlContent}\n`, 0o644);
      this.logger.info(`Wrote ${routes.length} port-expose Traefik route(s) to ${configPath}`);
    } catch (error) {
      this.logger.error('Failed to sync port-expose Traefik routes:', error);
      throw error;
    }
  }

  /**
   * Generate Traefik file-based configuration from running Docker containers
   * // TODO(#244): revisit on next Traefik upgrade
   * This is a workaround for Traefik Docker provider API version incompatibility
   */
  public async generateTraefikConfig(): Promise<void> {
    try {
      this.logger.debug('Generating Traefik file-based configuration from Docker containers...');

      const { directories } = this.config.getConfig();
      const configPath = `${directories.dataDir}/state/traefik/dynamic/apps.yml`;

      // Check if there's an existing invalid config file and remove it first
      // This prevents Traefik from trying to parse invalid YAML
      // A valid one is kept for the down routers of apps whose containers are gone right now.
      let previous: unknown = null;
      if (await this.filesystem.pathExists(configPath)) {
        try {
          const existingContent = await this.filesystem.readTextFile(configPath);
          if (existingContent) {
            // Try to parse it to see if it's valid
            try {
              previous = yaml.parse(existingContent);
            } catch {
              // Invalid YAML - delete it
              this.logger.debug(`Removing invalid Traefik config file at ${configPath}`);
              await this.filesystem.removeFile(configPath);
            }
          }
        } catch {
          // If we can't read it, try to remove it anyway
          await this.filesystem.removeFile(configPath);
        }
      }

      const containers = await this.docker.listContainers({
        filters: {
          label: ['traefik.enable=true'],
        },
      });

      const config: TraefikConfig = {
        http: {
          routers: {},
          services: {},
        },
      };
      /**
       * By compose project, every app with a container below: its routers on the web entry point, each
       * with the priority Traefik gives it, and the middlewares any of its containers define.
       */
      const apps = new Map<string, { routers: Array<{ name: string; router: TraefikRouter; priority: number }>; middlewares: Set<string> }>();

      // Process each container
      for (const containerInfo of containers) {
        const container = this.docker.getContainer(containerInfo.Id);
        const inspect = await container.inspect();

        // Skip the Hub appliance and traefik containers (they're handled separately)
        const containerName = inspect.Name.replace(/^\//, '');
        if (isHubApplianceContainerName(containerName) || containerName.includes('traefik')) {
          continue;
        }

        // Get container IP from the main network
        const networks = inspect.NetworkSettings?.Networks;
        const networkSettings = networks?.[this.mainNetworkName] ?? networks?.[LEGACY_NETWORK_NAME];
        if (!networkSettings?.IPAddress) {
          this.logger.debug(`Skipping container ${inspect.Name}: not on a Hub network or IP not assigned yet`);
          continue;
        }

        const containerIP = networkSettings.IPAddress;
        const labels = inspect.Config?.Labels || {};
        const project = labels[COMPOSE_PROJECT_LABEL];
        let app = project ? apps.get(project) : undefined;
        if (project && !app) {
          app = { routers: [], middlewares: new Set() };
          apps.set(project, app);
        }

        // Extract Traefik routing information from labels
        const routers: Record<string, TraefikRouter> = {};
        const services: Record<string, TraefikService> = {};
        const middlewares: Record<string, Record<string, unknown>> = {};
        const serviceSchemes: Record<string, string> = {};
        // Only to rank the down routers: the copies keep Traefik's default, as they always have.
        const routerPriorities: Record<string, number> = {};

        // Find all router labels
        for (const [key, value] of Object.entries(labels)) {
          if (key.startsWith('traefik.http.routers.')) {
            const routerName = key.replace('traefik.http.routers.', '').split('.')[0];
            const property = key.split('.').pop();

            if (!routerName) continue;

            if (!routers[routerName]) {
              routers[routerName] = {
                rule: '',
                service: '',
                entryPoints: [],
              };
            }

            // Ensure property exists
            if (!property) continue;

            switch (property) {
              case 'rule':
                routers[routerName].rule = String(value);
                break;
              case 'entrypoints':
                routers[routerName].entryPoints = String(value).split(',');
                break;
              case 'service':
                routers[routerName].service = String(value);
                break;
              case 'middlewares':
                routers[routerName].middlewares = String(value).split(',');
                break;
              case 'tls':
                routers[routerName].tls = String(value) === 'true';
                break;
              case 'priority':
                routerPriorities[routerName] = Number.parseInt(String(value), 10);
                break;
            }
          }

          // Find service port from labels
          if (key.startsWith('traefik.http.services.') && key.endsWith('.loadbalancer.server.port')) {
            const serviceName = key.replace('traefik.http.services.', '').replace('.loadbalancer.server.port', '');
            const port = Number.parseInt(String(value), 10);

            if (!Number.isNaN(port)) {
              services[serviceName] = {
                loadBalancer: {
                  servers: [{ url: `http://${containerIP}:${port}` }],
                },
              };
            }
          }

          // Capture per-service backend scheme (e.g. https for KasmVNC containers)
          if (key.startsWith('traefik.http.services.') && key.endsWith('.loadbalancer.server.scheme')) {
            const serviceName = key.replace('traefik.http.services.', '').replace('.loadbalancer.server.scheme', '');
            serviceSchemes[serviceName] = String(value);
          }

          // Parse middleware definitions
          // Label format: traefik.http.middlewares.<name>.<type>.<property>[.<sub>...]
          if (key.startsWith('traefik.http.middlewares.')) {
            const parts = key.replace('traefik.http.middlewares.', '').split('.');
            const middlewareName = parts[0];
            const nestedPath = parts.slice(1);

            if (!middlewareName || nestedPath.length === 0) continue;

            if (!middlewares[middlewareName]) {
              middlewares[middlewareName] = {};
            }

            setNestedValue(middlewares[middlewareName], nestedPath, String(value));
          }
        }

        // Apply scheme overrides: rewrite service URLs and add insecureSkipVerify transport for HTTPS backends
        for (const [serviceName, scheme] of Object.entries(serviceSchemes)) {
          if (scheme === 'https' && services[serviceName]) {
            const existing = services[serviceName].loadBalancer.servers[0]?.url;
            if (existing) {
              services[serviceName].loadBalancer.servers[0] = { url: existing.replace(/^http:\/\//, 'https://') };
            }
            services[serviceName].loadBalancer.serversTransport = 'insecureTransport';
            if (!config.http.serversTransports) {
              config.http.serversTransports = {};
            }
            config.http.serversTransports.insecureTransport = { insecureSkipVerify: true };
          }
        }

        // Only add routers that have valid rules and services
        const middlewareNames = Object.keys(middlewares);
        for (const name of middlewareNames) {
          app?.middlewares.add(name);
        }
        for (const [routerName, router] of Object.entries(routers)) {
          if (router.rule && router.service && router.entryPoints.length > 0) {
            // Auto-attach middleware definitions from this container to its routers
            // so app authors only need to define the middleware via extraLabels
            // without knowing the dynamically generated router name
            if (middlewareNames.length > 0) {
              const existing = router.middlewares ?? [];
              const merged = [...new Set([...existing, ...middlewareNames])];
              router.middlewares = merged;
            }

            // Only add insecure routers (web entrypoint) for file provider
            // Secure routers (websecure) require TLS which file provider handles differently
            // Note: Traefik's file provider automatically adds @file suffix, so we don't add it here
            if (router.entryPoints.includes('web')) {
              config.http.routers[routerName] = router;
              // Traefik's own ranking: the priority the labels set, or else the length of the rule.
              const explicitPriority = routerPriorities[routerName];
              const priority = explicitPriority !== undefined && explicitPriority > 0 ? explicitPriority : router.rule.length;
              app?.routers.push({ name: routerName, router, priority });
            }
          }
        }

        // Add services
        Object.assign(config.http.services, services);

        // Add middlewares
        if (Object.keys(middlewares).length > 0) {
          if (!config.http.middlewares) {
            config.http.middlewares = {};
          }
          Object.assign(config.http.middlewares, middlewares);
        }
      }

      const appsWithDownRouters = new Set<string>();
      for (const [project, app] of apps) {
        // Numbered from 1 in the order Traefik ranks the app's own routers, so a request that two of
        // them match gets the same one's chain while the app is down as while it is up (one with Hub
        // sign-in over one without, say). Far below the length of any Host rule, which is where the
        // app's own routers start, so those always win while they exist.
        const ranks = [...new Set(app.routers.map(({ priority }) => priority))].sort((a, b) => a - b);
        for (const { name, router, priority } of app.routers) {
          const downName = `${name}${APP_DOWN_ROUTER_SUFFIX}`;
          // An app router of that name keeps it.
          if (!(downName in config.http.routers)) {
            config.http.routers[downName] = appDownRouter(
              router,
              app.middlewares,
              `${APP_DOWN_SERVICE_PREFIX}${project}`,
              ranks.indexOf(priority) + 1,
            );
            appsWithDownRouters.add(project);
          }
        }
      }
      for (const project of await this.keepDownRoutersOfAppsWithoutContainers(previous, config, new Set(apps.keys()))) {
        appsWithDownRouters.add(project);
      }
      // After every container's services, so an app service that happens to share the name cannot
      // point the down routers at a container address.
      for (const project of appsWithDownRouters) {
        config.http.services[`${APP_DOWN_SERVICE_PREFIX}${project}`] = { loadBalancer: { servers: [{ url: APP_DOWN_SERVICE_URL }] } };
      }

      // Write the configuration file
      // configPath already defined at the start of the function

      const routerCount = Object.keys(config.http.routers).length;
      const serviceCount = Object.keys(config.http.services).length;
      const middlewareCount = Object.keys(config.http.middlewares ?? {}).length;
      const serversTransportCount = Object.keys(config.http.serversTransports ?? {}).length;

      // Traefik doesn't accept empty routers/services objects - only write file if we have content
      if (routerCount === 0 && serviceCount === 0 && middlewareCount === 0 && serversTransportCount === 0) {
        // Delete the file if it exists to avoid stale/invalid config
        if (await this.filesystem.pathExists(configPath)) {
          this.logger.debug(`No routers/services/middlewares found, deleting stale Traefik config at ${configPath}`);
          await this.filesystem.removeFile(configPath);
        } else {
          this.logger.debug('No routers/services/middlewares found, skipping Traefik config file write');
        }
        return;
      }

      // Only include non-empty sections in the config
      const validConfig: Partial<TraefikConfig> = {
        http: {
          routers: {},
          services: {},
        },
      };

      if (routerCount > 0 && validConfig.http) {
        validConfig.http.routers = config.http.routers;
      }
      if (serviceCount > 0 && validConfig.http) {
        validConfig.http.services = config.http.services;
      }
      if (middlewareCount > 0 && validConfig.http) {
        validConfig.http.middlewares = config.http.middlewares;
      }
      if (serversTransportCount > 0 && validConfig.http) {
        validConfig.http.serversTransports = config.http.serversTransports;
      }

      const yamlContent = yaml.stringify(validConfig, { indent: 2 });

      this.logger.debug(`Writing Traefik config to ${configPath}`);
      await writeHealableTextFile(configPath, yamlContent.endsWith('\n') ? yamlContent : `${yamlContent}\n`, 0o644);

      // Verify the file was written correctly
      const writtenContent = await this.filesystem.readTextFile(configPath);
      if (!writtenContent || writtenContent.trim().length === 0) {
        throw new Error('Failed to write Traefik config: file is empty after write');
      }

      this.logger.info(
        `Generated Traefik config with ${routerCount} routers, ${serviceCount} services, ${middlewareCount} middlewares, and ${serversTransportCount} serversTransports and wrote to ${configPath}`,
      );

      // Log router names for debugging
      if (routerCount > 0) {
        this.logger.debug(`Routers: ${Object.keys(config.http.routers).join(', ')}`);
      }
    } catch (error) {
      this.logger.error('Error generating Traefik config:', error);
      throw error;
    }
  }

  /**
   * The down routers of apps with no container in this rebuild, carried over from the apps.yml it
   * replaces while the app is still installed and keeps its address (CI-Hub#1944).
   *
   * apps.yml is rebuilt from the containers running at that moment, and many things rebuild it:
   * another app's Start, Stop, Install or Uninstall, the next app of a batch restart, the Hub's own
   * start. One that ran while an app was between its compose down and compose up used to drop that
   * app's down routers with its containers and the 404 was back. They stay while the app is running,
   * coming back or stopped and still goes out through Traefik; an app switched to local only has no
   * routes. Only a route an earlier apps.yml had is kept: an app that has had no container since it
   * last lost its routes (stopped before Hub releases that kept them, say) has none to keep.
   *
   * @returns the compose projects of the apps whose down routers it kept
   */
  private async keepDownRoutersOfAppsWithoutContainers(
    previous: unknown,
    config: TraefikConfig,
    seenProjects: ReadonlySet<string>,
  ): Promise<string[]> {
    const previousHttp = (previous as Partial<TraefikConfig> | null)?.http;
    const candidates = Object.entries(previousHttp?.routers ?? {}).flatMap(([name, router]) => {
      if (!name.endsWith(APP_DOWN_ROUTER_SUFFIX) || name in config.http.routers || !isAppDownRouter(router)) {
        return [];
      }
      const project = router.service.slice(APP_DOWN_SERVICE_PREFIX.length);
      return seenProjects.has(project) ? [] : [{ name, router, project }];
    });
    if (candidates.length === 0) {
      return [];
    }

    let expected: Set<string>;
    try {
      const installed = await this.appsRepository.getApps();
      expected = new Set(installed.filter((app) => APP_DOWN_KEPT_STATUSES.has(app.status) && isExposedThroughTraefik(app)).map(composeProjectOf));
    } catch (error) {
      this.logger.warn(`Could not read the apps' status; apps.yml keeps no route to the Hub's page for an app whose containers are gone: ${error}`);
      return [];
    }

    const kept = new Set<string>();
    for (const { name, router, project } of candidates) {
      if (!expected.has(project)) {
        continue;
      }
      config.http.routers[name] = router;
      // The copies of the app's own middlewares, which its chain names without a provider.
      for (const middleware of router.middlewares ?? []) {
        const definition = previousHttp?.middlewares?.[middleware];
        if (!middleware.includes('@') && definition && typeof definition === 'object' && !config.http.middlewares?.[middleware]) {
          config.http.middlewares = { ...config.http.middlewares, [middleware]: definition };
        }
      }
      kept.add(project);
    }
    return [...kept];
  }

  /**
   * Write or update the Traefik route for the Hub's public hostname
   * (e.g. devbox-core1.companionintelligence.com) so requests coming through the
   * Cloudflare tunnel reach ci-hub. This file is separate from apps.yml
   * because the hub container is explicitly skipped in generateTraefikConfig.
   */
  public async writeHubRoute(hubSubdomain: string, domain: string): Promise<void> {
    if (!hubSubdomain?.trim() || !domain?.trim() || domain === 'example.com') {
      this.logger.debug('Skipping hub route write: missing subdomain, domain, or example.com');
      return;
    }
    const hostname = `${hubSubdomain.trim()}.${domain.trim()}`;
    const hubContainer = hubContainerName();

    try {
      const { directories } = this.config.getConfig();
      const configPath = `${directories.dataDir}/state/traefik/dynamic/hub.yml`;

      const config: TraefikConfig = {
        http: {
          routers: {
            'hub-public': {
              rule: `Host(\`${hostname}\`)`,
              service: 'hub-service',
              entryPoints: ['web'],
            },
          },
          services: {
            'hub-service': {
              loadBalancer: {
                servers: [{ url: `http://${hubContainer}:5002` }],
              },
            },
          },
        },
      };

      const yamlContent = yaml.stringify(config, { indent: 2 });
      await writeHealableTextFile(configPath, yamlContent.endsWith('\n') ? yamlContent : `${yamlContent}\n`, 0o644);
      this.logger.info(`Wrote Traefik hub route for ${hostname}`);
    } catch (error) {
      this.logger.error(`Failed to write hub route for ${hostname}:`, error);
      throw error;
    }
  }

  /**
   * Remove the hub route file (e.g. when unregistering). Idempotent.
   */
  public async removeHubRoute(): Promise<void> {
    try {
      const { directories } = this.config.getConfig();
      const configPath = `${directories.dataDir}/state/traefik/dynamic/hub.yml`;
      if (await this.filesystem.pathExists(configPath)) {
        await this.filesystem.removeFile(configPath);
        this.logger.info('Removed Traefik hub route');
      }
    } catch (error) {
      this.logger.warn('Failed to remove hub route (non-fatal):', error);
    }
  }

  /**
   * Regenerate Traefik config after a short delay to allow containers to start
   * Retries up to 3 times if containers aren't ready yet
   */
  public async regenerateTraefikConfig(delayMs = 2000, maxRetries = 3): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await this.generateTraefikConfig();
            resolve();
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries) {
              this.logger.debug(`Traefik config generation attempt ${attempt} failed, retrying in 2s...`);
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
        this.logger.error(`Error regenerating Traefik config after ${maxRetries} attempts:`, lastError);
        resolve(); // Don't throw, just log - we don't want to fail app operations
      }, delayMs);
    });
  }
}
