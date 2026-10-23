import { extractAppUrn } from '@/common/helpers/app-helpers';
import { supportsPosixPermissions } from '@/common/helpers/bind-mount-helpers';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { appIdOf } from '@/modules/apps/app-id.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { publishesCloudflarePublicRoute } from '@/modules/apps/app-public-routing.helpers';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import { HEALTHCHECK_START_INTERVAL_MIN_ENGINE_MAJOR, withoutUnsupportedStartInterval } from '@/modules/docker/healthcheck-start-interval';
import { hostPortStaysOnLoopback, parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';

/** The app's own hosts in its env, which its Traefik router rules may name. */
const OWN_HOST_VARIABLES = ['APP_DOMAIN', 'APP_LOCAL_DOMAIN', 'APP_BASE_HOST'];

/**
 * The id of every app the Hub knows about: each installed app (custom apps among them) and each app
 * the enabled stores list, so that an app installed later counts too. The compose builder gives a
 * Traefik name to the app with the longest of these ids that covers it.
 *
 * A store's listing is a folder of names any store can publish. One that is no app URN is skipped.
 * A listing that can't be read leaves the installed apps' ids. Neither stops the app starting.
 */
async function knownAppIds(
  moduleRef: ModuleRef,
  marketplaceService: Pick<MarketplaceService, 'listedAppUrns'>,
  logger: Pick<LoggerService, 'warn'>,
): Promise<string[]> {
  const [installed, listed] = await Promise.all([
    moduleRef.get(AppsRepository, { strict: false }).getApps(),
    Promise.resolve()
      .then(() => marketplaceService.listedAppUrns())
      .catch((error: unknown): AppUrn[] => {
        logger.warn(`[compose] Could not list the stores' apps, so Traefik names are checked against installed apps only: ${String(error)}`);
        return [];
      }),
  ]);
  const ids = new Set(installed.map((app) => appIdOf(app.appName, app.appStoreSlug)));
  for (const urn of listed) {
    try {
      const { appName, appStoreId } = extractAppUrn(urn);
      ids.add(appIdOf(appName, appStoreId));
    } catch {
      // Not an app URN: no app of that id can be installed.
    }
  }
  return [...ids];
}

/**
 * Generates an app's docker-compose.yml from its marketplace manifest.
 *
 * Shared by install, update, start, and restart: each of them must regenerate compose before
 * running it, because domain, exposure mode, resource limits, and the allocated subnet can all
 * have changed since the last run.
 */
export async function prepareAppComposeDir(
  moduleRef: ModuleRef,
  docker: Dockerode,
  appUrn: AppUrn,
  form: AppEventFormInput,
  options?: { excludeSubnets?: string[] },
): Promise<void> {
  const appFilesManager = moduleRef.get(AppFilesManager, { strict: false });
  const marketplaceService = moduleRef.get(MarketplaceService, { strict: false });
  const logger = moduleRef.get(LoggerService, { strict: false });
  const subnetManager = moduleRef.get(SubnetManagerService, { strict: false });
  const configService = moduleRef.get(ConfigurationService, { strict: false });
  const fullConfig = (typeof configService.getConfig === 'function' ? configService.getConfig() : null) || {
    domain: configService.get('domain'),
    localDomain: configService.get('localDomain'),
    userSettings: configService.get('userSettings'),
  };

  const prunedNew = await docker
    .pruneContainers({ filters: { label: [`ci-hub.appurn=${appUrn}`] } })
    .catch(() => ({ ContainersDeleted: [] as string[], SpaceReclaimed: 0 }));
  const prunedLegacy = await docker
    .pruneContainers({ filters: { label: [`ci-os-hub.appurn=${appUrn}`] } })
    .catch(() => ({ ContainersDeleted: [] as string[], SpaceReclaimed: 0 }));
  const pruned = {
    ContainersDeleted: [...(prunedNew.ContainersDeleted ?? []), ...(prunedLegacy.ContainersDeleted ?? [])],
    SpaceReclaimed: (prunedNew.SpaceReclaimed ?? 0) + (prunedLegacy.SpaceReclaimed ?? 0),
  };

  logger.info('Pruned containers:', pruned.ContainersDeleted, 'Space reclaimed:', pruned.SpaceReclaimed / 1024 / 1024, 'MB');

  let composeJson = await appFilesManager.getDockerComposeJson(appUrn);
  if (!composeJson.content) {
    await marketplaceService.copyAppFromRepoToInstalled(appUrn);
    composeJson = await appFilesManager.getDockerComposeJson(appUrn);
  }

  try {
    const { services, overrides } = parseInstalledComposeJson(composeJson.content);

    // A database read and a listing of every store's folder, which the builder needs only at the end:
    // started now so it runs beside the reads below. Handled at once so a failure that stops the
    // build first is not left unhandled.
    const knownAppIdsLookup = knownAppIds(moduleRef, marketplaceService, logger);
    knownAppIdsLookup.catch(() => undefined);

    const architecture = configService.get('architecture');

    // Merge architecture-specific overrides with base services
    let mergedServices = mergeArchitectureOverrides(services, overrides, architecture);

    const appInfo = await Promise.resolve(marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn)).catch(() => null);
    if (appInfo?.runtime_platform) {
      mergedServices = mergedServices.map((service) => (service.platform ? service : { ...service, platform: appInfo.runtime_platform }));
    }

    // #936: a stdio MCP server reads MCP JSON-RPC from stdin. Docker closes stdin unless
    // stdin_open is set, so the main process EOFs at boot and restart-loops. Force it for
    // apps whose listing declares a stdio MCP transport, even when the store compose
    // forgot "stdinOpen": true.
    if (appInfo?.mcp?.transport === 'stdio') {
      mergedServices = mergedServices.map((service) => (service.isMain ? { ...service, stdinOpen: true } : service));
    }

    // Compose refuses a health check's start_interval on Docker Engine older than 25, which left any
    // app that sets one unable to install or start there. The engine is read only when a service sets it.
    if (mergedServices.some((service) => service.healthCheck?.startInterval)) {
      let engineVersion: string | undefined;
      try {
        engineVersion = await moduleRef.get(ResourceAllocatorService, { strict: false }).getDockerServerVersion();
      } catch {
        // Unknown engine: keep the setting.
      }
      mergedServices = withoutUnsupportedStartInterval(mergedServices, engineVersion, (service) => {
        logger.warn(
          `[compose] Docker Engine ${engineVersion} can't use a health check start_interval (it needs Engine ${HEALTHCHECK_START_INTERVAL_MIN_ENGINE_MAJOR} or newer); ${appUrn} service ${service.name} starts without it`,
        );
      });
    }

    // Read app env file to get DOMAIN and LOCAL_DOMAIN for Traefik label interpolation
    const appEnv = await appFilesManager.getAppEnv(appUrn);
    const envUtils = new EnvUtils();
    const envMap = envUtils.envStringToMap(appEnv.content || '');

    const domain = envMap.get('DOMAIN') || fullConfig.userSettings?.domain || fullConfig.domain;
    const localDomain = envMap.get('LOCAL_DOMAIN') || fullConfig.userSettings?.localDomain || fullConfig.localDomain;
    const configuredCpuLimit = (fullConfig.userSettings as Record<string, unknown> | undefined)?.defaultAppCpuLimit;
    const savedDefaultCpuLimit = typeof configuredCpuLimit === 'string' ? configuredCpuLimit.trim() || undefined : undefined;
    let defaultCpuLimit: string | undefined;
    let defaultMemoryLimit: string | undefined;
    try {
      const resourceAllocator = moduleRef.get(ResourceAllocatorService, { strict: false });
      const appDefaults = await resourceAllocator.getEffectiveAppDefaults();
      defaultCpuLimit = appDefaults.cpuLimit;
      defaultMemoryLimit = appDefaults.memoryLimit;
    } catch (resourceError) {
      // Fall back to the user-configured CPU limit if the allocator is unavailable
      logger.warn(`Resource allocator unavailable, skipping auto resource limits: ${resourceError}`);
      defaultCpuLimit = savedDefaultCpuLimit;
    }

    let cloudflareOriginHostname: string | undefined;
    let cloudflarePublicHostname: string | undefined;
    /*
     * Build the tunnel route for exactly the apps Companion Portal publishes. The sync applies this
     * predicate to the same stored form (`publicRoutingSnapshotOf`), so neither can publish what the
     * other does not. Whether the host port is also published does not matter, because Traefik
     * reaches the container over the Docker network. A `!openPort` guard here (added in #678 from
     * the env identity rule) left open-port apps on Traefik's 404 while the app page said "Public
     * domain: Enabled", including every install that omitted the field, because the queue form
     * defaults `openPort` to true. Those routes are new, so the compose builder puts the Hub login
     * in front of them unless the form decided otherwise (`requiresHubLoginOnPublicRoute`).
     */
    if (publishesCloudflarePublicRoute(form)) {
      const registrationService = moduleRef.get(RegistrationService, { strict: false });
      const org = await registrationService.getDeviceRegistrationInfo();
      const { appName, appStoreId } = extractAppUrn(appUrn);
      const appSubdomain = form.localSubdomain || `${appName}-${appStoreId}`;
      cloudflareOriginHostname = buildOriginServerName({
        appSubdomain,
        hubSubdomain: org?.hubSubdomain,
        orgSlug: org?.slug,
        localDomain,
      });
      const platformPublicHostname = buildPublicWebIdentity({
        appSubdomain,
        hubSubdomain: org?.hubSubdomain,
        orgSlug: org?.slug,
        publicDomainRoot: resolvePublicDomainRoot({
          selectedPublicDomain: typeof form.publicDomain === 'string' && form.publicDomain.trim().length > 0 ? form.publicDomain : undefined,
          envDomain: envMap.get('DOMAIN'),
          configDomain: domain,
        }),
      }).hostname;

      /*
       * This value becomes Traefik's `X-Forwarded-Host` custom request header
       * (traefik-labels.builder.ts), so it MUST follow the same binding
       * `generateEnvFile` follows. A whole class of frameworks — Rails, Django
       * with USE_X_FORWARDED_HOST, Laravel/Symfony trusted proxies, anything
       * that trusts proxy headers over its own env — builds absolute URLs and
       * OAuth `redirect_uri` from this header and never looks at
       * `APP_PUBLIC_URL`. Leaving it on the platform hostname makes the two
       * sources disagree and the feature silently do nothing for those apps.
       *
       * Read from the row, exactly as env generation does, so the header and
       * the env cannot drift regardless of which runs first.
       */
      let boundCustomDomain: string | null = null;
      try {
        const appsRepository = moduleRef.get(AppsRepository, { strict: false });
        boundCustomDomain = normalizeStoredHostname(await appsRepository.getAppCustomDomain(appUrn));
      } catch (customDomainError) {
        logger.warn(`Could not resolve the bound custom domain for ${appUrn}; using the platform hostname: ${customDomainError}`);
      }

      cloudflarePublicHostname = boundCustomDomain || platformPublicHostname;
    }

    // Windows-backed app data (drvfs/9p) silently drops chown/chmod, so database services that
    // must own their data directory cannot use a bind mount there. Probe once per build and let
    // the compose builder redirect those volumes; every other platform keeps its bind mounts.
    const appDataDir = configService.get('directories')?.appDataDir;
    const posixPermissionsSupported = appDataDir ? await supportsPosixPermissions(appDataDir) : true;
    if (!posixPermissionsSupported) {
      logger.info(`[compose] ${appDataDir} cannot carry POSIX permissions; ownership-sensitive volumes will use named volumes`);
    }

    // Whether the host port stays on loopback is read from the manifest. Without one this keeps the
    // all-interfaces default: binding an arbitrary app to loopback would cut its LAN access over a
    // transient lookup failure.
    if (!appInfo) {
      logger.warn(`[compose] No manifest for ${appUrn}; publishing its host port on all interfaces`);
    }
    const loopbackHostPort = appInfo ? hostPortStaysOnLoopback(appInfo) : false;

    // The builder applies the operator's Default app CPU limit to services the form and the manifest
    // leave uncapped. Only the saved setting: `defaultCpuLimit` above can be the allocator's
    // host-sized recommendation, which #1186 stopped stamping on every service. A limit in the form
    // caps every service, so the default is never used and the checks below would only mislead.
    let defaultAppCpuLimit = form.cpuLimit?.trim() ? undefined : savedDefaultCpuLimit;
    // Docker refuses to create a container capped above the CPUs it has ("range of CPUs is from 0.01
    // to 16.00"), and a cap that high limits nothing. A default saved on a bigger machine, or before
    // Docker's VM got fewer CPUs, would otherwise stop every app without a limit of its own.
    if (defaultAppCpuLimit) {
      let dockerCpus: number | undefined;
      try {
        dockerCpus = (await moduleRef.get(ResourceAllocatorService, { strict: false }).getDockerCapacity())?.cpuCores;
      } catch {
        // Count unknown: apply the default as saved.
      }
      if (dockerCpus && Number(defaultAppCpuLimit) > dockerCpus) {
        logger.warn(
          `[compose] Default app CPU limit ${defaultAppCpuLimit} is more than the ${dockerCpus} CPUs Docker has; ${appUrn} runs without it`,
        );
        defaultAppCpuLimit = undefined;
      }
    }

    // The manifest also carries the edge-auth default the route builder falls back to for a stored
    // form that never decided `enableAuth` (see `requiresHubLoginOnPublicRoute`).
    const dockerComposeBuilder = new DockerComposeBuilder(domain, localDomain, posixPermissionsSupported, {
      loopbackHostPort,
      manifest: appInfo ?? undefined,
      defaultAppCpuLimit,
      knownAppIds: await knownAppIdsLookup,
      // The hosts the Hub set for this app. compose expands one it left unset from the Hub's own
      // environment or a user env file, so an app's router rule may name only these.
      hostVariables: OWN_HOST_VARIABLES.filter((name) => envMap.has(name)),
    });
    const subnet = await subnetManager.allocateSubnet(appUrn, 0, options?.excludeSubnets ?? []);

    const composeFile = await dockerComposeBuilder.getDockerCompose(
      mergedServices,
      form,
      appUrn,
      subnet,
      domain,
      localDomain,
      appEnv.path,
      cloudflareOriginHostname,
      cloudflarePublicHostname,
      defaultCpuLimit,
      defaultMemoryLimit,
    );

    await appFilesManager.writeDockerComposeYml(appUrn, composeFile);
  } catch (err) {
    logger.error(`Error generating docker-compose.yml file for app ${appUrn}`);

    if (err instanceof ZodError) {
      logger.error(fromError(err).toString());
      logger.error('Report this issue to the appstore maintainer.');
      throw new Error(
        `Error generating docker-compose.yml file for app ${appUrn}.\n${fromError(err).toString()}\nReport this issue to the appstore maintainer.`,
      );
    }

    logger.error(err);
    throw new Error(`Error generating docker-compose.yml file for app ${appUrn}.`);
  }

  // Set permissions
  await appFilesManager.setAppDataDirPermissions(appUrn);
}
