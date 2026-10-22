import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppStoreService } from '@/modules/app-stores/app-store.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import type { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { RegistrationService } from '@/modules/registration/registration.service';
import type { AppRehydrationService, RehydrationExecuteResult } from '../app-rehydration.service';
import type { DeviceKeyRefreshService } from '../device-key-refresh.service';
import type { ExposureSyncService } from '../exposure-sync.service';
import { PairingAppRestoreService } from '../pairing-app-restore.service';
import * as recovery from '../registration-recovery-state';
import type { PairingAppCheckFile } from '../registration-recovery-state';
import { CatalogStillDownloadingError, type RehydrationStateFile } from '../app-rehydration';

vi.mock('../registration-recovery-state', () => ({
  readPairingAppCheck: vi.fn(),
  writePairingAppCheck: vi.fn(),
  clearPairingAppCheck: vi.fn(),
  hasRestoreIntent: vi.fn(),
  writeRestoreIntent: vi.fn(),
  clearRestoreIntent: vi.fn(),
  readRehydrationState: vi.fn(),
  startRestoreNotice: vi.fn(),
}));

const portalApp = (name: string) => ({ id: `id-${name}`, name, slug: name, port: 80, publicDomain: null });
const localApp = (appName: string, status = 'running') => ({ appName, appStoreSlug: 'ci-marketplace', status }) as never;
const completedRun = (overrides: Partial<RehydrationExecuteResult> = {}) =>
  ({
    success: true,
    message: 'Queued 2 install(s) and 0 start(s) from Portal',
    incomplete: false,
    queued: [],
    started: [],
    skipped: [],
    ...overrides,
  }) as never;

/*
 * A Hub reinstalled and paired back onto its Portal device (with a "Regenerate pairing code" code, not
 * the reconnect dialog's Restore) synced its empty app list, and the Portal released wordpress,
 * ci-memory and ci-hermes. Pairing now leaves a check that holds app sync until this service has read
 * the device's apps from the Portal and restored the missing ones.
 */
describe('PairingAppRestoreService', () => {
  let state: {
    check: PairingAppCheckFile | null;
    restoreIntent: boolean;
    rehydration: RehydrationStateFile | null;
    noticeStarted: boolean;
  };
  let registration: MockProxy<RegistrationService>;
  let cloudflare: MockProxy<CloudflareClientService>;
  let apps: MockProxy<AppsRepository>;
  let marketplace: MockProxy<MarketplaceService>;
  let appStores: MockProxy<AppStoreService>;
  let rehydration: MockProxy<AppRehydrationService>;
  let exposureSync: MockProxy<ExposureSyncService>;
  let keyRefresh: MockProxy<DeviceKeyRefreshService>;
  let config: { getConfig: () => { ciHubApiKey: string | null } };
  let service: PairingAppRestoreService;

  const pairedAt = new Date(Date.now() - 60_000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();

    // The state files, in memory, so what one pass writes the next one reads.
    state = { check: { markedAt: pairedAt }, restoreIntent: false, rehydration: null, noticeStarted: false };
    vi.mocked(recovery.startRestoreNotice).mockImplementation(async () => {
      state.noticeStarted = true;
    });
    vi.mocked(recovery.readPairingAppCheck).mockImplementation(async () => state.check);
    vi.mocked(recovery.writePairingAppCheck).mockImplementation(async (check) => {
      state.check = check ?? { markedAt: new Date().toISOString() };
    });
    vi.mocked(recovery.clearPairingAppCheck).mockImplementation(async () => {
      state.check = null;
    });
    vi.mocked(recovery.hasRestoreIntent).mockImplementation(async () => state.restoreIntent);
    vi.mocked(recovery.writeRestoreIntent).mockImplementation(async () => {
      state.restoreIntent = true;
    });
    vi.mocked(recovery.clearRestoreIntent).mockImplementation(async () => {
      state.restoreIntent = false;
    });
    vi.mocked(recovery.readRehydrationState).mockImplementation(async () => state.rehydration);

    registration = mock<RegistrationService>();
    registration.getLiveRegistrationStatus.mockResolvedValue({ phase: 'publicly_ready' } as never);
    cloudflare = mock<CloudflareClientService>();
    apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([]);
    marketplace = mock<MarketplaceService>();
    marketplace.getAvailableAppUrns.mockResolvedValue(['wordpress:ci-marketplace'] as never);
    appStores = mock<AppStoreService>();
    appStores.pullRepositories.mockResolvedValue({ success: true });
    rehydration = mock<AppRehydrationService>();
    rehydration.executeRehydrate.mockImplementation(async () => {
      state.rehydration = { completedAt: new Date().toISOString(), queuedUrns: [], startedUrns: [], skipped: [] };
      return completedRun();
    });
    exposureSync = mock<ExposureSyncService>();
    exposureSync.syncExposurePublic.mockResolvedValue(undefined);
    keyRefresh = mock<DeviceKeyRefreshService>();
    keyRefresh.refreshStaleDeviceKeys.mockResolvedValue([]);
    config = { getConfig: () => ({ ciHubApiKey: 'new-device-key' }) };

    service = new PairingAppRestoreService(
      mock<LoggerService>(),
      config as unknown as ConfigurationService,
      registration,
      cloudflare,
      apps,
      marketplace,
      appStores,
      rehydration,
      exposureSync,
      keyRefresh,
    );
  });

  it('does nothing when no pairing is waiting on a check', async () => {
    state.check = null;

    await expect(service.runCheck()).resolves.toBe('none');

    expect(cloudflare.getDeviceApplications).not.toHaveBeenCalled();
    expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
  });

  it('waits for the registration to be operational before asking the Portal', async () => {
    registration.getLiveRegistrationStatus.mockResolvedValue({ phase: 'paired' } as never);

    await expect(service.runCheck()).resolves.toBe('waiting');

    expect(cloudflare.getDeviceApplications).not.toHaveBeenCalled();
    expect(state.check).not.toBeNull();
  });

  describe('when the Portal lists apps this Hub does not have', () => {
    beforeEach(() => {
      cloudflare.getDeviceApplications.mockResolvedValue([portalApp('wordpress'), portalApp('ci-memory'), portalApp('ci-hermes')]);
      apps.getApps.mockResolvedValue([]);
    });

    it('records restore intent and restores them as the Hub, with nobody signed in', async () => {
      apps.getApps.mockResolvedValueOnce([]).mockResolvedValue([localApp('wordpress', 'installing'), localApp('ci-memory', 'installing')]);

      await expect(service.runCheck()).resolves.toBe('restoring');

      expect(state.restoreIntent).toBe(true);
      expect(rehydration.executeRehydrate).toHaveBeenCalledWith({ force: false, actor: { kind: 'system', reason: 'restore-after-pairing' } });
      expect(state.check?.restore?.portalAppNames).toEqual(['wordpress', 'ci-memory', 'ci-hermes']);
      // Syncing now would leave out every app still installing, and the Portal would release it.
      expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
    });

    /*
     * Nobody is signed in while this runs, so the person who signs in next was never on the restore
     * page. What sent them there was a choice one browser had stored; everyone else got the setup
     * wizard on a Hub that already had its apps. An app that failed was only in the log.
     */
    it('leaves a notice of the restore for whoever signs in next', async () => {
      await service.runCheck();

      expect(state.noticeStarted).toBe(true);
      expect(vi.mocked(recovery.startRestoreNotice).mock.invocationCallOrder[0]).toBeLessThan(
        rehydration.executeRehydrate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });

    // A factory reset removed the check while the pass waited on the Portal. Written back, it named the old device's apps.
    it('writes no check back when a forget overtook the pass', async () => {
      let answer: (value: ReturnType<typeof portalApp>[]) => void = () => undefined;
      cloudflare.getDeviceApplications.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
      );

      const pass = service.runCheck();
      await vi.waitFor(() => expect(cloudflare.getDeviceApplications).toHaveBeenCalled());
      state.check = null;
      service.forget();
      answer([portalApp('wordpress')]);

      await expect(pass).resolves.toBe('none');
      expect(state.check).toBeNull();
      expect(state.restoreIntent).toBe(false);
      expect(rehydration.executeRehydrate).not.toHaveBeenCalled();
    });

    it('lifts the hold and syncs once the restored apps have settled', async () => {
      apps.getApps.mockResolvedValueOnce([]).mockResolvedValue([localApp('wordpress', 'installing')]);
      await service.runCheck();

      apps.getApps.mockResolvedValue([localApp('wordpress'), localApp('ci-memory'), localApp('ci-hermes', 'install_failed')]);

      await expect(service.runCheck()).resolves.toBe('released');

      // The restore ran once: the second pass found this pairing's finished run.
      expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(1);
      expect(state.check).toBeNull();
      expect(state.restoreIntent).toBe(false);
      expect(exposureSync.syncExposurePublic).toHaveBeenCalledTimes(1);
      expect(keyRefresh.refreshStaleDeviceKeys).toHaveBeenCalled();
    });

    it('syncs anyway once an install has held it past the deadline', async () => {
      state.check = {
        markedAt: pairedAt,
        restore: { startedAt: new Date(Date.now() - PairingAppRestoreService.SETTLE_DEADLINE_MS - 1).toISOString(), portalAppNames: ['wordpress'] },
      };
      state.rehydration = { completedAt: new Date().toISOString(), queuedUrns: [], startedUrns: [], skipped: [] };
      apps.getApps.mockResolvedValue([localApp('wordpress', 'installing')]);

      await expect(service.runCheck()).resolves.toBe('released');

      expect(exposureSync.syncExposurePublic).toHaveBeenCalled();
    });

    it('runs the restore again when the only finished run is from an earlier pairing', async () => {
      state.rehydration = { completedAt: new Date(Date.now() - 86_400_000).toISOString(), queuedUrns: [], startedUrns: [], skipped: [] };

      await service.runCheck();

      expect(rehydration.executeRehydrate).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });

    // The restore page's run, joined while it was under way, answered from a run an earlier pairing left.
    it('keeps the hold when the run it joined had finished for an earlier pairing, and restores on the next pass', async () => {
      vi.useFakeTimers({ now: Date.now() });
      try {
        state.rehydration = { completedAt: new Date(Date.now() - 86_400_000).toISOString(), queuedUrns: [], startedUrns: [], skipped: [] };
        rehydration.executeRehydrate.mockResolvedValueOnce(completedRun({ alreadyCompleted: true }));

        await expect(service.runCheck()).resolves.toBe('held');

        expect(state.check).not.toBeNull();
        expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();

        vi.advanceTimersByTime(PairingAppRestoreService.POLL_MS);
        apps.getApps.mockResolvedValue([localApp('wordpress', 'installing')]);

        await expect(service.runCheck()).resolves.toBe('restoring');
        expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(2);
        expect(rehydration.executeRehydrate).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the hold and retries later when the restore cannot run', async () => {
      rehydration.executeRehydrate.mockRejectedValue(
        new Error('CI Portal lists 3 app(s) for this device, but the app catalog has not been downloaded yet'),
      );
      marketplace.getAvailableAppUrns.mockResolvedValue([]);

      await expect(service.runCheck()).resolves.toBe('held');

      expect(state.check).not.toBeNull();
      expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
      // An empty catalog matches no app to an install, so it is fetched rather than waited on for an hour.
      expect(appStores.pullRepositories).toHaveBeenCalledTimes(1);
      // Backed off: the next pass does not hammer the restore.
      await expect(service.runCheck()).resolves.toBe('held');
      expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(1);
    });

    // A factory reset starts a catalog download. The pairing after it came while it ran. A second download wrote the same folders at once.
    it('starts no second catalog download while one is under way', async () => {
      rehydration.executeRehydrate.mockRejectedValue(
        new Error('CI Portal lists 3 app(s) for this device, but the app catalog is still downloading, so they cannot be restored yet'),
      );
      marketplace.getAvailableAppUrns.mockResolvedValue([]);
      appStores.isDownloadingCatalog.mockReturnValue(true);

      await expect(service.runCheck()).resolves.toBe('held');

      expect(appStores.pullRepositories).not.toHaveBeenCalled();
      expect(state.check).not.toBeNull();
      expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
    });

    // The reset empties `repos/`. A pairing within ten minutes of the last pairing's download found the catalog empty and fetched none.
    it('downloads the catalog for the next pairing after forget, inside the last download cooldown', async () => {
      rehydration.executeRehydrate.mockRejectedValue(
        new Error('CI Portal lists 3 app(s) for this device, but the app catalog has not been downloaded yet'),
      );
      marketplace.getAvailableAppUrns.mockResolvedValue([]);
      await expect(service.runCheck()).resolves.toBe('held');
      expect(appStores.pullRepositories).toHaveBeenCalledTimes(1);

      service.forget();
      state.check = { markedAt: new Date().toISOString() };

      await expect(service.runCheck()).resolves.toBe('held');
      expect(appStores.pullRepositories).toHaveBeenCalledTimes(2);
    });

    // A pass still waiting on the Portal when the reset ran found the catalog the reset emptied. Its download
    // ran before the reset put the store back, fetched nothing and set the cooldown again.
    it('starts no catalog download from a pass that began before forget', async () => {
      rehydration.executeRehydrate.mockImplementationOnce(async () => {
        service.forget();
        throw new Error('CI Portal lists 3 app(s) for this device, but the app catalog has not been downloaded yet');
      });
      marketplace.getAvailableAppUrns.mockResolvedValue([]);

      await expect(service.runCheck()).resolves.toBe('held');
      expect(appStores.pullRepositories).not.toHaveBeenCalled();

      rehydration.executeRehydrate.mockRejectedValue(
        new Error('CI Portal lists 3 app(s) for this device, but the app catalog has not been downloaded yet'),
      );
      await expect(service.runCheck()).resolves.toBe('held');
      expect(appStores.pullRepositories).toHaveBeenCalledTimes(1);
    });

    // The restore can wait a minute on a catalog download. A reset and the next pairing can come meanwhile.
    it("leaves the next pairing's check alone when a reset came while the restore ran", async () => {
      const nextPairing = { markedAt: new Date(Date.now() + 1_000).toISOString() };
      rehydration.executeRehydrate.mockImplementationOnce(async () => {
        service.forget();
        state.check = nextPairing;
        return completedRun();
      });

      await expect(service.runCheck()).resolves.toBe('none');

      expect(state.check).toBe(nextPairing);
      expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
    });

    // A download under way ends on its own. Counted as a failure, each pass doubled the wait, up to five minutes.
    it('asks again at the next pass, without backing off, while the catalog downloads', async () => {
      vi.useFakeTimers({ now: Date.now() });
      try {
        rehydration.executeRehydrate.mockRejectedValue(
          new CatalogStillDownloadingError('CI Portal lists 3 app(s) for this device, but the app catalog is still downloading'),
        );
        appStores.isDownloadingCatalog.mockReturnValue(true);

        for (let pass = 1; pass <= 3; pass++) {
          await expect(service.runCheck()).resolves.toBe('held');
          expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(pass);
          vi.advanceTimersByTime(PairingAppRestoreService.REQUEST_MIN_INTERVAL_MS);
        }
        expect(appStores.pullRepositories).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('holds app sync and retries when the Portal cannot be asked for the apps', async () => {
    cloudflare.getDeviceApplications.mockRejectedValue(new Error("Could not read this device's apps from CI Portal: 503"));

    await expect(service.runCheck()).resolves.toBe('held');

    // An unanswered read is not "no apps": syncing on it is what released every app on the device.
    expect(state.check).not.toBeNull();
    expect(state.restoreIntent).toBe(false);
    expect(rehydration.executeRehydrate).not.toHaveBeenCalled();
    expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
  });

  it('asks the Portal again once the backoff has passed', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      cloudflare.getDeviceApplications.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValue([]);

      await expect(service.runCheck()).resolves.toBe('held');
      await expect(service.runCheck()).resolves.toBe('held');
      expect(cloudflare.getDeviceApplications).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(PairingAppRestoreService.POLL_MS);

      await expect(service.runCheck()).resolves.toBe('released');
      expect(exposureSync.syncExposurePublic).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncs as before when the Portal has no apps for the device', async () => {
    cloudflare.getDeviceApplications.mockResolvedValue([]);

    await expect(service.runCheck()).resolves.toBe('released');

    expect(state.check).toBeNull();
    expect(state.restoreIntent).toBe(false);
    expect(state.noticeStarted).toBe(false);
    expect(rehydration.executeRehydrate).not.toHaveBeenCalled();
    expect(exposureSync.syncExposurePublic).toHaveBeenCalledTimes(1);
  });

  it('syncs as before when this Hub still has the apps installed, as after a Settings reset', async () => {
    cloudflare.getDeviceApplications.mockResolvedValue([portalApp('wordpress'), portalApp('ci-memory')]);
    apps.getApps.mockResolvedValue([localApp('wordpress'), localApp('ci-memory', 'stopped'), localApp('n8n')]);

    await expect(service.runCheck()).resolves.toBe('released');

    expect(state.restoreIntent).toBe(false);
    expect(rehydration.executeRehydrate).not.toHaveBeenCalled();
    expect(exposureSync.syncExposurePublic).toHaveBeenCalledTimes(1);
    // Memory stayed installed across the re-pair, so it is handed the key this pairing issued.
    expect(keyRefresh.refreshStaleDeviceKeys).toHaveBeenCalledTimes(1);
  });

  it('waits while an app the Portal lists is still installing, so the sync does not leave it out', async () => {
    cloudflare.getDeviceApplications.mockResolvedValue([portalApp('wordpress')]);
    apps.getApps.mockResolvedValue([localApp('wordpress', 'installing')]);

    await expect(service.runCheck()).resolves.toBe('waiting');

    expect(state.check).not.toBeNull();
    expect(exposureSync.syncExposurePublic).not.toHaveBeenCalled();
  });

  it('restores when the person pairing chose Restore, even with every app still installed', async () => {
    state.restoreIntent = true;
    cloudflare.getDeviceApplications.mockResolvedValue([portalApp('wordpress')]);
    apps.getApps.mockResolvedValue([localApp('wordpress', 'stopped')]);

    await expect(service.runCheck()).resolves.toBe('released');

    expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(1);
    expect(state.restoreIntent).toBe(false);
  });

  // A factory reset removes the check. The backoff stayed, so the next pairing's check waited up to five minutes.
  it('runs the next pairing check at once after forget, whatever backoff the last one built up', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      cloudflare.getDeviceApplications.mockRejectedValue(new Error('socket hang up'));
      for (let pass = 0; pass < 5; pass++) {
        await expect(service.runCheck()).resolves.toBe('held');
        vi.advanceTimersByTime(PairingAppRestoreService.MAX_RETRY_DELAY_MS);
      }
      await expect(service.runCheck()).resolves.toBe('held');
      // Inside the backoff now: the pass does not ask the Portal.
      await expect(service.runCheck()).resolves.toBe('held');
      const asked = cloudflare.getDeviceApplications.mock.calls.length;

      service.forget();
      state.check = { markedAt: new Date().toISOString() };
      cloudflare.getDeviceApplications.mockResolvedValue([]);

      await expect(service.runCheck()).resolves.toBe('released');
      expect(cloudflare.getDeviceApplications).toHaveBeenCalledTimes(asked + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold app sync for a pairing that left no device key to ask with', async () => {
    config.getConfig = () => ({ ciHubApiKey: null });

    await expect(service.runCheck()).resolves.toBe('released');

    expect(cloudflare.getDeviceApplications).not.toHaveBeenCalled();
  });

  describe('in the background', () => {
    it('works through a pending check on its own, with nobody signed in', async () => {
      vi.useFakeTimers();
      try {
        cloudflare.getDeviceApplications.mockResolvedValue([portalApp('wordpress')]);
        service.onApplicationBootstrap();

        await vi.advanceTimersByTimeAsync(PairingAppRestoreService.POLL_MS);

        expect(rehydration.executeRehydrate).toHaveBeenCalledTimes(1);
      } finally {
        service.onApplicationShutdown();
        vi.useRealTimers();
      }
    });

    // A Hub re-paired before the check existed may still be handing Memory the key that pairing replaced.
    it('looks once for a device key left stale by an earlier pairing', async () => {
      vi.useFakeTimers();
      try {
        state.check = null;
        service.onApplicationBootstrap();

        await vi.advanceTimersByTimeAsync(PairingAppRestoreService.POLL_MS * 3);

        expect(keyRefresh.refreshStaleDeviceKeys).toHaveBeenCalledTimes(1);
      } finally {
        service.onApplicationShutdown();
        vi.useRealTimers();
      }
    });
  });

  it('shares one pass between concurrent callers', async () => {
    cloudflare.getDeviceApplications.mockResolvedValue([]);

    const [first, second] = await Promise.all([service.runCheck(), service.runCheck()]);

    expect([first, second]).toEqual(['released', 'released']);
    expect(cloudflare.getDeviceApplications).toHaveBeenCalledTimes(1);
  });

  // The status route asks on every poll of an open restore page, every 2 s per tab.
  it('runs at most one asked-for pass in each interval, however often a waiting page asks', () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const run = vi.spyOn(service, 'runCheck').mockResolvedValue('waiting');
    try {
      service.requestCheck();
      service.requestCheck();
      now += PairingAppRestoreService.REQUEST_MIN_INTERVAL_MS - 1;
      service.requestCheck();
      expect(run).toHaveBeenCalledTimes(1);

      now += 1;
      service.requestCheck();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});
