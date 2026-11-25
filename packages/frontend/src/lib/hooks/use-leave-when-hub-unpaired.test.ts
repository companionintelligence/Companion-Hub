import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistrationStatus } from '@/lib/registration-status';

const registration = vi.hoisted(() => ({
  data: undefined as RegistrationStatus | undefined,
  refetch: vi.fn(),
}));
const { handleSessionExpired } = vi.hoisted(() => ({ handleSessionExpired: vi.fn() }));
const connection = vi.hoisted(() => ({ mobile: false, hubBaseUrl: null as string | null }));

vi.mock('@/lib/hooks/use-registration-status', () => ({ useRegistrationStatus: () => registration }));
vi.mock('@/lib/session-expired', () => ({ handleSessionExpired }));
vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => connection.mobile,
  isTauriMobileSync: () => false,
  getHubBaseUrlSync: () => connection.hubBaseUrl,
}));

const { UNPAIRED_CONFIRM_MS, holdLeaveWhenHubUnpaired, useLeaveWhenHubUnpaired } = await import('./use-leave-when-hub-unpaired');

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
    connection.mobile = false;
    connection.hubBaseUrl = null;
    sessionStorage.clear();
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

  // A drift choice kept from the last pairing hid the pairing page's question about the Portal device.
  it('forgets the last pairing on its way out, as Settings does', async () => {
    sessionStorage.setItem('ci-hub-registration-drift-choice', 'fresh');
    sessionStorage.setItem('device-registered', 'true');
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    renderHook(() => useLeaveWhenHubUnpaired());

    await passConfirmDelay();

    expect(handleSessionExpired).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('ci-hub-registration-drift-choice')).toBeNull();
    expect(sessionStorage.getItem('device-registered')).toBeNull();
  });

  // Settings resetting the Hub, or watching for its removal, says what happened before it leaves.
  it('waits while a page leaves for pairing by itself and goes once it lets go', async () => {
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    const release = holdLeaveWhenHubUnpaired();
    try {
      renderHook(() => useLeaveWhenHubUnpaired());

      await passConfirmDelay();
      await passConfirmDelay();
      expect(handleSessionExpired).not.toHaveBeenCalled();

      release();
      await passConfirmDelay();
      expect(handleSessionExpired).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it('counts a release once, however often it is called', async () => {
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    const first = holdLeaveWhenHubUnpaired();
    const second = holdLeaveWhenHubUnpaired();
    try {
      first();
      first();
      renderHook(() => useLeaveWhenHubUnpaired());

      await passConfirmDelay();
      expect(handleSessionExpired).not.toHaveBeenCalled();
    } finally {
      second();
    }
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

  // A failed check keeps the old `unregistered` as its data, which must not count as a second answer.
  it('asks again when the check fails instead of leaving on the old answer', async () => {
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValueOnce({ isError: true, data: status('unregistered') });
    registration.refetch.mockResolvedValueOnce({ isError: false, data: status('unregistered') });
    renderHook(() => useLeaveWhenHubUnpaired());

    await passConfirmDelay();
    expect(registration.refetch).toHaveBeenCalledTimes(1);
    expect(handleSessionExpired).not.toHaveBeenCalled();

    await passConfirmDelay();
    expect(registration.refetch).toHaveBeenCalledTimes(2);
    expect(handleSessionExpired).toHaveBeenCalledTimes(1);
  });

  // The phone's root loader lets `/login` through without asking about pairing, so leaving would loop.
  it('leaves a phone signed in to a remote Hub alone', async () => {
    connection.mobile = true;
    connection.hubBaseUrl = 'https://hub.example.test';
    registration.data = status('unregistered');
    registration.refetch.mockResolvedValue({ data: status('unregistered') });
    renderHook(() => useLeaveWhenHubUnpaired());

    await passConfirmDelay();

    expect(registration.refetch).not.toHaveBeenCalled();
    expect(handleSessionExpired).not.toHaveBeenCalled();
  });
});
