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
import { buildOriginServerName } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';
import {
  AppLifecycleError,
  type AppCommandFailureResult,
  translateRocmKfdInstallMessage,
  translateDockerNetworkOverlapError,
} from './app-lifecycle-errors';
import { cidrOverlaps } from '@/modules/network/cidr-overlap';
import { isAbortError, throwIfAborted } from '@/common/abort';
import type { OperationPhase } from '../app-operation-registry';

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

    const pruned = await this.docker
      .pruneContainers({ filters: { label: [`ci-os-hub.appurn=${appUrn}`] } })
      .catch(() => ({ ContainersDeleted: [], SpaceReclaimed: 0 }));

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

      const appInfo = await marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn).catch(() => null);
      if (appInfo?.runtime_platform) {
        mergedServices = mergedServices.map((service) => (service.platform ? service : { ...service, platform: appInfo.runtime_platform }));
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
      if (effectiveExposureMode === 'cloudflare' && !form.openPort) {
        const registrationService = this.moduleRef.get(RegistrationService, { strict: false });
        const org = await registrationService.getDeviceRegistrationInfo();
        const { appName, appStoreId } = extractAppUrn(appUrn);
        cloudflareOriginHostname = buildOriginServerName({
          appSubdomain: form.localSubdomain || `${appName}-${appStoreId}`,
          hubSubdomain: org?.hubSubdomain,
          orgSlug: org?.slug,
          localDomain,
        });
      }

      const dockerComposeBuilder = new DockerComposeBuilder(domain, localDomain);
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
      this.reportCommandFailure(appId, event, err.errorDetail ?? err.message);
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
        this.reportCommandFailure(appId, event, overlapTranslated.errorDetail ?? overlapTranslated.message);
        return {
          success: false,
          message: overlapTranslated.message,
          errorCode: overlapTranslated.errorCode,
          errorDetail: overlapTranslated.errorDetail,
        };
      }

      const translated = translateRocmKfdInstallMessage(err.message);
      if (translated) {
        this.reportCommandFailure(appId, event, translated.errorDetail ?? translated.message);
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

  private reportCommandFailure(appId: string, event: string, message: string): void {
    const errorReportingService = this.moduleRef.get(ErrorReportingService, { strict: false });
    const phase = this.mapEventToFailurePhase(event);
    if (!phase) {
      return;
    }

    errorReportingService?.reportAppFailure({
      appUrn: appId,
      phase,
      message,
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
