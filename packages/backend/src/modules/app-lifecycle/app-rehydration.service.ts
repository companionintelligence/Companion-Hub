import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { APP_DATA_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { CloudflareClientService, type PortalDeviceApplication } from '@/modules/cloudflare/cloudflare-client.service';
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
  resolvePortalAppToUrn,
  scanLocalAppData,
  type RehydrationPlan,
  type RehydrationPlanItem,
  type RehydrationStateFile,
} from './app-rehydration';
import {
  clearRestoreIntent,
  hasRestoreIntent,
  readRehydrationState as loadRehydrationStateFile,
  writeRehydrationState as persistRehydrationStateFile,
} from './registration-recovery-state';

export interface RehydrationExecuteResult {
  success: boolean;
  message: string;
  alreadyCompleted?: boolean;
  /**
   * An install was refused by the org-grant gate, so the run was not recorded as done and the next
   * rehydrate picks those apps up without `force`. See `executeRehydrate`.
   */
  incomplete?: boolean;
  plan: RehydrationPlan;
  queued: string[];
  started: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The org-grant gate's refusal. Unlike an install that fails, it is an answer about who asked — or,
 * with WhoIs unreachable, no answer at all — so another person, or a later try, may get further.
 */
function isGrantRefusal(error: unknown): boolean {
  return error instanceof TranslatableError && error.message === 'APP_ACTION_GRANT_DENIED';
}

@Injectable()
export class AppRehydrationService {
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

  async buildPlan(): Promise<RehydrationPlan> {
    await this.assertCanRehydrate();
    const portalApps = await this.fetchPortalApplications();
    return this.buildPlanFromPortalApps(portalApps);
  }

  async executeRehydrate(options: {
    force?: boolean;
    source?: 'restore';
    operatorUserId?: number;
    actor: LifecycleActor;
  }): Promise<RehydrationExecuteResult> {
    await this.assertCanRehydrate();

    const existing = await this.readRehydrationState();
    if (existing?.completedAt && !options?.force) {
      const plan = await this.buildPlan();
      return {
        success: true,
        message: 'Rehydration already completed for this registration epoch',
        alreadyCompleted: true,
        plan,
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
     * ⚠ A REFUSAL IS NOT A FINISHED RUN. The requester's grant decided those installs (CI-Hub#1397),
     * so another person — or the same one once WhoIs answers again — may be allowed. Recording the run
     * as done made the refusal final: nothing retried it without `force`, and the restore page moved
     * straight on without showing it.
     *
     * The restore intent below is still cleared. While it stands with no finished run, Cloudflare sync
     * stands down for the whole Hub (`ExposureSyncService.triggerCloudflareSync`), and a requester who
     * may not install must not be able to hold that open.
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

    const restoreFlow = options?.source === 'restore' || (await hasRestoreIntent());
    if (restoreFlow && options?.operatorUserId) {
      await this.userRepository.updateUser(options.operatorUserId, { hasCompletedOnboarding: true });
      await clearRestoreIntent();
    }

    return {
      success: true,
      message: this.summarize(queued, started, refused),
      incomplete,
      plan,
      queued,
      started,
      skipped,
    };
  }

  async hasRestoreIntent(): Promise<boolean> {
    return hasRestoreIntent();
  }

  private summarize(queued: string[], started: string[], refused: string[]): string {
    const acted = `Queued ${queued.length} install(s) and ${started.length} start(s) from Portal`;

    if (refused.length > 0) {
      return `${acted}; ${refused.length} install(s) were refused for this account`;
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

  private async fetchPortalApplications(): Promise<PortalDeviceApplication[]> {
    const apps = await this.cloudflareClientService.getDeviceApplications();
    // Precompute the set of available marketplace URNs once (one directory listing per
    // enabled store) and match in-memory, instead of an N×M per-app/per-store loop of
    // getAppInfoFromAppStore() disk reads.
    const availableUrns = new Set<string>(await this.marketplaceService.getAvailableAppUrns());
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
    skipped: Array<{ name: string; reason: string }>,
    refused: string[],
    actor: LifecycleActor,
  ): Promise<void> {
    const label = item.portalApp.name;

    if (item.action === 'skip_unresolved' || item.action === 'skip_running' || item.action === 'skip_busy') {
      skipped.push({ name: label, reason: item.reason ?? item.action });
      return;
    }

    if (!item.appUrn || !item.form) {
      skipped.push({ name: label, reason: 'Missing install target' });
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
      skipped.push({ name: label, reason: message });
      if (isGrantRefusal(error)) {
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
