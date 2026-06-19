import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { HttpStatus, Inject, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity } from '@ci-hub/common/types';
import validator from 'validator';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppRuntimeMonitorService } from '../apps/app-runtime-monitor.service';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { InstallPipelineTracker } from '../apps/install-pipeline.tracker';
import { BackupManager } from '../backups/backup.manager';
import { CloudflareClientService, AppInfo } from '../cloudflare/cloudflare-client.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { ImageSizeService } from '../marketplace/image-size.service';
import { RegistrationService } from '../registration/registration.service';
import { ReposHelpers } from '../app-stores/repos.helpers';
import { AppStoreService } from '../app-stores/app-store.service';
import { AppEventsQueue, appEventResultSchema, appEventSchema } from '../queue/entities/app-events';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { appFormSchema } from './dto/app-lifecycle.dto';
import { INSTALL_PIPELINE_MUTEX_KEY } from '@/common/constants';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import type { AsyncMutex } from '@/utils/mutex/async-mutex';
import type { z } from 'zod';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { ErrorReportingService, type AppFailurePhase } from '@/core/error-reporting/error-reporting.service';
import { publishesHostPort } from '../apps/app-exposure.helpers';
import { DockerService } from '../docker/docker.service';

type AppFormForSubdomain = Pick<z.infer<typeof appFormSchema>, 'exposedLocal' | 'exposureMode' | 'localSubdomain'>;
type ParsedAppForm = z.infer<typeof appFormSchema>;

/** Trimmed subdomain when Cloudflare routing requires it to be globally unique on this Hub. */
function uniqueRoutingLocalSubdomain(parsedForm: AppFormForSubdomain): string | undefined {
  const trimmed = parsedForm.localSubdomain?.trim();
  if (!trimmed) return undefined;
  if (parsedForm.exposedLocal || parsedForm.exposureMode === 'cloudflare') {
    return trimmed;
  }
  return undefined;
}

function normalizeLocalOpenPort(parsedForm: ParsedAppForm): ParsedAppForm {
  if ((parsedForm.exposureMode ?? 'local') === 'local' && !parsedForm.openPort) {
    return { ...parsedForm, openPort: true };
  }

  return parsedForm;
}

/** Apply the same schema defaults/normalization used on save so unchanged configs compare equal. */
function normalizeConfigForCompare(raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = appFormSchema.safeParse(raw);
  if (!parsed.success) {
    return raw;
  }
  return normalizeLocalOpenPort(parsed.data) as Record<string, unknown>;
}

function buildPublicHostname(params: { appSubdomain: string; hubSubdomain?: string | null; orgSlug?: string | null; publicDomainRoot: string }) {
  return buildPublicWebIdentity({
    appSubdomain: params.appSubdomain,
    hubSubdomain: params.hubSubdomain,
    orgSlug: params.orgSlug,
    publicDomainRoot: params.publicDomainRoot,
  }).hostname;
}

@Injectable()
export class AppLifecycleService implements OnApplicationBootstrap {
  constructor(
    private readonly logger: LoggerService,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly commandFactory: AppLifecycleCommandFactory,
    private readonly appRepository: AppsRepository,
    private readonly config: ConfigurationService,
    private readonly marketplaceService: MarketplaceService,
    private readonly imageSizeService: ImageSizeService,
    private readonly appsService: AppsService,
    private readonly appRuntimeMonitor: AppRuntimeMonitorService,
    private readonly appFilesManager: AppFilesManager,
    private readonly dockerService: DockerService,
    private readonly sseService: SSEService,
    private readonly backupManager: BackupManager,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly registrationService: RegistrationService,
    private readonly repoHelpers: ReposHelpers,
    private readonly appStoreService: AppStoreService,
    private readonly moduleRef: ModuleRef,
    @Inject(APP_ASYNC_MUTEX) private mutex: AsyncMutex,
    private readonly installPipelineTracker: InstallPipelineTracker,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
    @Optional() private readonly errorReportingService?: ErrorReportingService,
  ) {
    this.logger.debug('Subscribing to app events...');
    this.appEventsQueue.onEvent((data, reply) => this.invokeCommand(data, reply));
  }

  async onApplicationBootstrap() {
    this.logger.info('Triggering initial Cloudflare sync in 5s...');
    setTimeout(() => {
      this.syncExposure().catch((e) => this.logger.error(`Startup sync failed: ${e.message}`));
    }, 5000);

    // Regenerate Traefik file-based config on startup to sync existing running apps
    // TODO(#244): revisit on next Traefik upgrade
    // This is a workaround for Traefik Docker provider API version incompatibility
    this.logger.info('Regenerating Traefik file-based configuration on startup...');
    setTimeout(async () => {
      try {
        const { TraefikConfigService } = await import('../docker/traefik-config.service');
        // Use moduleRef to get the service (lazily to avoid circular dependency)
        const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });
        if (traefikConfigService) {
          await traefikConfigService.generateTraefikConfig();
          this.logger.info('Traefik file-based configuration regenerated on startup');
        }
      } catch (e) {
        this.logger.error(`Failed to regenerate Traefik config on startup: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 10000); // Wait 10s for all services to be ready
  }

  private async emitInstallQueueUpdate() {
    const queue = await this.appsService.getInstallQueueState();
    this.sseService.emit('app', { event: 'install_queue', active: queue.active, queued: queue.queued });
  }

  /**
   * Last-resort handler for the fire-and-forget app command completion
   * callbacks. These run detached from any request, so an unhandled rejection
   * inside one (e.g. a failed status write) would otherwise crash the whole
   * process. Logging here keeps the Hub alive and degrades gracefully.
   */
  private logLifecycleHandlerError(command: string, appUrn: string, err: unknown) {
    this.logger.error(
      `[lifecycle] Unhandled error in '${command}' completion handler for ${appUrn}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  /** Fire-and-forget follow-up lifecycle action with a local rejection handler. */
  private fireAndForgetLifecycle(command: string, appUrn: AppUrn, action: () => Promise<unknown>) {
    void action().catch((err) => this.logLifecycleHandlerError(command, appUrn, err));
  }

  async invokeCommand(data: z.infer<typeof appEventSchema>, reply: (response: z.output<typeof appEventResultSchema>) => Promise<void>) {
    // Serialize installs so a second "Install" cannot compete with an in-progress image pull.
    let releasePipeline: (() => void) | undefined;
    const isInstall = data.command === 'install';
    if (isInstall) {
      releasePipeline = await this.mutex.acquire(INSTALL_PIPELINE_MUTEX_KEY);
      this.installPipelineTracker.setActive(data.appUrn);
      void this.emitInstallQueueUpdate();
    }

    const release = await this.mutex.acquire(data.appUrn);

    try {
      const command = this.commandFactory.createCommand(data);
      const { success, message } = await command.execute(data.appUrn, data.form);

      if (success) {
        this.logger.debug('Command executed successfully, triggering Cloudflare sync...');
        // Trigger sync to ensure cloud state matches local state (exposed apps)
        await this.syncExposure();
      }

      await reply({ success, message });
    } catch (err) {
      this.logger.error('Error invoking command:', err);
      await reply({ success: false, message: String(err) });
    } finally {
      release();
      if (isInstall) {
        this.installPipelineTracker.setActive(null);
        releasePipeline?.();
        void this.emitInstallQueueUpdate();
      }
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
    this.appEventsQueue
      .publish({ appUrn, command: 'start', requestId, form: { ...app.config, skipPull } })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} started successfully`);
          await this.appRepository.updateAppById(app.id, { status: 'running', pendingRestart: false });
          this.sseService.emit('app', { event: 'start_success', appUrn, appStatus: 'running' });

          // Check if we need to sync Cloudflare state (if app is exposedLocal and production)
          const { isProduction: isProdEnv } = this.config.getConfig();
          if (isProdEnv && app.exposedLocal) {
            this.logger.info(`[Cloudflare] App ${appUrn} started and is exposedLocal. Triggering sync.`);
            await this.syncExposure();
          }
        } else {
          this.logger.error(`Failed to start app ${appUrn}: ${message}`);
          await this.appRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'start_error', appUrn, appStatus: 'stopped', error: message });
          this.agentNotifyService?.notify('start_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'start', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('start', appUrn, err));

    return { requestId };
  }

  async installApp(params: { appUrn: AppUrn; form: unknown; skipRun?: boolean }) {
    const { appUrn, form, skipRun } = params;
    const { demoMode, architecture } = this.config.getConfig();

    // Check if we need to download files from CI Cloud
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const store = await this.appStoreService.getAppStoreBySlug(appStoreId);

    if (store && store.type === 'ci_cloud_api') {
      try {
        const result = await this.repoHelpers.downloadAppFiles(store.url, store.slug, appName);
        if (!result.success) {
          throw new Error(result.message);
        }
      } catch (error) {
        this.sseService.emit('app', {
          event: 'install_error',
          appUrn,
          appStatus: 'uninstalled',
          error: error instanceof Error ? error.message : String(error),
        });
        this.agentNotifyService?.notify('install_error', { appUrn }, 'high');
        this.reportAppFailure(appUrn, 'install', error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    const existingApp = await this.appRepository.getAppByUrn(appUrn);

    const parsedFormResult = appFormSchema.safeParse(form);
    if (!parsedFormResult.success) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedFormResult.error });
    }
    const parsedForm = normalizeLocalOpenPort(parsedFormResult.data);

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

    // Defense-in-depth beyond the declared `supported_architectures`: inspect
    // the actual image manifests so an image that doesn't publish the host
    // architecture fails here with a clear error, instead of a cryptic
    // "no matching manifest for linux/arm64/v8" mid-pull that previously
    // cascaded into an install_failed crash. Best-effort: a null result
    // (registry/network couldn't be inspected) does not block the install.
    const archCheck = await this.imageSizeService.verifyAppArchitecture(appUrn, architecture);
    if (archCheck && !archCheck.ok) {
      this.logger.warn(
        `App ${appUrn} image ${archCheck.image} does not publish a ${architecture} manifest (available: ${archCheck.available.join(', ') || 'none'})`,
      );
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
      parsedForm.publicDomain = undefined;
    }

    if (parsedForm.exposureMode !== 'cloudflare') {
      parsedForm.publicDomain = undefined;
    }

    if (appInfo.force_expose && !exposed) {
      throw new TranslatableError('APP_ERROR_APP_FORCE_EXPOSED', { id: appUrn });
    }

    const conflictsOtherApp = <T extends { id?: number }>(candidates: T[]) =>
      existingApp ? candidates.filter((candidate) => candidate.id !== existingApp.id) : candidates;

    if (exposed && domain) {
      const appsWithSameDomain = conflictsOtherApp(await this.appRepository.getAppsByDomain(domain));

      if (appsWithSameDomain.length > 0) {
        throw new TranslatableError('APP_ERROR_DOMAIN_ALREADY_IN_USE', { domain, id: appsWithSameDomain[0]?.appName });
      }
    }

    const routingSubdomain = uniqueRoutingLocalSubdomain(parsedForm);
    if (routingSubdomain) {
      const appsWithSameLocalSubdomain = conflictsOtherApp(await this.appRepository.getAppsByLocalSubdomain(routingSubdomain));

      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: routingSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    if (publishesHostPort(parsedForm) && port) {
      const appsWithSamePort = conflictsOtherApp(await this.appRepository.getAppsByPort(port));

      if (appsWithSamePort.length > 0) {
        throw new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: port.toString(), id: appsWithSamePort[0]?.appName });
      }
    }

    if (existingApp && existingApp.status !== 'install_failed') {
      await this.appRepository.updateAppById(existingApp.id, { config: parsedForm, ...parsedForm });
      return this.startApp({ appUrn });
    }

    // min_hub_version enforcement intentionally disabled until Hub semver stabilizes (post-Runtipi migration).
    const installRecord =
      existingApp ??
      (await this.appRepository.createApp({
        appName,
        status: 'installing' as const,
        config: parsedForm,
        // Port semantics:
        // - Local exposure always publishes the host port (normalized to openPort=true when needed).
        // - Cloudflare/Tailscale with exposedLocal also publish the host port for LAN access during DNS propagation.
        // - Traefik routing uses params.internalPort from the service definition, not this database field.
        port: parsedForm.port ?? appInfo.port,
        version: appInfo.cihub_app_version,
        exposed: exposed ?? false,
        domain: domain ?? null,
        localSubdomain: parsedForm.localSubdomain ?? null,
        publicDomain: parsedForm.publicDomain ?? null,
        openPort: openPort ?? false,
        exposedLocal: exposedLocal ?? !!appInfo.exposable,
        exposureMode: parsedForm.exposureMode ?? 'local',
        appStoreSlug: appStoreId,
        isVisibleOnGuestDashboard,
        enableAuth: enableAuth ?? false,
      }));

    if (existingApp) {
      await this.appRepository.updateAppById(existingApp.id, {
        status: 'installing',
        config: parsedForm,
        port: parsedForm.port ?? existingApp.port ?? appInfo.port,
        version: appInfo.cihub_app_version,
        exposed: exposed ?? false,
        domain: domain ?? null,
        localSubdomain: parsedForm.localSubdomain ?? null,
        publicDomain: parsedForm.publicDomain ?? null,
        openPort: openPort ?? false,
        exposedLocal: exposedLocal ?? !!appInfo.exposable,
        exposureMode: parsedForm.exposureMode ?? 'local',
        isVisibleOnGuestDashboard,
        enableAuth: enableAuth ?? false,
      });
    }

    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing' });
    void this.emitInstallQueueUpdate();

    const requestId = crypto.randomUUID();
    const appId = installRecord.id;
    const recordExposedLocal = exposedLocal ?? existingApp?.exposedLocal ?? !!appInfo.exposable;

    this.appEventsQueue
      .publish({ appUrn, command: 'install', requestId, form: { ...parsedForm, skipRun } })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} installed successfully`);
          const latest = await this.appRepository.getAppById(appId);
          if (latest?.status === 'installing') {
            await this.appRepository.updateAppById(appId, { status: 'running' });
            this.sseService.emit('app', { event: 'install_success', appUrn, appStatus: 'running' });
          }
          void this.emitInstallQueueUpdate();

          if (recordExposedLocal || (appInfo.exposable && !exposedLocal)) {
            await this.syncExposure();
          }
        } else {
          const isRpcTimeout = /timed out|RPC_TIMEOUT/i.test(message);
          if (isRpcTimeout) {
            this.logger.warn(
              `Install RPC timed out for ${appUrn}; the worker may still be pulling images or starting containers. Keeping the app in 'installing' until the worker finishes.`,
            );
            return;
          }

          this.logger.error(`Failed to install app ${appUrn}: ${message}`);
          // Guard the status write specifically: if the DB rejects the
          // 'install_failed' enum (e.g. a migration hasn't applied yet), we must
          // still surface the failure over SSE instead of crashing the process.
          try {
            await this.appRepository.updateAppById(appId, { status: 'install_failed' });
          } catch (statusError) {
            this.logger.error(
              `Failed to persist 'install_failed' status for ${appUrn} (continuing without crashing): ${statusError instanceof Error ? statusError.message : String(statusError)}`,
            );
          }
          this.sseService.emit('app', { event: 'install_error', appUrn, appStatus: 'install_failed', error: message });
          void this.emitInstallQueueUpdate();
          this.agentNotifyService?.notify('install_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'install', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('install', appUrn, err));

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

    await this.appRepository.updateAppById(app.id, { status: 'stopping' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopping' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue
      .publish({ command: 'stop', appUrn, requestId, form: app.config })
      .then(async ({ success, message }) => {
        if (success) {
          await this.appRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'stop_success', appUrn, appStatus: 'stopped' });
          this.logger.info(`App ${appUrn} stopped successfully`);

          // Trigger sync to remove route if exposedLocal
          if (app.exposedLocal) {
            await this.syncExposure();
          }
        } else {
          this.logger.error(`Failed to stop app ${appUrn}: ${message}`);
          await this.appRepository.updateAppById(app.id, { status: 'running' });
          this.sseService.emit('app', { event: 'stop_error', appUrn, appStatus: 'running', error: message });
          this.agentNotifyService?.notify('stop_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'stop', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('stop', appUrn, err));

    return { requestId };
  }

  public async forceStopApp(params: { appUrn: AppUrn }) {
    const { appUrn } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    const runtimeHealth = await this.appRuntimeMonitor.getAppRuntimeHealth(appUrn);
    if (!runtimeHealth.forceStopEligible) {
      throw new TranslatableError('APP_FORCE_STOP_NOT_AVAILABLE', {}, HttpStatus.CONFLICT);
    }

    const release = await this.mutex.acquire(appUrn);
    const requestId = crypto.randomUUID();

    try {
      await this.appRepository.updateAppById(app.id, { status: 'stopping' });
      this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopping' });

      try {
        const result = await this.dockerService.forceStopApp(appUrn);
        await this.appRepository.updateAppById(app.id, { status: 'stopped' });
        this.sseService.emit('app', { event: 'stop_success', appUrn, appStatus: 'stopped' });
        this.logger.warn(`App ${appUrn} force-stopped successfully`, result);

        if (app.exposedLocal) {
          await this.syncExposure();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to force-stop app ${appUrn}: ${message}`);
        await this.appRepository.updateAppById(app.id, { status: app.status });
        this.sseService.emit('app', { event: 'stop_error', appUrn, appStatus: app.status, error: message });
        this.agentNotifyService?.notify('stop_error', { appUrn }, 'high');
        this.reportAppFailure(appUrn, 'stop', message);
        throw new TranslatableError('APP_ACTION_FAILED_TO_RESOLVE', { error: message }, HttpStatus.INTERNAL_SERVER_ERROR);
      }
    } finally {
      release();
    }

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

    await this.appRepository.updateAppById(app.id, { status: 'restarting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'restarting' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue
      .publish({ command: 'restart', appUrn, requestId, form: { ...app.config, skipPull } })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} restarted successfully`);
          await this.appRepository.updateAppById(app.id, { status: 'running', pendingRestart: false });
          this.sseService.emit('app', { event: 'restart_success', appUrn, appStatus: 'running' });
        } else {
          this.logger.error(`Failed to restart app ${appUrn}: ${message}`);
          await this.appRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'restart_error', appUrn, appStatus: 'stopped', error: message });
          this.agentNotifyService?.notify('restart_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'restart', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('restart', appUrn, err));

    return { requestId };
  }

  /**
   * Uninstall an app by its ID
   */
  public async uninstallApp(params: { appUrn: AppUrn; deleteAllData: boolean }) {
    const { appUrn, deleteAllData } = params;

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    // Backups are always removed on uninstall (not exposed in the UI; independent of deleteAllData).
    await this.backupManager.deleteAppBackupsByUrn(appUrn);

    await this.appRepository.updateAppById(app.id, { status: 'uninstalling' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'uninstalling' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue
      .publish({ command: 'uninstall', appUrn, requestId, form: app.config, deleteAllData })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} uninstalled successfully`);
          await this.appRepository.deleteAppById(app.id);
          this.sseService.emit('app', { event: 'uninstall_success', appUrn, appStatus: 'missing' });

          // Trigger sync to remove route if it was exposedLocal
          if (app.exposedLocal) {
            await this.syncExposure();
          }
        } else {
          this.logger.error(`Failed to uninstall app ${appUrn}: ${message}`);
          await this.appRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'uninstall_error', appUrn, appStatus: 'stopped', error: message });
          this.agentNotifyService?.notify('uninstall_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'uninstall', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('uninstall', appUrn, err));

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
    await this.appRepository.updateAppById(app.id, { status: 'resetting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'resetting' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue
      .publish({ command: 'reset', appUrn, requestId, form: app.config })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} reset successfully`);
          await this.appRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'reset_success', appUrn, appStatus: 'stopped' });

          if (appStatusBeforeReset === 'running') {
            this.fireAndForgetLifecycle('start-after-reset', appUrn, () => this.startApp({ appUrn }));
          }
        } else {
          this.logger.error(`Failed to reset app ${appUrn}: ${message}`);
          const restoredStatus = appStatusBeforeReset ?? 'stopped';
          await this.appRepository.updateAppById(app.id, { status: restoredStatus });
          this.sseService.emit('app', { event: 'reset_error', appUrn, appStatus: restoredStatus, error: message });
          this.agentNotifyService?.notify('reset_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'reset', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('reset', appUrn, err));

    return { requestId };
  }

  public async updateAppConfig(params: { appUrn: AppUrn; form: unknown }) {
    const { appUrn, form } = params;

    const parsedFormResult = appFormSchema.safeParse(form);

    if (!parsedFormResult.success) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedFormResult.error });
    }
    const parsedForm = normalizeLocalOpenPort(parsedFormResult.data);

    const { exposed, domain, exposedLocal, enableAuth, port } = parsedForm;

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

    const settingsChanged = this.hasConfigChanged(
      normalizeConfigForCompare((app.config ?? {}) as Record<string, unknown>),
      parsedForm as Record<string, unknown>,
    );
    if (!settingsChanged) {
      this.logger.debug(`App ${appUrn} config update skipped — no changes detected`);
      return { requestId: crypto.randomUUID() };
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
      parsedForm.publicDomain = undefined;
    }

    if (parsedForm.exposureMode !== 'cloudflare') {
      parsedForm.publicDomain = undefined;
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

    const routingSubdomain = uniqueRoutingLocalSubdomain(parsedForm);
    if (routingSubdomain) {
      const appsWithSameLocalSubdomain = await this.appRepository.getAppsByLocalSubdomain(routingSubdomain, app.id);

      if (appsWithSameLocalSubdomain.length > 0) {
        throw new TranslatableError('APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE', {
          subdomain: routingSubdomain,
          id: appsWithSameLocalSubdomain[0]?.appName,
        });
      }
    }

    if (publishesHostPort(parsedForm) && port) {
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
      exposureMode: parsedForm.exposureMode ?? 'local',
      openPort: parsedForm.openPort,
      port: parsedForm.port ?? appInfo.port,
      domain: domain ?? null,
      localSubdomain: parsedForm.localSubdomain ?? null,
      publicDomain: parsedForm.publicDomain ?? null,
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
      await this.appRepository.updateAppById(app.id, { pendingRestart: settingsChanged });
    }

    // Sync state with Cloudflare whenever exposedLocal is enabled or changed
    this.logger.info(`[Cloudflare] Config updated for ${appUrn}. Triggering state sync.`);
    await this.syncExposure();

    // If the app is currently running, automatically restart it so the new
    // environment variables take effect immediately. The restart is fire-and-
    // forget — the config write has already succeeded at this point.
    const runningStatuses = ['running', 'starting', 'restarting'] as const;
    if (runningStatuses.includes(app.status as (typeof runningStatuses)[number])) {
      this.logger.info(`App ${appUrn} is running — triggering automatic restart after config update`);
      this.fireAndForgetLifecycle('restart-after-config-update', appUrn, () => this.restartApp({ appUrn, skipPull: true }));
    }

    return { requestId };
  }

  /**
   * Sync exposure state for all apps — Cloudflare + Tailscale in parallel
   */
  private async syncExposure() {
    await Promise.allSettled([this.triggerCloudflareSync(), this.triggerTailscaleSync()]);
  }

  /**
   * Public wrapper for syncExposure — used by AppsService.resolveAppAvailability
   */
  public async syncExposurePublic() {
    return this.syncExposure();
  }

  /**
   * Sync Tailscale Serve state for apps with exposureMode='tailscale'
   */
  private async triggerTailscaleSync() {
    try {
      const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
      if (!tailscaleService) return;

      const status = await tailscaleService.getStatus().catch(() => null);
      if (!status?.connected) return;

      const apps = await this.appRepository.getApps();

      // Apps that should be Tailscale-served
      const shouldServe = apps.filter(
        (app) => (app as Record<string, unknown>).exposureMode === 'tailscale' && ['running', 'starting', 'restarting'].includes(app.status),
      );

      const serveStatus = await tailscaleService.getServeStatus();
      const desiredPorts = new Map<
        number,
        {
          appName: string;
          appUrn: AppUrn;
          port: number;
          upstreamUrl: string;
        }
      >();

      for (const app of shouldServe) {
        if (!app.port) {
          this.logger.error(`[Tailscale] Skipping ${app.appName}:${app.appStoreSlug}: missing app port for Private VPN publishing`);
          continue;
        }

        const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;
        const target = await this.dockerService.getAppNetworkTarget(appUrn);

        if (!target) {
          this.logger.error(`[Tailscale] Skipping ${appUrn}: no running network target found for Private VPN publishing`);
          continue;
        }

        desiredPorts.set(app.port, {
          appName: app.localSubdomain || app.appName,
          appUrn,
          port: app.port,
          upstreamUrl: target.url,
        });
      }

      const currentlyServedByPort = new Map(
        serveStatus.entries.filter((entry) => entry.listenPort).map((entry) => [entry.listenPort as number, entry]),
      );

      for (const desired of desiredPorts.values()) {
        const currentEntry = currentlyServedByPort.get(desired.port);
        if (!currentEntry || currentEntry.dest !== desired.upstreamUrl || currentEntry.mountPoint !== '/') {
          await tailscaleService
            .serveApp({
              appName: desired.appName,
              httpsPort: desired.port,
              upstreamUrl: desired.upstreamUrl,
            })
            .catch((e) => this.logger.error(`[Tailscale] Failed to serve ${desired.appName} on :${desired.port}: ${e}`));
        }
      }

      for (const served of serveStatus.entries) {
        if (served.rawServiceName) {
          await tailscaleService
            .clearService(served.rawServiceName)
            .catch((e) => this.logger.error(`[Tailscale] Failed to clear ${served.rawServiceName}: ${e}`));
          continue;
        }

        const listenPort = served.listenPort;
        if (!listenPort || desiredPorts.has(listenPort)) {
          continue;
        }

        await tailscaleService.unservePort(listenPort).catch((e) => this.logger.error(`[Tailscale] Failed to unserve :${listenPort}: ${e}`));
      }

      this.logger.debug(`[Tailscale] Sync complete: ${desiredPorts.size} apps served`);
    } catch (error) {
      this.logger.error(`[Tailscale] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Triggers a full sync of all exposed apps to Cloudflare via CI-Cloud
   */
  private lastPublicDnsFailureReportAt = 0;
  private readonly lastPublicDnsToastAt = new Map<string, number>();
  private static readonly PUBLIC_DNS_FAILURE_COOLDOWN_MS = 5 * 60_000;

  /**
   * Surface a public-DNS sync failure so it is never silent: always logs an
   * error, reports to Sentry, and emits a per-app SSE event the frontend turns
   * into a toast. Sentry and toasts are cooldown-guarded to avoid flooding when
   * availability remediation re-triggers the sync for a still-broken app.
   */
  private surfacePublicDnsFailure(message: string, failedAppNames: string[], toastTargets: Array<{ appUrn: AppUrn; hostname: string }> = []): void {
    this.logger.error(message);

    const now = Date.now();
    if (now - this.lastPublicDnsFailureReportAt >= AppLifecycleService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
      this.lastPublicDnsFailureReportAt = now;
      this.errorReportingService?.captureMessage(message, 'error', { failedApps: failedAppNames });
    }

    for (const target of toastTargets) {
      const lastToast = this.lastPublicDnsToastAt.get(target.appUrn) ?? 0;
      if (now - lastToast < AppLifecycleService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
        continue;
      }
      this.lastPublicDnsToastAt.set(target.appUrn, now);
      this.sseService.emit('app', { event: 'public_dns_error', appUrn: target.appUrn, error: target.hostname }, target.appUrn);
    }
  }

  public async triggerCloudflareSync() {
    try {
      const orgInfo = await this.registrationService.getDeviceRegistrationInfo();

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
      const defaultPublicDomain = userSettings.domain || this.config.getConfig().domain;
      const localDomain = userSettings.localDomain || this.config.getConfig().localDomain;

      type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];

      const exposedApps: AppInfo[] = await Promise.all(
        apps
          .filter((app: AppFromDb) => {
            return app.exposedLocal && ['running', 'starting', 'restarting'].includes(app.status) && app.localSubdomain;
          })
          .map(async (app: AppFromDb) => {
            const subdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;
            const appPublicDomain = app.publicDomain || defaultPublicDomain;
            return {
              name: app.appName,
              subdomain,
              publicDomain: appPublicDomain,
              localPort: 80,
              protocol: 'http' as const,
              hostname: 'traefik',
              originServerName: buildOriginServerName({
                appSubdomain: subdomain,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                localDomain,
              }),
            };
          }),
      );

      // Include the Hub in every sync so CI-Cloud preserves its tunnel route.
      // `hubSubdomain` (from device_registration) is the canonical source for Hub route identity.
      // Do NOT use `DOMAIN` / `userSettings.domain` to derive the Hub subdomain — DOMAIN is the
      // root domain for app hostname construction, not the Hub prefix.
      // When hubSubdomain is null (e.g. pre-migration records), the Hub entry is omitted from sync.
      const hubSub = orgInfo.hubSubdomain;
      if (hubSub && defaultPublicDomain) {
        const orgSlug = orgInfo.slug;
        const orgSuffix = `-${orgSlug}`;
        const deviceName = hubSub.endsWith(orgSuffix) ? hubSub.slice(0, -orgSuffix.length) : hubSub;
        const hubHostname = `${hubSub}.${defaultPublicDomain}`;

        exposedApps.unshift({
          name: 'OS Hub',
          subdomain: deviceName,
          publicDomain: defaultPublicDomain,
          localPort: 80,
          protocol: 'http' as const,
          hostname: 'traefik',
          originServerName: hubHostname,
          privilegedKind: 'hub',
        });
      }

      const result = await this.cloudflareClientService.syncState(orgInfo.id, exposedApps, orgInfo.tunnelId || undefined);

      const appEntries = exposedApps.filter((entry) => entry.privilegedKind !== 'hub');

      if (!result.ok) {
        // A full sync failure means none of the exposed apps were updated, so
        // raise a per-app toast for every exposed app — not only the partial
        // per-app failures handled below. Without this, full failures (e.g.
        // CI-Cloud unreachable / non-success response) would be silent in the
        // UI. Cooldowns in surfacePublicDnsFailure prevent flooding on repeated
        // syncs.
        const toastTargets = appEntries
          .map((entry) => {
            const dbApp = apps.find((candidate: AppFromDb) => candidate.appName === entry.name);
            if (!dbApp) {
              return null;
            }
            return {
              appUrn: `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn,
              hostname: buildPublicHostname({
                appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
              }),
            };
          })
          .filter((target): target is { appUrn: AppUrn; hostname: string } => target !== null);
        this.surfacePublicDnsFailure(
          `[Cloudflare] State sync did not complete — public DNS was not updated for ${appEntries.length} exposed app(s).`,
          appEntries.map((entry) => entry.name),
          toastTargets,
        );
      } else if (result.failed.length > 0) {
        // Map CI-Cloud's failed app names back to their URN + hostname so the
        // frontend can raise a per-app toast (privileged Hub entry excluded).
        const toastTargets = result.failed
          .map((name) => {
            const dbApp = apps.find((candidate: AppFromDb) => candidate.appName === name);
            const entry = exposedApps.find((candidate) => candidate.name === name && candidate.privilegedKind !== 'hub');
            if (!dbApp || !entry) {
              return null;
            }
            return {
              appUrn: `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn,
              hostname: buildPublicHostname({
                appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
              }),
            };
          })
          .filter((target): target is { appUrn: AppUrn; hostname: string } => target !== null);
        const failedHostnames = toastTargets.map((target) => target.hostname);
        this.surfacePublicDnsFailure(
          `[Cloudflare] Public DNS records were NOT created for ${result.failed.length} app(s): ${(failedHostnames.length > 0 ? failedHostnames : result.failed).join(', ')}. ` +
            `These apps will not resolve at their public domain — verify the selected domain's zone is provisioned in CI-Cloud for this device.`,
          result.failed,
          toastTargets,
        );
      } else if (appEntries.length > 0) {
        // Only log success once the sync fully completed (ok and no per-app
        // failures); otherwise the failure branches above own the messaging.
        this.logger.info(
          `[Cloudflare] Public hostnames synced: ${appEntries
            .map(
              (entry) =>
                `${entry.name} -> ${buildPublicHostname({
                  appSubdomain: entry.subdomain,
                  hubSubdomain: orgInfo.hubSubdomain,
                  orgSlug: orgInfo.slug,
                  publicDomainRoot: entry.publicDomain || defaultPublicDomain,
                })}`,
            )
            .join(', ')}`,
        );
      }
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

    // min_hub_version enforcement intentionally disabled until Hub semver stabilizes (post-Runtipi migration).

    await this.appRepository.updateAppById(app.id, { status: 'updating' });

    const appStatusBeforeUpdate = app.status;
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'updating' });

    const requestId = crypto.randomUUID();
    this.appEventsQueue
      .publish({ command: 'update', appUrn, requestId, form: app.config, performBackup })
      .then(async ({ success, message }) => {
        if (success) {
          const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);
          const restoredStatus = appStatusBeforeUpdate === 'running' ? 'stopped' : appStatusBeforeUpdate;

          await this.updateAppConfig({ appUrn, form: app.config });
          await this.appRepository.updateAppById(app.id, { version: appInfo?.cihub_app_version, status: restoredStatus });
          this.sseService.emit('app', { event: 'update_success', appUrn, appStatus: restoredStatus });
          this.agentNotifyService?.notify('update_success', { appUrn }, 'info');

          if (appStatusBeforeUpdate === 'running') {
            this.fireAndForgetLifecycle('start-after-update', appUrn, () => this.startApp({ appUrn }));
          }
        } else {
          this.logger.error(`Failed to update app ${appUrn}: ${message}`);
          const restoredStatus = appStatusBeforeUpdate === 'running' ? 'stopped' : appStatusBeforeUpdate;
          await this.appRepository.updateAppById(app.id, { status: restoredStatus });
          this.sseService.emit('app', { event: 'update_error', appUrn, appStatus: restoredStatus, error: message });
          this.agentNotifyService?.notify('update_error', { appUrn }, 'high');
          this.reportAppFailure(appUrn, 'update', message);
        }
      })
      .catch((err) => this.logLifecycleHandlerError('update', appUrn, err));

    return { requestId };
  }

  async updateAllApps(): Promise<void> {
    const installedApps = await this.appsService.getInstalledApps();
    type InstalledApp = Awaited<ReturnType<typeof this.appsService.getInstalledApps>>[number];
    const availableUpdates: InstalledApp[] = installedApps.filter((item: InstalledApp) => {
      const { app, metadata } = item;
      return Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion;
    });

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
    type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];
    const runningApps = apps.filter((app: AppFromDb) => app.status === 'running');

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
    type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];
    const stoppedApps = apps.filter((app: AppFromDb) => app.status === 'stopped');

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
    type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];
    const runningApps = apps.filter((app: AppFromDb) => app.status === 'running');

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
    type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];
    const runningApps = apps.filter((app: AppFromDb) => app.status === 'running');

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

  /**
   * Restart every running app whose marketplace listing is categorized as "ai".
   * Called after inference preferences change so AI apps pick up the new
   * model/backend env. Fire-and-forget: restarts run in the background so the
   * caller (e.g. the preferences endpoint) isn't blocked.
   */
  async restartAiApps() {
    const apps = await this.appRepository.getApps();
    type AppFromDb = Awaited<ReturnType<typeof this.appRepository.getApps>>[number];
    const runningApps = apps.filter((app: AppFromDb) => app.status === 'running');

    await Promise.all(
      runningApps.map(async (app) => {
        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
        try {
          const info = await this.marketplaceService.getAppInfoFromAppStore(appUrn);
          if (!info?.categories?.includes('ai')) {
            return;
          }
          this.logger.info(`Restarting AI app ${appUrn} after inference preferences change`);
          return this.restartApp({ appUrn });
        } catch (e) {
          this.logger.error(`Failed to restart AI app ${app.id}`, e);
        }
      }),
    );
  }

  private reportAppFailure(appUrn: AppUrn, phase: AppFailurePhase, message: string): void {
    this.errorReportingService?.reportAppFailure({ appUrn, phase, message });
  }
}
