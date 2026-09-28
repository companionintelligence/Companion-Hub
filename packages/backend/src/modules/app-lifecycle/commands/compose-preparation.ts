import { extractAppUrn } from '@/common/helpers/app-helpers';
import { supportsPosixPermissions } from '@/common/helpers/bind-mount-helpers';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { publishesCloudflarePublicRoute } from '@/modules/apps/app-public-routing.helpers';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import { hostPortStaysOnLoopback, parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';

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
    const { services, overrides } = parseComposeJson(composeJson.content);
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

    // Read app env file to get DOMAIN and LOCAL_DOMAIN for Traefik label interpolation
    const appEnv = await appFilesManager.getAppEnv(appUrn);
    const envUtils = new EnvUtils();
    const envMap = envUtils.envStringToMap(appEnv.content || '');

    const domain = envMap.get('DOMAIN') || fullConfig.userSettings?.domain || fullConfig.domain;
    const localDomain = envMap.get('LOCAL_DOMAIN') || fullConfig.userSettings?.localDomain || fullConfig.localDomain;
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
      defaultCpuLimit =
        typeof (fullConfig.userSettings as Record<string, unknown> | undefined)?.defaultAppCpuLimit === 'string'
          ? ((fullConfig.userSettings as Record<string, unknown>).defaultAppCpuLimit as string).trim() || undefined
          : undefined;
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

    // The manifest also carries the edge-auth default the route builder falls back to for a stored
    // form that never decided `enableAuth` (see `requiresHubLoginOnPublicRoute`).
    const dockerComposeBuilder = new DockerComposeBuilder(domain, localDomain, posixPermissionsSupported, {
      loopbackHostPort,
      manifest: appInfo ?? undefined,
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
