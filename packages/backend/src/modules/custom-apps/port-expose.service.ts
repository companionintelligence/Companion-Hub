import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { isPortExposeApp, PORT_EXPOSE_KIND, type AppInfo } from '@ci-hub/common/schemas';
import path from 'node:path';
import { AppsRepository } from '../apps/apps.repository';
import { AppFilesManager } from '../apps/app-files-manager';
import { publishesCloudflarePublicRoute } from '../apps/app-public-routing.helpers';
import { ExposureSyncService } from '../app-lifecycle/exposure-sync.service';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { TraefikConfigService, type PortExposeRoute } from '../docker/traefik-config.service';
import type { CreatePortExposeAppDto, UpdatePortExposeAppDto } from './dto/custom-apps.dto';

const APPS_FOLDER = '_user';

@Injectable()
export class PortExposeService {
  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly configService: ConfigurationService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly traefikConfigService: TraefikConfigService,
    private readonly exposureSyncService: ExposureSyncService,
    private readonly portalClient: PortalClientService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
  ) {}

  async createPortExposeApp(dto: CreatePortExposeAppDto): Promise<{ appUrn: AppUrn; appName: string; storeId: string }> {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { name, port, exposureMode, localSubdomain, publicDomain } = dto;

    if (exposureMode === 'cloudflare' && !localSubdomain?.trim()) {
      throw new TranslatableError('PORT_EXPOSE_SUBDOMAIN_REQUIRED', undefined, HttpStatus.BAD_REQUEST);
    }

    const appUrn = createAppUrn(name, APPS_FOLDER);
    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (existingApp) {
      throw new TranslatableError('CUSTOM_APP_ERROR_DUPLICATE_NAME', { name }, HttpStatus.CONFLICT);
    }

    const appsWithSamePort = await this.appsRepository.getAppsByPort(port);
    if (appsWithSamePort.length > 0) {
      throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
    }

    const routingSubdomain = sanitizeAppSubdomain(localSubdomain?.trim() || name);
    if (exposureMode === 'cloudflare') {
      const appsWithSameLocalSubdomain = await this.appsRepository.getAppsByLocalSubdomain(routingSubdomain);
      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: routingSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    try {
      await this.createAppDirectories(appUrn);
      await this.writePortExposeConfig(appUrn);
      await this.createAppInfo(appUrn, name, port);

      const exposedLocal = exposureMode === 'cloudflare';
      const openPort = exposureMode === 'local' || exposedLocal;

      await this.appsRepository.createApp({
        appStoreSlug: APPS_FOLDER,
        appName: name,
        config: {
          kind: PORT_EXPOSE_KIND,
          port,
          exposureMode,
          localSubdomain: routingSubdomain,
          publicDomain: exposureMode === 'cloudflare' ? publicDomain : undefined,
          exposedLocal,
          openPort,
        },
        status: 'running',
        port,
        exposed: false,
        exposedLocal,
        exposureMode,
        openPort,
        localSubdomain: routingSubdomain,
        publicDomain: exposureMode === 'cloudflare' ? (publicDomain ?? null) : null,
        enableAuth: false,
        isVisibleOnGuestDashboard: false,
      });

      await this.syncPortExposeRoutes();
      await this.exposureSyncService.syncExposurePublic();

      if (exposureMode !== 'cloudflare') {
        await this.syncPortalRegistry(appUrn, 'upsert');
      }

      this.logger.info(`Port-expose workload ${name} created on port ${port} (${exposureMode})`);

      return { appUrn, appName: name, storeId: APPS_FOLDER };
    } catch (error) {
      this.logger.error(`Failed to create port-expose workload ${name}:`, error);
      await this.cleanupAppDirectories(appUrn).catch(() => undefined);
      if (error instanceof TranslatableError) {
        throw error;
      }
      throw new TranslatableError('CUSTOM_APP_ERROR_CREATION_FAILED', { name }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async updatePortExposeApp(appUrn: AppUrn, dto: UpdatePortExposeAppDto): Promise<void> {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!isPortExposeApp(info) && !isPortExposeApp(app.config)) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.BAD_REQUEST);
    }

    const { port, exposureMode, localSubdomain, publicDomain } = dto;
    const previousExposureMode = app.exposureMode;

    if (exposureMode === 'cloudflare' && !localSubdomain?.trim()) {
      throw new TranslatableError('PORT_EXPOSE_SUBDOMAIN_REQUIRED', undefined, HttpStatus.BAD_REQUEST);
    }

    const appsWithSamePort = await this.appsRepository.getAppsByPort(port, app.id);
    if (appsWithSamePort.length > 0) {
      throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
    }

    const { appName } = extractAppUrn(appUrn);
    const routingSubdomain = sanitizeAppSubdomain(localSubdomain?.trim() || appName);
    if (exposureMode === 'cloudflare') {
      const appsWithSameLocalSubdomain = await this.appsRepository.getAppsByLocalSubdomain(routingSubdomain, app.id);
      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: routingSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    try {
      await this.updatePortExposeConfigJson(appUrn, port);

      const exposedLocal = exposureMode === 'cloudflare';
      const openPort = exposureMode === 'local' || exposedLocal;
      const config = {
        kind: PORT_EXPOSE_KIND,
        port,
        exposureMode,
        localSubdomain: routingSubdomain,
        publicDomain: exposureMode === 'cloudflare' ? publicDomain : undefined,
        exposedLocal,
        openPort,
      };

      await this.appsRepository.updateAppById(app.id, {
        config,
        port,
        exposedLocal,
        exposureMode,
        openPort,
        localSubdomain: routingSubdomain,
        publicDomain: exposureMode === 'cloudflare' ? (publicDomain ?? null) : null,
        status: 'running',
      });

      await this.syncPortExposeRoutes();
      await this.exposureSyncService.syncExposurePublic();

      const previousNeedsPortal = portExposeNeedsPortalRegistry(previousExposureMode);
      const nextNeedsPortal = portExposeNeedsPortalRegistry(exposureMode);

      if (previousNeedsPortal && !nextNeedsPortal) {
        await this.syncPortalRegistry(appUrn, 'remove');
      } else if (nextNeedsPortal) {
        await this.syncPortalRegistry(appUrn, 'upsert');
      }

      this.logger.info(`Port-expose workload ${appName} updated (port ${port}, ${exposureMode})`);
    } catch (error) {
      this.logger.error(`Failed to update port-expose workload ${appUrn}:`, error);
      if (error instanceof TranslatableError) {
        throw error;
      }
      throw new TranslatableError('PORT_EXPOSE_UPDATE_ERROR', { name: appName }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async beforePortExposeUninstall(appUrn: AppUrn): Promise<void> {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      return;
    }

    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!isPortExposeApp(info) && !isPortExposeApp(app.config)) {
      return;
    }

    if (app.exposureMode !== 'cloudflare') {
      await this.syncPortalRegistry(appUrn, 'remove');
    }
  }

  async afterPortExposeUninstall(): Promise<void> {
    await this.syncPortExposeRoutes();
  }

  /** @deprecated Use beforePortExposeUninstall + afterPortExposeUninstall from uninstall flow */
  async removePortExposeApp(appUrn: AppUrn): Promise<void> {
    await this.beforePortExposeUninstall(appUrn);
    await this.afterPortExposeUninstall();
    await this.exposureSyncService.syncExposurePublic();
  }

  async syncPortExposeRoutes(): Promise<void> {
    const apps = await this.appsRepository.getApps();
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const { userSettings, localDomain: configLocalDomain } = this.configService.getConfig();
    const localDomain = userSettings.localDomain || configLocalDomain;

    const routes: PortExposeRoute[] = [];

    for (const app of apps) {
      if (!['running', 'starting', 'restarting'].includes(app.status)) {
        continue;
      }

      const info = await this.appFilesManager.getInstalledAppInfo(`${app.appName}:${app.appStoreSlug}` as AppUrn);
      if (!info || !isPortExposeApp(info)) {
        continue;
      }

      const upstreamPort = info.upstreamPort ?? info.port ?? app.port;
      if (!upstreamPort) {
        continue;
      }

      const exposureMode = app.exposureMode || 'local';
      if (exposureMode === 'tailscale') {
        continue;
      }

      const appSubdomain = app.localSubdomain || app.appName;
      const traefikHost = buildOriginServerName({
        appSubdomain,
        hubSubdomain: org?.hubSubdomain,
        orgSlug: org?.slug,
        localDomain,
      });

      routes.push({
        appUrn: `${app.appName}:${app.appStoreSlug}` as AppUrn,
        traefikHost,
        upstreamPort,
      });
    }

    await this.traefikConfigService.syncPortExposeRoutes(routes);
  }

  private async syncPortalRegistry(appUrn: AppUrn, action: 'upsert' | 'remove'): Promise<void> {
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    if (!org?.id) {
      this.logger.debug('[Portal] Skipping workload registry sync — device not registered');
      return;
    }

    const { appName } = extractAppUrn(appUrn);
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      return;
    }

    try {
      await this.portalClient.postDeviceApplicationsRegistry({
        organizationId: org.id,
        apps: [
          {
            name: appName,
            slug: app.localSubdomain || appName,
            port: app.port ?? 0,
            publicDomain: app.publicDomain ?? undefined,
            remove: action === 'remove',
          },
        ],
      });
    } catch (error) {
      this.logger.warn(`[Portal] Failed to ${action} workload registry entry for ${appUrn}: ${error}`);
    }
  }

  private async createAppDirectories(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');

    const appPath = path.join(dataDir, 'apps', appStoreId, appName);
    const dataPath = path.join(dataDir, 'app-data', appStoreId, appName);

    const ok = await this.filesystem.createDirectories([appPath, dataPath]);
    if (!ok) {
      throw new Error(`Failed to create app directories at ${appPath} and ${dataPath}`);
    }
  }

  private async writePortExposeConfig(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');
    const configPath = path.join(dataDir, 'apps', appStoreId, appName, 'docker-compose.json');
    const configContent = JSON.stringify({ schemaVersion: 2, services: [] }, null, 2);
    const ok = await this.filesystem.writeTextFile(configPath, configContent);
    if (!ok) {
      throw new Error(`Failed to write docker-compose config at ${configPath}`);
    }
  }

  private async updatePortExposeConfigJson(appUrn: AppUrn, upstreamPort: number): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');
    const infoPath = path.join(dataDir, 'apps', appStoreId, appName, 'config.json');

    const existing = await this.filesystem.readJsonFile<AppInfo>(infoPath);
    if (!existing) {
      throw new Error(`Failed to read app info at ${infoPath}`);
    }

    const updatedInfo = {
      ...existing,
      port: upstreamPort,
      upstreamPort,
      updated_at: Date.now(),
    } satisfies AppInfo;

    const ok = await this.filesystem.writeJsonFile(infoPath, updatedInfo);
    if (!ok) {
      throw new Error(`Failed to write app info at ${infoPath}`);
    }
  }

  private async createAppInfo(appUrn: AppUrn, name: string, upstreamPort: number): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');
    const infoPath = path.join(dataDir, 'apps', appStoreId, appName, 'config.json');

    const appInfo = {
      id: appName,
      name,
      urn: appUrn,
      available: true,
      port: upstreamPort,
      upstreamPort,
      kind: PORT_EXPOSE_KIND,
      categories: ['utilities'],
      description: `Port-exposed workload: ${name}`,
      short_desc: 'User workload exposed on a host port',
      author: 'User',
      source: '',
      website: '',
      exposable: true,
      no_gui: false,
      supported_architectures: ['amd64', 'arm64'],
      cihub_app_version: 1,
      version: '1.0.0',
      dynamic_config: false,
      deprecated: false,
      force_expose: false,
      generate_vapid_keys: false,
      form_fields: [],
      https: false,
      created_at: Date.now(),
      updated_at: Date.now(),
      force_pull: false,
    } satisfies AppInfo;

    const descriptionPath = path.join(dataDir, 'apps', appStoreId, appName, 'metadata', 'description.md');
    const descriptionContent = `---\nname: ${name}\nshort_desc: User workload exposed on a host port\nversion: 1.0.0\n---\n\n# ${name}\n\nThis workload is exposed via a host port on your Hub.\n`;

    const ok = await this.filesystem.writeJsonFile(infoPath, appInfo);
    if (!ok) {
      throw new Error(`Failed to write app info at ${infoPath}`);
    }

    const metadataDir = path.join(dataDir, 'apps', appStoreId, appName, 'metadata');
    await this.filesystem.createDirectory(metadataDir);
    await this.filesystem.writeTextFile(descriptionPath, descriptionContent);
  }

  private async cleanupAppDirectories(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');
    const appPath = path.join(dataDir, 'apps', appStoreId, appName);
    const dataPath = path.join(dataDir, 'app-data', appStoreId, appName);
    await Promise.all([this.filesystem.removeDirectory(appPath), this.filesystem.removeDirectory(dataPath)]);
  }
}

export function portExposeNeedsPortalRegistry(exposureMode: string | null | undefined): boolean {
  return exposureMode === 'local' || exposureMode === 'tailscale';
}

export function portExposePublishesCloudflare(exposureMode: string | null | undefined): boolean {
  return publishesCloudflarePublicRoute({ exposureMode: exposureMode as 'local' | 'cloudflare' | 'tailscale' });
}
