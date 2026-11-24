import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from '@/lib/registration-status';

const registration = vi.hoisted(() => ({
  data: undefined as RegistrationStatus | undefined,
  refetch: vi.fn(),
}));
const { handleSessionExpired } = vi.hoisted(() => ({ handleSessionExpired: vi.fn() }));

vi.mock('@/lib/hooks/use-registration-status', () => ({ useRegistrationStatus: () => registration }));
vi.mock('@/lib/session-expired', () => ({ handleSessionExpired }));

const { UNPAIRED_CONFIRM_MS, useLeaveWhenHubUnpaired } = await import('./use-leave-when-hub-unpaired');

const status = (phase: RegistrationStatus['phase']): RegistrationStatus => ({
  phase,
  degradedReasons: [],
  registered: phase !== 'unregistered' && phase !== 'paired' && phase !== 'provisioning',
});

/** Runs the confirmation delay and lets the refetch it starts settle. */
async function passConfirmDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UNPAIRED_CONFIRM_MS);
  });
}

describe('useLeaveWhenHubUnpaired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registration.data = status('publicly_ready');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an open page on once the Hub stays unpaired', async () => {
    const { rerender } = renderHook(() => useLeaveWhenHubUnpaired());
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    rerender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNPAIRED_CONFIRM_MS - 1);
    });
    expect(handleSessionExpired).not.toHaveBeenCalled();

    await passConfirmDelay();
    expect(registration.refetch).toHaveBeenCalledTimes(1);
    expect(handleSessionExpired).toHaveBeenCalledTimes(1);
  });

  // A Hub that just started answers `unregistered` once before it reads its registration back.
  it('stays when the next answer says the Hub is paired after all', async () => {
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('locally_ready') });
    renderHook(() => useLeaveWhenHubUnpaired());

    await passConfirmDelay();

    expect(registration.refetch).toHaveBeenCalledTimes(1);
    expect(handleSessionExpired).not.toHaveBeenCalled();
  });

  it('leaves a paired Hub alone, whatever its phase', async () => {
    for (const phase of ['locally_ready', 'publicly_ready', 'degraded'] as const) {
      registration.data = status(phase);
      renderHook(() => useLeaveWhenHubUnpaired());
      await passConfirmDelay();
    }

    expect(registration.refetch).not.toHaveBeenCalled();
    expect(handleSessionExpired).not.toHaveBeenCalled();
  });

  it('does nothing once the page has gone', async () => {
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    const { unmount } = renderHook(() => useLeaveWhenHubUnpaired());

    unmount();
    await passConfirmDelay();

    expect(handleSessionExpired).not.toHaveBeenCalled();
  });
});
