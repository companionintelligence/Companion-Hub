import type { AppUrn } from '@ci-hub/common/types';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { PortManagerService } from '@/modules/network/port-manager.service';

/**
 * A port written as a number or as the digits the create form submits, with stray whitespace allowed.
 * Anything else (an env reference, a range, a value outside 1 to 65535) is not a plain port.
 */
export function parsePort(value: unknown): number | undefined {
  const raw = typeof value === 'string' ? value.trim() : value;
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export type MappedHostPort = { hostPort: number; protocol: 'tcp' | 'udp' };

type PortMappingInput = { hostPort?: unknown; tcp?: boolean; udp?: boolean } | null | undefined;

/**
 * The host ports a custom app's Port Mappings publish, with their protocol. A host port given as an env
 * reference is left out. `services` may come from a compose file read back from disk, so it is not
 * trusted to be well formed.
 */
export function mappedHostPorts(
  services: ReadonlyArray<{ addPorts?: ReadonlyArray<PortMappingInput> | null } | null | undefined> | undefined,
): MappedHostPort[] {
  const ports: MappedHostPort[] = [];
  for (const service of Array.isArray(services) ? services : []) {
    for (const mapping of Array.isArray(service?.addPorts) ? service.addPorts : []) {
      const hostPort = parsePort(mapping?.hostPort);
      if (!mapping || hostPort === undefined) {
        continue;
      }
      // As the compose builder publishes them: TCP unless the mapping is UDP only.
      if (mapping.tcp || !mapping.udp) {
        ports.push({ hostPort, protocol: 'tcp' });
      }
      if (mapping.udp) {
        ports.push({ hostPort, protocol: 'udp' });
      }
    }
  }
  return ports;
}

/**
 * The host ports a custom app's main port must keep off although the port manager would hand them out:
 * the Hub's own ports, the ones the app maps itself, and its internal port when another app's row
 * publishes it. A port-expose app is such a row: it points at a service already running on the host and
 * holds no allocation. The app's own row is not "another app", which matters on a start, where it exists.
 */
export async function customAppMainPortAvoids(
  appsRepository: Pick<AppsRepository, 'getAppsByPort'>,
  appUrn: AppUrn,
  mappings: ReadonlyArray<MappedHostPort>,
  internalPort: number,
  hubPorts: ReadonlySet<number>,
): Promise<Set<number>> {
  const avoid = new Set(hubPorts);
  for (const { hostPort, protocol } of mappings) {
    if (protocol === 'tcp') {
      avoid.add(hostPort);
    }
  }
  const publishers = await appsRepository.getAppsByPort(internalPort);
  if (publishers.some((row) => createAppUrn(row.appName, row.appStoreSlug) !== appUrn)) {
    avoid.add(internalPort);
  }
  return avoid;
}

/**
 * Allocate the host port a custom app publishes its main service on, from the port manager installs use.
 *
 * A custom app is created, not installed, so it never got the host port an install allocates. Its
 * compose published `${APP_PORT}:<internal port>` with `APP_PORT` falling back to the internal port
 * itself, so an app listening on a port the Hub holds (80, where Traefik serves) could never start.
 *
 * The internal port is asked for first, so an app on a free port keeps the address it had. The port
 * manager refuses a privileged port, a port it keeps for the Hub, or another app's, and hands out a
 * free one from its range instead. The internal port stays the container port. `avoid` holds the host
 * ports the port manager can't see but the main port must not take; see `customAppMainPortAvoids`.
 */
export async function allocateCustomAppHostPort(
  portManager: Pick<PortManagerService, 'allocatePorts'>,
  appUrn: AppUrn,
  internalPort: number,
  avoid: ReadonlySet<number> = new Set(),
): Promise<number> {
  const [main] = await portManager.allocatePorts(appUrn, [
    { containerPort: internalPort, label: 'main', preferredHostPort: avoid.has(internalPort) ? undefined : internalPort },
  ]);

  if (!main) {
    throw new Error(`The port manager allocated no host port for ${appUrn}`);
  }

  return main.hostPort;
}

/**
 * The host port of a custom app made before custom apps were given one, found or allocated on its
 * first start. It is written to the app's row (`config.port` and `port`), which every later start,
 * the Open link and the port conflict checks read.
 *
 * A main allocation the app already holds is kept unless it is one of the ports in `avoid`. Such an
 * allocation exists for an app whose settings were saved before this change: the settings dialog
 * copied the internal port into the row, and the boot backfill (`migrateExistingPortAllocations`)
 * recorded that row port as the app's main allocation. A custom app holds no allocation besides its
 * main one, so releasing all of them gives back only that.
 */
export async function ensureCustomAppHostPort(
  portManager: Pick<PortManagerService, 'allocatePorts' | 'getMainPort' | 'releaseAll'>,
  appsRepository: Pick<AppsRepository, 'getAppByUrn' | 'updateAppById'>,
  appUrn: AppUrn,
  internalPort: number,
  avoid: ReadonlySet<number> = new Set(),
): Promise<number> {
  const existing = await portManager.getMainPort(appUrn);
  let hostPort: number;
  if (existing !== null && !avoid.has(existing)) {
    hostPort = existing;
  } else {
    if (existing !== null) {
      await portManager.releaseAll(appUrn);
    }
    hostPort = await allocateCustomAppHostPort(portManager, appUrn, internalPort, avoid);
  }

  const app = await appsRepository.getAppByUrn(appUrn);
  const config = (app?.config ?? {}) as Record<string, unknown>;
  if (app && (app.port !== hostPort || config.port !== hostPort)) {
    await appsRepository.updateAppById(app.id, { config: { ...config, port: hostPort }, port: hostPort });
  }

  return hostPort;
}

/**
 * The Hub's API (5002), and its database (6543) and queue (5001) on 127.0.0.1, as every Hub compose file
 * publishes them. Inside the Hub container `API_PORT` and the others name the container side, so the
 * defaults are all the Hub can know.
 */
const HUB_SERVICE_HOST_PORTS = [5002, 6543, 5001] as const;

/**
 * The host ports the Hub's own containers publish, which a custom app's main port and its Port Mappings
 * must keep off. Only these: the port manager's reserved list also holds the Hub's development ports
 * (3000, 5432, 9091), which a running Hub doesn't publish.
 *
 * Every Hub compose file publishes Traefik on `${HTTP_PORT:-80}`, `${HTTPS_PORT:-443}` and
 * `${TRAEFIK_DASHBOARD_PORT:-8080}`, and the desktop app moves them when it can't have those: on
 * Linux, where only root may open a port below 1024, HTTP and HTTPS go to 8880 and 8443. The values
 * come from the Hub's env file, which the backend loads into `process.env`. The port manager's probe
 * runs inside the Hub container and sees none of them. `userSettings.port` and `sslPort`
 * (`NGINX_PORT` and `NGINX_PORT_SSL`) are kept for a Hub that sets them.
 */
export function hubHostPorts(userSettings: { port?: number; sslPort?: number } | undefined, env: NodeJS.ProcessEnv = process.env): Set<number> {
  const ports = [
    parsePort(env.HTTP_PORT) ?? 80,
    parsePort(env.HTTPS_PORT) ?? 443,
    parsePort(env.TRAEFIK_DASHBOARD_PORT) ?? 8080,
    ...HUB_SERVICE_HOST_PORTS,
    userSettings?.port,
    userSettings?.sslPort,
  ];
  return new Set(ports.filter((port): port is number => typeof port === 'number'));
}
