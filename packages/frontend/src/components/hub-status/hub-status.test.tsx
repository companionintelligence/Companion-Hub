import { describe, expect, it, vi } from 'vitest';

import { pollDockerAccess } from './hub-status';

describe('pollDockerAccess', () => {
  it('keeps polling until Docker becomes available', async () => {
    const invoke = vi
      .fn<(cmd: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'daemon starting' })
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'still starting' })
      .mockResolvedValueOnce({ state: 'available' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 5,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({ state: 'available' });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('returns permission denied immediately once detected', async () => {
    const invoke = vi
      .fn<(cmd: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'daemon starting' })
      .mockResolvedValueOnce({ state: 'permission_denied', detail: 'dial unix /var/run/docker.sock: permission denied' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 5,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({
      state: 'permission_denied',
      detail: 'dial unix /var/run/docker.sock: permission denied',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('returns the last daemon-unavailable result after timeout', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue({ state: 'daemon_unavailable', detail: 'daemon still starting' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 3,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({ state: 'daemon_unavailable', detail: 'daemon still starting' });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });
});
