import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';

/**
 * The Hub only ever learned about a custom domain connected in the Portal when
 * something else made it sync — a boot, a routing change, a manual repair. This
 * timer is what closes that gap (CI-Hub#1209), so the properties under test are
 * that it keeps firing, that it never overlaps itself, and that it is torn down.
 */
describe('AppLifecycleService periodic exposure sync', () => {
  const INTERVAL_MS = 5 * 60_000;

  let service: AppLifecycleService;
  let syncExposure: ReturnType<typeof vi.fn>;
  let isCloudflareSyncInFlight: ReturnType<typeof vi.fn>;
  let logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    syncExposure = vi.fn().mockResolvedValue(undefined);
    isCloudflareSyncInFlight = vi.fn().mockReturnValue(false);
    logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };

    service = Object.create(AppLifecycleService.prototype) as AppLifecycleService;
    Object.assign(service, {
      logger,
      syncExposure,
      exposureSyncService: { isCloudflareSyncInFlight },
      exposureSyncInterval: null,
      tailscaleReadinessInterval: null,
      periodicExposureSyncInFlight: false,
    });
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('re-syncs exposure on every interval', async () => {
    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(2);
  });

  it('does not start a second pass while one is still running', async () => {
    // Portal requests retry with backoff, so a pass can outlive its interval.
    // Overlapping passes would duplicate every DNS write and let two
    // custom-domain reconciliations race for the same row.
    let release: () => void = () => {};
    syncExposure.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(2);
  });

  it('keeps polling after a failed pass', async () => {
    // A rejected pass must clear the in-flight flag, or one transient Portal
    // outage would silently stop the Hub from ever syncing again.
    syncExposure.mockRejectedValueOnce(new Error('portal unreachable'));

    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('portal unreachable'));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(2);
  });

  it('stands down while a sync started elsewhere is still running', async () => {
    // The in-flight flag only sees passes this timer started. The startup sync, a
    // settings save, a port-expose change, availability remediation and
    // `public-web repair` all enter the same custom-domain reconcile without it,
    // so the background poll has to ask the sync service itself before adding a
    // second reconciliation racing for the same row.
    isCloudflareSyncInFlight.mockReturnValue(true);

    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).not.toHaveBeenCalled();

    isCloudflareSyncInFlight.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(syncExposure).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the module is destroyed', async () => {
    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    service.onModuleDestroy();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(syncExposure).toHaveBeenCalledTimes(1);
  });

  it('replaces rather than leaks the timer if it is started twice', async () => {
    (service as any).startPeriodicExposureSync();
    (service as any).startPeriodicExposureSync();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    // A leaked first interval would fire alongside the second one.
    expect(syncExposure).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(syncExposure).toHaveBeenCalledTimes(1);
  });

  it('is started by application bootstrap', async () => {
    // The tests above drive `startPeriodicExposureSync` directly, so none of them
    // would notice the call being dropped from `onApplicationBootstrap` — which
    // is the whole of the CI-Hub#1209 fix.
    const started = vi.spyOn(AppLifecycleService.prototype as any, 'startPeriodicExposureSync').mockImplementation(() => {});
    Object.assign(service, {
      recoverStuckInstallsOnStartup: vi.fn().mockResolvedValue(undefined),
      startTailscaleReadinessWatcher: vi.fn(),
      syncInferenceAppsAfterHubUpgrade: vi.fn().mockResolvedValue(undefined),
      moduleRef: { get: vi.fn().mockReturnValue(undefined) },
    });

    await service.onApplicationBootstrap();

    expect(started).toHaveBeenCalled();
    started.mockRestore();
  });
});
