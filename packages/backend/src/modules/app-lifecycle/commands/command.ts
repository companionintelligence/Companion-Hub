import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import { parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { ErrorReportingService, type AppFailurePhase } from '@/core/error-reporting/error-reporting.service';
import { buildOriginServerName } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';

export const ROCM_KFD_MISSING_MESSAGE =
  'This app requires an AMD GPU with ROCm drivers. The ROCm compute device (/dev/kfd) was not found on this machine. Verify that you have a supported AMD GPU and ROCm drivers installed before running this app.';

export class AppLifecycleCommand {
  constructor(
    protected moduleRef: ModuleRef,
    protected docker: Dockerode,
  ) {}

  protected async ensureAppDir(appUrn: AppUrn, form: AppEventFormInput): Promise<void> {
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
      const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);

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
      const subnet = await subnetManager.allocateSubnet(appUrn);

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

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<{ success: false; message: string }> => {
    if (err instanceof Error) {
      const translatedMessage = this.translateKnownInstallError(err.message);
      this.reportCommandFailure(appId, event, translatedMessage);
      return { success: false, message: translatedMessage };
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

  private translateKnownInstallError(message: string): string {
    const normalizedMessage = message.toLowerCase();
    const referencesKfd = normalizedMessage.includes('/dev/kfd');
    const missingRocmDevice =
      normalizedMessage.includes('error gathering device information') && normalizedMessage.includes('no such file or directory');
    const blockedKfdPath = normalizedMessage.includes('file path') && normalizedMessage.includes('is not allowed');

    if (referencesKfd && (missingRocmDevice || blockedKfdPath)) {
      return ROCM_KFD_MISSING_MESSAGE;
    }

    return message;
  }
}
