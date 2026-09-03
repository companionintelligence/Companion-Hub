import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { APP_DATA_DIR } from '@/common/constants';
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
  plan: RehydrationPlan;
  queued: string[];
  started: string[];
  skipped: Array<{ name: string; reason: string }>;
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

  async executeRehydrate(options?: { force?: boolean; source?: 'restore'; operatorUserId?: number }): Promise<RehydrationExecuteResult> {
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

    for (const item of plan.items) {
      await this.executePlanItem(item, queued, started, skipped);
    }

    const state: RehydrationStateFile = {
      completedAt: new Date().toISOString(),
      queuedUrns: queued,
      startedUrns: started,
      skipped,
    };
    await this.writeRehydrationState(state);

    const restoreFlow = options?.source === 'restore' || (await hasRestoreIntent());
    if (restoreFlow && options?.operatorUserId) {
      await this.userRepository.updateUser(options.operatorUserId, { hasCompletedOnboarding: true });
      await clearRestoreIntent();
    }

    return {
      success: true,
      message:
        queued.length + started.length > 0
          ? `Queued ${queued.length} install(s) and ${started.length} start(s) from Portal`
          : 'No apps required rehydration',
      plan,
      queued,
      started,
      skipped,
    };
  }

  async hasRestoreIntent(): Promise<boolean> {
    return hasRestoreIntent();
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
  ): Promise<void> {
    const label = item.portalApp.name;

    if (item.action === 'skip_unresolved' || item.action === 'skip_running') {
      skipped.push({ name: label, reason: item.reason ?? item.action });
      return;
    }

    if (!item.appUrn || !item.form) {
      skipped.push({ name: label, reason: 'Missing install target' });
      return;
    }

    try {
      if (item.action === 'start') {
        await this.appLifecycleService.startApp({ appUrn: item.appUrn, skipPull: true });
        started.push(item.appUrn);
        return;
      }

      await this.appLifecycleService.installApp({ appUrn: item.appUrn, form: item.form });
      queued.push(item.appUrn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Rehydration failed for ${item.appUrn}: ${message}`);
      skipped.push({ name: label, reason: message });
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
