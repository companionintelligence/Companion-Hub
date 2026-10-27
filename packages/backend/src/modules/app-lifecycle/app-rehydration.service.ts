import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
import { SUPPORTED_APP_SLUGS } from '@/modules/inference/app-credentials.service';
import { bootstrapAppNamesForSlug } from '@/modules/inference/bootstrap-app-names';
import { CreatePortExposeAppDto } from '@/modules/custom-apps/dto/custom-apps.dto';
import { PORT_EXPOSE_KIND } from '@ci-hub/common/schemas';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { isOperational } from '@/modules/registration/registration-state';
import type { AppUrn } from '@ci-hub/common/types';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { AppLifecycleService } from './app-lifecycle.service';
import {
  buildRehydrationPlan,
  CATALOG_DOWNLOAD_WAIT_MS,
  CatalogStillDownloadingError,
  type ExposedPortEntry,
  type ExposedPortTarget,
  exposedPortTarget,
  filterLocalEntriesForPortalUrns,
  isKeptAppSkip,
  planExposedPorts,
  resolvePortalAppToUrn,
  scanLocalAppData,
  skipCodeForAction,
  UNLISTED_REASON,
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
  type RestoreNoticeFile,
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
  /** The Hub hands this app a chat model (`usesChatModel`). */
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
  /** Whether anyone has chosen a chat model on this Hub. Until then AI apps get the setup wizard's Default. */
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

/**
 * Whether the Hub hands this app a chat model: by its listing (`isAiAppInfo`), or as an agent that
 * fetches its credentials from the Hub. OpenClaw's listing is filed under `development` with no
 * inference mapping, and it is the app most likely to be running on a model nobody chose.
 */
function usesChatModel(appName: string, info: Parameters<typeof isAiAppInfo>[0] | undefined): boolean {
  if (info && isAiAppInfo(info)) {
    return true;
  }
  return SUPPORTED_APP_SLUGS.some((slug) => bootstrapAppNamesForSlug(slug).includes(appName));
}

/**
 * The finished run that belongs to this pairing's restore notice, or `null`.
 *
 * ⚠ A RECORD OLDER THAN THE NOTICE IS AN EARLIER PAIRING'S. A re-pairing that does not reset the
 * registration first (`cihub register`) keeps the last record until this pairing's run replaces it.
 * Read as this pairing's, it showed the last pairing's apps as restored while this restore was still
 * running, and a Continue there acknowledged a restore nobody had seen.
 */
function runForNotice(state: RehydrationStateFile | null, notice: RestoreNoticeFile | null | undefined): RehydrationStateFile | null {
  if (!state?.completedAt) {
    return null;
  }
  if (!notice?.startedAt) {
    return state;
  }
  const finished = Date.parse(state.completedAt);
  const started = Date.parse(notice.startedAt);
  return Number.isNaN(finished) || Number.isNaN(started) || finished >= started ? state : null;
}

/** A finished run with no app in it: the Portal listed none, so nothing came back and nothing failed. */
function restoredNothing(state: RehydrationStateFile): boolean {
  return state.queuedUrns.length === 0 && state.startedUrns.length === 0 && state.skipped.length === 0;
}

/**
 * The Portal's apps for this device, told apart: the ports it exposed (#2131), the rows marked as one that
 * the restore cannot rebuild (`exposedPortTarget`) and the rest, which a store may list. A marked row is
 * never a store app. Matched against the stores, it installed a store app that happened to share its name.
 */
function splitExposedPorts(portalApps: PortalDeviceApplication[]): {
  storeApps: PortalDeviceApplication[];
  exposed: ExposedPortEntry[];
  unrebuildable: PortalDeviceApplication[];
} {
  const storeApps: PortalDeviceApplication[] = [];
  const exposed: ExposedPortEntry[] = [];
  const unrebuildable: PortalDeviceApplication[] = [];
  for (const portalApp of portalApps) {
    const target = exposedPortTarget(portalApp);
    if (target) {
      exposed.push({ portalApp, target });
    } else if (portalApp.kind === PORT_EXPOSE_KIND) {
      unrebuildable.push(portalApp);
    } else {
      storeApps.push(portalApp);
    }
  }
  return { storeApps, exposed, unrebuildable };
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
    private readonly moduleRef: ModuleRef,
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
   *
   * A run that finished with no app in it (Restore was chosen for a device the Portal lists no apps
   * for) leaves nothing to show, so it opens setup as a pairing with nothing to restore does.
   */
  async getRestoreStatus(mayManage: () => Promise<boolean>): Promise<RestoreStatus> {
    const [{ completed, state }, restoreIntent, pairingCheck, notice] = await Promise.all([
      this.getRehydrationStatus(),
      hasRestoreIntent(),
      readPairingAppCheck(),
      readRestoreNotice(),
    ]);
    const run = runForNotice(state, notice);
    const unseen = Boolean(notice?.startedAt && !notice.acknowledgedAt) && !(run && restoredNothing(run));
    const noticePending = unseen && (await mayManage());
    const summary = noticePending && run ? await this.buildRestoreSummary(run) : undefined;

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
   * was set up before, so its setup wizard is not asked for again; one that never finished, or found no
   * app to restore, leaves it.
   */
  async acknowledgeRestore(): Promise<void> {
    await acknowledgeRestoreNotice();
    const state = await this.readRehydrationState();
    if (state?.completedAt && !restoredNothing(state)) {
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
        const appName = urn.split(':')[0] ?? urn;
        return { name: info?.name || appName, urn, status: rows.get(urn) ?? 'missing', usesAi: usesChatModel(appName, info) };
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
    const { listed, exposed } = await this.fetchPortalApplications();
    return this.buildPlanFromPortalApps(listed, exposed, await this.restoresExposedPorts());
  }

  /**
   * Whether this rehydrate may put back the ports the Portal lists as exposed on this device: only the
   * restore after a pairing, while that pairing's apps check stands. That is the one time a Hub has
   * lost its own record of them and takes the Portal's word for what to publish (#2131).
   */
  private async restoresExposedPorts(): Promise<boolean> {
    return Boolean(await readPairingAppCheck());
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
    // A record older than this pairing's restore notice is an earlier pairing's (see runForNotice), so it
    // does not answer for this one.
    if (existing?.completedAt && !options?.force && runForNotice(existing, await readRestoreNotice())) {
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

    const { listed, unlisted, exposed } = await this.fetchPortalApplications(CATALOG_DOWNLOAD_WAIT_MS);
    const plan = await this.buildPlanFromPortalApps(listed, exposed, await this.restoresExposedPorts());

    const queued: string[] = [];
    const started: string[] = [];
    /** Exposed ports put back. Recorded with the starts: like them, they are serving when the run ends. */
    const exposedUrns: string[] = [];
    /*
     * An app the Portal lists that no store here does is not in the plan, but it was not restored
     * either. Leaving it out of the record left it out of the summary the next sign-in shows, so
     * nobody was told it did not come back.
     */
    const skipped: RehydrationSkipped[] = unlisted.map((portalApp) => ({ name: portalApp.name, reason: UNLISTED_REASON, code: 'unlisted' }));
    const refused: string[] = [];

    for (const item of plan.items) {
      await this.executePlanItem(item, { queued, started, exposed: exposedUrns, skipped, refused }, options.actor);
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
        startedUrns: [...started, ...exposedUrns],
        skipped,
      };
      await this.writeRehydrationState(state);
    }

    return {
      success: true,
      message: this.summarize(queued, started, exposedUrns, refused, plan),
      incomplete,
      plan,
      queued,
      started: [...started, ...exposedUrns],
      skipped,
    };
  }

  /**
   * What a finished run reports as its plan. It is only shown, so a Portal that cannot be asked right
   * now yields an empty plan rather than failing a restore that is already done.
   */
  private async planForCompletedRun(): Promise<RehydrationPlan> {
    try {
      const { listed, exposed } = await this.fetchPortalApplications();
      return await this.buildPlanFromPortalApps(listed, exposed, false);
    } catch (error) {
      this.logger.warn(`Could not rebuild the plan of a finished restore: ${error instanceof Error ? error.message : String(error)}`);
      return { items: [], portalAppCount: 0, localAppDataCount: 0 };
    }
  }

  private summarize(queued: string[], started: string[], exposed: string[], refused: string[], plan: RehydrationPlan): string {
    const queuedAndStarted = `Queued ${queued.length} install(s) and ${started.length} start(s) from Portal`;
    const acted = exposed.length > 0 ? `${queuedAndStarted} and exposed ${exposed.length} port(s) again` : queuedAndStarted;

    if (refused.length > 0) {
      // A refused start is an installed app its requester may not start, not one they may not install.
      const refusedStarts = plan.items.filter((item) => item.action === 'start' && item.appUrn !== undefined && refused.includes(item.appUrn)).length;
      const refusedInstalls = refused.length - refusedStarts;
      const what = [refusedInstalls > 0 ? `${refusedInstalls} install(s)` : '', refusedStarts > 0 ? `${refusedStarts} start(s)` : '']
        .filter(Boolean)
        .join(' and ');

      return `${acted}; ${what} were refused for this account`;
    }

    return queued.length + started.length + exposed.length > 0 ? acted : 'No apps required rehydration';
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

  /**
   * The device's apps from the Portal: the ports this device exposed (#2131), those an enabled store
   * here lists and those none does. Throws when the Portal gives no answer
   * (`CloudflareClientService.getDeviceApplications`).
   *
   * Exposed ports are told apart first (`splitExposedPorts`). They come from no store, so neither the
   * catalog download nor an empty catalog says anything about them.
   */
  private async fetchPortalApplications(catalogDownloadWaitMs = 0): Promise<{
    listed: PortalDeviceApplication[];
    unlisted: PortalDeviceApplication[];
    exposed: ExposedPortEntry[];
  }> {
    let split = splitExposedPorts(await this.cloudflareClientService.getDeviceApplications());
    let apps = split.storeApps;
    if (apps.length === 0) {
      return { listed: [], unlisted: split.unrebuildable, exposed: split.exposed };
    }

    /*
     * ⚠ A CATALOG STILL DOWNLOADING IS MISSING APPS. The download writes the apps' folders a dozen at a
     * time, so an app it has not reached yet was skipped below as unlisted. The run was recorded as done
     * and the next sync released it. A pairing right after a factory reset met the reset's download. A retry
     * 15 s after `PairingAppRestoreService` started one met that one. So a restore waits for the download
     * to end first, for `catalogDownloadWaitMs`. Asked again after the listing, so a download that starts
     * during it counts too.
     */
    const catalogStillDownloading = () =>
      new CatalogStillDownloadingError(
        `CI Portal lists ${apps.length} app(s) for this device, but the app catalog is still downloading, so they cannot be restored yet`,
      );
    if (this.appStoreService.isDownloadingCatalog()) {
      if (!(await this.appStoreService.waitForCatalogDownloads(catalogDownloadWaitMs))) {
        throw catalogStillDownloading();
      }

      // Read again after the wait, with the device key the Hub holds now. A factory reset or a pairing
      // onto another device may have come meanwhile. The list read before it was then the old device's.
      split = splitExposedPorts(await this.cloudflareClientService.getDeviceApplications());
      apps = split.storeApps;
      if (apps.length === 0) {
        return { listed: [], unlisted: split.unrebuildable, exposed: split.exposed };
      }
    }

    // Precompute the set of available marketplace URNs once (one directory listing per
    // enabled store) and match in-memory, instead of an N×M per-app/per-store loop of
    // getAppInfoFromAppStore() disk reads.
    const availableUrns = new Set<string>(await this.marketplaceService.getAvailableAppUrns());

    if (this.appStoreService.isDownloadingCatalog()) {
      throw catalogStillDownloading();
    }

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
    const listed: PortalDeviceApplication[] = [];
    const unlisted: PortalDeviceApplication[] = [];

    for (const portalApp of apps) {
      if (storeSlugs.some((storeSlug) => availableUrns.has(createAppUrn(portalApp.name, storeSlug)))) {
        listed.push(portalApp);
      } else {
        this.logger.warn(`Portal app "${portalApp.name}" has no marketplace listing — skipping`);
        unlisted.push(portalApp);
      }
    }

    return { listed, unlisted: [...split.unrebuildable, ...unlisted], exposed: split.exposed };
  }

  /**
   * The plan for `portalApps`, the store apps, with an item for each exposed port after them.
   * `restoreExposedPorts` says whether a missing one is put back (`restoresExposedPorts`).
   */
  private async buildPlanFromPortalApps(
    portalApps: PortalDeviceApplication[],
    exposed: ReadonlyArray<ExposedPortEntry> = [],
    restoreExposedPorts = false,
  ): Promise<RehydrationPlan> {
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

    const plan = buildRehydrationPlan({
      portalApps,
      storeSlugs,
      localEntries: scopedLocalEntries,
      installedComposeUrns,
      dbAppsByUrn,
    });
    if (exposed.length === 0) {
      return plan;
    }

    const exposedItems = planExposedPorts({
      exposed,
      dbAppsByUrn: new Map(dbApps.map((app) => [createAppUrn(app.appName, app.appStoreSlug), { status: app.status }])),
      restore: restoreExposedPorts,
    });
    return { ...plan, items: [...plan.items, ...exposedItems], portalAppCount: plan.portalAppCount + exposed.length };
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
    outcome: { queued: string[]; started: string[]; exposed: string[]; skipped: RehydrationSkipped[]; refused: string[] },
    actor: LifecycleActor,
  ): Promise<void> {
    const { queued, started, exposed, skipped, refused } = outcome;
    const label = item.portalApp.name;
    const target = item.appUrn ? { appUrn: item.appUrn } : {};

    if (item.action === 'skip_unresolved' || item.action === 'skip_running' || item.action === 'skip_busy') {
      skipped.push({ name: label, reason: item.reason ?? item.action, code: skipCodeForAction(item.action), ...target });
      return;
    }

    if (!item.appUrn || (item.action === 'expose' ? !item.exposedPort : !item.form)) {
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

      if (item.action === 'expose' && item.exposedPort) {
        await this.exposePortAgain(item.portalApp.name, item.exposedPort);
        exposed.push(item.appUrn);
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

  /**
   * Puts back a port this device exposed before a reinstall, in the mode it had (#2131).
   *
   * Through `PortExposeService`, so it is held to everything "Expose a port" is: the name and the port
   * must be free here. Something must also answer on the port. That last check is why a port whose
   * program is not running comes back under **Not restored**, with the reason. The values are checked
   * against the form's own schema first, since this call does not come through its route.
   *
   * Looked up when needed, as `AppLifecycleService` does for exposed ports: `PortExposeService` lives in
   * a module that imports this one.
   */
  private async exposePortAgain(name: string, target: ExposedPortTarget): Promise<void> {
    const parsed = CreatePortExposeAppDto.schema.safeParse({
      name,
      port: target.port,
      exposureMode: target.exposureMode,
      localSubdomain: target.localSubdomain,
      publicDomain: target.publicDomain,
    });
    if (!parsed.success) {
      throw new Error("CI Portal's details for this exposed port are not ones Expose a port accepts, so it was not exposed again");
    }
    const request = parsed.data;

    // `ModuleRef.get` throws for a provider it cannot find, so there is no missing service to check for.
    const { PortExposeService } = await import('../custom-apps/port-expose.service');
    await this.moduleRef.get(PortExposeService, { strict: false }).createPortExposeApp(request);
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
