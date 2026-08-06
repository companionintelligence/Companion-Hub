import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import messages from '@ci-hub/common/i18n/translations/en.json';
import type { SSE } from '@ci-hub/common/schemas';
import { isPortExposeApp, manifestDefaultsEdgeAuthOn } from '@ci-hub/common/schemas';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { HttpStatus, Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import validator from 'validator';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppRuntimeMonitorService } from '../apps/app-runtime-monitor.service';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { InstallPipelineTracker } from '../apps/install-pipeline.tracker';
import { BackupManager } from '../backups/backup.manager';
import { TailscaleService } from '../tailscale/tailscale.service';
import { ExposureSyncService } from './exposure-sync.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { ImageSizeService } from '../marketplace/image-size.service';
import { ReposHelpers } from '../app-stores/repos.helpers';
import { AppStoreService } from '../app-stores/app-store.service';
import { AppEventsQueue, appEventResultSchema, appEventSchema } from '../queue/entities/app-events';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppOperationRegistry, type CancellabilityTier, type OperationCommand } from './app-operation-registry';
import type { AppStatus } from '@/core/database/drizzle/types';
import { toAppCommandFailureResult } from './commands/app-lifecycle-errors';
import type { CommandExecutionContext } from './commands/command';
import { appFormSchema } from './dto/app-lifecycle.dto';
import { INSTALL_PIPELINE_MUTEX_KEY } from '@/common/constants';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import type { AsyncMutex } from '@/utils/mutex/async-mutex';
import type { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { ErrorReportingService, type AppFailurePhase } from '@/core/error-reporting/error-reporting.service';
import { publishesHostPort } from '../apps/app-exposure.helpers';
import { didPublicRoutingIdentityChange, type AppPublicRoutingSnapshot } from '../apps/app-public-routing.helpers';
import { DockerService } from '../docker/docker.service';
import { AppIntentSyncService } from '../apps/app-intent-sync.service';
import { isMemoryProviderApp } from '../memory-connect/memory-provider.predicate';
import type { MemoryConnectService } from '../memory-connect/memory-connect.service';
import { validateAppFormFields } from '@ci-hub/common/validation';

type AppFormForSubdomain = Pick<z.infer<typeof appFormSchema>, 'exposedLocal' | 'exposureMode' | 'localSubdomain'>;
type ParsedAppForm = z.infer<typeof appFormSchema>;
type AppOutcomeSseEvent = Extract<Extract<SSE, { topic: 'app' }>['data'], { appUrn: string }>['event'];

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

@Injectable()
export class AppLifecycleService implements OnApplicationBootstrap, OnModuleDestroy {
  private static readonly TAILSCALE_READINESS_POLL_MS = 45_000;

  private tailscaleReadinessInterval: ReturnType<typeof setInterval> | null = null;
  private tailscaleReadinessInitialized = false;
  private lastTailscaleConnected = false;
  private lastTailscaleHttpsAvailable = false;

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
    private readonly exposureSyncService: ExposureSyncService,
    private readonly repoHelpers: ReposHelpers,
    private readonly appStoreService: AppStoreService,
    private readonly moduleRef: ModuleRef,
    @Inject(APP_ASYNC_MUTEX) private mutex: AsyncMutex,
    private readonly installPipelineTracker: InstallPipelineTracker,
    private readonly operationRegistry: AppOperationRegistry,
    @Optional() private readonly appIntentSyncService?: AppIntentSyncService,
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

    // After a Hub upgrade, inference-opted apps may still hold stale app.env from the
    // previous image. Once per version bump, refresh their env + recreate containers.
    setTimeout(() => {
      void this.syncInferenceAppsAfterHubUpgrade();
    }, 20_000);

    this.startTailscaleReadinessWatcher();
  }

  private async syncInferenceAppsAfterHubUpgrade(): Promise<void> {
    const prefs = this.config.getInferencePreferences();
    if (!prefs.preferredBackend) {
      return;
    }

    const hubVersion = this.config.get('version');
    const syncPath = path.join(DATA_DIR, 'state', 'inference-apps-synced-version');
    let lastSynced = '';
    try {
      lastSynced = (await fs.readFile(syncPath, 'utf8')).trim();
    } catch {
      // first boot or missing marker — treat as unsynced
    }

    if (lastSynced === hubVersion) {
      return;
    }

    this.logger.info(`[InferenceSync] Hub version ${hubVersion} (was ${lastSynced || 'none'}) — restarting inference-opted apps to refresh env`);
    await this.restartAiApps();
  }

  private async markInferenceAppsEnvSynced(): Promise<void> {
    const syncPath = path.join(DATA_DIR, 'state', 'inference-apps-synced-version');
    await fs.mkdir(path.dirname(syncPath), { recursive: true });
    await fs.writeFile(syncPath, this.config.get('version'), 'utf8');
  }

  onModuleDestroy() {
    if (this.tailscaleReadinessInterval) {
      clearInterval(this.tailscaleReadinessInterval);
      this.tailscaleReadinessInterval = null;
    }
  }

  private startTailscaleReadinessWatcher() {
    this.tailscaleReadinessInterval = setInterval(() => {
      void this.checkTailscaleReadinessTransition();
    }, AppLifecycleService.TAILSCALE_READINESS_POLL_MS);
  }

  /**
   * Re-publish Private VPN apps when Tailscale connects or HTTPS/Serve becomes
   * available on the tailnet (e.g. after admin enables certificates in the console).
   */
  private async checkTailscaleReadinessTransition() {
    const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
    if (!tailscaleService) {
      return;
    }

    const status = await tailscaleService.getStatus().catch(() => null);
    if (!status) {
      return;
    }

    const connected = status.connected;
    const httpsAvailable = status.httpsAvailable;

    if (!this.tailscaleReadinessInitialized) {
      this.tailscaleReadinessInitialized = true;
      this.lastTailscaleConnected = connected;
      this.lastTailscaleHttpsAvailable = httpsAvailable;
      return;
    }

    const becameConnected = !this.lastTailscaleConnected && connected;
    const becameHttpsReady = !this.lastTailscaleHttpsAvailable && httpsAvailable;
    this.lastTailscaleConnected = connected;
    this.lastTailscaleHttpsAvailable = httpsAvailable;

    if (connected && (becameConnected || becameHttpsReady)) {
      this.logger.info('[Tailscale] Readiness changed — re-syncing Private VPN exposure');
      await this.syncTailscaleExposurePublic();
    }
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
      // Only treat the registry entry as ours when its requestId matches this message. A stale queued
      // message dequeued after a newer op replaced the entry must NOT wire the newer op's AbortSignal
      // into this command or mutate the newer entry's phase.
      const registered = this.operationRegistry.get(data.appUrn);
      const entry = registered && registered.requestId === data.requestId ? registered : undefined;

      // Tier-A: the op was cancelled while queued (before this worker dequeued it). Skip execution
      // entirely and finalize the cancellation. No compose/pull ran, so there is nothing to compensate.
      if (entry && (entry.cancelRequestedWhileQueued || entry.abortController.signal.aborted)) {
        this.logger.info(`[lifecycle] '${data.command}' for ${data.appUrn} was cancelled while queued; skipping execution`);
        await this.handleCancelledResult(data.command, data.appUrn, {
          success: false,
          cancelled: true,
          message: 'Operation cancelled before it started',
        });
        await reply({ success: false, cancelled: true, message: 'Operation cancelled before it started' });
        this.operationRegistry.clear(data.appUrn, data.requestId);
        return;
      }

      // Build the cancellation context from our own registry entry so the cancel endpoint's abort()
      // reaches the running command and its docker spawns/pulls. Phase updates are requestId-gated.
      if (entry) {
        this.operationRegistry.markPhase(data.appUrn, 'preparing', data.requestId);
      }
      const ctx: CommandExecutionContext | undefined = entry
        ? {
            signal: entry.abortController.signal,
            setPhase: (phase) => this.operationRegistry.markPhase(data.appUrn, phase, data.requestId),
          }
        : undefined;

      const command = this.commandFactory.createCommand(data);
      // Only pass the context when there is one, so commands without cancellation see the original 2-arg call.
      const result = (await (ctx ? command.execute(data.appUrn, data.form, ctx) : command.execute(data.appUrn, data.form))) as z.output<
        typeof appEventResultSchema
      >;

      // Finalize the outcome worker-side so it does not depend on the RPC reply being delivered (the
      // publisher may have already timed out). Success is finalized inside the command
      // (markInstallSucceeded); here we cover cancellation and — crucially — failure, so an install
      // that fails AFTER its RPC timed out still reaches 'install_failed' instead of being stranded
      // in 'installing'.
      if (result.cancelled) {
        await this.handleCancelledResult(data.command, data.appUrn, result);
        this.operationRegistry.clear(data.appUrn, data.requestId);
      } else if (result.success) {
        this.logger.debug('Command executed successfully, triggering Cloudflare sync...');
        // Trigger sync to ensure cloud state matches local state (exposed apps)
        await this.syncExposure();
        // Install success is finalized worker-side (markInstallSucceeded); the publisher-side
        // handler only performs optional follow-up work.
        if (isInstall) {
          this.operationRegistry.clear(data.appUrn, data.requestId);
        }
      } else {
        await this.handleFailedResult(data.command, data.appUrn, result);
        if (isInstall) {
          this.operationRegistry.clear(data.appUrn, data.requestId);
        }
      }

      await reply(result);
    } catch (err) {
      this.logger.error('Error invoking command:', err);
      await reply(toAppCommandFailureResult(err));
    } finally {
      // Do not clear the operation registry here. The publisher-side completion handler
      // claims the entry via settleCommandOutcome/claimCompletion once the RPC reply is
      // delivered; clearing worker-side first would race that claim and strand apps in
      // transitional statuses (e.g. update -> start-after-update). Superseded handlers
      // still lose the claim when a newer op replaced the registry entry.
      release();
      if (isInstall) {
        this.installPipelineTracker.setActive(null);
        releasePipeline?.();
        void this.emitInstallQueueUpdate();
      }
    }
  }

  /**
   * Single authoritative finalization point for a cancelled operation. Runs worker-side from
   * {@link invokeCommand}. For `install` it removes the partially-created app record and emits an
   * `install_cancelled` SSE event so the UI returns to the not-installed (store) state. Other
   * commands are wired in later phases; until then this is a safe no-op for them.
   */
  private async handleCancelledResult(command: OperationCommand | string, appUrn: AppUrn, result: z.output<typeof appEventResultSchema>) {
    if (command === 'install') {
      const app = await this.appRepository.getAppByUrn(appUrn).catch(() => null);
      if (app) {
        try {
          await this.appRepository.deleteAppById(app.id);
        } catch (e) {
          this.logger.error(`Failed to delete cancelled install record for ${appUrn}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.logger.info(`[lifecycle] install of ${appUrn} cancelled${result.message ? `: ${result.message}` : ''}`);
      // Use 'missing' (not 'uninstalled') to match uninstall_success — both delete the app record.
      this.sseService.emit('app', { event: 'install_cancelled', appUrn, appStatus: 'missing' });
      void this.emitInstallQueueUpdate();
      return;
    }

    // Other commands report a cancelled-status resting state in later phases; nothing to do yet.
    this.logger.info(`[lifecycle] '${command}' for ${appUrn} cancelled (no finalization wired yet)`);
  }

  /**
   * Worker-side finalization for a FAILED operation. The install completion handler keeps the app in
   * 'installing' across an RPC timeout (image pulls can outlast the RPC) and trusts the worker to
   * finish — but the worker must then write the terminal status itself, otherwise a failure after the
   * timeout strands the app in 'installing' forever. Wired for `install` (the op with that
   * keep-installing-on-timeout behaviour); a no-op for other commands, which are finalized by their
   * own completion handlers. Idempotent via the status guard in {@link finalizeFailedInstall}.
   */
  private async handleFailedResult(command: OperationCommand | string, appUrn: AppUrn, result: z.output<typeof appEventResultSchema>) {
    if (command !== 'install') {
      return;
    }
    const app = await this.appRepository.getAppByUrn(appUrn).catch(() => null);
    // Worker path: invokeCommand's finally emits the install-queue update AFTER clearing the pipeline
    // tracker, so suppress it here to avoid a duplicate (and stale, pre-clear) install_queue event.
    await this.finalizeFailedInstall(app, appUrn, result, { emitQueueUpdate: false });
  }

  /**
   * Transition a failed install to `install_failed` and emit `install_error`, but ONLY while the app
   * is still `installing`. The status guard makes this safe to call from both the worker side
   * ({@link handleFailedResult}) and the publisher-side fallback (when the publish never reached a
   * worker) without ever double-finalizing. The status write is guarded so a missing enum migration
   * still surfaces the failure over SSE instead of crashing the process.
   *
   * @param emitQueueUpdate - Whether to emit an install-queue SSE update. The worker path passes
   *   `false` because invokeCommand's `finally` emits it after clearing the pipeline tracker (emitting
   *   here would produce a duplicate, stale event still showing the failed app as active); the
   *   publisher-side fallback passes `true` since it has no such `finally`.
   */
  private async finalizeFailedInstall(
    app: { id: number; status: string } | null | undefined,
    appUrn: AppUrn,
    result: z.output<typeof appEventResultSchema>,
    { emitQueueUpdate }: { emitQueueUpdate: boolean },
  ) {
    if (!app || app.status !== 'installing') {
      return;
    }
    this.logger.error(`Failed to install app ${appUrn}: ${result.message}`);
    try {
      await this.appRepository.updateAppById(app.id, { status: 'install_failed' });
    } catch (statusError) {
      this.logger.error(
        `Failed to persist 'install_failed' status for ${appUrn} (continuing without crashing): ${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
    }
    this.sseService.emit('app', {
      event: 'install_error',
      appUrn,
      appStatus: 'install_failed',
      error: result.message,
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
      settingsPath: result.settingsPath,
    });
    if (emitQueueUpdate) {
      void this.emitInstallQueueUpdate();
    }
    this.agentNotifyService?.notify('install_error', { appUrn }, 'high');
    this.reportAppFailure(appUrn, 'install', result.message);
  }

  /**
   * Request cancellation of the in-flight (or queued) operation for an app.
   *
   * Looks up the live registry entry and decides the outcome by cancellability tier and phase:
   * - no entry / stale requestId → `not_found`
   * - non-cancellable, or past the point of no return → `refused`
   * - otherwise abort the controller → `cancelled_queued` (was still queued) or `cancelling` (in flight)
   *
   * Returns immediately; the actual `*_cancelled` SSE event arrives once the worker finishes
   * compensation. In Phase 1 only `install` registers, so other ops return `not_found`.
   */
  async cancelOperation(
    appUrn: AppUrn,
    requestId?: string,
  ): Promise<{ outcome: 'cancelling' | 'cancelled_queued' | 'refused' | 'force_reset' | 'not_found'; status?: string; message?: string }> {
    const entry = this.operationRegistry.get(appUrn);
    if (!entry) {
      return { outcome: 'not_found', message: 'No operation in progress for this app' };
    }
    if (requestId && entry.requestId !== requestId) {
      return { outcome: 'not_found', message: 'Operation already completed or replaced' };
    }

    if (entry.tier === 'non_cancellable') {
      return { outcome: 'refused', message: 'This operation cannot be cancelled.' };
    }
    if (entry.tier === 'before_ponr' && (entry.phase === 'finalizing' || entry.phase === 'committed')) {
      return { outcome: 'refused', message: 'Operation has passed the point of no return.' };
    }
    if (entry.tier === 'safe' && (entry.phase === 'finalizing' || entry.phase === 'committed')) {
      return { outcome: 'refused', message: 'Operation is finalizing and can no longer be cancelled.' };
    }

    // Derive the outcome and logging from the entry returned by abort() (its phase at abort time),
    // not from the earlier read, so the result reflects the op's actual state when it was aborted.
    const aborted = this.operationRegistry.abort(appUrn, requestId);
    if (!aborted) {
      return { outcome: 'not_found', message: 'Operation already completed or replaced' };
    }
    const wasQueued = aborted.phase === 'queued';
    this.logger.info(`[lifecycle] cancel requested for ${aborted.command} ${appUrn} (phase=${aborted.phase})`);
    return wasQueued
      ? { outcome: 'cancelled_queued', message: 'Operation cancelled before it started' }
      : { outcome: 'cancelling', message: 'Cancellation requested' };
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
    this.registerDispatchedCommand(appUrn, requestId, 'start');
    this.appEventsQueue
      .publish({ appUrn, command: 'start', requestId, form: { ...app.config, skipPull } })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} started successfully`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'start',
            success: true,
            successOutcome: {
              status: 'running',
              event: 'start_success',
              clearPendingRestart: true,
              afterApply: async () => {
                const { isProduction: isProdEnv } = this.config.getConfig();
                if (isProdEnv && app.exposedLocal) {
                  this.logger.info(`[Cloudflare] App ${appUrn} started and is exposedLocal. Triggering sync.`);
                  await this.syncExposure();
                }
              },
            },
          });
        } else {
          this.logger.error(`Failed to start app ${appUrn}: ${message}`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'start',
            success: false,
            message,
            failureOutcome: {
              status: 'stopped',
              event: 'start_error',
              notifyEvent: 'start_error',
              failurePhase: 'start',
            },
          });
        }
      })
      .catch((err) => this.logLifecycleHandlerError('start', appUrn, err));

    return { requestId };
  }

  /** Shared install-form validation used by UI pre-check, install, and hub_install_app MCP tool. */
  async validateAppConfig(appUrn: AppUrn, form: unknown) {
    const info = await this.marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn);
    if (!info) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, HttpStatus.NOT_FOUND);
    }

    const parsedFormResult = appFormSchema.safeParse(form ?? {});
    if (!parsedFormResult.success) {
      return {
        valid: false,
        errors: [{ env_variable: '_form', label: 'form', messageKey: 'SYSTEM_ERROR_INVALID_BODY' }],
      };
    }

    const parsedForm = normalizeLocalOpenPort(parsedFormResult.data);

    if (parsedForm.exposedLocal && !parsedForm.localSubdomain?.trim() && info.exposable) {
      parsedForm.localSubdomain = appUrn.split(':')[0];
    }

    // Fall back to the manifest port exactly as the persisted row does (`parsedForm.port ?? appInfo.port`
    // in installApp). Without it, a production install that exposes locally but sends no port is rejected
    // for a port the app already declares — `port` is a top-level manifest field, not a form field, so
    // mergeFormFieldDefaults never supplies it. That killed every onboarding install on a production Hub:
    // the wizard sends exposureMode 'cloudflare' (hence exposedLocal) and never sends a port, so all four
    // companion apps failed `requirePortWhenExposedLocal` before their app row was created.
    if (parsedForm.port === undefined) {
      parsedForm.port = info.port;
    }

    const { isProduction } = this.config.getConfig();
    const errors = validateAppFormFields(parsedForm as Record<string, unknown>, info.form_fields ?? [], {
      requirePortWhenExposedLocal: isProduction,
    });

    return {
      valid: errors.length === 0,
      errors: errors.map((e) => ({ env_variable: e.env_variable, label: e.label, messageKey: e.messageKey })),
    };
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
          const rawMessage = result.message ?? 'COMMON_AN_ERROR_OCCURRED';
          const messageKey = (Object.hasOwn(messages, rawMessage) ? rawMessage : 'COMMON_AN_ERROR_OCCURRED') as keyof typeof messages;
          throw new TranslatableError(messageKey, undefined, HttpStatus.BAD_GATEWAY);
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

    const configValidation = await this.validateAppConfig(appUrn, parsedForm);
    if (!configValidation.valid) {
      const labels = configValidation.errors.map((e) => e.label).join(', ');
      throw new TranslatableError('APP_INSTALL_FORM_ERROR_INVALID', { fields: labels }, HttpStatus.BAD_REQUEST);
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

    // Defense-in-depth beyond the declared `supported_architectures`: inspect
    // the actual image manifests so an image that doesn't publish the host
    // architecture fails here with a clear error, instead of a cryptic
    // "no matching manifest for linux/arm64/v8" mid-pull that previously
    // cascaded into an install_failed crash. Best-effort: a null result
    // (registry/network couldn't be inspected) does not block the install.
    const archCheck = await this.imageSizeService.verifyAppArchitecture(appUrn, architecture);
    if (archCheck && !archCheck.ok) {
      const canEmulateAmd64 = architecture === 'arm64' && archCheck.available.includes('amd64') && appInfo.supported_architectures?.includes('amd64');

      if (!canEmulateAmd64) {
        this.logger.warn(
          `App ${appUrn} image ${archCheck.image} does not publish a ${architecture} manifest (available: ${archCheck.available.join(', ') || 'none'})`,
        );
        throw new TranslatableError('APP_ERROR_ARCHITECTURE_NOT_SUPPORTED', { id: appUrn, arch: architecture });
      }

      this.logger.info(
        `App ${appUrn} will run amd64 images via platform emulation on ${architecture} host (image ${archCheck.image} lacks native ${architecture} manifest)`,
      );
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

    // Manifest edge-auth default (CI-Engineering#74): when the caller did not decide the
    // "Require Auth" toggle — the onboarding install path sends no enableAuth at all — an
    // exposable app that ships `hub_integration.edge_auth.default: true` starts protected.
    // Fallback only: an explicit operator true/false (form or API) always wins, and a
    // manifest can never force auth OFF. Placed before the queue publish so compose/labels
    // and the persisted row all see the resolved value.
    if (parsedForm.enableAuth === undefined) {
      parsedForm.enableAuth = manifestDefaultsEdgeAuthOn(appInfo) || undefined;
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
        enableAuth: parsedForm.enableAuth ?? false,
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
        enableAuth: parsedForm.enableAuth ?? false,
      });
    }

    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing' });
    void this.emitInstallQueueUpdate();

    const requestId = crypto.randomUUID();
    const appId = installRecord.id;
    const recordExposedLocal = exposedLocal ?? existingApp?.exposedLocal ?? !!appInfo.exposable;

    // Register the operation BEFORE publishing so a cancel arriving during the publish->dequeue
    // window (tier-A) can be honoured. Cleared in invokeCommand's finally.
    this.registerDispatchedCommand(appUrn, requestId, 'install');

    this.appEventsQueue
      .publish({ appUrn, command: 'install', requestId, form: { ...parsedForm, skipRun } })
      .then(async (raw) => {
        const { success, message, cancelled } = raw as z.output<typeof appEventResultSchema>;
        // Cancellation is finalized worker-side in invokeCommand (record deleted + install_cancelled
        // emitted), independent of this RPC reply. Nothing to do here — avoids a double delete/SSE/toast.
        if (cancelled) {
          return;
        }
        if (success) {
          this.logger.info(`App ${appUrn} installed successfully`);
          const claimed = this.operationRegistry.claimCompletion(appUrn, requestId);
          if (claimed) {
            await this.appRepository.updateAppById(appId, { status: 'running' });
            this.sseService.emit('app', { event: 'install_success', appUrn, appStatus: 'running' });

            const appIntentSyncService = this.appIntentSyncService;
            if (appIntentSyncService) {
              this.fireAndForgetLifecycle('register-intents', appUrn, () => appIntentSyncService.registerAppIntents(appUrn, appInfo));
            }

            if (recordExposedLocal || (appInfo.exposable && !exposedLocal)) {
              await this.syncExposure();
            }
          }
          void this.emitInstallQueueUpdate();
        } else {
          const isRpcTimeout = /timed out|RPC_TIMEOUT/i.test(message);
          if (isRpcTimeout) {
            // The image pull/compose can outlast the RPC. Keep 'installing' and let the worker finalize
            // the terminal status itself (markInstallSucceeded on success, handleFailedResult on failure).
            this.logger.warn(
              `Install RPC timed out for ${appUrn}; the worker is still finishing and will finalize the result. Keeping the app in 'installing' for now.`,
            );
            return;
          }

          // Publish failed without the command running (queue unavailable/overflow/invalid event), so
          // the worker never finalized — clear the registry and finalize here. finalizeFailedInstall is
          // guarded on status, so it's a no-op if the worker already finalized.
          this.operationRegistry.clear(appUrn, requestId);
          const latest = await this.appRepository.getAppById(appId).catch(() => null);
          // Publisher fallback: no invokeCommand `finally` ran, so emit the install-queue update here.
          await this.finalizeFailedInstall(latest, appUrn, raw as z.output<typeof appEventResultSchema>, { emitQueueUpdate: true });
        }
      })
      .catch((err) => {
        // A publish rejection (invalid event data, etc.) or a throw inside the completion handler
        // means invokeCommand never ran (or didn't finish) for this op — clear the registry entry so
        // a stale 'queued' operation can't linger and keep /cancel returning 'cancelled_queued'.
        this.operationRegistry.clear(appUrn, requestId);
        this.logLifecycleHandlerError('install', appUrn, err);
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

    if (isPortExposeApp(app.config)) {
      this.logger.debug(`Ignoring stop for port-expose workload ${appUrn}`);
      return { requestId: crypto.randomUUID() };
    }

    await this.appRepository.updateAppById(app.id, { status: 'stopping' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopping' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'stop');
    this.appEventsQueue
      .publish({ command: 'stop', appUrn, requestId, form: app.config })
      .then(async ({ success, message }) => {
        if (success) {
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'stop',
            success: true,
            successOutcome: {
              status: 'stopped',
              event: 'stop_success',
              afterApply: async () => {
                this.logger.info(`App ${appUrn} stopped successfully`);
                try {
                  const { PortExposeService } = await import('../custom-apps/port-expose.service');
                  const portExposeService = this.moduleRef.get(PortExposeService, { strict: false });
                  await portExposeService?.syncPortExposeRoutes().catch(() => undefined);
                } catch (err) {
                  this.logger.warn(`Port-expose route sync skipped after stop for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
                }

                if (app.exposedLocal || app.exposureMode === 'cloudflare' || app.exposureMode === 'tailscale') {
                  await this.syncExposure();
                }
              },
            },
          });
        } else {
          this.logger.error(`Failed to stop app ${appUrn}: ${message}`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'stop',
            success: false,
            message,
            failureOutcome: {
              status: 'running',
              event: 'stop_error',
              notifyEvent: 'stop_error',
              failurePhase: 'stop',
            },
          });
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
    this.registerDispatchedCommand(appUrn, requestId, 'stop');

    try {
      await this.appRepository.updateAppById(app.id, { status: 'stopping' });
      this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopping' });

      try {
        const result = await this.dockerService.forceStopApp(appUrn);
        await this.settleCommandOutcome({
          appId: app.id,
          appUrn,
          requestId,
          command: 'stop',
          success: true,
          successOutcome: {
            status: 'stopped',
            event: 'stop_success',
            afterApply: async () => {
              this.logger.warn(`App ${appUrn} force-stopped successfully`, result);
              if (app.exposedLocal) {
                await this.syncExposure();
              }
            },
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to force-stop app ${appUrn}: ${message}`);
        await this.settleCommandOutcome({
          appId: app.id,
          appUrn,
          requestId,
          command: 'stop',
          success: false,
          message,
          failureOutcome: {
            status: app.status,
            event: 'stop_error',
            notifyEvent: 'stop_error',
            failurePhase: 'stop',
          },
        });
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
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    await this.appRepository.updateAppById(app.id, { status: 'restarting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'restarting' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'restart');
    this.appEventsQueue
      .publish({ command: 'restart', appUrn, requestId, form: { ...app.config, skipPull } })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} restarted successfully`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'restart',
            success: true,
            successOutcome: {
              status: 'running',
              event: 'restart_success',
              clearPendingRestart: true,
            },
          });
        } else {
          this.logger.error(`Failed to restart app ${appUrn}: ${message}`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'restart',
            success: false,
            message,
            failureOutcome: {
              status: 'stopped',
              event: 'restart_error',
              notifyEvent: 'restart_error',
              failurePhase: 'restart',
            },
          });
        }
      })
      .catch((err) => this.logLifecycleHandlerError('restart', appUrn, err));

    return { requestId };
  }

  /**
   * Start an app and wait for the queue worker to finish.
   *
   * {@link startApp} resolves once the command is published; this variant is for callers
   * (such as post-update restart) that must not proceed until the app reaches a terminal
   * start outcome.
   */
  public async startAppAndWait(params: { appUrn: AppUrn; skipPull?: boolean }): Promise<boolean> {
    const { appUrn, skipPull } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    await this.appRepository.updateAppById(app.id, { status: 'starting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'starting' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'start');
    const { success, message } = await this.appEventsQueue.publish({
      appUrn,
      command: 'start',
      requestId,
      form: { ...app.config, skipPull },
    });

    if (success) {
      this.logger.info(`App ${appUrn} started successfully`);
      await this.settleCommandOutcome({
        appId: app.id,
        appUrn,
        requestId,
        command: 'start',
        success: true,
        successOutcome: {
          status: 'running',
          event: 'start_success',
          clearPendingRestart: true,
          afterApply: async () => {
            const { isProduction: isProdEnv } = this.config.getConfig();
            if (isProdEnv && app.exposedLocal) {
              this.logger.info(`[Cloudflare] App ${appUrn} started and is exposedLocal. Triggering sync.`);
              await this.syncExposure();
            }
          },
        },
      });

      return true;
    }

    this.logger.error(`Failed to start app ${appUrn}: ${message}`);
    await this.settleCommandOutcome({
      appId: app.id,
      appUrn,
      requestId,
      command: 'start',
      success: false,
      message,
      failureOutcome: {
        status: 'stopped',
        event: 'start_error',
        notifyEvent: 'start_error',
        failurePhase: 'start',
      },
    });

    return false;
  }

  /**
   * Restart an app and WAIT for the compose restart to actually finish.
   *
   * {@link restartApp} resolves as soon as the command is published — its result is
   * handled in a detached `.then` — which is right for a UI action driven by SSE, but
   * useless to a caller that must know whether the container really came back up (the
   * memory-connect key rotation strands an app on a retired key if it does not).
   * Returns whether the restart succeeded; the status/SSE bookkeeping is identical.
   */
  public async restartAppAndWait(params: { appUrn: AppUrn; skipPull?: boolean }): Promise<boolean> {
    const { appUrn, skipPull } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    await this.appRepository.updateAppById(app.id, { status: 'restarting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'restarting' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'restart');
    const { success, message } = await this.appEventsQueue.publish({
      command: 'restart',
      appUrn,
      requestId,
      form: { ...app.config, skipPull },
    });

    if (success) {
      this.logger.info(`App ${appUrn} restarted successfully`);
      await this.settleCommandOutcome({
        appId: app.id,
        appUrn,
        requestId,
        command: 'restart',
        success: true,
        successOutcome: {
          status: 'running',
          event: 'restart_success',
          clearPendingRestart: true,
        },
      });

      return true;
    }

    this.logger.error(`Failed to restart app ${appUrn}: ${message}`);
    await this.settleCommandOutcome({
      appId: app.id,
      appUrn,
      requestId,
      command: 'restart',
      success: false,
      message,
      failureOutcome: {
        status: 'stopped',
        event: 'restart_error',
        notifyEvent: 'restart_error',
        failurePhase: 'restart',
      },
    });

    return false;
  }

  /**
   * Rewrite an app's env file from its current stored config, without touching its
   * containers.
   *
   * For applying a config change to an app that is DOWN: a stopped app must not be
   * composed up just to pick up an env change, but leaving the file stale is not
   * harmless either — it is how a revoked credential survives on disk, and how an app
   * that is mid-install comes up with the env the installer wrote before the change
   * landed. Returns whether the env was rewritten.
   */
  public async regenerateAppEnv(appUrn: AppUrn): Promise<boolean> {
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      return false;
    }

    const requestId = crypto.randomUUID();
    const { success, message } = await this.appEventsQueue.publish({
      command: 'generate_env',
      appUrn,
      requestId,
      form: app.config,
    });

    if (!success) {
      this.logger.error(`Failed to regenerate env for app ${appUrn}: ${message}`);
    }

    return success;
  }

  /**
   * Lazily resolve MemoryConnectService. The dynamic import + ModuleRef lookup
   * avoids a static module cycle with memory-connect; a resolution failure (module
   * unloadable — `ModuleRef.get` throws rather than returning undefined) is folded
   * into `undefined` so callers can decide how to handle a missing service.
   */
  private async getMemoryConnectService(): Promise<MemoryConnectService | undefined> {
    try {
      const { MemoryConnectService } = await import('../memory-connect/memory-connect.service');
      return this.moduleRef.get(MemoryConnectService, { strict: false }) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Refuse to destroy Companion Memory (the shared provider) while other installed
   * apps still hold a live connection to it — uninstalling or resetting it would
   * sever their connections and irrecoverably delete the shared memory store.
   * `force` (an explicit user/agent confirmation) bypasses the guard; non-provider
   * apps are never affected. Fails closed if the memory module can't be resolved:
   * a data-destroying operation must not proceed when the safety check can't run.
   */
  private async assertMemoryProviderNotInUse(appUrn: AppUrn, force: boolean | undefined): Promise<void> {
    if (force || !isMemoryProviderApp({ urn: appUrn })) {
      return;
    }

    const memoryConnect = await this.getMemoryConnectService();

    if (!memoryConnect) {
      // The safety check couldn't run — fail closed with a distinct message
      // rather than pretending "0 apps" via the in-use copy.
      throw new TranslatableError('APP_ERROR_MEMORY_PROVIDER_UNVERIFIABLE', { id: appUrn }, HttpStatus.CONFLICT);
    }

    const consumers = await memoryConnect.listConnectedConsumers();

    if (consumers.length > 0) {
      throw new TranslatableError(
        'APP_ERROR_MEMORY_PROVIDER_IN_USE',
        { id: appUrn, count: String(consumers.length), apps: consumers.map((c) => c.name).join(', ') },
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Uninstall an app by its ID
   */
  public async uninstallApp(params: { appUrn: AppUrn; deleteAllData: boolean; force?: boolean }) {
    const { appUrn, deleteAllData, force } = params;

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    // Guard the shared memory provider before any destructive side effect runs.
    await this.assertMemoryProviderNotInUse(appUrn, force);

    // NOTE: backups are deliberately NOT deleted here — see the uninstall-success
    // arm below. Discarding them before the worker has run would destroy the safety
    // net even when the uninstall subsequently FAILS and the app survives intact.

    await this.appRepository.updateAppById(app.id, { status: 'uninstalling' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'uninstalling' });

    // Revoke any Companion Memory key minted for this app and drop its connection
    // state so access dies with the app. Best-effort — the app is going away
    // regardless. Dispatched OFF the response path: when the app IS the memory
    // provider this re-arms every connected consumer (a container-restart sweep
    // that ran ~28s in a production incident), which must not hold the uninstall
    // HTTP response open (#906). A cleanup miss is non-fatal (the key lapses on
    // its own TTL), so it stays at warn — not the error level the shared
    // completion-handler logger would use.
    void this.getMemoryConnectService()
      .then((memoryConnect) => memoryConnect?.handleUninstall(appUrn))
      .catch((err) => this.logger.warn(`Memory-connect cleanup failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`));

    const installedInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);
    const isPortExpose = isPortExposeApp(installedInfo) || isPortExposeApp(app.config);

    let portExposeService: { beforePortExposeUninstall: (urn: AppUrn) => Promise<void>; afterPortExposeUninstall: () => Promise<void> } | undefined;
    if (isPortExpose) {
      try {
        const { PortExposeService } = await import('../custom-apps/port-expose.service');
        portExposeService = this.moduleRef.get(PortExposeService, { strict: false }) ?? undefined;
        if (portExposeService) {
          await portExposeService.beforePortExposeUninstall(appUrn).catch((err) => {
            this.logger.warn(`Port-expose registry cleanup failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        this.logger.warn(`Port-expose cleanup unavailable for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'uninstall');
    this.appEventsQueue
      .publish({ command: 'uninstall', appUrn, requestId, form: app.config, deleteAllData })
      .then(async (result) => {
        const { success, message } = result;
        if (success) {
          if (!this.operationRegistry.claimCompletion(appUrn, requestId)) {
            return;
          }

          this.logger.info(`App ${appUrn} uninstalled successfully`);

          await this.appRepository.deleteAppById(app.id);

          // Carry a non-fatal caveat (e.g. a disk remnant the delete could not
          // remove, #907) so the client can warn instead of a plain success toast.
          // warningDetail carries the host path so the client can show a manual
          // cleanup command. The infra-failure arm of the publish result has neither.
          let warningCode = 'warningCode' in result ? result.warningCode : undefined;
          let warningDetail = 'warningDetail' in result ? result.warningDetail : undefined;

          // Backups follow the user's data choice, and are discarded only now that the
          // app is definitively gone. THREE conditions must hold: the user asked for the
          // live data to go (`deleteAllData`), the uninstall succeeded, and the data wipe
          // was not itself partial. Deleting them before the worker ran destroyed the only
          // means of recovery even when the uninstall then failed (#908) — and discarding
          // them when the wipe demonstrably left data behind would be the same inversion
          // at the other end: the app's data survives on disk while its backups do not.
          if (deleteAllData && warningCode !== 'APP_UNINSTALL_PARTIAL_REMNANT') {
            try {
              await this.backupManager.deleteAppBackupsByUrn(appUrn);
            } catch (err) {
              // Never report a clean removal we did not achieve: the user asked for every
              // trace of this app to go, so surface the leftover archives through the same
              // channel #907 uses for disk remnants rather than a warn-level log they will
              // never see. Non-fatal — the app itself IS uninstalled.
              this.logger.warn(`Failed to delete backups for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
              warningCode = 'APP_UNINSTALL_PARTIAL_REMNANT';
              // Point the manual-cleanup command at the BACKUP directory, not the app-data
              // one: this arm fires only when the data wipe already succeeded, so the sole
              // leftover is the archives. Without a detail the client falls back to a generic
              // "some files remain" toast with no path, which is the one thing the user needs.
              warningDetail = this.backupManager.getAppBackupsHostDir(appUrn);
            }
          }

          if (portExposeService) {
            await portExposeService.afterPortExposeUninstall().catch((err) => {
              this.logger.warn(`Port-expose route cleanup failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          const appIntentSyncService = this.appIntentSyncService;
          if (appIntentSyncService) {
            this.fireAndForgetLifecycle('unregister-intents', appUrn, () => appIntentSyncService.unregisterAppIntents(appUrn));
          }

          await this.syncExposure().catch((err) => {
            this.logger.warn(`Post-uninstall Portal sync failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
          });

          // warningCode/warningDetail were resolved above, before the backup cleanup, so
          // a failed backup delete can escalate the code it carries.
          this.sseService.emit('app', { event: 'uninstall_success', appUrn, appStatus: 'missing', warningCode, warningDetail });
        } else {
          this.logger.error(`Failed to uninstall app ${appUrn}: ${message}`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'uninstall',
            success: false,
            message,
            failureOutcome: {
              status: 'stopped',
              event: 'uninstall_error',
              notifyEvent: 'uninstall_error',
              failurePhase: 'uninstall',
            },
          });
        }
      })
      .catch((err) => this.logLifecycleHandlerError('uninstall', appUrn, err));

    return { requestId };
  }

  /**
   * Reset an app by its ID
   */
  public async resetApp(params: { appUrn: AppUrn; force?: boolean }) {
    const { appUrn, force } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    // Reset wipes volumes + app-data — guard the shared memory provider before it runs.
    await this.assertMemoryProviderNotInUse(appUrn, force);

    const appStatusBeforeReset = app?.status;
    await this.appRepository.updateAppById(app.id, { status: 'resetting' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'resetting' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'reset');
    this.appEventsQueue
      .publish({ command: 'reset', appUrn, requestId, form: app.config })
      .then(async ({ success, message }) => {
        if (success) {
          this.logger.info(`App ${appUrn} reset successfully`);
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'reset',
            success: true,
            successOutcome: {
              status: 'stopped',
              event: 'reset_success',
              afterApply: async () => {
                if (appStatusBeforeReset === 'running') {
                  this.fireAndForgetLifecycle('start-after-reset', appUrn, () => this.startApp({ appUrn }));
                }
              },
            },
          });
        } else {
          this.logger.error(`Failed to reset app ${appUrn}: ${message}`);
          const restoredStatus = appStatusBeforeReset ?? 'stopped';
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'reset',
            success: false,
            message,
            failureOutcome: {
              status: restoredStatus,
              event: 'reset_error',
              notifyEvent: 'reset_error',
              failurePhase: 'reset',
            },
          });
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

    // Snapshot of what the REQUEST asked for, used by the validation below. Everything written to
    // the row further down must read `parsedForm` instead: the production-exposed guard, the
    // non-exposable reset and the edge-auth defaulting all mutate it after this point.
    const { exposed, domain, port } = parsedForm;

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

    // Manifest edge-auth default (CI-Engineering#74): when this update does not carry an
    // enableAuth decision, inherit the app's STORED choice first, and only fall to the manifest
    // default when the app never had one (an onboarding-era install). "Explicit operator choice
    // always wins" must survive a PARTIAL update too: a client that PATCHes some other field
    // without resending enableAuth must not have a prior explicit `false` silently flipped back
    // to the manifest's `true`. Inheriting the stored value also keeps hasConfigChanged from
    // seeing a spurious diff (and restarting the app) on such updates.
    //
    // This MUST run before the no-change short-circuit below: a version bump re-submits the
    // stored config verbatim (updateApp → this method); an onboarding install whose stored config
    // never decided enableAuth then self-heals to the manifest default here, and that resolved
    // `true` is what makes hasConfigChanged see a difference at all.
    if (parsedForm.enableAuth === undefined) {
      const storedEnableAuth = (app.config as { enableAuth?: boolean } | null | undefined)?.enableAuth;
      parsedForm.enableAuth = storedEnableAuth ?? (manifestDefaultsEdgeAuthOn(appInfo) || undefined);
    }

    const settingsChanged = this.hasConfigChanged(
      normalizeConfigForCompare((app.config ?? {}) as Record<string, unknown>),
      parsedForm as Record<string, unknown>,
    );
    if (!settingsChanged) {
      this.logger.debug(`App ${appUrn} config update skipped — no changes detected`);
      return { requestId: crypto.randomUUID() };
    }

    if (!appInfo.exposable) {
      // Read from parsedForm, not the destructured copies taken at the top of this method: both
      // the production-exposed guard above and the edge-auth defaulting have since mutated it, so
      // the stale copies would make this warning describe the REQUEST rather than what is actually
      // being reset — announcing a reset that already happened, and staying silent on an
      // enableAuth the defaulting just resolved.
      if (parsedForm.exposed || parsedForm.exposedLocal || parsedForm.enableAuth) {
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
      // `parsedForm`, not the request snapshot: the row must record what was actually applied.
      // Reading the snapshot here wrote `exposed: true` (and kept the domain) for a request the
      // production guard or the non-exposable reset had just disabled — disagreeing with the
      // `config` blob stored in this same call, which does carry the corrected form.
      exposed: parsedForm.exposed ?? false,
      exposedLocal: parsedForm.exposedLocal ?? false,
      exposureMode: parsedForm.exposureMode ?? 'local',
      openPort: parsedForm.openPort,
      port: parsedForm.port ?? appInfo.port,
      domain: parsedForm.domain ?? null,
      localSubdomain: parsedForm.localSubdomain ?? null,
      publicDomain: parsedForm.publicDomain ?? null,
      config: parsedForm,
      isVisibleOnGuestDashboard: parsedForm.isVisibleOnGuestDashboard ?? false,
      enableAuth: parsedForm.enableAuth ?? false,
      maxBackups: parsedForm.maxBackups ?? null,
    });

    const { appName, appStoreId } = extractAppUrn(appUrn);
    const routingChanged = didPublicRoutingIdentityChange(app as AppPublicRoutingSnapshot, parsedForm, appName, appStoreId);

    if (!changed?.pendingRestart) {
      await this.appRepository.updateAppById(app.id, { pendingRestart: settingsChanged });
    }

    // Sync tunnel/DNS state with CI-Cloud. When subdomain or public domain changed,
    // run a release pass first so the old hostname is removed from Cloudflare DNS.
    this.logger.info(`[Cloudflare] Config updated for ${appUrn}. Triggering state sync.`);
    await this.syncExposureAfterRoutingChange(appUrn, routingChanged);

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
  private async syncExposure(options?: { excludeAppUrns?: AppUrn[] }) {
    await this.exposureSyncService.syncExposurePublic(options);
  }

  /**
   * When public routing identity changes, CI-Cloud only deletes stale DNS when the
   * app's previous slug disappears from the sync payload. Sync once without the
   * reconfigured app so the old record is released, then sync the full state.
   */
  private async syncExposureAfterRoutingChange(appUrn: AppUrn, routingChanged: boolean) {
    await this.exposureSyncService.syncExposureAfterRoutingChange(appUrn, routingChanged);
  }

  /**
   * Public wrapper for syncExposure — used by AppsService.resolveAppAvailability
   */
  public async syncExposurePublic(options?: { excludeAppUrns?: AppUrn[] }) {
    return this.exposureSyncService.syncExposurePublic(options);
  }

  /** Reconcile Tailscale Serve for all Private VPN apps (no Cloudflare sync). */
  public async syncTailscaleExposurePublic() {
    return this.exposureSyncService.syncTailscaleExposurePublic();
  }

  public async triggerCloudflareSync(options?: { excludeAppUrns?: AppUrn[] }) {
    return this.exposureSyncService.triggerCloudflareSync(options);
  }

  public async updateApp(params: { appUrn: AppUrn; performBackup: boolean }) {
    const { appUrn, performBackup } = params;
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    // For CI Marketplace (ci_cloud_api) apps, the periodic catalog sync only carries
    // metadata (and compose for free apps). Download the full, freshly published app
    // bundle before updating — mirrors installApp — so the update installs the new
    // version rather than whatever is in the local repo copy.
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const store = await this.appStoreService.getAppStoreBySlug(appStoreId);
    if (store && store.type === 'ci_cloud_api') {
      const result = await this.repoHelpers.downloadAppFiles(store.url, store.slug, appName);
      if (!result.success) {
        const rawMessage = result.message ?? 'COMMON_AN_ERROR_OCCURRED';
        const messageKey = (Object.hasOwn(messages, rawMessage) ? rawMessage : 'COMMON_AN_ERROR_OCCURRED') as keyof typeof messages;
        throw new TranslatableError(messageKey, undefined, HttpStatus.BAD_GATEWAY);
      }
    }

    // min_hub_version enforcement intentionally disabled until Hub semver stabilizes (post-Runtipi migration).

    await this.appRepository.updateAppById(app.id, { status: 'updating' });

    const appStatusBeforeUpdate = app.status;
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'updating' });

    const requestId = crypto.randomUUID();
    this.registerDispatchedCommand(appUrn, requestId, 'update');
    this.appEventsQueue
      .publish({ command: 'update', appUrn, requestId, form: app.config, performBackup })
      .then(async ({ success, message }) => {
        if (success) {
          if (!this.operationRegistry.claimCompletion(appUrn, requestId)) {
            return;
          }

          const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);
          const restoredStatus = appStatusBeforeUpdate === 'running' ? 'stopped' : appStatusBeforeUpdate;

          await this.updateAppConfig({ appUrn, form: app.config });
          await this.appRepository.updateAppById(app.id, { version: appInfo?.cihub_app_version, status: restoredStatus });
          this.sseService.emit('app', { event: 'update_success', appUrn, appStatus: restoredStatus });
          this.agentNotifyService?.notify('update_success', { appUrn }, 'info');

          if (appStatusBeforeUpdate === 'running') {
            await this.startAppAndWait({ appUrn });
          }
        } else {
          this.logger.error(`Failed to update app ${appUrn}: ${message}`);
          const restoredStatus = appStatusBeforeUpdate === 'running' ? 'stopped' : appStatusBeforeUpdate;
          await this.settleCommandOutcome({
            appId: app.id,
            appUrn,
            requestId,
            command: 'update',
            success: false,
            message,
            failureOutcome: {
              status: restoredStatus,
              event: 'update_error',
              notifyEvent: 'update_error',
              failurePhase: 'update',
            },
          });
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
          const inferenceMapping = info?.hub_integration?.inference;
          const hasInferenceIntegration = inferenceMapping && Object.keys(inferenceMapping).length > 0;
          if (!info?.categories?.includes('ai') && !hasInferenceIntegration) {
            return;
          }
          this.logger.info(`Restarting AI app ${appUrn} after inference preferences change`);
          return this.restartApp({ appUrn });
        } catch (e) {
          this.logger.error(`Failed to restart AI app ${app.id}`, e);
        }
      }),
    );

    const prefs = this.config.getInferencePreferences();
    if (prefs.preferredBackend) {
      try {
        await this.markInferenceAppsEnvSynced();
      } catch (err) {
        this.logger.warn(`[InferenceSync] Failed to persist inference env sync marker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private reportAppFailure(appUrn: AppUrn, phase: AppFailurePhase, message: string): void {
    this.errorReportingService?.reportAppFailure({ appUrn, phase, message });
  }

  private registerDispatchedCommand(appUrn: AppUrn, requestId: string, command: OperationCommand): void {
    this.operationRegistry.register(appUrn, {
      requestId,
      command,
      tier: this.cancellabilityTierFor(command),
    });
  }

  private cancellabilityTierFor(command: OperationCommand): CancellabilityTier {
    switch (command) {
      case 'install':
      case 'start':
      case 'stop':
      case 'restart':
      case 'generate_env':
        return 'safe';
      case 'update':
      case 'reset':
        return 'before_ponr';
      case 'uninstall':
      case 'backup':
      case 'restore':
        return 'non_cancellable';
    }
  }

  private async settleCommandOutcome(params: {
    appId: number;
    appUrn: AppUrn;
    requestId: string;
    command: OperationCommand;
    success: boolean;
    message?: string;
    successOutcome?: {
      status: AppStatus;
      event: AppOutcomeSseEvent;
      clearPendingRestart?: boolean;
      afterApply?: () => Promise<void>;
    };
    failureOutcome?: {
      status: AppStatus;
      event: AppOutcomeSseEvent;
      notifyEvent: string;
      failurePhase: AppFailurePhase;
      notifySeverity?: 'high' | 'info';
    };
  }): Promise<boolean> {
    if (!this.operationRegistry.claimCompletion(params.appUrn, params.requestId)) {
      this.logger.debug(`[lifecycle] Superseded ${params.command} completion for ${params.appUrn} (req=${params.requestId})`);
      return false;
    }

    if (params.success && params.successOutcome) {
      await this.appRepository.updateAppById(params.appId, {
        status: params.successOutcome.status,
        ...(params.successOutcome.clearPendingRestart ? { pendingRestart: false } : {}),
      });
      this.sseService.emit('app', {
        event: params.successOutcome.event,
        appUrn: params.appUrn,
        appStatus: params.successOutcome.status,
      });
      if (params.successOutcome.afterApply) {
        await params.successOutcome.afterApply();
      }
      return true;
    }

    if (!params.success && params.failureOutcome) {
      await this.appRepository.updateAppById(params.appId, { status: params.failureOutcome.status });
      this.sseService.emit('app', {
        event: params.failureOutcome.event,
        appUrn: params.appUrn,
        appStatus: params.failureOutcome.status,
        error: params.message,
      });
      this.agentNotifyService?.notify(params.failureOutcome.notifyEvent, { appUrn: params.appUrn }, params.failureOutcome.notifySeverity ?? 'high');
      this.reportAppFailure(params.appUrn, params.failureOutcome.failurePhase, params.message ?? 'Unknown error');
      return true;
    }

    return true;
  }
}
