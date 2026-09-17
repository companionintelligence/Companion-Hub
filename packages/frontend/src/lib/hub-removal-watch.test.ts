import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForRemoval } from '@/api-client/sdk.gen';
import {
  checkHubRemoval,
  HUB_REMOVAL_WATCH_INTERVAL_MS,
  HUB_REMOVAL_WATCH_TIMEOUT_MS,
  type HubRemovalCheck,
  portalRemoveDeviceUrl,
  watchForHubRemoval,
} from './hub-removal-watch';

vi.mock('@/api-client/sdk.gen', () => ({ checkForRemoval: vi.fn() }));

const sdkAnswer = (status: number, data?: unknown) => ({
  data,
  error: status >= 400 ? { status } : undefined,
  response: new Response(null, { status }),
});

describe('portalRemoveDeviceUrl', () => {
  it("opens the Portal's delete confirmation for this hardware device", () => {
    expect(portalRemoveDeviceUrl('https://portal.example.com/', 'hw id/1')).toBe('https://portal.example.com/home?remove_device=hw%20id%2F1');
  });
});

describe('checkHubRemoval', () => {
  beforeEach(() => {
    vi.mocked(checkForRemoval).mockReset();
  });

  it('returns what the Hub found', async () => {
    vi.mocked(checkForRemoval).mockResolvedValue(sdkAnswer(200, { result: 'removed' }) as never);

    await expect(checkHubRemoval()).resolves.toBe('removed');
  });

  it('reads a refusal from the Hub itself as not_allowed', async () => {
    vi.mocked(checkForRemoval).mockResolvedValue(sdkAnswer(401) as never);
    await expect(checkHubRemoval()).resolves.toBe('not_allowed');

    vi.mocked(checkForRemoval).mockResolvedValue(sdkAnswer(403) as never);
    await expect(checkHubRemoval()).resolves.toBe('not_allowed');
  });

  it('reads server errors, unknown answers and network failures as not_checked', async () => {
    vi.mocked(checkForRemoval).mockResolvedValue(sdkAnswer(502) as never);
    await expect(checkHubRemoval()).resolves.toBe('not_checked');

    vi.mocked(checkForRemoval).mockResolvedValue(sdkAnswer(200, { result: 'something_new' }) as never);
    await expect(checkHubRemoval()).resolves.toBe('not_checked');

    vi.mocked(checkForRemoval).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(checkHubRemoval()).resolves.toBe('not_checked');
  });
});

describe('watchForHubRemoval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const answers = (...results: HubRemovalCheck[]) => {
    const check = vi.fn<() => Promise<HubRemovalCheck>>();
    for (const result of results) {
      check.mockResolvedValueOnce(result);
    }
    check.mockResolvedValue(results.at(-1) ?? 'still_registered');
    return check;
  };

  it('checks right away, then every 15 seconds, and ends when the Portal removed the Hub', async () => {
    const check = answers('still_registered', 'not_checked', 'removed');
    const onEnd = vi.fn();

    watchForHubRemoval({ check, onEnd });

    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith('removed');

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS * 4);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('gives up after 15 minutes and stops checking', async () => {
    const check = answers('still_registered');
    const onEnd = vi.fn();

    watchForHubRemoval({ check, onEnd });

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_TIMEOUT_MS - 1);
    expect(onEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith('timed_out');

    const checksAtTimeout = check.mock.calls.length;
    expect(checksAtTimeout).toBe(HUB_REMOVAL_WATCH_TIMEOUT_MS / HUB_REMOVAL_WATCH_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_TIMEOUT_MS);
    expect(check).toHaveBeenCalledTimes(checksAtTimeout);
  });

  it('stops at once when the Portal refuses the device key, instead of asking again for 15 minutes', async () => {
    const check = answers('still_registered', 'key_refused');
    const onEnd = vi.fn();

    watchForHubRemoval({ check, onEnd });
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS);

    expect(onEnd).toHaveBeenCalledExactlyOnceWith('key_refused');

    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_TIMEOUT_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stops when the Hub refuses the check, such as after the session expired', async () => {
    const check = answers('not_allowed');
    const onEnd = vi.fn();

    watchForHubRemoval({ check, onEnd });
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_TIMEOUT_MS);

    expect(onEnd).toHaveBeenCalledExactlyOnceWith('not_allowed');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('keeps watching when a check throws', async () => {
    const check = vi.fn<() => Promise<HubRemovalCheck>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('removed');
    const onEnd = vi.fn();

    watchForHubRemoval({ check, onEnd });
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS);

    expect(onEnd).toHaveBeenCalledExactlyOnceWith('removed');
  });

  it('never starts a check while the previous one is still waiting for an answer', async () => {
    let answer: (result: HubRemovalCheck) => void = () => {};
    const check = vi.fn<() => Promise<HubRemovalCheck>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    watchForHubRemoval({ check, onEnd: vi.fn() });
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS * 3);
    expect(check).toHaveBeenCalledTimes(1);

    answer('still_registered');
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stops without reporting an end when the caller cancels', async () => {
    const check = answers('still_registered', 'removed');
    const onEnd = vi.fn();

    const stop = watchForHubRemoval({ check, onEnd });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(HUB_REMOVAL_WATCH_TIMEOUT_MS);

    expect(check).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
