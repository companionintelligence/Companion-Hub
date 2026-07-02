import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';

describe('AppLifecycleService Tailscale readiness watcher', () => {
  const triggerTailscaleSync = vi.fn().mockResolvedValue(undefined);
  const getStatus = vi.fn();

  let service: AppLifecycleService;

  beforeEach(() => {
    vi.clearAllMocks();

    service = Object.create(AppLifecycleService.prototype) as AppLifecycleService;
    Object.assign(service, {
      moduleRef: {
        get: vi.fn().mockReturnValue({ getStatus }),
      },
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      syncTailscaleExposurePublic: triggerTailscaleSync,
      tailscaleReadinessInitialized: false,
      lastTailscaleConnected: false,
      lastTailscaleHttpsAvailable: false,
    });
  });

  it('seeds readiness state without syncing on first poll', async () => {
    getStatus.mockResolvedValue({ connected: true, httpsAvailable: true });

    await (service as any).checkTailscaleReadinessTransition();

    expect(triggerTailscaleSync).not.toHaveBeenCalled();
    expect((service as any).tailscaleReadinessInitialized).toBe(true);
    expect((service as any).lastTailscaleConnected).toBe(true);
  });

  it('syncs when Tailscale becomes connected', async () => {
    getStatus.mockResolvedValueOnce({ connected: false, httpsAvailable: false }).mockResolvedValueOnce({ connected: true, httpsAvailable: false });

    await (service as any).checkTailscaleReadinessTransition();
    await (service as any).checkTailscaleReadinessTransition();

    expect(triggerTailscaleSync).toHaveBeenCalledTimes(1);
  });

  it('syncs when HTTPS becomes available on a connected tailnet', async () => {
    getStatus.mockResolvedValueOnce({ connected: true, httpsAvailable: false }).mockResolvedValueOnce({ connected: true, httpsAvailable: true });

    await (service as any).checkTailscaleReadinessTransition();
    await (service as any).checkTailscaleReadinessTransition();

    expect(triggerTailscaleSync).toHaveBeenCalledTimes(1);
  });
});
