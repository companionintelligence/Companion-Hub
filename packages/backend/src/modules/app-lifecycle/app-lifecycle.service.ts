import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { HttpStatus, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { lt, valid } from 'semver';
import semver from 'semver';
import validator from 'validator';
import { type } from 'arktype';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { BackupManager } from '../backups/backup.manager';
import { CloudflareClientService, AppInfo } from '../cloudflare/cloudflare-client.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { RegistrationService } from '../registration/registration.service';
import { AppEventsQueue, appEventResultSchema, appEventSchema } from '../queue/entities/app-events';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { appFormSchema } from './dto/app-lifecycle.dto';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import type { AsyncMutex } from '@/utils/mutex/async-mutex';
import type { z } from 'zod';

@Injectable()
export class AppLifecycleService implements OnApplicationBootstrap {
  constructor(
    private readonly logger: LoggerService,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly commandFactory: AppLifecycleCommandFactory,
    private readonly appRepository: AppsRepository,
    private readonly config: ConfigurationService,
    private readonly marketplaceService: MarketplaceService,
    private readonly appsService: AppsService,
    private readonly appFilesManager: AppFilesManager,
    private readonly sseService: SSEService,
    private readonly backupManager: BackupManager,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly registrationService: RegistrationService,
    @Inject(APP_ASYNC_MUTEX) private mutex: AsyncMutex,
  ) {
    this.logger.debug('Subscribing to app events...');
    this.appEventsQueue.onEvent((data, reply) => this.invokeCommand(data, reply));
  }

  async onApplicationBootstrap() {
    this.logger.info('Triggering initial Cloudflare sync in 5s...');
    setTimeout(() => {
      this.triggerCloudflareSync().catch((e) => this.logger.error(`Startup sync failed: ${e.message}`));
    }, 5000);
  }

  async invokeCommand(data: z.infer<typeof appEventSchema>, reply: (response: z.output<typeof appEventResultSchema>) => Promise<void>) {
    const release = await this.mutex.acquire(data.appUrn);

    try {
      const command = this.commandFactory.createCommand(data);
      const { success, message } = await command.execute(data.appUrn, data.form);

      if (success) {
        this.logger.debug('Command executed successfully, triggering Cloudflare sync...');
        // Trigger sync to ensure cloud state matches local state (exposed apps)
        await this.triggerCloudflareSync();
      }

      await reply({ success, message });
    } catch (err) {
      this.logger.error('Error invoking command:', err);
      await reply({ success: false, message: String(err) });
    } finally {
      release();
    }
  }

  /**
   * Check if the configuration has changed in a way that requires a restart
   */
  private hasConfigChanged(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>): boolean {
    const oldJSON = JSON.stringify(oldConfig);
    const newJSON = JSON.stringify(newConfig);

    return oldJSON !== newJSON;
  }

  async startApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    const { appUrn, skipPull } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    await this.appRepository.updateAppById(app.id, { status: 'starting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'starting' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ appUrn, command: 'start', requestId, form: { ...app.config, skipPull } }).then(async ({ success, message }) => {
      if (success) {
        this.logger.info(`App ${appUrn} started successfully`);
        this.sseService.emit('app', { event: 'start_success', appUrn, appStatus: 'running' });
        await this.appRepository.updateAppById(app.id, { status: 'running', pendingRestart: false });

        // Check if we need to sync Cloudflare state (if app is exposedLocal and production)
        const { isProduction: isProdEnv } = this.config.getConfig();
        if (isProdEnv && app.exposedLocal) {
          this.logger.info(`[Cloudflare] App ${appUrn} started and is exposedLocal. Triggering sync.`);
          await this.triggerCloudflareSync();
        }
      } else {
        this.logger.error(`Failed to start app ${appUrn}: ${message}`);
        this.sseService.emit('app', { event: 'start_error', appUrn, appStatus: 'stopped', error: message });
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });
      }
    });

    return { requestId };
  }

  async installApp(params: { appUrn: AppUrn; form: unknown; skipRun?: boolean }) {
    const { appUrn, form, skipRun } = params;
    const { demoMode, version, architecture } = this.config.getConfig();

    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing' });

    const app = await this.appRepository.getAppByUrn(appUrn);

    const parsedForm = appFormSchema(form);
    if (parsedForm instanceof type.errors) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedForm });
    }

    if (app) {
      await this.appRepository.updateAppById(app.id, { config: parsedForm, ...parsedForm });
      return this.startApp({ appUrn });
    }

    const { exposed, exposedLocal, openPort, domain, isVisibleOnGuestDashboard, enableAuth, port } = parsedForm;
    const apps = await this.appRepository.getApps();

    if (demoMode && apps.length >= 6) {
      throw new TranslatableError('SYSTEM_ERROR_DEMO_MODE_LIMIT');
    }

    // Prevent exposing to internet in production - use exposedLocal with Cloudflare tunnel instead
    const { isProduction } = this.config.getConfig();
    if (isProduction && exposed) {
      this.logger.warn(`App ${appUrn} attempted to use exposed=true in production, disabling`);
      parsedForm.exposed = false;
      parsedForm.domain = undefined;
    }

    if (exposed && !domain) {
      throw new TranslatableError('APP_ERROR_DOMAIN_REQUIRED_IF_EXPOSE_APP');
    }

    if (domain && !validator.isFQDN(domain)) {
      throw new TranslatableError('APP_ERROR_DOMAIN_NOT_VALID', { domain });
    }

    const appInfo = await this.marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn);

    if (!appInfo) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    if (appInfo.supported_architectures?.length && !appInfo.supported_architectures.includes(architecture)) {
      throw new TranslatableError('APP_ERROR_ARCHITECTURE_NOT_SUPPORTED', { id: appUrn, arch: architecture });
    }

    if (!appInfo.exposable) {
      if (exposed || exposedLocal || enableAuth) {
        this.logger.warn(`App ${appUrn} is not exposable, resetting proxy settings`);
      }
      parsedForm.exposed = false;
      parsedForm.exposedLocal = false;
      parsedForm.enableAuth = false;
      parsedForm.domain = undefined;
    }

    if (appInfo.force_expose && !exposed) {
      throw new TranslatableError('APP_ERROR_APP_FORCE_EXPOSED', { id: appUrn });
    }

    if (exposed && domain) {
      const appsWithSameDomain = await this.appRepository.getAppsByDomain(domain);

      if (appsWithSameDomain.length > 0) {
        throw new TranslatableError('APP_ERROR_DOMAIN_ALREADY_IN_USE', { domain, id: appsWithSameDomain[0]?.appName });
      }
    }

    if (exposedLocal && parsedForm.localSubdomain) {
      const appsWithSameLocalSubdomain = await this.appRepository.getAppsByLocalSubdomain(parsedForm.localSubdomain);

      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: parsedForm.localSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    if (openPort && port) {
      const appsWithSamePort = await this.appRepository.getAppsByPort(port);

      if (appsWithSamePort.length > 0) {
        throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
      }
    }

    if (appInfo?.min_tipi_version && valid(version) && lt(version, appInfo.min_tipi_version)) {
      throw new TranslatableError('APP_UPDATE_ERROR_MIN_TIPI_VERSION', { id: appUrn, minVersion: appInfo.min_tipi_version });
    }

    const { appName, appStoreId } = extractAppUrn(appUrn);

    const createdApp = await this.appRepository.createApp({
      appName,
      status: 'installing',
      config: parsedForm,
      port: parsedForm.port ?? appInfo.port,
      version: appInfo.tipi_version,
      exposed: exposed ?? false,
      domain: domain ?? null,
      localSubdomain: parsedForm.localSubdomain ?? null,
      openPort: openPort ?? false,
      exposedLocal: exposedLocal ?? !!appInfo.exposable,
      appStoreSlug: appStoreId,
      isVisibleOnGuestDashboard,
      enableAuth: enableAuth ?? false,
    });

    const requestId = crypto.randomUUID();

    this.appEventsQueue.publish({ appUrn, command: 'install', requestId, form: { ...parsedForm, skipRun } }).then(async ({ success, message }) => {
      if (success) {
        this.logger.info(`App ${appUrn} installed successfully`);
        this.sseService.emit('app', { event: 'install_success', appUrn, appStatus: 'running' });
        await this.appRepository.updateAppById(createdApp.id, { status: 'running' });

        // Check if we need to sync Cloudflare state (if app is exposedLocal)
        if (createdApp.exposedLocal || (appInfo.exposable && !exposedLocal)) {
          // Wait for DB consistency/propagation
          await new Promise((r) => setTimeout(r, 2000));
          await this.triggerCloudflareSync();
        }
      } else {
        this.sseService.emit('app', { event: 'install_error', appUrn, appStatus: 'missing', error: message });
        this.logger.error(`Failed to install app ${appUrn}: ${message}`);
        await this.appRepository.deleteAppById(createdApp.id);
      }
    });

    return { requestId };
  }

  /**
   * Stop an app by its ID
   */
  public async stopApp(params: { appUrn: AppUrn }) {
    const { appUrn } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopping' });

    await this.appRepository.updateAppById(app.id, { status: 'stopping' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ command: 'stop', appUrn, requestId, form: app.config }).then(async ({ success, message }) => {
      if (success) {
        this.sseService.emit('app', { event: 'stop_success', appUrn, appStatus: 'stopped' });
        this.logger.info(`App ${appUrn} stopped successfully`);
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });

        // Trigger sync to remove route if exposedLocal
        if (app.exposedLocal) {
          await this.triggerCloudflareSync();
        }
      } else {
        this.sseService.emit('app', { event: 'stop_error', appUrn, appStatus: 'running', error: message });
        this.logger.error(`Failed to stop app ${appUrn}: ${message}`);
        await this.appRepository.updateAppById(app.id, { status: 'running' });
      }
    });

    return { requestId };
  }

  /**
   * Restart an app by its ID
   */
  public async restartApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    const { appUrn, skipPull } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND');
    }

    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'restarting' });
    await this.appRepository.updateAppById(app.id, { status: 'restarting' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ command: 'restart', appUrn, requestId, form: { ...app.config, skipPull } }).then(async ({ success, message }) => {
      if (success) {
        this.logger.info(`App ${appUrn} restarted successfully`);
        this.sseService.emit('app', { event: 'restart_success', appUrn, appStatus: 'running' });
        await this.appRepository.updateAppById(app.id, { status: 'running', pendingRestart: false });
      } else {
        this.logger.error(`Failed to restart app ${appUrn}: ${message}`);
        this.sseService.emit('app', { event: 'restart_error', appUrn, appStatus: 'running', error: message });
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });
      }
    });

    return { requestId };
  }

  /**
   * Uninstall an app by its ID
   */
  public async uninstallApp(params: { appUrn: AppUrn; removeBackups: boolean }) {
    const { appUrn, removeBackups } = params;

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    if (removeBackups) {
      await this.backupManager.deleteAppBackupsByUrn(appUrn);
    }

    await this.appRepository.updateAppById(app.id, { status: 'uninstalling' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'uninstalling' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ command: 'uninstall', appUrn, requestId, form: app.config }).then(async ({ success, message }) => {
      if (success) {
        this.logger.info(`App ${appUrn} uninstalled successfully`);
        await this.appRepository.deleteAppById(app.id);
        this.sseService.emit('app', { event: 'uninstall_success', appUrn, appStatus: 'missing' });

        // Trigger sync to remove route if it was exposedLocal
        if (app.exposedLocal) {
          await this.triggerCloudflareSync();
        }
      } else {
        this.logger.error(`Failed to uninstall app ${appUrn}: ${message}`);
        this.sseService.emit('app', { event: 'uninstall_error', appUrn, appStatus: 'stopped', error: message });
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });
      }
    });

    return { requestId };
  }

  /**
   * Reset an app by its ID
   */
  public async resetApp(params: { appUrn: AppUrn }) {
    const { appUrn } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    const appStatusBeforeReset = app?.status;
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'resetting' });
    await this.appRepository.updateAppById(app.id, { status: 'resetting' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ command: 'reset', appUrn, requestId, form: app.config }).then(async ({ success, message }) => {
      if (success) {
        this.logger.info(`App ${appUrn} reset successfully`);
        this.sseService.emit('app', { event: 'reset_success', appUrn, appStatus: 'stopped' });
        if (appStatusBeforeReset === 'running') {
          this.startApp({ appUrn });
        } else {
          await this.appRepository.updateAppById(app.id, { status: appStatusBeforeReset });
        }
      } else {
        this.logger.error(`Failed to reset app ${appUrn}: ${message}`);
        this.sseService.emit('app', { event: 'reset_error', appUrn, appStatus: appStatusBeforeReset, error: message });
        await this.appRepository.updateAppById(app.id, { status: 'running' });
      }
    });

    return { requestId };
  }

  public async updateAppConfig(params: { appUrn: AppUrn; form: unknown }) {
    const { appUrn, form } = params;

    const parsedForm = appFormSchema(form);

    if (parsedForm instanceof type.errors) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedForm });
    }

    const { exposed, domain, exposedLocal, enableAuth, openPort, port } = parsedForm;

    // Prevent exposing to internet in production - use exposedLocal with Cloudflare tunnel instead
    const { isProduction } = this.config.getConfig();
    if (isProduction && exposed) {
      this.logger.warn(`App ${appUrn} attempted to use exposed=true in production, disabling`);
      parsedForm.exposed = false;
      parsedForm.domain = undefined;
    }

    if (exposed && !domain) {
      throw new TranslatableError('APP_ERROR_DOMAIN_REQUIRED_IF_EXPOSE_APP');
    }

    if (domain && !validator.isFQDN(domain)) {
      throw new TranslatableError('APP_ERROR_DOMAIN_NOT_VALID');
    }

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);

    if (!appInfo) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    if (!appInfo.exposable) {
      if (exposed || exposedLocal || enableAuth) {
        this.logger.warn(`App ${appUrn} is not exposable, resetting proxy settings`);
      }
      parsedForm.exposed = false;
      parsedForm.exposedLocal = false;
      parsedForm.enableAuth = false;
      parsedForm.domain = undefined;
    }

    if (appInfo.force_expose && !exposed) {
      throw new TranslatableError('APP_ERROR_APP_FORCE_EXPOSED', { id: appUrn });
    }

    if (exposed && domain) {
      const appsWithSameDomain = await this.appRepository.getAppsByDomain(domain, app.id);

      if (appsWithSameDomain.length > 0) {
        throw new TranslatableError('APP_ERROR_DOMAIN_ALREADY_IN_USE', { domain, id: appsWithSameDomain[0]?.appName });
      }
    }

    if (exposedLocal && parsedForm.localSubdomain) {
      const appsWithSameLocalSubdomain = await this.appRepository.getAppsByLocalSubdomain(parsedForm.localSubdomain, app.id);

      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: parsedForm.localSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    if (openPort && port) {
      const appsWithSamePort = await this.appRepository.getAppsByPort(port, app.id);

      if (appsWithSamePort.length > 0) {
        throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
      }
    }

    const requestId = crypto.randomUUID();
    const { success, message } = await this.appEventsQueue.publish({
      command: 'generate_env',
      appUrn,
      requestId,
      form: parsedForm,
    });

    if (!success) {
      this.logger.error(`Failed to update app ${appUrn}: ${message}`);
      throw new TranslatableError('APP_ERROR_APP_FAILED_TO_UPDATE', { id: appUrn }, HttpStatus.INTERNAL_SERVER_ERROR, { cause: message });
    }

    const changed = await this.appRepository.updateAppById(app.id, {
      exposed: exposed ?? false,
      exposedLocal: parsedForm.exposedLocal ?? false,
      openPort: parsedForm.openPort,
      port: parsedForm.port ?? appInfo.port,
      domain: domain ?? null,
      localSubdomain: parsedForm.localSubdomain ?? null,
      config: parsedForm,
      isVisibleOnGuestDashboard: parsedForm.isVisibleOnGuestDashboard ?? false,
      enableAuth: parsedForm.enableAuth ?? false,
      maxBackups: parsedForm.maxBackups ?? null,
    });

    // Update Cloudflare Tunnel routes if exposedLocal is enabled (production only)
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { isProduction: _isProdEnv } = this.config.getConfig();
    const oldSubdomain = app.localSubdomain || `${appName}-${appStoreId}`;
    const newSubdomain = parsedForm.localSubdomain || `${appName}-${appStoreId}`;
    const _wasExposedLocal = app.exposedLocal;
    const _isNowExposedLocal = parsedForm.exposedLocal ?? false;
    const oldPort = app.port;
    // Prioritize parsedForm.port (user-specified port) > app.port (saved host port) > appInfo.port (container port)
    // parsedForm.port is the port being set in this update, so it's the most authoritative
    const newPort = parsedForm.port ? Number(parsedForm.port) : app.port ? Number(app.port) : appInfo.port;
    const _subdomainChanged = oldSubdomain !== newSubdomain;
    const _portChanged = oldPort !== newPort;

    if (!changed?.pendingRestart) {
      const pendingRestart = this.hasConfigChanged(app.config, changed?.config || {});
      await this.appRepository.updateAppById(app.id, { pendingRestart });
    }

    // Sync state with Cloudflare whenever exposedLocal is enabled or changed
    this.logger.info(`[Cloudflare] Config updated for ${appUrn}. Triggering state sync.`);
    await this.triggerCloudflareSync();

    return { requestId };
  }

  /**
   * Triggers a full sync of all exposed apps to Cloudflare via CI-Cloud
   */
  private async triggerCloudflareSync() {
    try {
      const orgInfo = await this.registrationService.getOrganizationInfo();

      if (!orgInfo) {
        this.logger.debug('[Cloudflare] Skipping sync: Organization not registered');
        return;
      }

      if (!orgInfo.tunnelId) {
        this.logger.warn(
          `[Cloudflare] Skipping sync: Organization ${orgInfo.id} exists but has no tunnelId. Please complete device registration to provision tunnel.`,
        );
        return;
      }

      const apps = await this.appRepository.getApps();
      const userSettings = this.config.getConfig().userSettings;
      const localDomain = userSettings.localDomain || 'tipi.lan';

      const exposedApps: AppInfo[] = apps
        .filter((app) => {
          return app.exposedLocal && app.status === 'running' && app.port !== null;
        })
        .map((app) => {
          // Construct URN for this app
          const _appUrn = createAppUrn(app.appName, app.appStoreSlug);
          const subdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;

          // For exposedLocal apps, they go through Traefik on port 80
          // Traefik routes based on Host header matching: ${subdomain}.${LOCAL_DOMAIN}
          // So we need to send the LOCAL_DOMAIN hostname, not the public domain
          const traefikHostname = `${subdomain}.${localDomain}`;

          return {
            name: app.appName,
            subdomain: subdomain,
            localPort: 80, // Traefik port - Traefik routes to the app based on Host header
            protocol: 'http' as const,
            hostname: 'host.docker.internal', // Always use host.docker.internal to reach Traefik
            originServerName: traefikHostname, // This sets the Host header that Traefik expects
            // Don't set publicHostname - let CI-Cloud construct it from subdomain + org slug
            // This ensures consistent format without device subdomain contamination
          };
        });

      // Don't add Dashboard here - it's already registered during device registration
      // Adding it here would overwrite the Hub's domain (devicename-orgname.ci.computer)
      // The Dashboard/Hub is accessible at the device subdomain registered during setup

      await this.cloudflareClientService.syncState(orgInfo.id, exposedApps, orgInfo.tunnelId || undefined);
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`[Cloudflare] Sync failed: ${error.message}`);
      } else {
        this.logger.error(`[Cloudflare] Sync failed: ${String(error)}`);
      }
    }
  }

  public async updateApp(params: { appUrn: AppUrn; performBackup: boolean }) {
    const { appUrn, performBackup } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    const version = this.config.get('version');

    const { minTipiVersion } = await this.marketplaceService.getAppUpdateInfo(appUrn);
    if (minTipiVersion && semver.valid(version) && semver.lt(version, minTipiVersion)) {
      throw new TranslatableError('APP_UPDATE_ERROR_MIN_TIPI_VERSION', { id: appUrn, minVersion: minTipiVersion });
    }

    await this.appRepository.updateAppById(app.id, { status: 'updating' });

    const appStatusBeforeUpdate = app.status;
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'updating' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue.publish({ command: 'update', appUrn, requestId, form: app.config, performBackup }).then(async ({ success, message }) => {
      if (success) {
        const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);

        await this.updateAppConfig({ appUrn, form: app.config });
        await this.appRepository.updateAppById(app.id, { version: appInfo?.tipi_version });
        this.sseService.emit('app', { event: 'update_success', appUrn });

        if (appStatusBeforeUpdate === 'running') {
          this.startApp({ appUrn });
        } else {
          await this.appRepository.updateAppById(app.id, { status: appStatusBeforeUpdate });
        }
      } else {
        this.logger.error(`Failed to update app ${appUrn}: ${message}`);
        this.sseService.emit('app', { event: 'update_error', appUrn, error: message });
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });
      }
    });

    return { requestId };
  }

  async updateAllApps() {
    const installedApps = await this.appsService.getInstalledApps();
    const availableUpdates = installedApps.filter(
      ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
    );

    for (const { app } of availableUpdates) {
      try {
        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
        await this.updateApp({ appUrn, performBackup: true });
      } catch (e) {
        this.logger.error(`Failed to update app ${app.id}`, e);
      }
    }
  }

  async restartRunningApps() {
    const apps = await this.appRepository.getApps();
    const runningApps = apps.filter((app) => app.status === 'running');

    (async () => {
      for (const app of runningApps) {
        try {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          await this.startApp({ appUrn, skipPull: true });
        } catch (e) {
          this.logger.error(`Failed to start app ${app.id}`, e);
        }
      }
    })();
  }

  async startAllApps() {
    const apps = await this.appRepository.getApps();
    const stoppedApps = apps.filter((app) => app.status === 'stopped');

    (async () => {
      for (const app of stoppedApps) {
        try {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          await this.startApp({ appUrn, skipPull: true });
        } catch (e) {
          this.logger.error(`Failed to start app ${app.id}`, e);
        }
      }
    })();
  }

  async stopAllApps() {
    const apps = await this.appRepository.getApps();
    const runningApps = apps.filter((app) => app.status === 'running');

    (async () => {
      for (const app of runningApps) {
        try {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          await this.stopApp({ appUrn });
        } catch (e) {
          this.logger.error(`Failed to stop app ${app.id}`, e);
        }
      }
    })();
  }

  async restartAllApps() {
    const apps = await this.appRepository.getApps();
    const runningApps = apps.filter((app) => app.status === 'running');

    (async () => {
      for (const app of runningApps) {
        try {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          await this.restartApp({ appUrn });
        } catch (e) {
          this.logger.error(`Failed to restart app ${app.id}`, e);
        }
      }
    })();
  }
}
