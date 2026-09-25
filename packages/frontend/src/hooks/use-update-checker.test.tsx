import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';
import type { UpdateInfo } from '@/lib/update-service';

/**
 * Tests the desktop self-update checker.
 *
 * The load-bearing case is the *mobile* one: `isTauri()` is true on iOS and
 * Android, so without an explicit platform gate this hook would poll our own
 * release feed from inside a store-shipped app and offer .dmg/.exe artifacts
 * the phone cannot install — an App Store rejection (2.4.5 / 3.2.2). It is
 * inert on mobile today only because the mobile Rust shell never registers
 * `get_desktop_release_version_command`; these tests make the gate explicit so
 * adding one later cannot silently arm the updater.
 */

// `t` must keep a stable identity across renders, the way real react-i18next
// does: the poll effect depends on it transitively (t -> showUpdateToast ->
// runCheck -> effect), so a fresh `t` per render would re-arm the interval on
// every state change and make the poll assertions meaningless.
const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));

const toastMock = vi.hoisted(() => ({ info: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const svc = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  dismissVersion: vi.fn(),
  getPollIntervalMs: vi.fn(() => 60_000),
  isTauri: vi.fn(() => true),
  isVersionDismissed: vi.fn(() => false),
  markToastShown: vi.fn(),
  wasToastShown: vi.fn(() => false),
}));
vi.mock('@/lib/update-service', () => svc);

const mc = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/lib/mobile-connection', () => ({ isTauriMobileSync: () => mc.mobile }));

const { useUpdateChecker } = await import('./use-update-checker');

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  downloadUrl: 'https://dl.ci.computer/hub-1.1.0.dmg',
  updateAvailable: true,
  platform: 'macos',
  manualDownload: false,
  ...over,
});

beforeEach(() => {
  mc.mobile = false;
  toastMock.info.mockClear();
  toastMock.dismiss.mockClear();
  svc.checkForUpdates.mockReset().mockResolvedValue(info());
  svc.dismissVersion.mockClear();
  svc.markToastShown.mockClear();
  svc.getPollIntervalMs.mockReset().mockReturnValue(60_000);
  svc.isTauri.mockReset().mockReturnValue(true);
  svc.isVersionDismissed.mockReset().mockReturnValue(false);
  svc.wasToastShown.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUpdateChecker — platform gating', () => {
  it('never checks for updates on mobile, where the store owns updates', async () => {
    // isTauri() stays true — mobile IS a Tauri shell. Only the mobile gate
    // stops the feed check here.
    mc.mobile = true;

    const { result } = renderHook(() => useUpdateChecker());

    await new Promise((r) => setTimeout(r, 20));
    expect(svc.checkForUpdates).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(result.current.update).toBeNull();
  });

  it('does not poll on mobile', async () => {
    vi.useFakeTimers();
    mc.mobile = true;

    renderHook(() => useUpdateChecker());
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(svc.checkForUpdates).not.toHaveBeenCalled();
  });

  it('ignores even an explicit recheck on mobile', async () => {
    mc.mobile = true;
    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await expect(result.current.recheck()).resolves.toBeNull();
    });

    expect(svc.checkForUpdates).not.toHaveBeenCalled();
  });

  it('is inert in the browser (not a Tauri shell at all)', async () => {
    svc.isTauri.mockReturnValue(false);

    renderHook(() => useUpdateChecker());

    await new Promise((r) => setTimeout(r, 20));
    expect(svc.checkForUpdates).not.toHaveBeenCalled();
  });

  it('does check on desktop', async () => {
    renderHook(() => useUpdateChecker());
    await waitFor(() => expect(svc.checkForUpdates).toHaveBeenCalled());
  });
});

describe('useUpdateChecker — desktop behaviour', () => {
  it('surfaces an available update and toasts once', async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => expect(result.current.update).toEqual(info()));
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    expect(svc.markToastShown).toHaveBeenCalledWith('1.1.0');
  });

  it('stays quiet when already on the latest version', async () => {
    svc.checkForUpdates.mockResolvedValue(info({ updateAvailable: false }));

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => expect(svc.checkForUpdates).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('stays quiet when the feed check fails', async () => {
    svc.checkForUpdates.mockResolvedValue(null);

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => expect(svc.checkForUpdates).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('honours a version the user already dismissed', async () => {
    svc.isVersionDismissed.mockReturnValue(true);

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => expect(svc.checkForUpdates).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('does not re-toast a version already announced this session', async () => {
    svc.wasToastShown.mockReturnValue(true);

    const { result } = renderHook(() => useUpdateChecker());

    // Still offered in the UI — just not toasted at the user again.
    await waitFor(() => expect(result.current.update).toEqual(info()));
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(svc.markToastShown).not.toHaveBeenCalled();
  });

  it('dismiss() records the version so it stays dismissed', async () => {
    const { result } = renderHook(() => useUpdateChecker());
    await waitFor(() => expect(result.current.update).not.toBeNull());

    act(() => {
      result.current.dismiss();
    });

    expect(svc.dismissVersion).toHaveBeenCalledWith('1.1.0');
    expect(result.current.update).toBeNull();
  });

  it('dismiss() with nothing pending records nothing', () => {
    svc.checkForUpdates.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateChecker());

    act(() => {
      result.current.dismiss();
    });

    expect(svc.dismissVersion).not.toHaveBeenCalled();
  });

  it('recheck() re-queries without toasting (it is user-initiated)', async () => {
    const { result } = renderHook(() => useUpdateChecker());
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(1));
    svc.wasToastShown.mockReturnValue(false);

    await act(async () => {
      await expect(result.current.recheck()).resolves.toEqual(info());
    });

    expect(svc.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(toastMock.info).toHaveBeenCalledTimes(1); // no second toast
  });

  it('polls on the service-provided interval and stops on unmount', async () => {
    vi.useFakeTimers();
    svc.getPollIntervalMs.mockReturnValue(1_000);

    const { unmount } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(svc.checkForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(svc.checkForUpdates).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(svc.checkForUpdates).toHaveBeenCalledTimes(3); // no leaked interval
  });

  it('swallows a thrown feed check instead of leaking an unhandled rejection', async () => {
    // The mount and the poll both call runCheck as `void runCheck(true)`, so
    // anything that escapes it lands as an unhandled rejection with nobody to
    // catch it — noise in Sentry at best. checkForUpdates absorbs its own
    // errors today, so this guards the day it stops.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    svc.checkForUpdates.mockRejectedValue(new Error('feed down'));

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => expect(svc.checkForUpdates).toHaveBeenCalled());
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.update).toBeNull();

    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('reports a thrown feed check to recheck() as "nothing found", not a rejection', async () => {
    svc.checkForUpdates.mockRejectedValue(new Error('feed down'));
    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await expect(result.current.recheck()).resolves.toBeNull();
    });
  });
});
