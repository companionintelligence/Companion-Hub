import type { ReactElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, userEvent, waitFor } from '@/tests/test-utils';
import type { DesktopRestartState } from '@/lib/update-service';

// A stable `t`, the way react-i18next keeps one: the effect depends on it.
const i18n = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));

const toastMock = vi.hoisted(() => ({ info: vi.fn(), dismiss: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const svc = vi.hoisted(() => ({
  getDesktopRestartState: vi.fn(),
  isTauri: vi.fn(() => true),
  restartDesktopApp: vi.fn(),
}));
vi.mock('@/lib/update-service', () => svc);

const mc = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/lib/mobile-connection', () => ({ isTauriMobileSync: () => mc.mobile }));

const { RESTART_CHECK_INTERVAL_MS, useDesktopRestartNotice } = await import('./use-desktop-restart-notice');

const state = (over: Partial<DesktopRestartState> = {}): DesktopRestartState => ({
  runningVersion: '0.2.77',
  installedVersion: '0.2.78',
  restartRequired: true,
  ...over,
});

beforeEach(() => {
  mc.mobile = false;
  toastMock.info.mockClear();
  toastMock.dismiss.mockClear();
  toastMock.error.mockClear();
  svc.getDesktopRestartState.mockReset().mockResolvedValue(state());
  svc.isTauri.mockReset().mockReturnValue(true);
  svc.restartDesktopApp.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDesktopRestartNotice', () => {
  it('says once that the installed version needs a restart', async () => {
    renderHook(() => useDesktopRestartNotice());

    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(1));
    const [content, options] = toastMock.info.mock.calls[0] as [ReactElement, { id: string; duration: number }];
    expect(options).toEqual({ id: 'desktop-restart-required', duration: Number.POSITIVE_INFINITY });
    render(content);
    expect(screen.getByText('DESKTOP_RESTART_TOAST_TITLE {"version":"0.2.78"}')).toBeInTheDocument();
    expect(screen.getByText('DESKTOP_RESTART_TOAST_BODY {"running":"0.2.77"}')).toBeInTheDocument();

    // Focusing the window checks again, but the same version is not announced twice.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(svc.getDesktopRestartState).toHaveBeenCalledTimes(2));
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('announces a later install again', async () => {
    renderHook(() => useDesktopRestartNotice());
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(1));

    svc.getDesktopRestartState.mockResolvedValue(state({ installedVersion: '0.2.79' }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(2));
  });

  it('keeps checking while the app is open', async () => {
    vi.useFakeTimers();
    svc.getDesktopRestartState.mockResolvedValue(state({ restartRequired: false, installedVersion: null }));
    renderHook(() => useDesktopRestartNotice());
    await act(async () => {});
    expect(svc.getDesktopRestartState).toHaveBeenCalledTimes(1);

    svc.getDesktopRestartState.mockResolvedValue(state());
    await act(async () => {
      vi.advanceTimersByTime(RESTART_CHECK_INTERVAL_MS);
    });

    expect(svc.getDesktopRestartState).toHaveBeenCalledTimes(2);
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when no restart is needed, or the app cannot tell', async () => {
    svc.getDesktopRestartState.mockResolvedValue(state({ restartRequired: false, installedVersion: null }));
    renderHook(() => useDesktopRestartNotice());
    await waitFor(() => expect(svc.getDesktopRestartState).toHaveBeenCalled());

    svc.getDesktopRestartState.mockResolvedValue(null);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(svc.getDesktopRestartState).toHaveBeenCalledTimes(2));

    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('never asks outside the desktop app, or on a phone', async () => {
    svc.isTauri.mockReturnValue(false);
    const browser = renderHook(() => useDesktopRestartNotice());
    browser.unmount();

    svc.isTauri.mockReturnValue(true);
    mc.mobile = true;
    renderHook(() => useDesktopRestartNotice());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(svc.getDesktopRestartState).not.toHaveBeenCalled();
  });

  it('restarts from the notice, and says how to by hand when the app refuses', async () => {
    renderHook(() => useDesktopRestartNotice());
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(1));
    const [content] = toastMock.info.mock.calls[0] as [ReactElement];
    render(content);

    await userEvent.click(screen.getByText('DESKTOP_RESTART_NOW'));
    expect(svc.restartDesktopApp).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();

    svc.restartDesktopApp.mockResolvedValue(false);
    await userEvent.click(screen.getByText('DESKTOP_RESTART_NOW'));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('DESKTOP_RESTART_FAILED'));
  });
});
