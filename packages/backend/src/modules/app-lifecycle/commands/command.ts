import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import { parseComposeJson } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import * as Sentry from '@sentry/nestjs';
import { type } from 'arktype';
import Dockerode from 'dockerode';
import { ZodError } from 'zod';
import { fromError } from 'zod-validation-error';

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

      const domain = envMap.get('DOMAIN') || configService.get('userSettings').domain || configService.get('domain');
      const localDomain = envMap.get('LOCAL_DOMAIN') || configService.get('userSettings').localDomain || configService.get('localDomain');

      const dockerComposeBuilder = new DockerComposeBuilder(domain, localDomain);
      const subnet = await subnetManager.allocateSubnet(appUrn);

      const composeFile = await dockerComposeBuilder.getDockerCompose(mergedServices, form, appUrn, subnet, domain, localDomain, appEnv.path);

      await appFilesManager.writeDockerComposeYml(appUrn, composeFile);
    } catch (err) {
      logger.error(`Error generating docker-compose.yml file for app ${appUrn}`);

      if (err instanceof type.errors) {
        logger.error(err.summary);
        logger.error('Report this issue to the appstore maintainer.');
        throw new Error(`Error generating docker-compose.yml file for app ${appUrn}.\n${err.summary}\nReport this issue to the appstore maintainer.`);
      }

      if (err instanceof ZodError) {
        logger.error(fromError(err).toString());
        logger.error('Report this issue to the appstore maintainer.');
        throw new Error(
          `Error generating docker-compose.yml file for app ${appUrn}.\n${fromError(err).toString()}\nReport this issue to the appstore maintainer.`,
        );
      }

      logger.error(err);
      Sentry.captureException(err, {
        tags: { appId: appUrn, event: 'ensure_app_dir' },
      });
      throw new Error(`Error generating docker-compose.yml file for app ${appUrn}.`);
    }

    // Set permissions
    await appFilesManager.setAppDataDirPermissions(appUrn);
  }

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<{ success: false; message: string }> => {
    Sentry.captureException(err, {
      tags: { appId, event },
    });

    if (err instanceof Error) {
      return { success: false, message: err.message };
    }

    return { success: false, message: `An error occurred: ${String(err)}` };
  };
}
