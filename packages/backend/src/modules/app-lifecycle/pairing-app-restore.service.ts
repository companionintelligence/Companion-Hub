import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { isOperational } from '@/modules/registration/registration-state';
import { IN_FLIGHT_STATUSES } from './app-rehydration';
import { AppRehydrationService } from './app-rehydration.service';
import { DeviceKeyRefreshService } from './device-key-refresh.service';
import { ExposureSyncService } from './exposure-sync.service';
import {
  type PairingAppCheckFile,
  clearPairingAppCheck,
  clearRestoreIntent,
  hasRestoreIntent,
  readPairingAppCheck,
  readRehydrationState,
  writePairingAppCheck,
  writeRestoreIntent,
} from './registration-recovery-state';

/**
 * Where a pairing's apps check stands after one pass:
 *
 * - `none`: no pairing is waiting on a check.
 * - `waiting`: the Hub is not registered yet, or apps the Portal lists are mid-operation.
 * - `held`: the Portal could not be asked, or the restore could not run. App sync stays held and the
 *   check is tried again after a backoff.
 * - `restoring`: the restore has run and its installs are still settling.
 * - `released`: the check is done and app sync runs again.
 */
export type PairingAppCheckOutcome = 'none' | 'waiting' | 'held' | 'restoring' | 'released';

type LocalApp = Awaited<ReturnType<AppsRepository['getApps']>>[number];

/**
 * Makes pairing back onto an existing Companion Portal device restore that device's apps, instead of
 * releasing them.
 *
 * ⚠ A SYNC NAMES EVERY APP THIS HUB SERVES, AND THE PORTAL RELEASES THE REST. A Hub reinstalled and
 * paired back onto its device has none of the device's apps installed, so its first sync released all
 * of them: their DNS records and Portal rows were deleted and the device listed no apps. The Hub held
 * that sync back only when the person pairing had chosen "Restore" in the reconnect dialog, and even
 * then the restore itself ran only once they signed in and the restore page opened.
 *
 * So every pairing now leaves a check (`writePairingAppCheck`), and app sync is held while it stands
 * (`ExposureSyncService.triggerCloudflareSync`). This service works through it in the background, with
 * nobody signed in:
 *
 * 1. Once the Hub is registered, it reads the device's apps from the Portal with the new device key.
 *    If the Portal cannot be asked, the sync stays held and the read is retried with backoff. An empty
 *    list is not a guess the Hub may make: it is what releases everything.
 * 2. When the Portal lists apps this Hub does not have (or the person pairing chose "Restore"), it
 *    records restore intent and runs the restore flow (`AppRehydrationService.executeRehydrate`) as the
 *    Hub itself. The restore page, if someone has it open, joins that run rather than starting another.
 * 3. It lifts the hold once the restored apps have settled, so no sync goes out while they are still
 *    installing and would be left out of it, or after a deadline so a stuck install cannot hold every
 *    other app's DNS indefinitely.
 *
 * A pairing whose device has no apps on the Portal, or a Hub that still has them installed (a Settings
 * reset), is released on the first pass and syncs as before. Either way, apps that call the Portal as
 * this device are then given the new device key (`DeviceKeyRefreshService`).
 */
@Injectable()
export class PairingAppRestoreService implements OnApplicationBootstrap, OnApplicationShutdown {
  static readonly POLL_MS = 15_000;
  static readonly MAX_RETRY_DELAY_MS = 5 * 60_000;
  /** How long a restore's installs may hold app sync before it runs anyway. */
  static readonly SETTLE_DEADLINE_MS = 2 * 60 * 60_000;
  static readonly CATALOG_PULL_COOLDOWN_MS = 10 * 60_000;

  private timer: NodeJS.Timeout | null = null;
  private checkInFlight: Promise<PairingAppCheckOutcome> | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastCatalogPullAt = 0;
  /** Passes left in which to look for a device key an earlier re-pair left stale; see `tick`. */
  private startupKeyRefreshPasses = 20;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registrationService: RegistrationService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly appsRepository: AppsRepository,
    private readonly marketplaceService: MarketplaceService,
    private readonly appStoreService: AppStoreService,
    private readonly appRehydrationService: AppRehydrationService,
    private readonly exposureSyncService: ExposureSyncService,
    private readonly deviceKeyRefreshService: DeviceKeyRefreshService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.tick();
    }, PairingAppRestoreService.POLL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const outcome = await this.runCheck();

      /*
       * A Hub re-paired before this check existed may still hand Memory the old key. Look once, when it
       * is registered; the registration is read back from the database a moment after boot, so a Hub
       * that is not registered within the first few passes is left to its next pairing.
       */
      if (outcome === 'none' && this.startupKeyRefreshPasses > 0) {
        this.startupKeyRefreshPasses -= 1;
        if (isOperational((await this.registrationService.getLiveRegistrationStatus()).phase)) {
          this.startupKeyRefreshPasses = 0;
          await this.deviceKeyRefreshService.refreshStaleDeviceKeys();
        }
      }
    } catch (error) {
      this.logger.error(`[PairingAppRestore] Check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One pass over the pending check. Concurrent callers share the pass under way. */
  runCheck(): Promise<PairingAppCheckOutcome> {
    if (!this.checkInFlight) {
      this.checkInFlight = this.check().finally(() => {
        this.checkInFlight = null;
      });
    }

    return this.checkInFlight;
  }

  private async check(): Promise<PairingAppCheckOutcome> {
    let pending = await readPairingAppCheck();
    if (!pending) {
      return 'none';
    }

    if (Date.now() < this.retryAt) {
      return 'held';
    }

    const { phase } = await this.registrationService.getLiveRegistrationStatus();
    if (!isOperational(phase)) {
      return 'waiting';
    }

    if (!this.config.getConfig().ciHubApiKey?.trim()) {
      // With no device key neither the Portal's list nor a sync can be authenticated, so a sync cannot
      // release anything either.
      this.logger.warn('[PairingAppRestore] This Hub paired without a CI Portal device key; app sync is not held for the apps check');
      return this.release();
    }

    if (!pending.restore) {
      const decided = await this.decideRestore(pending);
      if (typeof decided === 'string') {
        return decided;
      }
      pending = decided;
    }

    const restore = pending.restore;
    if (!restore) {
      return 'held';
    }

    const rehydration = await readRehydrationState();
    const ranForThisPairing = Boolean(rehydration?.completedAt && Date.parse(rehydration.completedAt) >= Date.parse(pending.markedAt));

    if (!ranForThisPairing) {
      try {
        const result = await this.appRehydrationService.executeRehydrate({
          // A finished run left from an earlier pairing is not this one's.
          force: Boolean(rehydration?.completedAt),
          actor: { kind: 'system', reason: 'restore-after-pairing' },
        });

        if (result.incomplete) {
          return this.hold('some of the apps could not be restored yet');
        }

        /*
         * ⚠ "ALREADY COMPLETED" MAY NOT BE THIS PAIRING'S RESTORE. A run already under way is joined, and
         * its options win over `force`: a restore page run without it answers from a run an earlier
         * pairing left, and installs nothing. Taking that as done would release every app the Portal
         * lists. The next pass reads the state again: a run this pairing finished meanwhile is found
         * there, and anything else runs with `force`.
         */
        if (result.alreadyCompleted) {
          return this.hold('the restore that answered had not run for this pairing');
        }

        this.logger.info(`[PairingAppRestore] ${result.message}`);
      } catch (error) {
        await this.pullCatalogIfEmpty();
        return this.hold('the apps could not be restored', error);
      }
    }

    this.failures = 0;

    const unsettled = this.unsettledApps(restore.portalAppNames, await this.appsRepository.getApps());
    if (unsettled.length > 0) {
      if (Date.now() - Date.parse(restore.startedAt) < PairingAppRestoreService.SETTLE_DEADLINE_MS) {
        return 'restoring';
      }

      this.logger.warn(
        `[PairingAppRestore] ${unsettled.join(', ')} had still not settled ${PairingAppRestoreService.SETTLE_DEADLINE_MS / 3_600_000}h after the restore began; syncing apps anyway`,
      );
    }

    // The restore this intent asked for is done. Left in place, it would restore again on a later pairing.
    await clearRestoreIntent();
    return this.release();
  }

  /**
   * Reads the device's apps from the Portal and decides whether this pairing needs a restore. Returns
   * the check with its restore recorded, or where the pass ended.
   */
  private async decideRestore(pending: PairingAppCheckFile): Promise<PairingAppCheckFile | PairingAppCheckOutcome> {
    let portalApps: Awaited<ReturnType<CloudflareClientService['getDeviceApplications']>>;
    try {
      portalApps = await this.cloudflareClientService.getDeviceApplications();
    } catch (error) {
      return this.hold("the device's apps could not be read from CI Portal", error);
    }

    this.failures = 0;
    const localApps = await this.appsRepository.getApps();
    const installed = new Set(localApps.map((app) => app.appName));
    const missing = portalApps.filter((app) => !installed.has(app.name)).map((app) => app.name);
    const restoreChosen = await hasRestoreIntent();

    if (missing.length === 0 && !restoreChosen) {
      // The Portal's apps are all here, but a sync that runs while one is still installing leaves it out.
      if (
        this.unsettledApps(
          portalApps.map((app) => app.name),
          localApps,
        ).length > 0
      ) {
        return 'waiting';
      }

      return this.release();
    }

    this.logger.info(
      missing.length > 0
        ? `[PairingAppRestore] CI Portal lists ${missing.length} app(s) for this device that this Hub does not have (${missing.join(', ')}); restoring them before apps are synced`
        : '[PairingAppRestore] Restore was chosen for this pairing; restoring the apps CI Portal lists before apps are synced',
    );

    const withRestore: PairingAppCheckFile = {
      ...pending,
      restore: { startedAt: new Date().toISOString(), portalAppNames: portalApps.map((app) => app.name) },
    };
    await writeRestoreIntent();
    await writePairingAppCheck(withRestore);

    return withRestore;
  }

  /** The named apps whose rows are mid-operation. An app with no row was not installed, so it has nothing to settle. */
  private unsettledApps(names: string[], localApps: LocalApp[]): string[] {
    const wanted = new Set(names);
    return localApps.filter((app) => wanted.has(app.appName) && IN_FLIGHT_STATUSES.has(app.status)).map((app) => app.appName);
  }

  private async release(): Promise<PairingAppCheckOutcome> {
    await clearPairingAppCheck();
    this.failures = 0;
    this.retryAt = 0;
    this.startupKeyRefreshPasses = 0;

    try {
      await this.deviceKeyRefreshService.refreshStaleDeviceKeys();
    } catch (error) {
      this.logger.error(
        `[PairingAppRestore] Could not refresh the device key held by apps: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    void this.exposureSyncService.syncExposurePublic().catch((error) => {
      this.logger.error(`[PairingAppRestore] App sync after the apps check failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return 'released';
  }

  private hold(reason: string, error?: unknown): PairingAppCheckOutcome {
    this.failures += 1;
    const delay = Math.min(PairingAppRestoreService.MAX_RETRY_DELAY_MS, PairingAppRestoreService.POLL_MS * 2 ** (this.failures - 1));
    this.retryAt = Date.now() + delay;

    const cause = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
    this.logger.warn(`[PairingAppRestore] App sync stays held because ${reason}${cause}. Trying again in ${Math.round(delay / 1000)}s`);

    return 'held';
  }

  /** A Hub that has not downloaded its app catalog cannot match any app to an install, so fetch it now. */
  private async pullCatalogIfEmpty(): Promise<void> {
    if (Date.now() - this.lastCatalogPullAt < PairingAppRestoreService.CATALOG_PULL_COOLDOWN_MS) {
      return;
    }

    try {
      if ((await this.marketplaceService.getAvailableAppUrns()).length > 0) {
        return;
      }

      this.lastCatalogPullAt = Date.now();
      this.logger.info('[PairingAppRestore] The app catalog is empty; downloading it so the apps can be restored');
      void this.appStoreService.pullRepositories().catch((error) => {
        this.logger.error(`[PairingAppRestore] App catalog download failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.logger.warn(`[PairingAppRestore] Could not check the app catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
