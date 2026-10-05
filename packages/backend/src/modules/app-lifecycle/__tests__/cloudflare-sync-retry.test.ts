import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ExposureSyncService } from '@/modules/app-lifecycle/exposure-sync.service';

/**
 * A pass that never reached Companion Portal leaves a new app without a DNS record, and a
 * browser that looks the name up meanwhile caches the miss. The pass retries on its own, ahead
 * of the 5-minute background poll.
 */
describe('ExposureSyncService Cloudflare retry', () => {
  let service: ExposureSyncService;
  let trigger: ReturnType<typeof vi.fn>;
  let inFlight: boolean;

  const settle = (answered: boolean) => (service as any).settleCloudflareRetry(answered);

  beforeEach(() => {
    vi.useFakeTimers();
    inFlight = false;
    trigger = vi.fn().mockResolvedValue(undefined);
    service = Object.create(ExposureSyncService.prototype) as ExposureSyncService;
    Object.assign(service, {
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      cloudflareRetryTimer: null,
      cloudflareRetryAttempt: 0,
      triggerCloudflareSync: trigger,
      isCloudflareSyncInFlight: () => inFlight,
    });
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('re-runs a pass Companion Portal never answered, with growing delays', async () => {
    settle(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(trigger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(trigger).toHaveBeenCalledTimes(1);

    settle(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(trigger).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('stops and starts over once a pass is answered', async () => {
    settle(false);
    settle(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(trigger).not.toHaveBeenCalled();

    settle(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last delay and leaves the rest to the background poll', async () => {
    for (let i = 0; i < 5; i++) {
      settle(false);
      await vi.advanceTimersByTimeAsync(120_000);
    }
    expect(trigger).toHaveBeenCalledTimes(5);

    // The sixth failure books nothing; the next independent failure starts the run over.
    settle(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(trigger).toHaveBeenCalledTimes(5);
    settle(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(trigger).toHaveBeenCalledTimes(6);
  });

  it('does not start a pass over one that is still running', async () => {
    inFlight = true;
    settle(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(trigger).not.toHaveBeenCalled();
  });
});
