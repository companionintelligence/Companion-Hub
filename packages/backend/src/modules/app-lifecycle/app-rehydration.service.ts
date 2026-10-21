import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { APP_DATA_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { castAppUrn, createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { CloudflareClientService, type PortalDeviceApplication } from '@/modules/cloudflare/cloudflare-client.service';
import { isAiAppInfo } from '@/modules/apps/app.helpers';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { isOperational } from '@/modules/registration/registration-state';
import type { AppUrn } from '@ci-hub/common/types';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { AppLifecycleService } from './app-lifecycle.service';
import {
  buildRehydrationPlan,
  filterLocalEntriesForPortalUrns,
  isKeptAppSkip,
  resolvePortalAppToUrn,
  scanLocalAppData,
  skipCodeForAction,
  type RehydrationPlan,
  type RehydrationPlanItem,
  type RehydrationSkipped,
  type RehydrationStateFile,
} from './app-rehydration';
import {
  acknowledgeRestoreNotice,
  clearRestoreIntent,
  hasRestoreIntent,
  readPairingAppCheck,
  readRestoreNotice,
  readRehydrationState as loadRehydrationStateFile,
  writeRehydrationState as persistRehydrationStateFile,
} from './registration-recovery-state';

export interface RehydrationExecuteResult {
  success: boolean;
  message: string;
  alreadyCompleted?: boolean;
  /**
   * An install or a start was refused by the org-grant gate, so the run was not recorded as done and
   * the next rehydrate picks those apps up without `force`. See `executeRehydrate`.
   */
  incomplete?: boolean;
  plan: RehydrationPlan;
  queued: string[];
  started: string[];
  skipped: RehydrationSkipped[];
}

/** One app a finished restore put back, as it stands now. */
export interface RestoreSummaryApp {
  name: string;
  urn: string;
  /** The app's status on this Hub now, or `missing` when its install never made a row. */
  status: string;
  /** The Hub hands this app an AI model (`isAiAppInfo`). */
  usesAi: boolean;
}

/** An app a finished restore could not put back, with the reason. */
export interface RestoreSummaryFailure {
  name: string;
  urn?: string;
  reason: string;
  code?: RehydrationSkipped['code'];
  params?: Record<string, string>;
}

/** What the restore after this pairing brought back, for the person who signs in next. */
export interface RestoreSummary {
  completedAt: string;
  restored: RestoreSummaryApp[];
  notRestored: RestoreSummaryFailure[];
  /** Whether anyone has chosen a chat model on this Hub. Until then AI apps get the one it recommends. */
  aiModelChosen: boolean;
}

export interface RestoreStatus {
  completed: boolean;
  state: RehydrationStateFile | null;
  restoreIntent: boolean;
  /** A pairing's apps check stands and has not yet decided whether there is anything to restore. */
  checking: boolean;
  /** This pairing's restore began or finished, nobody has seen it yet and the caller may manage the Hub. */
  noticePending: boolean;
  /** What the finished restore brought back, while `noticePending`. */
  summary?: RestoreSummary;
}

interface RehydrateOptions {
  force?: boolean;
  source?: 'restore';
  operatorUserId?: number;
  actor: LifecycleActor;
}

/**
 * The org-grant gate's refusal. Unlike an install that fails, it is an answer about who asked — or,
 * with WhoIs unreachable, no answer at all — so another person, or a later try, may get further.
 */
function isGrantRefusal(error: unknown): boolean {
  return error instanceof TranslatableError && error.message === 'APP_ACTION_GRANT_DENIED';
}

/**
 * The values a refusal's message key is written with. `APP_INSTALL_FORM_ERROR_INVALID` names the form
 * fields it found missing in `fields`. That list is the reason a person can act on: the restore
 * sends only what Companion Portal keeps for an app (its address and port), so a field with no
 * default, such as Kimai's admin password, is missing on every restore.
 */
function messageParams(error: unknown): Record<string, string> | undefined {
  if (!(error instanceof TranslatableError)) {
    return undefined;
  }
  const response = error.getResponse() as { intlParams?: Record<string, string | undefined> };
  const entries = Object.entries(response.intlParams ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

@Injectable()
export class AppRehydrationService {
  /** The run under way, which a second caller joins rather than queueing the same installs again. */
  private runInFlight: Promise<RehydrationExecuteResult> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registrationService: RegistrationService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly appStoreService: AppStoreService,
    private readonly marketplaceService: MarketplaceService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly userRepository: UserRepository,
  ) {}

  async getRehydrationStatus(): Promise<{ completed: boolean; state: RehydrationStateFile | null }> {
    const state = await this.readRehydrationState();
    return { completed: Boolean(state?.completedAt), state };
  }

  /**
   * Where this pairing's restore stands, which decides what the next sign-in opens (see
   * `RestoreNoticeFile`): the restore page while it runs, its summary once it has finished and until
   * someone has seen it. Only then does it open the Hub or its setup wizard.
   *
   * `mayManage` is asked only while a notice is unseen: the notice and its summary are for someone who
   * may manage the Hub, who is also the one the setup wizard would open for.
   */
  async getRestoreStatus(mayManage: () => Promise<boolean>): Promise<RestoreStatus> {
    const [{ completed, state }, restoreIntent, pairingCheck, notice] = await Promise.all([
      this.getRehydrationStatus(),
      hasRestoreIntent(),
      readPairingAppCheck(),
      readRestoreNotice(),
    ]);
    const noticePending = Boolean(notice?.startedAt && !notice.acknowledgedAt) && (await mayManage());
    const summary = noticePending && state?.completedAt ? await this.buildRestoreSummary(state) : undefined;

    return {
      completed,
      state,
      restoreIntent,
      checking: Boolean(pairingCheck && !pairingCheck.restore) && !notice,
      noticePending,
      ...(summary ? { summary } : {}),
    };
  }

  /**
   * The person who saw the restore goes on to the Hub. A restore that finished brought back a Hub that
   * was set up before, so its setup wizard is not asked for again; one that never finished leaves it.
   */
  async acknowledgeRestore(): Promise<void> {
    await acknowledgeRestoreNotice();
    if ((await this.readRehydrationState())?.completedAt) {
      await this.userRepository.markApplianceOnboardingComplete();
    }
  }

  private async buildRestoreSummary(state: RehydrationStateFile): Promise<RestoreSummary> {
    const rows = new Map<string, string>(
      (await this.appsRepository.getApps()).map((app) => [createAppUrn(app.appName, app.appStoreSlug), app.status]),
    );
    const kept = state.skipped.filter((entry) => isKeptAppSkip(entry) && entry.appUrn).map((entry) => entry.appUrn as string);
    const restoredUrns = [...new Set([...state.queuedUrns, ...state.startedUrns, ...kept])];

    const restored = await Promise.all(
      restoredUrns.map(async (urn) => {
        const info = await this.appInfoFor(urn);
        return { name: info?.name || (urn.split(':')[0] ?? urn), urn, status: rows.get(urn) ?? 'missing', usesAi: info ? isAiAppInfo(info) : false };
      }),
    );
    const notRestored = await Promise.all(
      state.skipped
        .filter((entry) => !isKeptAppSkip(entry))
        .map(async (entry) => {
          const info = entry.appUrn ? await this.appInfoFor(entry.appUrn) : undefined;
          return {
            name: info?.name || entry.name,
            reason: entry.reason,
            ...(entry.appUrn ? { urn: entry.appUrn } : {}),
            ...(entry.code ? { code: entry.code } : {}),
            ...(entry.params ? { params: entry.params } : {}),
          };
        }),
    );

    return {
      completedAt: state.completedAt,
      restored,
      notRestored,
      aiModelChosen: Boolean(this.config.getInferencePreferences().preferredModel),
    };
  }

  /** The app's listing, for its name. A store that cannot be read only costs the name. */
  private async appInfoFor(urn: string) {
    try {
      return await this.marketplaceService.getAppInfoFromAppStoreOrInstalled(castAppUrn(urn));
    } catch {
      return undefined;
    }
  }

  async buildPlan(): Promise<RehydrationPlan> {
    await this.assertCanRehydrate();
    const portalApps = await this.fetchPortalApplications();
    return this.buildPlanFromPortalApps(portalApps);
  }

  async executeRehydrate(options: RehydrateOptions): Promise<RehydrationExecuteResult> {
    await this.assertCanRehydrate();

    /*
     * ⚠ TWO CALLERS CAN ASK AT ONCE. After a pairing the Hub restores on its own
     * (`PairingAppRestoreService`), while the restore page, open for the person who paired, asks as
     * well. Each run plans from app rows the other has not written yet, so both would queue the same
     * installs. A second caller waits for the run under way and takes its result.
     */
    const result = await (this.runInFlight ?? this.startRun(options));

    /*
     * A person who reaches the restore page after the Hub already restored on its own still finishes the
     * restore flow here, as they would have by running it: it used to send them to onboarding, which a
     * restored Hub has already been through.
     */
    const restoreFlow = options?.source === 'restore' || (await hasRestoreIntent());
    if (restoreFlow && options?.operatorUserId) {
      await this.userRepository.updateUser(options.operatorUserId, { hasCompletedOnboarding: true });
      await clearRestoreIntent();
    }

    return result;
  }

  private startRun(options: RehydrateOptions): Promise<RehydrationExecuteResult> {
    const run = this.runRehydrate(options).finally(() => {
      if (this.runInFlight === run) {
        this.runInFlight = null;
      }
    });
    this.runInFlight = run;
    return run;
  }

  private async runRehydrate(options: RehydrateOptions): Promise<RehydrationExecuteResult> {
    const existing = await this.readRehydrationState();
    if (existing?.completedAt && !options?.force) {
      return {
        success: true,
        message: 'Rehydration already completed for this registration epoch',
        alreadyCompleted: true,
        plan: await this.planForCompletedRun(),
        queued: existing.queuedUrns,
        started: existing.startedUrns,
        skipped: existing.skipped,
      };
    }

    const portalApps = await this.fetchPortalApplications();
    const plan = await this.buildPlanFromPortalApps(portalApps);

    const queued: string[] = [];
    const started: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    const refused: string[] = [];

    for (const item of plan.items) {
      await this.executePlanItem(item, queued, started, skipped, refused, options.actor);
    }

    /*
     * ⚠ A REFUSAL IS NOT A FINISHED RUN. The requester's grant decided those installs and starts
     * (CI-Hub#1397), so another person — or the same one once WhoIs answers again — may be allowed.
     * Recording the run as done made the refusal final: nothing retried it without `force`, and the
     * restore page moved straight on without showing it.
     *
     * The restore intent is still cleared by `executeRehydrate`. While it stands with no finished run,
     * Cloudflare sync stands down for the whole Hub (`ExposureSyncService.triggerCloudflareSync`), and a
     * requester who may not install must not be able to hold that open.
     */
    const incomplete = refused.length > 0;

    if (!incomplete) {
      const state: RehydrationStateFile = {
        completedAt: new Date().toISOString(),
        queuedUrns: queued,
        startedUrns: started,
        skipped,
      };
      await this.writeRehydrationState(state);
    }

    return {
      success: true,
      message: this.summarize(queued, started, refused, plan),
      incomplete,
      plan,
      queued,
      started,
      skipped,
    };
  }

  /**
   * What a finished run reports as its plan. It is only shown, so a Portal that cannot be asked right
   * now yields an empty plan rather than failing a restore that is already done.
   */
  private async planForCompletedRun(): Promise<RehydrationPlan> {
    try {
      return await this.buildPlanFromPortalApps(await this.fetchPortalApplications());
    } catch (error) {
      this.logger.warn(`Could not rebuild the plan of a finished restore: ${error instanceof Error ? error.message : String(error)}`);
      return { items: [], portalAppCount: 0, localAppDataCount: 0 };
    }
  }

  private summarize(queued: string[], started: string[], refused: string[], plan: RehydrationPlan): string {
    const acted = `Queued ${queued.length} install(s) and ${started.length} start(s) from Portal`;

    if (refused.length > 0) {
      // A refused start is an installed app its requester may not start, not one they may not install.
      const refusedStarts = plan.items.filter((item) => item.action === 'start' && item.appUrn !== undefined && refused.includes(item.appUrn)).length;
      const refusedInstalls = refused.length - refusedStarts;
      const what = [refusedInstalls > 0 ? `${refusedInstalls} install(s)` : '', refusedStarts > 0 ? `${refusedStarts} start(s)` : '']
        .filter(Boolean)
        .join(' and ');

      return `${acted}; ${what} were refused for this account`;
    }

    return queued.length + started.length > 0 ? acted : 'No apps required rehydration';
  }

  private async assertCanRehydrate(): Promise<void> {
    const status = await this.registrationService.getLiveRegistrationStatus();
    if (!isOperational(status.phase)) {
      throw new Error('Device must be registered and operational before rehydrating apps');
    }

    const apiKey = this.config.getConfig().ciHubApiKey;
    if (!apiKey?.trim()) {
      throw new Error('CI Hub device API key is not configured');
    }
  }

  /** Throws when the Portal gives no answer (`CloudflareClientService.getDeviceApplications`). */
  private async fetchPortalApplications(): Promise<PortalDeviceApplication[]> {
    const apps = await this.cloudflareClientService.getDeviceApplications();
    if (apps.length === 0) {
      return [];
    }

    // Precompute the set of available marketplace URNs once (one directory listing per
    // enabled store) and match in-memory, instead of an N×M per-app/per-store loop of
    // getAppInfoFromAppStore() disk reads.
    const availableUrns = new Set<string>(await this.marketplaceService.getAvailableAppUrns());

    /*
     * ⚠ AN EMPTY CATALOG MATCHES NOTHING. On a Hub that has not downloaded its app catalog yet, every
     * app below would be skipped as unlisted, the run recorded as done with nothing installed, and the
     * next sync would release all of them. That is not an answer about the apps, so it is not a run.
     */
    if (availableUrns.size === 0) {
      throw new Error(
        `CI Portal lists ${apps.length} app(s) for this device, but the app catalog has not been downloaded yet, so they cannot be restored`,
      );
    }
    const storeSlugs = await this.getStoreSlugsWithApps();
    const resolved: PortalDeviceApplication[] = [];

    for (const portalApp of apps) {
      const listed = storeSlugs.some((storeSlug) => availableUrns.has(createAppUrn(portalApp.name, storeSlug)));

      if (listed) {
        resolved.push(portalApp);
      } else {
        this.logger.warn(`Portal app "${portalApp.name}" has no marketplace listing — skipping`);
      }
    }

    return resolved;
  }

  private async buildPlanFromPortalApps(portalApps: PortalDeviceApplication[]): Promise<RehydrationPlan> {
    const localEntries = scanLocalAppData(APP_DATA_DIR);
    const storeSlugs = await this.getStoreSlugsWithApps();

    const portalUrns = new Set<AppUrn>();
    for (const portalApp of portalApps) {
      const urn = resolvePortalAppToUrn(portalApp, storeSlugs, localEntries);
      if (urn) {
        portalUrns.add(urn);
      }
    }

    const scopedLocalEntries = filterLocalEntriesForPortalUrns(localEntries, portalUrns);

    const dbApps = await this.appsRepository.getApps();
    const dbAppsByUrn = new Map(
      dbApps
        .filter((app) => portalUrns.has(createAppUrn(app.appName, app.appStoreSlug)))
        .map((app) => [`${app.appName}:${app.appStoreSlug}` as AppUrn, { status: app.status }]),
    );

    const installedComposeUrns = new Set<string>();
    for (const urn of portalUrns) {
      if (await this.hasInstalledCompose(urn)) {
        installedComposeUrns.add(urn);
      }
    }

    this.logger.info(
      `Rehydration plan: ${portalApps.length} Portal app(s), ${portalUrns.size} resolvable, ${localEntries.length} local app-data folder(s) on disk (${scopedLocalEntries.length} match Portal)`,
    );

    return buildRehydrationPlan({
      portalApps,
      storeSlugs,
      localEntries: scopedLocalEntries,
      installedComposeUrns,
      dbAppsByUrn,
    });
  }

  private async hasInstalledCompose(appUrn: AppUrn): Promise<boolean> {
    const { appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
    try {
      await fs.access(path.join(appInstalledDir, 'docker-compose.yml'));
      return true;
    } catch {
      return false;
    }
  }

  private async executePlanItem(
    item: RehydrationPlanItem,
    queued: string[],
    started: string[],
    skipped: RehydrationSkipped[],
    refused: string[],
    actor: LifecycleActor,
  ): Promise<void> {
    const label = item.portalApp.name;
    const target = item.appUrn ? { appUrn: item.appUrn } : {};

    if (item.action === 'skip_unresolved' || item.action === 'skip_running' || item.action === 'skip_busy') {
      skipped.push({ name: label, reason: item.reason ?? item.action, code: skipCodeForAction(item.action), ...target });
      return;
    }

    if (!item.appUrn || !item.form) {
      skipped.push({ name: label, reason: 'Missing install target', code: 'no_target', ...target });
      return;
    }

    // As the person who asked for the rehydrate: an app they may not start or install is skipped, not
    // started or installed.
    try {
      if (item.action === 'start') {
        await this.appLifecycleService.startApp({ appUrn: item.appUrn, skipPull: true, actor });
        started.push(item.appUrn);
        return;
      }

      await this.appLifecycleService.installApp({ appUrn: item.appUrn, form: item.form, actor });
      queued.push(item.appUrn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Rehydration failed for ${item.appUrn}: ${message}`);
      const refusal = isGrantRefusal(error);
      const params = messageParams(error);
      skipped.push({ name: label, reason: message, appUrn: item.appUrn, code: refusal ? 'refused' : 'failed', ...(params ? { params } : {}) });
      if (refusal) {
        refused.push(item.appUrn);
      }
    }
  }

  private async getStoreSlugsWithApps(): Promise<string[]> {
    const stores = await this.appStoreService.getEnabledAppStores();
    return stores.map((store) => store.slug);
  }

  private async readRehydrationState(): Promise<RehydrationStateFile | null> {
    return loadRehydrationStateFile();
  }

  private async writeRehydrationState(state: RehydrationStateFile): Promise<void> {
    await persistRehydrationStateFile(state);
  }
}
