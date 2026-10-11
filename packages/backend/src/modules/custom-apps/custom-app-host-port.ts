import type { AppUrn } from '@ci-hub/common/types';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { PortManagerService } from '@/modules/network/port-manager.service';

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
 * ports the app maps itself in Port Mappings, which the main port must not take.
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
 */
export async function ensureCustomAppHostPort(
  portManager: Pick<PortManagerService, 'allocatePorts' | 'getMainPort'>,
  appsRepository: Pick<AppsRepository, 'getAppByUrn' | 'updateAppById'>,
  appUrn: AppUrn,
  internalPort: number,
  avoid: ReadonlySet<number> = new Set(),
): Promise<number> {
  const hostPort = (await portManager.getMainPort(appUrn)) ?? (await allocateCustomAppHostPort(portManager, appUrn, internalPort, avoid));
  const app = await appsRepository.getAppByUrn(appUrn);

  if (app) {
    await appsRepository.updateAppById(app.id, { config: { ...(app.config ?? {}), port: hostPort }, port: hostPort });
  }

  return hostPort;
}

/**
 * The host ports the Hub's own web server publishes, which a custom app's main port and its Port
 * Mappings must keep off.
 *
 * Every Hub compose file publishes Traefik on `${HTTP_PORT:-80}`, `${HTTPS_PORT:-443}` and
 * `${TRAEFIK_DASHBOARD_PORT:-8080}`, and the desktop app moves them when it can't have those: on
 * Linux, where only root may open a port below 1024, HTTP and HTTPS go to 8880 and 8443. The values
 * come from the Hub's env file, which the backend loads into `process.env`. The port manager's probe
 * runs inside the Hub container and sees none of them. `userSettings.port` and `sslPort`
 * (`NGINX_PORT` and `NGINX_PORT_SSL`) are kept for a Hub that sets them.
 */
export function hubWebHostPorts(userSettings: { port?: number; sslPort?: number } | undefined, env: NodeJS.ProcessEnv = process.env): Set<number> {
  const envPort = (name: string, fallback: number) => {
    const raw = env[name]?.trim() ?? '';
    const value = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
    return value >= 1 && value <= 65535 ? value : fallback;
  };
  const ports = [
    envPort('HTTP_PORT', 80),
    envPort('HTTPS_PORT', 443),
    envPort('TRAEFIK_DASHBOARD_PORT', 8080),
    userSettings?.port,
    userSettings?.sslPort,
  ];
  return new Set(ports.filter((port): port is number => typeof port === 'number'));
}
