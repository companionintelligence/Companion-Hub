import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { deriveAppBaseWsOrigin, parseAppBaseUrl } from '@/modules/apps/app.helpers';
import { EnvUtils } from '@/modules/env/env.utils';
import { extractConflictingHostBinding } from '@/modules/network/docker-port-errors';
import { PortManagerService, type PortAllocation } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';

/**
 * `url` with the port `from` it names replaced by `to`. A URL that names another port or none (a
 * public `https` address), or a value that is not an http(s) URL, comes back unchanged.
 */
export function withMovedPort(url: string, from: number, to: number): string {
  const match = /^(https?:\/\/(?:\[[^\]]*\]|[^/:?#@]+)):(\d{1,5})(?=$|[/?#])/i.exec(url);
  return match && Number(match[2]) === from ? `${match[1]}:${to}${url.slice(match[0].length)}` : url;
}

/**
 * Point the app at the host port of its main allocation: `APP_PORT` and the local URL variables in its
 * app.env, its base URLs, `form.port`, and the `port` column and `config` of its row. Every later
 * start, restart and update rebuilds app.env from the row's config, so a port kept only in app.env
 * would go back to the manifest's port on the next start.
 */
export async function writeMainHostPort(
  moduleRef: ModuleRef,
  appUrn: AppUrn,
  form: AppEventFormInput,
  main: Pick<PortAllocation, 'hostPort' | 'containerPort'>,
): Promise<void> {
  const { hostPort } = main;
  const appFilesManager = moduleRef.get(AppFilesManager, { strict: false });
  const envUtils = moduleRef.get(EnvUtils, { strict: false });
  const config = moduleRef.get(ConfigurationService, { strict: false });
  const appsRepository = moduleRef.get(AppsRepository, { strict: false });

  const appEnvData = await appFilesManager.getAppEnv(appUrn);
  const envMap = envUtils.envStringToMap(appEnvData.content);
  // The port app.env pointed the app at until now: the form's or the manifest's on a first
  // allocation, the refused one on a move.
  const previousPort = Number(envMap.get('APP_PORT'));
  envMap.set('APP_PORT', String(hostPort));

  // Keep URL/origin vars aligned with generateEnvFile (browser host, not bind address).
  const bindHost = envMap.get('APP_HOSTNAME') || config.getConfig().internalIp;
  const browserHost = resolveBrowserHost(bindHost);
  const internalAuthority = `${browserHost}:${hostPort}`;
  envMap.set('APP_INTERNAL_AUTHORITY', internalAuthority);
  if (envMap.get('APP_EXPOSED') !== 'true') {
    envMap.set('APP_HOST', browserHost);
    envMap.set('APP_DOMAIN', internalAuthority);
    envMap.set('APP_URL', `http://${internalAuthority}`);
  }

  // The app's own base URLs: APP_BASE_URL, which generateEnvFile copies from APP_URL when the app
  // has no public address, and each `app_base_url` field, which the install dialog fills with
  // `http://localhost:<port>` (or the tailnet name and port) and config replays on every start.
  // One still naming the port the app left would send its redirects, sign-in callbacks and links to
  // whatever holds that port now. A public address names no port, so it stays as it is.
  const followsPort = Number.isInteger(previousPort) && previousPort !== hostPort;
  const follow = (value: unknown) => (followsPort && typeof value === 'string' ? withMovedPort(value, previousPort, hostPort) : value);
  const baseUrlFields = followsPort
    ? ((await appFilesManager.getInstalledAppInfo(appUrn))?.form_fields ?? []).filter((field) => field.type === 'app_base_url')
    : [];
  const baseUrlBefore = envMap.get('APP_BASE_URL');
  for (const envVar of ['APP_BASE_URL', ...baseUrlFields.flatMap((field) => [field.env_variable, ...(field.alias_env_variables ?? [])])]) {
    const value = envMap.get(envVar);
    if (value !== undefined) {
      envMap.set(envVar, follow(value) as string);
    }
  }
  const baseUrl = envMap.get('APP_BASE_URL');
  if (baseUrl && baseUrl !== baseUrlBefore) {
    try {
      const parsed = parseAppBaseUrl(baseUrl);
      envMap.set('APP_BASE_HOST', parsed.host);
      envMap.set('APP_BASE_WSS_ORIGIN', deriveAppBaseWsOrigin(parsed));
    } catch {
      // generateEnvFile leaves the derived pair alone for a base URL it cannot parse, and so does this.
    }
  }

  // Also update form.port so ensureAppDir uses the right port
  form.port = hostPort;

  await appFilesManager.writeAppEnv(appUrn, envUtils.envMapToString(envMap));

  const app = await appsRepository?.getAppByUrn(appUrn);
  if (!app) {
    return;
  }
  const storedConfig = (app.config ?? {}) as Record<string, unknown>;
  const nextConfig: Record<string, unknown> = { ...storedConfig, port: hostPort };
  for (const field of baseUrlFields) {
    if (storedConfig[field.env_variable] !== undefined) {
      nextConfig[field.env_variable] = follow(storedConfig[field.env_variable]);
    }
  }
  // A start rebuilds APP_PORT from config.port, or from the manifest's port (the container port)
  // when config has none, so that is the port to compare, not the row's port column alone.
  const portOnNextStart = storedConfig.port ?? main.containerPort;
  const baseUrlsMoved = baseUrlFields.some((field) => nextConfig[field.env_variable] !== storedConfig[field.env_variable]);
  if (app.port !== hostPort || portOnNextStart !== hostPort || baseUrlsMoved) {
    await appsRepository.updateAppById(app.id, { config: nextConfig, port: hostPort });
  }
}

/**
 * Move the app's main port when `compose up` failed because something already holds it on the
 * host, and report whether it moved. The port manager's probe runs inside the Hub container and
 * cannot see a program listening on the host itself (a locally run OpenClaw gateway on 18789,
 * say), so Docker's refusal is the first sign of it. `refused` collects every port Docker turned
 * down during this command, so a retry never lands on one of them again.
 *
 * Only the main port moves. A port from the manifest's `addPorts` is published as written, so a
 * conflict on one fails the install as before.
 */
export async function moveMainPortOffHostConflict(
  moduleRef: ModuleRef,
  appUrn: AppUrn,
  form: AppEventFormInput,
  error: unknown,
  refused: Set<number>,
): Promise<boolean> {
  const portManager = moduleRef.get(PortManagerService, { strict: false });
  const logger = moduleRef.get(LoggerService, { strict: false });
  const conflict = extractConflictingHostBinding(error);
  // The main port is always TCP, so a UDP refusal on the same number is an `addPorts` mapping.
  if (!portManager || !conflict || conflict.protocol === 'udp' || (await portManager.getMainPort(appUrn)) !== conflict.port) {
    return false;
  }

  const { port } = conflict;
  refused.add(port);
  const moved = await portManager.moveMainPort(appUrn, refused);
  if (!moved) {
    return false;
  }

  logger.warn(`Host port ${port} for ${appUrn} is already in use on this computer; moving the app to port ${moved.hostPort}`);
  await writeMainHostPort(moduleRef, appUrn, form, moved);
  return true;
}
