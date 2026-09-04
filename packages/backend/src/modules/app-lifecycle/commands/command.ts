import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { DockerService } from '@/modules/docker/docker.service';
import { isDockerNetworkOverlapError } from '@/modules/network/docker-network-errors';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import { parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { ErrorReportingService, type AppFailurePhase } from '@/core/error-reporting/error-reporting.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { buildOriginServerName, buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';
import {
  AppLifecycleError,
  type AppCommandFailureResult,
  createKvmMissingError,
  createRocmKfdMissingError,
  translateKvmInstallMessage,
  translateRocmKfdInstallMessage,
  translateDockerNetworkOverlapError,
} from './app-lifecycle-errors';
import { cidrOverlaps } from '@/modules/network/cidr-overlap';
import { supportsPosixPermissions } from '@/common/helpers/bind-mount-helpers';
import { isAbortError, throwIfAborted } from '@/common/abort';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import type { OperationPhase } from '../app-operation-registry';
import fs from 'node:fs';
import * as yaml from 'yaml';

async function isKvmDeviceAvailable(): Promise<boolean> {
  try {
    await fs.promises.access('/dev/kvm', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Optional cancellation context threaded into a command's `execute()`.
 * Commands that support cancellation observe `signal` (passed down to killable docker spawns/pulls)
 * and report progress via `setPhase` so the cancel endpoint can decide whether an abort is still safe.
 */
export interface CommandExecutionContext {
  /** Aborted when the user cancels the operation. */
  signal: AbortSignal;
  /** Report the current execution phase to the operation registry. */
  setPhase(phase: OperationPhase): void;
}

/**
 * Shared shape for a lifecycle command. `execute` accepts an optional {@link CommandExecutionContext}
 * as its last argument; commands that don't support cancellation simply ignore it.
 */
export interface LifecycleCommand {
  execute(appUrn: AppUrn, form: AppEventFormInput, ctx?: CommandExecutionContext): Promise<unknown>;
}

export class AppLifecycleCommand {
  constructor(
    protected moduleRef: ModuleRef,
    protected docker: Dockerode,
  ) {}

  protected async assertMarketplaceEntitlement(appUrn: AppUrn, mode: 'install' | 'start' | 'update'): Promise<void> {
    const entitlements = this.moduleRef.get(MarketplaceEntitlementService, { strict: false });
    if (!entitlements) {
      return;
    }
    if (mode === 'start') {
      await entitlements.assertForStart(appUrn);
      return;
    }
    if (mode === 'update') {
      await entitlements.assertForUpdate(appUrn);
      return;
    }
    await entitlements.assertForInstall(appUrn);
  }

  protected async ensureAppDir(appUrn: AppUrn, form: AppEventFormInput, options?: { excludeSubnets?: string[] }): Promise<void> {
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const subnetManager = this.moduleRef.get(SubnetManagerService, { strict: false });
    const configService = this.moduleRef.get(ConfigurationService, { strict: false });
    const fullConfig = (typeof configService.getConfig === 'function' ? configService.getConfig() : null) || {
      domain: configService.get('domain'),
      localDomain: configService.get('localDomain'),
      userSettings: configService.get('userSettings'),
    };

    const prunedNew = await this.docker
      .pruneContainers({ filters: { label: [`ci-hub.appurn=${appUrn}`] } })
      .catch(() => ({ ContainersDeleted: [] as string[], SpaceReclaimed: 0 }));
    const prunedLegacy = await this.docker
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
        const resourceAllocator = this.moduleRef.get(ResourceAllocatorService, { strict: false });
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

      const effectiveExposureMode = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
      let cloudflareOriginHostname: string | undefined;
      let cloudflarePublicHostname: string | undefined;
      if (effectiveExposureMode === 'cloudflare' && !form.openPort) {
        const registrationService = this.moduleRef.get(RegistrationService, { strict: false });
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
          const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
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

      const dockerComposeBuilder = new DockerComposeBuilder(domain, localDomain, posixPermissionsSupported);
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

  private hostDevicePath(device: string): string | null {
    const hostDevice = device.split(':')[0]?.trim();
    return hostDevice || null;
  }

  private isKfdHostDevice(device: string): boolean {
    return this.hostDevicePath(device) === '/dev/kfd';
  }

  private isKvmHostDevice(device: string): boolean {
    return this.hostDevicePath(device) === '/dev/kvm';
  }

  /**
   * Returns which special host devices a raw user docker-compose.yml override
   * declares. Failures to parse are silently ignored so a malformed override
   * never blocks an otherwise-valid install/start.
   */
  private userComposeRequiredDevices(composeYaml: string): { requiresKfd: boolean; requiresKvm: boolean } {
    try {
      const parsed = yaml.parse(composeYaml) as { services?: Record<string, { devices?: unknown[] } | null> } | null;
      if (!parsed?.services) return { requiresKfd: false, requiresKvm: false };
      let requiresKfd = false;
      let requiresKvm = false;
      for (const svc of Object.values(parsed.services)) {
        for (const device of svc?.devices ?? []) {
          if (typeof device !== 'string') continue;
          if (this.isKfdHostDevice(device)) requiresKfd = true;
          if (this.isKvmHostDevice(device)) requiresKvm = true;
        }
      }
      return { requiresKfd, requiresKvm };
    } catch {
      return { requiresKfd: false, requiresKvm: false };
    }
  }

  /**
   * Fail fast with friendly guidance when a compose manifest declares /dev/kfd or /dev/kvm but
   * the host can't provide it, instead of surfacing Docker's raw device-attach error. Shared by
   * install and start: a device present at install time can still be gone by a later start (e.g.
   * ROCm/KVM modules not yet loaded at boot), so start needs this same preflight rather than
   * relying solely on translating Docker's error message after the fact.
   */
  protected async assertRequiredHostDevices(appUrn: AppUrn): Promise<void> {
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    // Check the base installed compose (docker-compose.json) with architecture overrides applied.
    let requiresKfd = false;
    let requiresKvm = false;
    const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
    if (composeJson.content) {
      const { services, overrides } = parseComposeJson(composeJson.content);
      const architecture = config.get('architecture');
      const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);
      for (const service of mergedServices) {
        for (const device of service.devices ?? []) {
          if (typeof device !== 'string') continue;
          if (this.isKfdHostDevice(device)) requiresKfd = true;
          if (this.isKvmHostDevice(device)) requiresKvm = true;
        }
      }
    }

    // Also check the user compose override (user-config/{store}/{app}/docker-compose.yml).
    // composeApp layers this file on top of the generated docker-compose.yml via an additional
    // -f flag. Docker Compose appends list fields across -f files, so an override that adds
    // /dev/kfd or /dev/kvm will be present in the effective compose even when the base does not.
    if (!requiresKfd || !requiresKvm) {
      const userCompose = await appFilesManager.getUserComposeFile(appUrn);
      if (userCompose.content) {
        const fromUser = this.userComposeRequiredDevices(userCompose.content);
        requiresKfd = requiresKfd || fromUser.requiresKfd;
        requiresKvm = requiresKvm || fromUser.requiresKvm;
      }
    }

    if (requiresKfd && !(await isRocmKfdPassthroughAvailable())) {
      throw createRocmKfdMissingError();
    }

    if (requiresKvm && !(await isKvmDeviceAvailable())) {
      throw createKvmMissingError();
    }
  }

  protected async removeStaleAppNetworks(appUrn: AppUrn): Promise<void> {
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    await dockerService?.removeAppNetworks(appUrn);
  }

  /**
   * Run compose for an app, removing stale project networks first and retrying
   * with a fresh subnet when Docker reports overlapping bridge ranges.
   *
   * When a `signal` is supplied, an abort kills the underlying `docker compose` process and is
   * re-thrown immediately so a cancellation is never misclassified as a retryable network overlap.
   */
  protected async composeAppWithNetworkRecovery(
    appUrn: AppUrn,
    form: AppEventFormInput,
    command: string,
    maxAttempts = 3,
    signal?: AbortSignal,
  ): Promise<void> {
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const subnetManager = this.moduleRef.get(SubnetManagerService, { strict: false });
    const logger = this.moduleRef.get(LoggerService, { strict: false });

    if (!dockerService) {
      throw new Error('DockerService unavailable');
    }

    let lastError: unknown;
    const failedSubnets: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal);
      await this.removeStaleAppNetworks(appUrn);

      try {
        await dockerService.composeApp(appUrn, command, signal);
        return;
      } catch (error) {
        // A cancellation must propagate immediately, not be treated as a network-overlap retry.
        if (isAbortError(error)) {
          throw error;
        }
        lastError = error;
        const canRetry = isDockerNetworkOverlapError(error) && attempt < maxAttempts;
        if (!canRetry) {
          if (isDockerNetworkOverlapError(error)) {
            const overlapError = translateDockerNetworkOverlapError(error, await this.describeNetworkOverlap(appUrn));
            if (overlapError) {
              throw overlapError;
            }
          }
          throw error;
        }

        logger.warn(`Docker network overlap for ${appUrn} on attempt ${attempt}/${maxAttempts}; releasing subnet and regenerating compose`);
        const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
        const app = appsRepository ? await appsRepository.getAppByUrn(appUrn).catch(() => null) : null;
        if (app?.subnet) {
          failedSubnets.push(app.subnet);
        }
        await subnetManager?.releaseSubnet(appUrn);
        await this.ensureAppDir(appUrn, form, { excludeSubnets: failedSubnets });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async describeNetworkOverlap(appUrn: AppUrn): Promise<string[]> {
    const subnetManager = this.moduleRef.get(SubnetManagerService, { strict: false });
    if (!subnetManager) {
      return [];
    }

    const occupied = await subnetManager.listOccupiedSubnets(appUrn);
    const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
    const app = appsRepository ? await appsRepository.getAppByUrn(appUrn).catch(() => null) : null;
    const candidateSubnet = app?.subnet;
    if (!candidateSubnet) {
      return occupied.map((entry) => entry.cidr);
    }

    return occupied.filter((entry) => cidrOverlaps(candidateSubnet, entry.cidr)).map((entry) => entry.cidr);
  }

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<AppCommandFailureResult> => {
    if (err instanceof AppLifecycleError) {
      this.reportCommandFailure(appId, event, err.errorDetail ?? err.message, err.errorCode);
      return {
        success: false,
        message: err.message,
        errorCode: err.errorCode,
        errorDetail: err.errorDetail,
        settingsPath: err.settingsPath,
      };
    }

    if (err instanceof Error) {
      const overlapTranslated = translateDockerNetworkOverlapError(err);
      if (overlapTranslated) {
        this.reportCommandFailure(appId, event, overlapTranslated.errorDetail ?? overlapTranslated.message, overlapTranslated.errorCode);
        return {
          success: false,
          message: overlapTranslated.message,
          errorCode: overlapTranslated.errorCode,
          errorDetail: overlapTranslated.errorDetail,
        };
      }

      const translated = translateRocmKfdInstallMessage(err.message) ?? translateKvmInstallMessage(err.message);
      if (translated) {
        this.reportCommandFailure(appId, event, translated.errorDetail ?? translated.message, translated.errorCode);
        return {
          success: false,
          message: translated.message,
          errorCode: translated.errorCode,
          errorDetail: translated.errorDetail,
          settingsPath: translated.settingsPath,
        };
      }

      this.reportCommandFailure(appId, event, err.message);
      return { success: false, message: err.message };
    }

    const message = `An error occurred: ${String(err)}`;
    this.reportCommandFailure(appId, event, message);
    return { success: false, message };
  };

  /**
   * Reports to Sentry synchronously, inside the queue worker, before the result round-trips back
   * to AppLifecycleService's settleCommandOutcome (which also reports, with errorCode, once the
   * RPC reply arrives). ErrorReportingService debounces per `${phase}:${appUrn}` for 30s, so
   * whichever call lands first is what Sentry actually receives — this one, here, usually wins the
   * race since it runs before the round-trip. errorCode must therefore be threaded through HERE
   * too, not only on the settleCommandOutcome side, or a classified failure can still surface in
   * Sentry as unclassified depending on timing.
   */
  private reportCommandFailure(appId: string, event: string, message: string, errorCode?: string): void {
    const errorReportingService = this.moduleRef.get(ErrorReportingService, { strict: false });
    const phase = this.mapEventToFailurePhase(event);
    if (!phase) {
      return;
    }

    errorReportingService?.reportAppFailure({
      appUrn: appId,
      phase,
      message,
      errorCode,
    });
  }

  private mapEventToFailurePhase(event: string): AppFailurePhase | null {
    switch (event) {
      case 'install':
        return 'install';
      case 'start':
        return 'start';
      case 'stop':
        return 'stop';
      case 'restart':
        return 'restart';
      case 'uninstall':
        return 'uninstall';
      case 'reset':
        return 'reset';
      case 'backup':
        return 'backup';
      case 'restore':
        return 'restore';
      case 'update_error':
      case 'generate_env_error':
        return 'update';
      default:
        return null;
    }
  }
}
